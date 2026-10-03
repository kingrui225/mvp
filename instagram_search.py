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

from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CookieEntry(BaseModel):
    """Represents a single browser cookie."""

    name: str
    value: str
    domain: str = ""
    path: str = "/"
    secure: bool = False
    http_only: bool = False
    expiry: Optional[int] = None

    class Config:
        extra = "allow"


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


class SearchResult(BaseModel):
    """Normalised representation of a single search hit."""

    pk: Optional[str] = None
    username: Optional[str] = None
    name: Optional[str] = None
    tag_name: Optional[str] = None
    full_name: Optional[str] = None
    is_private: Optional[bool] = None
    is_verified: Optional[bool] = None
    profile_pic_url: Optional[str] = None
    follower_count: Optional[int] = None


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


def save_session(bundle: SessionBundle) -> None:
    SESSION_FILE.write_text(
        bundle.model_dump_json(indent=2), encoding="utf-8"
    )
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


def persist_device_settings(cl, bundle: SessionBundle) -> SessionBundle:
    """
    After building the client, persist its generated device settings back into
    the bundle so subsequent runs reuse the same device fingerprint.
    """
    try:
        settings = cl.get_settings()
        # Preserve the cookies / user_agent already in the bundle.
        settings.pop("cookies", None)
        settings.pop("user_agent", None)
        bundle.instagrapi_settings.update(settings)
        save_session(bundle)
    except Exception as exc:
        print(f"[warn] Could not persist device settings: {exc}")
    return bundle


def health_check(cl) -> bool:
    """
    Validate the session with a low-friction authenticated request.
    Returns True if valid, False if the session has expired.
    """
    from instagrapi.exceptions import ChallengeRequired, LoginRequired

    try:
        # `get_timeline_feed` is among the lightest authenticated calls and
        # is used internally by instagrapi to verify sessions.
        cl.get_timeline_feed()
        return True
    except (LoginRequired, ChallengeRequired):
        return False
    except Exception as exc:
        # Network or other transient errors are not treated as session invalidity.
        print(f"[warn] Health check encountered an unexpected error: {exc}")
        return True  # Optimistic—don't nuke the session on transient failures.


def get_authenticated_client():
    """
    Return an authenticated instagrapi Client.
    - Loads session.json if present and valid.
    - Falls back to browser-based login when necessary.
    - Persists updated device settings after successful auth.
    """
    bundle = load_session()

    if bundle is not None:
        print("[info] Found existing session. Verifying…")
        cl = build_client(bundle)
        if health_check(cl):
            print("[info] Session is valid. Proceeding without browser.\n")
            bundle = persist_device_settings(cl, bundle)
            return cl
        else:
            print("[warn] Session expired or invalid. Re-authenticating…")
            delete_session()
            bundle = None

    # No valid session—run browser login.
    bundle = browser_login()
    cl = build_client(bundle)
    bundle = persist_device_settings(cl, bundle)
    save_session(bundle)
    return cl


# ---------------------------------------------------------------------------
# Search normalization helpers
# ---------------------------------------------------------------------------

def _str(val) -> Optional[str]:
    return str(val) if val is not None else None


def _normalize_user(u) -> SearchResult:
    """Normalize an instagrapi UserShort / User object."""
    pic = getattr(u, "profile_pic_url", None)
    return SearchResult(
        pk=_str(getattr(u, "pk", None)),
        username=getattr(u, "username", None),
        full_name=getattr(u, "full_name", None),
        is_private=getattr(u, "is_private", None),
        is_verified=getattr(u, "is_verified", None),
        profile_pic_url=str(pic) if pic else None,
        follower_count=getattr(u, "follower_count", None),
    )


def _normalize_hashtag(h) -> SearchResult:
    """Normalize an instagrapi Hashtag object."""
    return SearchResult(
        pk=_str(getattr(h, "id", None)),
        tag_name=getattr(h, "name", None),
        name=getattr(h, "name", None),
    )


def _normalize_place(p) -> SearchResult:
    """Normalize an instagrapi Location / Place object."""
    return SearchResult(
        pk=_str(getattr(p, "pk", None) or getattr(p, "facebook_places_id", None)),
        name=getattr(p, "name", None),
    )


# ---------------------------------------------------------------------------
# Primary search function
# ---------------------------------------------------------------------------

VALID_SEARCH_TYPES = ("top", "user", "hashtag", "place")


def search_instagram(
    cl,
    query: str,
    search_type: str = "top",
) -> Dict[str, Any]:
    """
    Execute a personalized Instagram search using the authenticated Client.

    Parameters
    ----------
    cl          : Authenticated instagrapi.Client instance.
    query       : Search query string.
    search_type : One of "top", "user", "hashtag", "place".

    Returns
    -------
    dict with keys: query, search_type, results (list of normalized hits).
    """
    from instagrapi.exceptions import ChallengeRequired, LoginRequired

    if search_type not in VALID_SEARCH_TYPES:
        raise ValueError(
            f"Invalid search_type '{search_type}'. "
            f"Choose from: {', '.join(VALID_SEARCH_TYPES)}"
        )

    results: List[SearchResult] = []

    try:
        if search_type == "user":
            raw = cl.search_users(query)
            results = [_normalize_user(u) for u in raw]

        elif search_type == "hashtag":
            raw = cl.search_hashtags(query)
            results = [_normalize_hashtag(h) for h in raw]

        elif search_type == "place":
            raw = cl.fbsearch_places(query)
            results = [_normalize_place(p) for p in raw]

        else:  # "top" — hit Instagram's personalized topsearch private endpoint
            raw = cl.search_users(query)
            users = [_normalize_user(u) for u in raw]

            try:
                hashtags = [_normalize_hashtag(h) for h in cl.search_hashtags(query)]
            except Exception:
                hashtags = []

            # Interleave: users first (personalized graph), then hashtags.
            results = users + hashtags

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
            "Search mode: top (default), user, hashtag, or place. "
            "'top' blends personalized users and hashtags."
        ),
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
    output = search_instagram(cl, query=args.query, search_type=args.search_type)

    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
