"""
instagram_search.py
-------------------
Personalized Instagram search CLI backed by a persisted browser session.

First run:  Opens Chrome via Selenium, waits for you to log in manually,
            captures cookies + User-Agent, writes them to session.json.

Subsequent runs: Reads session.json, injects settings into an instagrapi
                 Client, and issues lightweight HTTP search requests against
                 Instagram's private endpoints—no browser started.

Usage:
    python instagram_search.py "coffee shops" --type top
    python instagram_search.py "nike" --type user
    python instagram_search.py "travel" --type hashtag
    python instagram_search.py "New York" --type place
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, field_validator

# ---------------------------------------------------------------------------
# Patch instagrapi to use the current Instagram Android app version.
# Instagram pushed v450 on 2026-10-04 and now rejects v449 User-Agent headers.
# The bloks_versioning_id for v450 is not yet public; we reuse the v449 hash
# which is only needed for the CAA username/password login flow — not for
# session-based (sessionid / Selenium cookie) authentication.
# ---------------------------------------------------------------------------
try:
    import instagrapi.config as _ig_cfg
    _NEW_VER = "450.0.0.41.77"
    _NEW_VER_CODE = "385609976"
    _OLD_HASH = _ig_cfg.APP_SETTINGS.get(
        _ig_cfg.DEFAULT_APP_VERSION, {}
    ).get("bloks_versioning_id", "")
    if _NEW_VER not in _ig_cfg.APP_SETTINGS:
        _ig_cfg.APP_SETTINGS[_NEW_VER] = {
            "app_version": _NEW_VER,
            "version_code": _NEW_VER_CODE,
            "bloks_versioning_id": _OLD_HASH,
        }
    _ig_cfg.DEFAULT_APP_VERSION = _NEW_VER
except Exception:
    pass  # If instagrapi isn't installed yet, skip silently

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CookieEntry(BaseModel):
    """Represents a single browser cookie."""

    model_config = ConfigDict(extra="allow")

    name: str
    value: str
    domain: str = ""
    path: str = "/"
    secure: bool = False
    http_only: bool = False
    expiry: Optional[int] = None


class SessionBundle(BaseModel):
    """Persisted session data written to / read from session.json."""

    user_agent: str
    cookies: List[CookieEntry]
    # Full instagrapi settings dict (device ids, uuid, etc.)
    instagrapi_settings: Dict[str, Any] = {}
    created_at: str = ""
    # Instagram username for the connected account — populated after first login
    username: Optional[str] = None

    @field_validator("created_at", mode="before")
    @classmethod
    def default_created_at(cls, v: str) -> str:
        return v or datetime.now(timezone.utc).isoformat()


MEDIA_TYPE_MAP = {1: "photo", 2: "video", 8: "carousel"}


class TranscriptSegment(BaseModel):
    """One time-stamped speech segment from Faster-Whisper."""
    start: float
    end: float
    text: str
    words: Optional[List[Dict[str, Any]]] = None  # [{word, start, end, prob}]


class TranscriptResult(BaseModel):
    """High-fidelity transcription of a reel's audio track."""
    text: str = ""
    language: Optional[str] = None
    duration_seconds: Optional[float] = None
    word_count: Optional[int] = None
    model: Optional[str] = None
    # Supabase Storage paths (bucket = reel-artifacts)
    audio_storage_path: Optional[str] = None      # {user_id}/{code}/audio.mp3
    transcript_storage_path: Optional[str] = None # {user_id}/{code}/transcript.json
    segments: Optional[List[Dict[str, Any]]] = None
    error: Optional[str] = None  # set when transcription partially failed


class PostResult(BaseModel):
    """Normalised representation of a single Instagram post / reel / carousel."""

    pk: Optional[str] = None
    code: Optional[str] = None          # shortcode → instagram.com/p/{code}/
    url: Optional[str] = None
    media_type: Optional[str] = None    # "photo" | "video" | "carousel"
    thumbnail_url: Optional[str] = None
    video_url: Optional[str] = None
    caption: Optional[str] = None
    like_count: Optional[int] = None
    comment_count: Optional[int] = None
    view_count: Optional[int] = None    # video / reel play count
    taken_at: Optional[str] = None      # ISO timestamp
    username: Optional[str] = None
    user_pk: Optional[str] = None
    is_verified: Optional[bool] = None
    transcript: Optional[TranscriptResult] = None  # populated when transcription requested


# ---------------------------------------------------------------------------
# Session store helpers
# ---------------------------------------------------------------------------

SESSION_FILE = Path(__file__).parent / "session.json"
REQUIRED_COOKIES = {"sessionid", "ds_user_id"}
POLL_INTERVAL_SEC = 2
POLL_TIMEOUT_SEC = 300

# URL path fragments that indicate the user is still mid-auth flow.
# The browser must navigate away from ALL of these before we capture cookies.
AUTH_PATHS = (
    "/accounts/login",
    "/accounts/emailsignup",
    "/accounts/onetap",
    "/challenge/",
    "/two_factor",
    "/verify/",
    "/accounts/suspended",
)

# ---------------------------------------------------------------------------
# Rate-limit / anti-abuse messaging
# ---------------------------------------------------------------------------

COOLDOWN_MSG = (
    "[error] Instagram is rate-limiting this session.\n"
    "        Wait at least 10–15 minutes before retrying.\n"
    "        Do NOT run the script in a tight loop — this makes it worse."
)

CHALLENGE_MSG = (
    "[error] Instagram issued a security challenge (ChallengeRequired).\n"
    "        Open the Instagram app or website and complete the verification.\n"
    "        Once cleared, re-run the script (session will be re-captured)."
)


def _get_feedback_message(cl) -> str:
    """Safely extract Instagram's feedback_message from the last response."""
    try:
        last = getattr(cl, "last_json", {}) or {}
        return last.get("feedback_message") or last.get("message") or ""
    except Exception:
        return ""


def session_exists() -> bool:
    return SESSION_FILE.exists() and SESSION_FILE.stat().st_size > 0


def load_session() -> Optional[SessionBundle]:
    """Load and validate session.json.  Returns None on corruption."""
    if not session_exists():
        return None
    try:
        raw = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        return SessionBundle.model_validate(raw)
    except Exception as exc:
        print(f"[warn] session.json is corrupt ({exc}); will re-authenticate.")
        delete_session()
        return None


def save_session(bundle: SessionBundle, *, verbose: bool = True) -> None:
    SESSION_FILE.write_text(
        bundle.model_dump_json(indent=2), encoding="utf-8"
    )
    if verbose:
        print(f"[info] Session saved to {SESSION_FILE}")


def delete_session() -> None:
    if SESSION_FILE.exists():
        SESSION_FILE.unlink()
        print(f"[info] Removed stale session file: {SESSION_FILE}")


# ---------------------------------------------------------------------------
# Browser-based first-run authentication
# ---------------------------------------------------------------------------

def _build_chrome_driver():
    """Return a Selenium Chrome WebDriver, auto-managing the chromedriver binary."""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager

    options = Options()
    # Run headed so the user can complete login/2FA/CAPTCHA.
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    # Suppress automation detection banners.
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    options.add_argument(
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    return driver


def _on_auth_page(url: str) -> bool:
    """Return True if the URL is still on a login / verification / challenge page."""
    return any(fragment in url for fragment in AUTH_PATHS)


def browser_login() -> SessionBundle:
    """
    Open Instagram login page in Chrome and wait for the user to fully complete
    authentication — including any email/SMS verification or 2FA prompts.

    Two conditions must BOTH be true before the browser closes:
      1. The required cookies (sessionid, ds_user_id) are present.
      2. The browser URL is no longer on any auth/challenge/verification page.

    This prevents the window from closing mid-email-verification, which used to
    happen because Instagram sets cookies before the verification step completes.
    """
    print("\n[auth] Starting browser-based login…")
    print("[auth] A Chrome window will open. Please log in to Instagram.")
    print("[auth] Complete ALL steps including email/SMS verification if prompted.")
    print("[auth] The window will close automatically once you reach the home feed.")
    print(f"[auth] Waiting up to {POLL_TIMEOUT_SEC // 60} minutes…\n")

    driver = _build_chrome_driver()
    try:
        driver.get("https://www.instagram.com/accounts/login/")

        cookies_ready = False
        deadline = time.monotonic() + POLL_TIMEOUT_SEC

        while time.monotonic() < deadline:
            try:
                current_url = driver.current_url
                cookies = driver.get_cookies()
                cookie_names = {c["name"] for c in cookies}

                has_required = REQUIRED_COOKIES.issubset(cookie_names)
                still_in_auth = _on_auth_page(current_url)

                if has_required and not still_in_auth:
                    break

                # Give the user a progress hint when cookies appear but they're
                # still mid-verification (e.g. checking their email).
                if has_required and still_in_auth and not cookies_ready:
                    cookies_ready = True
                    print(
                        "[auth] Session cookies detected — waiting for you to "
                        "finish verification before closing the browser…"
                    )

            except Exception:
                # Window may be navigating; ignore transient WebDriver errors.
                pass

            time.sleep(POLL_INTERVAL_SEC)
        else:
            driver.quit()
            raise TimeoutError(
                f"Login not completed within {POLL_TIMEOUT_SEC} seconds. "
                "Please re-run the script and complete all verification steps promptly."
            )

        # Capture User-Agent from the live browser.
        user_agent: str = driver.execute_script("return navigator.userAgent;")

        cookie_models = [
            CookieEntry(
                name=c["name"],
                value=c["value"],
                domain=c.get("domain", ""),
                path=c.get("path", "/"),
                secure=c.get("secure", False),
                http_only=c.get("httpOnly", False),
                expiry=c.get("expiry"),
            )
            for c in cookies
        ]

        bundle = SessionBundle(user_agent=user_agent, cookies=cookie_models)
        print("[auth] Login fully complete. Closing browser…")
        return bundle

    finally:
        try:
            driver.quit()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# instagrapi client bootstrap
# ---------------------------------------------------------------------------

def _cookies_to_jar(cookies: List[CookieEntry]) -> Dict[str, str]:
    """Flatten cookie list to a simple name→value dict for instagrapi."""
    return {c.name: c.value for c in cookies}


def build_client(bundle: SessionBundle):
    """
    Build and return an instagrapi Client pre-loaded with the persisted session.

    - Device/UUID settings are merged first so the same fingerprint is reused.
    - `login_by_sessionid()` is the instagrapi-supported way to bootstrap from
      a browser-captured sessionid without a password. It also validates the
      session by fetching the current user's info, so a separate health_check
      call is not needed.
    - `delay_range` adds a random 1–3 s pause after each request to mimic
      human cadence and reduce rate-limit risk.
    """
    from instagrapi import Client

    cl = Client()

    # Reuse stable device fingerprint (UUIDs, device_id, locale, etc.)
    if bundle.instagrapi_settings:
        cl.set_settings(bundle.instagrapi_settings)

    # Always apply the captured User-Agent for consistency.
    cl.set_settings({"user_agent": bundle.user_agent})

    # Random 1–3 s delay after every request — mimics human behaviour and
    # reduces the chance of hitting rate limits.
    cl.delay_range = [1, 3]

    # Bootstrap auth state via the sessionid. This is the instagrapi-recommended
    # path when you have a browser-captured sessionid but no password. It calls
    # /users/{id}/info/ internally which also acts as our session health check.
    cookie_jar = _cookies_to_jar(bundle.cookies)
    sessionid = cookie_jar.get("sessionid", "")
    if not sessionid:
        raise ValueError("No sessionid found in stored cookies — re-authentication required.")
    cl.login_by_sessionid(sessionid)

    return cl


def persist_device_settings(cl, bundle: SessionBundle, *, verbose: bool = False) -> SessionBundle:
    """
    Write instagrapi's generated device settings (UUIDs, device_id, etc.)
    back into the bundle so the same fingerprint is reused on the next run.
    Also captures the authenticated username from the client.
    Only logs when verbose=True (i.e. on first-time save after browser login).
    """
    try:
        settings = cl.get_settings()
        # Preserve the cookies / user_agent already in the bundle.
        settings.pop("cookies", None)
        settings.pop("user_agent", None)
        bundle.instagrapi_settings.update(settings)
        # Capture the username that login_by_sessionid() resolved.
        if getattr(cl, "username", None):
            bundle.username = cl.username
        SESSION_FILE.write_text(bundle.model_dump_json(indent=2), encoding="utf-8")
        if verbose:
            user_display = f" (@{bundle.username})" if bundle.username else ""
            print(f"[info] Session saved to {SESSION_FILE}{user_display}")
    except Exception as exc:
        print(f"[warn] Could not persist device settings: {exc}")
    return bundle


def _session_cookie_expired(bundle: SessionBundle) -> bool:
    """
    Fast local check: return True if the sessionid cookie's expiry timestamp
    is in the past.  If no expiry is recorded we assume it's still live.
    """
    now = int(time.time())
    for cookie in bundle.cookies:
        if cookie.name == "sessionid" and cookie.expiry is not None:
            if cookie.expiry < now:
                return True
    return False



def get_authenticated_client():
    """
    Return an authenticated instagrapi Client.

    Decision tree:
      1. No session.json                          → browser login
      2. sessionid cookie locally expired         → browser login (no network)
      3. login_by_sessionid() raises auth error   → browser login
      4. All good                                 → reuse session (no browser)

    `build_client()` calls `login_by_sessionid()` which fetches the current
    user's info as its internal validation step, so no separate health_check
    call is needed. Device settings are persisted back to session.json after
    every successful load so the same fingerprint is reused.
    """
    from instagrapi.exceptions import (
        ChallengeRequired,
        ClientThrottledError,
        LoginRequired,
        PleaseWaitFewMinutes,
        RateLimitError,
    )

    bundle = load_session()

    if bundle is not None:
        # ── Step 1: local expiry gate (free, no network) ──────────────────
        if _session_cookie_expired(bundle):
            print("[warn] sessionid cookie has expired. Re-authenticating…")
            delete_session()
            bundle = None
        else:
            # ── Step 2: bootstrap + implicit session validation ───────────
            print("[info] Found existing session. Verifying…")
            try:
                cl = build_client(bundle)
                print("[info] Session is valid. Proceeding without browser.\n")
                persist_device_settings(cl, bundle, verbose=False)
                return cl
            except (LoginRequired,):
                print("[warn] Session rejected by Instagram. Re-authenticating…")
                delete_session()
                bundle = None
            except (ClientThrottledError, PleaseWaitFewMinutes, RateLimitError):
                # Rate-limit during startup — session is probably fine; tell
                # the user to wait rather than triggering a re-login loop.
                print(COOLDOWN_MSG)
                sys.exit(1)
            except ChallengeRequired:
                print(CHALLENGE_MSG)
                delete_session()
                sys.exit(1)
            except Exception as exc:
                # Transient network error — keep the session but abort.
                print(f"[warn] Could not verify session (network error): {exc}")
                print("[info] Retrying with existing session anyway…\n")
                # Re-build without login_by_sessionid to avoid another network
                # call; fall through to attempt the search.
                from instagrapi import Client
                cl = Client()
                if bundle.instagrapi_settings:
                    cl.set_settings(bundle.instagrapi_settings)
                cl.set_settings({"cookies": _cookies_to_jar(bundle.cookies), "user_agent": bundle.user_agent})
                cl.delay_range = [1, 3]
                return cl

    # ── No valid session: open browser once and capture cookies ───────────
    bundle = browser_login()
    cl = build_client(bundle)
    persist_device_settings(cl, bundle, verbose=True)
    return cl


# ---------------------------------------------------------------------------
# Post normalisation helpers
# ---------------------------------------------------------------------------

def _str(val) -> Optional[str]:
    return str(val) if val is not None else None


def _normalize_media(m) -> PostResult:
    """Normalize an instagrapi Media object into a PostResult."""
    pk = _str(getattr(m, "pk", None))
    code = getattr(m, "code", None)
    media_type_int = getattr(m, "media_type", None)
    media_type = MEDIA_TYPE_MAP.get(media_type_int, "photo") if media_type_int else None

    thumb = getattr(m, "thumbnail_url", None)
    vid = getattr(m, "video_url", None)

    user = getattr(m, "user", None)
    username = getattr(user, "username", None) if user else None
    user_pk = _str(getattr(user, "pk", None)) if user else None
    is_verified = getattr(user, "is_verified", None) if user else None

    taken_at = getattr(m, "taken_at", None)
    taken_at_str = taken_at.isoformat() if taken_at and hasattr(taken_at, "isoformat") else _str(taken_at)

    return PostResult(
        pk=pk,
        code=code,
        url=f"https://www.instagram.com/p/{code}/" if code else None,
        media_type=media_type,
        thumbnail_url=str(thumb) if thumb else None,
        video_url=str(vid) if vid else None,
        caption=getattr(m, "caption_text", None),
        like_count=getattr(m, "like_count", None),
        comment_count=getattr(m, "comment_count", None),
        view_count=getattr(m, "view_count", None) or getattr(m, "play_count", None),
        taken_at=taken_at_str,
        username=username,
        user_pk=user_pk,
        is_verified=is_verified,
    )


def _normalize_reel_node(node: dict) -> Optional[PostResult]:
    """
    Normalize a raw reel node dict returned by fbsearch_reels_v2.
    The structure varies; we extract best-effort fields.
    """
    try:
        media = node.get("media", node)
        pk = _str(media.get("pk") or media.get("id"))
        code = media.get("code")
        user = media.get("user") or {}
        thumb_candidates = (
            media.get("image_versions2", {}).get("candidates", [{}])
        )
        thumb = thumb_candidates[0].get("url") if thumb_candidates else None
        vid_versions = media.get("video_versions", [{}])
        vid = vid_versions[0].get("url") if vid_versions else None
        caption_raw = media.get("caption") or {}
        caption = caption_raw.get("text") if isinstance(caption_raw, dict) else caption_raw

        return PostResult(
            pk=pk,
            code=code,
            url=f"https://www.instagram.com/p/{code}/" if code else None,
            media_type="video",
            thumbnail_url=thumb,
            video_url=vid,
            caption=caption,
            like_count=media.get("like_count"),
            comment_count=media.get("comment_count"),
            view_count=media.get("view_count") or media.get("play_count"),
            username=user.get("username"),
            user_pk=_str(user.get("pk")),
            is_verified=user.get("is_verified"),
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Primary search function
# ---------------------------------------------------------------------------

VALID_SEARCH_TYPES = ("top", "reel", "hashtag", "place")
DEFAULT_LIMIT = 100


def search_instagram(
    cl,
    query: str,
    search_type: str = "top",
    limit: int = DEFAULT_LIMIT,
) -> Dict[str, Any]:
    """
    Execute a personalized Instagram post search using the authenticated Client.

    Parameters
    ----------
    cl          : Authenticated instagrapi.Client instance.
    query       : Search query string.
    search_type : One of "top", "reel", "hashtag", "place".
                  - top      : keyword post search (photos + videos + carousels)
                  - reel     : reels-specific search
                  - hashtag  : top posts filed under the best-matching hashtag
                  - place    : location search (returns place names, not posts)
    limit       : Maximum number of results to return (default 100).

    Returns
    -------
    dict with keys: query, search_type, limit, results.
    """
    from instagrapi.exceptions import (
        AccountSuspended,
        ChallengeRequired,
        ClientConnectionError,
        ClientRequestTimeout,
        ClientThrottledError,
        FeedbackRequired,
        LoginRequired,
        PleaseWaitFewMinutes,
        RateLimitError,
        SentryBlock,
    )

    if search_type not in VALID_SEARCH_TYPES:
        raise ValueError(
            f"Invalid search_type '{search_type}'. "
            f"Choose from: {', '.join(VALID_SEARCH_TYPES)}"
        )

    if limit < 1:
        limit = DEFAULT_LIMIT

    results: List[PostResult] = []

    try:
        if search_type == "top":
            # Direct keyword → post search; returns photos, videos, carousels.
            raw = cl.media_search(query, amount=limit)
            results = [_normalize_media(m) for m in raw[:limit]]

        elif search_type == "reel":
            # Reels-specific search via fbsearch_reels_v2.
            raw_dict = cl.fbsearch_reels_v2(query)
            nodes = (
                raw_dict.get("reels_media", [])
                or raw_dict.get("items", [])
                or raw_dict.get("medias", [])
                or []
            )
            for node in nodes[:limit]:
                normalized = _normalize_reel_node(node)
                if normalized:
                    results.append(normalized)

        elif search_type == "hashtag":
            # Find matching hashtags, then pull top posts for the best one.
            tags = cl.search_hashtags(query)
            if not tags:
                print(f"[warn] No hashtags found for '{query}'")
            else:
                top_tag = tags[0].name
                print(f"[info] Using hashtag #{top_tag}")
                raw = cl.hashtag_medias_top(top_tag, amount=limit)
                results = [_normalize_media(m) for m in raw[:limit]]

        elif search_type == "place":
            # Place search — returns location names (not posts).
            from instagrapi.types import Location
            raw = cl.fbsearch_places(query)
            for p in raw[:limit]:
                pk = _str(getattr(p, "pk", None) or getattr(p, "facebook_places_id", None))
                results.append(PostResult(pk=pk, caption=getattr(p, "name", None), media_type="place"))

    except LoginRequired:
        # Session expired mid-search. Delete it so the next run triggers
        # browser re-authentication with the same device identity.
        delete_session()
        print(
            "\n[error] Session expired during search (LoginRequired).\n"
            "        session.json has been removed.\n"
            "        Re-run the script — a browser window will open to log in again."
        )
        sys.exit(1)

    except ChallengeRequired:
        # Do NOT rotate identity or delete session yet — the doc says to keep
        # the same device/session while resolving the challenge in the app.
        print(CHALLENGE_MSG)
        sys.exit(1)

    except (ClientThrottledError, RateLimitError):
        # HTTP 429 — current IP or request pattern is too aggressive right now.
        # This does NOT mean the session is broken; do not delete session.json.
        print(f"\n{COOLDOWN_MSG}")
        sys.exit(1)

    except PleaseWaitFewMinutes:
        # More serious than a plain 429 — Instagram is throttling at the account
        # level, not just the request level. Freeze for longer.
        print(
            f"\n{COOLDOWN_MSG}\n"
            "        PleaseWaitFewMinutes: this account needs a longer cooldown.\n"
            "        Consider waiting 30–60 minutes before retrying."
        )
        sys.exit(1)

    except FeedbackRequired:
        # An action was blocked or the account is temporarily restricted.
        # Surface Instagram's own message so the operator knows what happened.
        msg = _get_feedback_message(cl)
        print(
            "\n[error] Instagram blocked this action (FeedbackRequired).\n"
            f"        Instagram says: {msg or '(no message returned)'}\n"
            "        Stop repeating this search type for now and wait for the\n"
            "        restriction to clear before retrying."
        )
        sys.exit(1)

    except (AccountSuspended, SentryBlock):
        # Account-level block — requires manual investigation, not a retry.
        print(
            "\n[error] This Instagram account has been suspended or blocked.\n"
            "        Open the Instagram app and verify the account status manually."
        )
        sys.exit(1)

    except (ClientConnectionError, ClientRequestTimeout) as exc:
        # Pure network / transport errors — session is fine, just retry later.
        print(
            f"\n[error] Network error during search: {exc}\n"
            "        Check your internet connection and retry. The session is intact."
        )
        sys.exit(1)

    except Exception as exc:
        # Unexpected error — print it verbatim so it can be reported.
        print(f"\n[error] Search request failed unexpectedly: {exc}")
        sys.exit(1)

    return {
        "query": query,
        "search_type": search_type,
        "limit": limit,
        "results": [r.model_dump(exclude_none=True) for r in results],
    }


# ---------------------------------------------------------------------------
# JSON-RPC helpers (no Selenium — used by the Next.js server via lib/instagram.ts)
# ---------------------------------------------------------------------------

def build_client_from_settings(settings: dict):
    """
    Restore an instagrapi Client from a previously-saved get_settings() dict.
    The dict must contain 'authorization_data' with a valid sessionid.
    No browser or password needed.
    """
    from instagrapi import Client

    cl = Client()
    cl.set_settings(settings)
    cl.delay_range = [1, 3]
    # Restore username/user_id stashed by rpc_browser_login (no private-API call)
    if settings.get("_af_username"):
        cl.username = settings["_af_username"]
    if settings.get("_af_user_id") and str(settings["_af_user_id"]).isdigit():
        cl.user_id = int(settings["_af_user_id"])
    return cl


def _make_client() -> "Client":
    """
    Create an instagrapi Client, optionally routing through a residential proxy.

    Set INSTAGRAM_LOGIN_PROXY to a proxy URL to bypass datacenter IP blocks:
        http://user:pass@host:port       (HTTP proxy)
        socks5://user:pass@host:port     (SOCKS5 proxy)

    Residential proxy services: Brightdata, Oxylabs, SmartProxy, IPRoyal.
    Without a proxy, credential login from cloud datacenter IPs (Vercel, AWS, etc.)
    will be rate-limited or blocked by Instagram.
    """
    from instagrapi import Client
    proxy = os.environ.get("INSTAGRAM_LOGIN_PROXY", "").strip()
    cl = Client()
    cl.delay_range = [1, 3]
    if proxy:
        print(f"[ig] using proxy host={proxy.split('@')[-1] if '@' in proxy else proxy}", flush=True)
        cl.set_proxy(proxy)
    else:
        print("[ig] no INSTAGRAM_LOGIN_PROXY set — login may fail from datacenter IPs", flush=True)
    return cl


# Device settings captured when Instagram asks for a code, so the follow-up
# request can submit that code on the same device instead of starting over.
_pending_login_settings: Dict[str, Dict[str, Any]] = {}
_pending_verification_methods: Dict[str, List[str]] = {}
_last_challenge: Dict[str, dict] = {}
_last_attempt_at: Dict[str, float] = {}

_KNOWN_METHODS = ("app", "email", "sms", "totp", "unknown")


def _collect_keys(value: Any, depth: int = 0) -> List[str]:
    keys: List[str] = []
    if depth > 3:
        return keys
    if isinstance(value, dict):
        for key, child in value.items():
            keys.append(str(key))
            keys.extend(_collect_keys(child, depth + 1))
    elif isinstance(value, list):
        for child in value[:20]:
            keys.extend(_collect_keys(child, depth + 1))
    return keys


def _find_flag(value: Any, key: str) -> bool:
    if isinstance(value, dict):
        if key in value:
            flag = value[key]
            if isinstance(flag, bool):
                return flag
            if isinstance(flag, (int, float)):
                return bool(flag)
            if isinstance(flag, str):
                return flag.strip().lower() in {"1", "true", "yes"}
        return any(_find_flag(child, key) for child in value.values())
    if isinstance(value, list):
        return any(_find_flag(child, key) for child in value[:20])
    return False


def _find_text(value: Any, key: str) -> str:
    if isinstance(value, dict):
        if key in value and isinstance(value[key], str):
            return value[key]
        for child in value.values():
            found = _find_text(child, key)
            if found:
                return found
    elif isinstance(value, list):
        for child in value[:20]:
            found = _find_text(child, key)
            if found:
                return found
    return ""


def _methods_from_payload(payload: Any) -> List[str]:
    """Read the verification methods Instagram actually named. Never guess email."""
    text = json.dumps(payload, default=str).lower() if payload else ""
    step = _find_text(payload, "step_name").lower()
    methods: List[str] = []
    if _find_flag(payload, "totp_two_factor_on") or "enter_totp_code" in text or "totp" in step:
        methods.append("totp")
    if _find_flag(payload, "sms_two_factor_on") or "sms" in step or "whatsapp" in text:
        methods.append("sms")
    if any(marker in text for marker in (
        "delta_login_review",
        "challenge.redirect",
        "login_notification",
        "trusted_notification",
        "delta_acknowledge_approved",
    )):
        methods.append("app")
    if "verify_email" in text or "email" in step or _find_flag(payload, "email_two_factor_on"):
        methods.append("email")
    return methods


def _remember_methods(username: str, methods: List[str]) -> List[str]:
    cleaned = [method for method in methods if method in _KNOWN_METHODS]
    if not cleaned:
        cleaned = ["unknown"]
    _pending_verification_methods[username] = cleaned
    return cleaned


def _challenge_payload(username: str, methods: Optional[List[str]] = None) -> dict:
    methods = _remember_methods(username, methods or _pending_verification_methods.get(username, []))
    labels = {
        "app": "an approval in the Instagram app",
        "email": "an email code",
        "sms": "a text-message code",
        "totp": "an authenticator code",
        "unknown": "a confirmation Instagram did not name",
    }
    named = ", ".join(labels[method] for method in methods)
    payload = {
        "ok": False,
        "challenge_required": True,
        "verification_method": methods[0],
        "verification_methods": methods,
        "error": f"Instagram is asking for {named}.",
    }
    saved = _pending_login_settings.get(username)
    if isinstance(saved, dict):
        payload["pending_settings"] = saved
    _last_challenge[username] = payload
    return payload


def _remember_pending_login(username: str, client) -> None:
    try:
        _pending_login_settings[username] = client.get_settings()
    except Exception as e:
        print(f"[rpc_login] could not save pending settings: {type(e).__name__}", flush=True)


def rpc_login(
    username: str,
    password: str,
    poll: bool = False,
    pending_settings: Optional[dict] = None,
) -> dict:
    """
    Attempt direct instagrapi login (no Selenium).
    Returns the session settings dict on success so the caller can persist it.
    The password is NEVER included in the response or written to any file.
    """
    from instagrapi import Client
    from instagrapi.exceptions import (
        BadCredentials,
        BadPassword,
        ChallengeRequired,
        ClientThrottledError,
        FeedbackRequired,
        LoginRequired,
        PleaseWaitFewMinutes,
        RateLimitError,
        SentryBlock,
        TwoFactorRequired,
        UnknownError,
        UserNotFound,
    )

    now = time.time()
    if poll and now - _last_attempt_at.get(username, 0) < 5 and username in _last_challenge:
        return _last_challenge[username]

    cl = _make_client()
    saved = pending_settings or _pending_login_settings.get(username)
    if saved:
        cl.set_settings(saved)
        print(f"[rpc_login] reusing pending device settings for {username}", flush=True)

    def _decline_interactive_code(_username: str, choice) -> str:
        methods = _methods_from_payload(getattr(cl, "last_json", {}))
        if getattr(choice, "name", "") == "SMS":
            methods.append("sms")
        methods = _remember_methods(username, methods)
        keys = sorted(set(_collect_keys(getattr(cl, "last_json", {}))))[:40]
        print(f"[rpc_login] instagram methods={methods} choice={getattr(choice, 'name', choice)} keys={keys}", flush=True)
        return ""

    # Never block on input(). The app collects a code and also polls for an in-app approval.
    cl.challenge_code_handler = _decline_interactive_code
    _last_attempt_at[username] = now

    try:
        cl.login(username, password)
        settings = cl.get_settings()
        print(f"[rpc_login] success username={username}", flush=True)
        _pending_login_settings.pop(username, None)
        _pending_verification_methods.pop(username, None)
        _last_challenge.pop(username, None)
        return {
            "ok": True,
            "username": cl.username,
            "user_id": str(cl.user_id) if cl.user_id else None,
            "session": settings,
        }
    except (ChallengeRequired, EOFError) as e:
        methods = _methods_from_payload(getattr(cl, "last_json", {}))
        if "instagram app" in str(e).lower() or "checkpoint" in str(e).lower():
            methods.append("app")
        print(f"[rpc_login] verification required {type(e).__name__} methods={methods or _pending_verification_methods.get(username)}", flush=True)
        _remember_pending_login(username, cl)
        return _challenge_payload(username, methods)
    except TwoFactorRequired as e:
        print(f"[rpc_login] authenticator code required: {e}", flush=True)
        _remember_pending_login(username, cl)
        return _challenge_payload(username, ["totp"])
    except (BadPassword, BadCredentials, UserNotFound, LoginRequired) as e:
        print(f"[rpc_login] auth failed {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": "Authentication failed. Check your username and password."}
    except FeedbackRequired as e:
        print(f"[rpc_login] FeedbackRequired: {e}", flush=True)
        return {"ok": False, "error": "Instagram blocked this login attempt. Try again later or use the browser login."}
    except (ClientThrottledError, RateLimitError) as e:
        print(f"[rpc_login] rate-limited {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": "Instagram is rate-limiting login attempts. Wait 10–30 minutes and try again."}
    except (SentryBlock, PleaseWaitFewMinutes) as e:
        print(f"[rpc_login] blocked {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": "Instagram is temporarily blocking automated access. Wait a few minutes and try again."}
    except UnknownError as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"[rpc_login] UnknownError: {e}", flush=True)
        return {"ok": False, "error": f"Instagram returned an unexpected error: {e}"}
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"[rpc_login] unhandled {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": f"Login error: {type(e).__name__}: {e}"}


def rpc_login_by_sessionid(sessionid: str) -> dict:
    """
    Authenticate via Instagram web sessionid cookie (immune to mobile app version checks).
    The raw sessionid is NEVER stored — only the resulting instagrapi session settings.
    """
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, BadCredentials

    if not sessionid or len(sessionid) < 10:
        return {"ok": False, "error": "Invalid session ID."}

    cl = _make_client()
    try:
        cl.login_by_sessionid(sessionid)
        settings = cl.get_settings()
        print(f"[rpc_login_by_sessionid] success username={cl.username}", flush=True)
        return {
            "ok": True,
            "username": cl.username,
            "user_id": str(cl.user_id) if cl.user_id else None,
            "session": settings,
        }
    except (LoginRequired, BadCredentials) as e:
        print(f"[rpc_login_by_sessionid] invalid/expired {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": "Session ID is invalid or expired. Please get a fresh one from your browser cookies."}
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"[rpc_login_by_sessionid] unhandled {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": f"Login error: {type(e).__name__}: {e}"}


def rpc_browser_login(timeout_seconds: int = 300) -> dict:
    """
    Open a visible Chrome window so the user can log in to Instagram normally.

    After login we capture the browser cookies and build an instagrapi session
    directly — WITHOUT calling any private-API validation endpoints that would
    trigger the Instagram app-version check.  The raw cookies/sessionid are
    never stored; only the encrypted instagrapi session blob is persisted.
    """
    import re as _re
    import time
    from instagrapi import Client

    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.common.exceptions import WebDriverException, NoSuchElementException
    except ImportError:
        return {"ok": False, "error": "Selenium is not installed. Run: pip3 install selenium"}

    options = Options()
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--disable-infobars")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    try:
        driver = webdriver.Chrome(options=options)
    except WebDriverException as e:
        return {"ok": False, "error": f"Could not launch Chrome: {e}"}

    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"},
    )

    try:
        driver.get("https://www.instagram.com/accounts/login/")
        print(f"[browser_login] Browser opened — waiting up to {timeout_seconds}s for user to log in…", flush=True)

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            time.sleep(2)
            try:
                current_url = driver.current_url
                cookie_list = driver.get_cookies()
                cookies = {c["name"]: c["value"] for c in cookie_list}
                sessionid = cookies.get("sessionid", "")
                ds_user_id = cookies.get("ds_user_id", "")

                logged_in = (
                    sessionid
                    and ds_user_id
                    and "accounts/login" not in current_url
                    and "accounts/suspended" not in current_url
                    and "challenge" not in current_url
                )
                if not logged_in:
                    continue

                print("[browser_login] Login detected — extracting credentials from browser.", flush=True)

                # ── Get username from the page (no private-API call needed) ──
                username = None
                try:
                    # Try shared_data JSON embedded in the page
                    username = driver.execute_script(
                        "var d=window.__additionalDataLoaded||{};"
                        "return (window._sharedData||{}).config?.viewer?.username || null;"
                    )
                except Exception:
                    pass

                if not username:
                    try:
                        # Navigate to account edit page and read the username input
                        driver.get("https://www.instagram.com/accounts/edit/")
                        time.sleep(3)
                        el = driver.find_element(By.CSS_SELECTOR, 'input[name="username"]')
                        username = el.get_attribute("value") or None
                    except (NoSuchElementException, WebDriverException):
                        pass

                if not username:
                    # Last resort: extract numeric user_id from sessionid prefix
                    m = _re.match(r"^(\d+)", sessionid)
                    username = m.group(1) if m else ds_user_id

                driver.quit()

                # ── Build instagrapi session WITHOUT any private-API round-trip ──
                # set_settings() + init() wires up the HTTP client; we deliberately
                # skip login_by_sessionid() to avoid the version-gated user_info_v1 call.
                cl = Client()
                cl.delay_range = [1, 3]
                cl.set_settings({
                    "cookies": cookies,
                    "authorization_data": {
                        "ds_user_id": ds_user_id,
                        "sessionid": sessionid,
                        "should_use_header_over_cookies": "1",
                    },
                })
                cl.user_id = int(ds_user_id) if ds_user_id.isdigit() else 0
                cl.username = username

                settings = cl.get_settings()
                # Store username/user_id in the settings blob so we can recover them later
                settings["_af_username"] = username
                settings["_af_user_id"] = ds_user_id

                return {
                    "ok": True,
                    "username": username,
                    "user_id": ds_user_id,
                    "session": settings,
                }

            except WebDriverException:
                return {"ok": False, "error": "Browser window was closed before login completed."}

        driver.quit()
        return {"ok": False, "error": "Timed out waiting for Instagram login. Please try again."}

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        try:
            driver.quit()
        except Exception:
            pass
        return {"ok": False, "error": f"Browser login error: {type(e).__name__}: {e}"}


def rpc_challenge(
    username: str,
    password: str,
    code: str,
    pending_settings: Optional[dict] = None,
) -> dict:
    """
    Finish a login that asked for an email or SMS code.
    Reuses the device settings from the first attempt when they are still in memory.
    """
    cl = _make_client()
    saved = pending_settings or _pending_login_settings.get(username)
    if saved:
        cl.set_settings(saved)
        print(f"[rpc_challenge] reusing pending device settings for {username}", flush=True)
    cl.challenge_code_handler = lambda _u, _c: code

    try:
        cl.login(username, password, verification_code=code)
        settings = cl.get_settings()
        _pending_login_settings.pop(username, None)
        _pending_verification_methods.pop(username, None)
        _last_challenge.pop(username, None)
        return {
            "ok": True,
            "username": cl.username,
            "user_id": str(cl.user_id) if cl.user_id else None,
            "session": settings,
        }
    except Exception as e:
        print(f"[rpc_challenge] failed {type(e).__name__}: {e}", flush=True)
        return {"ok": False, "error": "Verification failed. Check the code and try again."}


def rpc_logout(session: dict) -> dict:
    """
    Best-effort logout — invalidates the session on Instagram's servers so the
    stored token can no longer be used even if the encrypted blob is compromised.
    Always returns ok=True; a logout failure is logged but never blocks disconnect.
    """
    from instagrapi import Client
    try:
        if not session:
            return {"ok": True, "note": "no session provided, skipping logout"}
        cl = Client()
        cl.set_settings(session)
        cl.logout()
        print("[rpc_logout] session invalidated on Instagram servers", flush=True)
        return {"ok": True}
    except Exception as e:
        # Best-effort: we still disconnect from our side regardless
        print(f"[rpc_logout] best-effort logout failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return {"ok": True, "warning": f"Could not confirm logout: {type(e).__name__}"}


# ---------------------------------------------------------------------------
# Reel transcription engine
# ---------------------------------------------------------------------------

# ffmpeg binary: prefer static-ffmpeg's bundled binary, fall back to PATH.
_FFMPEG: Optional[str] = None
_FFMPEG_LOCK = threading.Lock()


def _get_ffmpeg() -> str:
    global _FFMPEG
    if _FFMPEG:
        return _FFMPEG
    with _FFMPEG_LOCK:
        if _FFMPEG:
            return _FFMPEG
        try:
            import static_ffmpeg
            static_ffmpeg.add_paths()
            _FFMPEG = "ffmpeg"
            print("[transcribe] Using static-ffmpeg binary", flush=True)
        except ImportError:
            # Fall back to system ffmpeg
            _FFMPEG = "ffmpeg"
            print("[transcribe] static-ffmpeg not installed, using system ffmpeg", flush=True)
        return _FFMPEG


# Faster-Whisper model cache — loaded once per process, reused across requests.
_WHISPER_MODEL = None
_WHISPER_MODEL_NAME: Optional[str] = None
_WHISPER_LOCK = threading.Lock()

# ffmpeg audio denoise filter chain for voice clarity.
# highpass: remove low-frequency hum/rumble below 80 Hz
# lowpass:  remove high-frequency hiss above 8 kHz (keeps voice band)
# afftdn:   FFT-based spectral noise reduction (-25 dB floor)
# dynaudnorm: dynamic loudness normalization so quiet speech is audible
_DENOISE_FILTER = "highpass=f=80,lowpass=f=8000,afftdn=nf=-25,dynaudnorm=f=200:g=15"
_DENOISE_FILTER_SIMPLE = "highpass=f=80,lowpass=f=8000,dynaudnorm=f=200:g=15"


def _get_whisper_model():
    """Load and cache the Faster-Whisper model. Thread-safe."""
    global _WHISPER_MODEL, _WHISPER_MODEL_NAME
    model_name = os.environ.get("WHISPER_MODEL", "medium")
    with _WHISPER_LOCK:
        if _WHISPER_MODEL is None or _WHISPER_MODEL_NAME != model_name:
            print(f"[whisper] Loading model={model_name} (this may take a while on first run)...", flush=True)
            try:
                from faster_whisper import WhisperModel
                model_dir = os.environ.get("WHISPER_MODEL_DIR", "/tmp/whisper_models")
                _WHISPER_MODEL = WhisperModel(
                    model_name,
                    device="cpu",
                    compute_type="int8",
                    download_root=model_dir,
                )
                _WHISPER_MODEL_NAME = model_name
                print(f"[whisper] Model ready: {model_name}", flush=True)
            except Exception as exc:
                print(f"[whisper] Failed to load model {model_name}: {exc}", file=sys.stderr, flush=True)
                raise
    return _WHISPER_MODEL


def preload_whisper_model() -> None:
    """Call at worker startup to warm the model before the first request arrives."""
    if not os.environ.get("WHISPER_MODEL"):
        return
    try:
        from faster_whisper import WhisperModel  # noqa: F401 — check installable
        _get_whisper_model()
    except Exception:
        pass  # Non-fatal: model will be loaded on first transcription request


def _upload_to_supabase_storage(
    data: bytes,
    bucket: str,
    object_path: str,
    content_type: str,
    supabase_url: str,
    supabase_key: str,
) -> None:
    """Upload bytes to Supabase Storage via REST API (POST with x-upsert)."""
    url = f"{supabase_url}/storage/v1/object/{bucket}/{object_path}"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {supabase_key}")
    req.add_header("Content-Type", content_type)
    req.add_header("x-upsert", "true")
    try:
        with urllib.request.urlopen(req, timeout=120):
            pass
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"Supabase Storage upload failed HTTP {exc.code}: {body}") from exc


def _run_ffmpeg(args: List[str], timeout: int = 120) -> subprocess.CompletedProcess:
    ffmpeg = _get_ffmpeg()
    return subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error"] + args,
        capture_output=True,
        timeout=timeout,
    )


def transcribe_reel(
    video_url: str,
    post_code: str,
    user_id: str,
    supabase_url: str = "",
    supabase_key: str = "",
) -> TranscriptResult:
    """
    Pipeline: download reel audio → denoise → Faster-Whisper → upload to Supabase Storage.

    Audio is extracted as 16 kHz mono WAV for optimal Whisper accuracy,
    denoised with ffmpeg's FFT-based filter chain, then encoded as MP3 for storage.
    Transcription uses beam_size=5 + VAD + word-level timestamps for maximum fidelity.

    Raises on hard failure (e.g. download error, model not installed).
    Individual upload failures are logged but don't raise.
    """
    model_name = os.environ.get("WHISPER_MODEL", "medium")
    bucket = "reel-artifacts"

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        raw_wav = tmp / "raw.wav"
        denoised_wav = tmp / "denoised.wav"
        denoised_mp3 = tmp / "audio.mp3"

        # ── Step 1: Download reel and extract audio as 16 kHz mono WAV ──────
        print(f"[transcribe] {post_code}: downloading audio", flush=True)
        dl = _run_ffmpeg(
            ["-i", video_url,
             "-vn",                    # audio only — skip video stream
             "-acodec", "pcm_s16le",   # raw 16-bit PCM
             "-ar", "16000",           # 16 kHz — Whisper's native rate
             "-ac", "1",               # mono
             str(raw_wav)],
            timeout=120,
        )
        if dl.returncode != 0:
            err = dl.stderr.decode("utf-8", errors="replace")[-400:]
            raise RuntimeError(f"Audio download failed (ffmpeg rc={dl.returncode}): {err}")

        # ── Step 2: Denoise with ffmpeg filter chain ─────────────────────────
        print(f"[transcribe] {post_code}: denoising audio", flush=True)
        dn = _run_ffmpeg(
            ["-i", str(raw_wav),
             "-af", _DENOISE_FILTER,
             "-ar", "16000", "-ac", "1",
             str(denoised_wav)],
            timeout=60,
        )
        if dn.returncode != 0:
            # afftdn may not be available in all builds — fall back to simpler chain
            print(f"[transcribe] {post_code}: full denoise filter failed, trying simpler chain", flush=True)
            dn2 = _run_ffmpeg(
                ["-i", str(raw_wav),
                 "-af", _DENOISE_FILTER_SIMPLE,
                 "-ar", "16000", "-ac", "1",
                 str(denoised_wav)],
                timeout=60,
            )
            if dn2.returncode != 0:
                print(f"[transcribe] {post_code}: denoise failed entirely, using raw audio", flush=True)
                denoised_wav = raw_wav  # type: ignore[assignment]

        # ── Step 3: Encode denoised WAV → MP3 for storage ───────────────────
        print(f"[transcribe] {post_code}: encoding MP3", flush=True)
        mp3 = _run_ffmpeg(
            ["-i", str(denoised_wav),
             "-acodec", "libmp3lame",
             "-b:a", "128k",
             str(denoised_mp3)],
            timeout=60,
        )
        mp3_ok = mp3.returncode == 0 and denoised_mp3.exists()

        # ── Step 4: Transcribe with Faster-Whisper ───────────────────────────
        print(f"[transcribe] {post_code}: running Faster-Whisper model={model_name}", flush=True)
        model = _get_whisper_model()
        segments_iter, info = model.transcribe(
            str(denoised_wav),
            beam_size=5,
            vad_filter=True,           # Voice Activity Detection removes silence/noise
            word_timestamps=True,      # per-word timing for high-fidelity output
            language=None,             # auto-detect
        )

        segments: List[Dict[str, Any]] = []
        text_parts: List[str] = []
        for seg in segments_iter:
            seg_d: Dict[str, Any] = {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
            }
            if seg.words:
                seg_d["words"] = [
                    {
                        "word": w.word,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        "prob": round(w.probability, 3),
                    }
                    for w in seg.words
                ]
            segments.append(seg_d)
            if seg.text.strip():
                text_parts.append(seg.text.strip())

        transcript_text = " ".join(text_parts)
        word_count = len(transcript_text.split()) if transcript_text else 0
        duration = round(info.duration, 2)
        language = info.language

        print(
            f"[transcribe] {post_code}: done lang={language} dur={duration}s words={word_count}",
            flush=True,
        )

        # ── Step 5: Upload artifacts to Supabase Storage ─────────────────────
        audio_path: Optional[str] = None
        transcript_path: Optional[str] = None

        if supabase_url and supabase_key:
            # Upload MP3
            if mp3_ok:
                try:
                    audio_obj = f"{user_id}/{post_code}/audio.mp3"
                    _upload_to_supabase_storage(
                        denoised_mp3.read_bytes(),
                        bucket, audio_obj, "audio/mpeg",
                        supabase_url, supabase_key,
                    )
                    audio_path = audio_obj
                    print(f"[transcribe] {post_code}: uploaded audio → {audio_obj}", flush=True)
                except Exception as exc:
                    print(f"[transcribe] {post_code}: audio upload failed: {exc}", file=sys.stderr, flush=True)

            # Upload transcript JSON
            try:
                transcript_payload = {
                    "language": language,
                    "duration": duration,
                    "model": model_name,
                    "word_count": word_count,
                    "segments": segments,
                }
                t_obj = f"{user_id}/{post_code}/transcript.json"
                _upload_to_supabase_storage(
                    json.dumps(transcript_payload, ensure_ascii=False, indent=2).encode("utf-8"),
                    bucket, t_obj, "application/json",
                    supabase_url, supabase_key,
                )
                transcript_path = t_obj
                print(f"[transcribe] {post_code}: uploaded transcript → {t_obj}", flush=True)
            except Exception as exc:
                print(f"[transcribe] {post_code}: transcript upload failed: {exc}", file=sys.stderr, flush=True)
        else:
            print(f"[transcribe] {post_code}: SUPABASE_URL/KEY not set — skipping artifact upload", flush=True)

        return TranscriptResult(
            text=transcript_text,
            language=language,
            duration_seconds=duration,
            word_count=word_count,
            model=model_name,
            audio_storage_path=audio_path,
            transcript_storage_path=transcript_path,
            segments=segments,
        )


def rpc_search(payload: dict) -> dict:
    """
    Run a search using a caller-supplied session dict (pre-decrypted by TypeScript).
    Never touches session.json or any file in RPC mode.
    """
    session = payload.get("session")
    query = str(payload.get("query", "")).strip()
    search_type = str(payload.get("search_type", "top"))
    limit = int(payload.get("limit", DEFAULT_LIMIT))
    transcribe = bool(payload.get("transcribe", False))
    user_id = str(payload.get("user_id", "")).strip()

    if not session:
        return {
            "ok": False,
            "error": "No Instagram session found. Connect your Instagram account first.",
        }
    if not query:
        return {"ok": False, "error": "query is required."}

    cl = build_client_from_settings(session)
    try:
        output = search_instagram(cl, query=query, search_type=search_type, limit=limit)
        results: List[Dict[str, Any]] = output.get("results", [])

        # ── Transcription stage ───────────────────────────────────────────────
        # Only runs when transcribe=True + user_id are sent in the payload.
        # Capped at WHISPER_MAX_REELS per search to keep latency predictable.
        if transcribe and user_id:
            supabase_url = (
                os.environ.get("SUPABASE_URL", "")
                or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
            ).rstrip("/")
            supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
            max_reels = int(os.environ.get("WHISPER_MAX_REELS", "5"))

            video_count = 0
            for r in results:
                if video_count >= max_reels:
                    break
                if r.get("media_type") != "video":
                    continue
                video_url = r.get("video_url")
                post_code = r.get("code")
                if not video_url or not post_code:
                    continue

                try:
                    t = transcribe_reel(
                        video_url=video_url,
                        post_code=post_code,
                        user_id=user_id,
                        supabase_url=supabase_url,
                        supabase_key=supabase_key,
                    )
                    r["transcript"] = t.model_dump(exclude_none=True)
                except Exception as exc:
                    print(
                        f"[transcribe] {post_code}: failed: {type(exc).__name__}: {exc}",
                        file=sys.stderr, flush=True,
                    )
                    r["transcript"] = {"text": "", "error": f"{type(exc).__name__}: {exc}"}

                video_count += 1

        return {"ok": True, **output, "results": results}
    except SystemExit:
        # search_instagram calls sys.exit() on rate-limit / auth errors.
        # Convert to an RPC failure so the caller gets a JSON response.
        return {"ok": False, "error": "Search failed. Check session validity or wait before retrying."}
    except Exception as exc:
        return {"ok": False, "error": f"Search failed: {exc}"}


def handle_json_rpc() -> None:
    """
    JSON-RPC entry point.

    Reads one JSON object from stdin, dispatches to rpc_login / rpc_challenge /
    rpc_search, and writes exactly one JSON object to stdout.

    All log/print output from inner functions is redirected to stderr so the
    caller (lib/instagram.ts) can safely parse stdout as pure JSON.
    """
    # Redirect existing print() calls to stderr for this session.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    result: dict = {"ok": False, "error": "Internal error."}
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        cmd = payload.get("cmd")

        if cmd == "login":
            result = rpc_login(
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                poll=bool(payload.get("poll")),
                pending_settings=payload.get("pending_settings"),
            )
        elif cmd == "login_by_sessionid":
            result = rpc_login_by_sessionid(str(payload.get("sessionid", "")))
        elif cmd == "browser_login":
            result = rpc_browser_login(int(payload.get("timeout_seconds", 300)))
        elif cmd == "challenge":
            result = rpc_challenge(
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                str(payload.get("code", "")),
                pending_settings=payload.get("pending_settings"),
            )
        elif cmd == "search":
            result = rpc_search(payload)
        else:
            result = {"ok": False, "error": f"Unknown RPC command: {cmd!r}"}

    except json.JSONDecodeError:
        result = {"ok": False, "error": "Invalid JSON on stdin."}
    except SystemExit:
        # Catch any sys.exit() from inner functions and convert to JSON error.
        pass
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        result = {"ok": False, "error": f"Unexpected error: {type(e).__name__}: {e}"}
    finally:
        sys.stdout = real_stdout
        print(json.dumps(result, default=str), flush=True)


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="instagram_search",
        description=(
            "Instagram search tool.\n"
            "Pass --json-rpc to use the server-side JSON-RPC mode (no browser).\n"
            "Otherwise, searches via a persisted local session."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python instagram_search.py "coffee shops" --type top
  python instagram_search.py "travel" --type hashtag
  python instagram_search.py "New York" --type place
""",
    )
    parser.add_argument(
        "query",
        nargs="?",
        default=None,
        help="Search query (e.g. 'coffee shops', 'travel').",
    )
    parser.add_argument(
        "--json-rpc",
        action="store_true",
        help="Read a JSON command from stdin and write a JSON response to stdout (server mode).",
    )
    parser.add_argument(
        "--type",
        dest="search_type",
        choices=VALID_SEARCH_TYPES,
        default="top",
        help=(
            "Search mode: top (default) = keyword post search, "
            "reel = reels only, hashtag = top posts under best-matching tag, "
            "place = location names."
        ),
    )
    parser.add_argument(
        "--limit",
        dest="limit",
        type=int,
        default=DEFAULT_LIMIT,
        metavar="N",
        help=f"Maximum number of results to return (default: {DEFAULT_LIMIT}).",
    )
    parser.add_argument(
        "--reset-session",
        action="store_true",
        help="Delete the stored session and force a fresh browser login.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # ── JSON-RPC mode (used by Next.js server via lib/instagram.ts) ──────────
    if args.json_rpc:
        handle_json_rpc()
        return

    # ── CLI mode (local development / manual testing) ─────────────────────────
    if not args.query:
        parser.error("query is required in CLI mode (or use --json-rpc).")

    if args.reset_session:
        delete_session()
        print("[info] Session reset. A fresh browser login will be triggered.\n")

    cl = get_authenticated_client()
    output = search_instagram(cl, query=args.query, search_type=args.search_type, limit=args.limit)

    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
