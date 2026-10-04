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
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, field_validator

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

    @field_validator("created_at", mode="before")
    @classmethod
    def default_created_at(cls, v: str) -> str:
        return v or datetime.now(timezone.utc).isoformat()


MEDIA_TYPE_MAP = {1: "photo", 2: "video", 8: "carousel"}


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


# ---------------------------------------------------------------------------
# Session store helpers
# ---------------------------------------------------------------------------

SESSION_FILE = Path(__file__).parent / "session.json"
REQUIRED_COOKIES = {"sessionid", "ds_user_id"}
POLL_INTERVAL_SEC = 2
POLL_TIMEOUT_SEC = 300


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


def browser_login() -> SessionBundle:
    """
    Open Instagram login page in Chrome and wait for the user to complete
    authentication manually. Returns a SessionBundle when the required cookies
    are detected.
    """
    print("\n[auth] Starting browser-based login…")
    print("[auth] A Chrome window will open. Please log in to Instagram.")
    print("[auth] Handle any 2FA or CAPTCHA prompts in the browser.")
    print(f"[auth] Waiting up to {POLL_TIMEOUT_SEC // 60} minutes for login…\n")

    driver = _build_chrome_driver()
    try:
        driver.get("https://www.instagram.com/accounts/login/")

        deadline = time.monotonic() + POLL_TIMEOUT_SEC
        while time.monotonic() < deadline:
            cookies = driver.get_cookies()
            cookie_names = {c["name"] for c in cookies}
            if REQUIRED_COOKIES.issubset(cookie_names):
                break
            time.sleep(POLL_INTERVAL_SEC)
        else:
            driver.quit()
            raise TimeoutError(
                f"Login not detected within {POLL_TIMEOUT_SEC} seconds. "
                "Please run the script again and complete login promptly."
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
        print("[auth] Login detected. Closing browser…")
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
    Device/UUID settings are merged from existing instagrapi_settings so the
    same device fingerprint is reused across runs.
    """
    from instagrapi import Client

    cl = Client()

    # Merge any previously persisted instagrapi settings first so UUIDs are stable.
    if bundle.instagrapi_settings:
        cl.set_settings(bundle.instagrapi_settings)

    # Inject the session cookies so instagrapi treats this as a logged-in client.
    cookie_jar = _cookies_to_jar(bundle.cookies)
    cl.set_settings(
        {
            "cookies": cookie_jar,
            "user_agent": bundle.user_agent,
        }
    )

    return cl


def persist_device_settings(cl, bundle: SessionBundle, *, verbose: bool = False) -> SessionBundle:
    """
    Write instagrapi's generated device settings (UUIDs, device_id, etc.)
    back into the bundle so the same fingerprint is reused on the next run.
    Only logs when verbose=True (i.e. on first-time save after browser login).
    """
    try:
        settings = cl.get_settings()
        # Preserve the cookies / user_agent already in the bundle.
        settings.pop("cookies", None)
        settings.pop("user_agent", None)
        bundle.instagrapi_settings.update(settings)
        SESSION_FILE.write_text(bundle.model_dump_json(indent=2), encoding="utf-8")
        if verbose:
            print(f"[info] Session saved to {SESSION_FILE}")
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


def health_check(cl) -> bool:
    """
    Validate the session with a minimal authenticated request.
    Uses /accounts/current_user/ (account_info) which is the lightest
    authenticated endpoint instagrapi exposes — much lighter than a feed fetch
    and less likely to trigger rate-limit or anti-bot responses.
    Returns True if valid, False if the session has expired or been revoked.
    """
    from instagrapi.exceptions import ChallengeRequired, LoginRequired

    try:
        cl.account_info()
        return True
    except (LoginRequired, ChallengeRequired):
        return False
    except Exception as exc:
        # Treat transient network / server errors as "session probably fine".
        print(f"[warn] Health check hit a transient error (will continue): {exc}")
        return True


def get_authenticated_client():
    """
    Return an authenticated instagrapi Client.

    Decision tree:
      1. No session.json              → browser login
      2. sessionid cookie expired     → browser login (local check, no network)
      3. Network health-check fails   → browser login
      4. All good                     → reuse session (no browser)

    Device settings (UUIDs, etc.) are written back to session.json after every
    successful load so the same fingerprint is reused across runs.
    """
    bundle = load_session()

    if bundle is not None:
        # ── Step 1: local expiry gate (free, no network) ──────────────────
        if _session_cookie_expired(bundle):
            print("[warn] sessionid cookie has expired. Re-authenticating…")
            delete_session()
            bundle = None
        else:
            # ── Step 2: lightweight network verification ───────────────────
            print("[info] Found existing session. Verifying…")
            cl = build_client(bundle)
            if health_check(cl):
                print("[info] Session is valid. Proceeding without browser.\n")
                # Persist any updated device settings quietly (no extra log).
                persist_device_settings(cl, bundle, verbose=False)
                return cl
            else:
                print("[warn] Session rejected by Instagram. Re-authenticating…")
                delete_session()
                bundle = None

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
    from instagrapi.exceptions import ChallengeRequired, LoginRequired

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
        print(
            "\n[error] Instagram requires re-authentication (LoginRequired).\n"
            "        Delete session.json and run the script again to log in."
        )
        sys.exit(1)
    except ChallengeRequired:
        print(
            "\n[error] Instagram issued a security challenge (ChallengeRequired).\n"
            "        Delete session.json, wait a few minutes, then re-run."
        )
        sys.exit(1)
    except Exception as exc:
        print(f"\n[error] Search request failed: {exc}")
        sys.exit(1)

    return {
        "query": query,
        "search_type": search_type,
        "limit": limit,
        "results": [r.model_dump(exclude_none=True) for r in results],
    }


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="instagram_search",
        description=(
            "Perform personalized Instagram searches using a persisted "
            "browser session. First run opens Chrome for manual login; "
            "subsequent runs are pure HTTP (no browser)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python instagram_search.py "coffee shops" --type top
  python instagram_search.py "nike" --type user
  python instagram_search.py "travel" --type hashtag
  python instagram_search.py "New York" --type place
""",
    )
    parser.add_argument(
        "query",
        help="Search query (e.g. 'coffee shops', 'nike', 'travel')",
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

    if args.reset_session:
        delete_session()
        print("[info] Session reset. A fresh browser login will be triggered.\n")

    cl = get_authenticated_client()
    output = search_instagram(cl, query=args.query, search_type=args.search_type, limit=args.limit)

    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
