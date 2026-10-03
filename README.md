# AgenticFruit MVP

A Next.js web app paired with a Python-based Instagram search pipeline that finds viral content formats aligned to brand goals.

---

## Instagram Search CLI

`instagram_search.py` is a standalone Python CLI that executes **personalized** Instagram searches by piggybacking on a real, logged-in browser session. Searches hit Instagram's private API endpoints, so results reflect your account's social graph and affinity—not generic public results.

### How it works

```
First run                               Subsequent runs
──────────────────────────────────      ──────────────────────────────────
1. Open Chrome (Selenium)               1. Read session.json
2. Navigate to Instagram login          2. Inject cookies + User-Agent into
3. You log in manually (2FA / CAPTCHA      an instagrapi Client
   handled in the browser)              3. Validate session health (1 HTTP req)
4. Script detects sessionid cookie      4. Run search query via instagrapi
5. Saves cookies + User-Agent to           private endpoint (pure HTTP)
   session.json; closes browser         5. Print structured JSON results
6. Run search query
```

> **No username or password is ever typed into the terminal or stored in any file.**

---

### Setup

**Requirements:** Python 3.10+, Google Chrome installed.

```bash
# 1. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate       # macOS / Linux
# .venv\Scripts\activate        # Windows

# 2. Install dependencies
pip install -r requirements.txt
```

---

### First run – browser login

The first time you run any search command, a Chrome window opens automatically. Log in to your Instagram account (including any 2FA or CAPTCHA steps). The window closes itself once login is detected and the session is saved locally.

```bash
python instagram_search.py "coffee shops"
```

Expected console output (first run):

```
[auth] Starting browser-based login…
[auth] A Chrome window will open. Please log in to Instagram.
[auth] Handle any 2FA or CAPTCHA prompts in the browser.
[auth] Waiting up to 5 minutes for login…

[auth] Login detected. Closing browser…
[info] Session saved to session.json
```

---

### Subsequent runs – pure HTTP (no browser)

After the first run, `session.json` stores the session. All subsequent calls skip the browser entirely and issue direct HTTPS requests to Instagram's private API.

```
[info] Found existing session. Verifying…
[info] Session is valid. Proceeding without browser.
```

---

### CLI usage

```
python instagram_search.py QUERY [--type {top,user,hashtag,place}] [--reset-session]
```

| Argument | Default | Description |
|---|---|---|
| `QUERY` | *(required)* | Search query string |
| `--type` | `top` | Search mode: `top`, `user`, `hashtag`, or `place` |
| `--reset-session` | off | Delete stored session and force a fresh browser login |

#### Examples

```bash
# Blended top results (personalized users + hashtags)
python instagram_search.py "coffee shops"

# User search
python instagram_search.py "nike" --type user

# Hashtag search
python instagram_search.py "travel" --type hashtag

# Place / location search
python instagram_search.py "New York" --type place

# Force re-authentication (e.g. after account password change)
python instagram_search.py "nike" --type user --reset-session
```

---

### Output format

Results are printed as structured JSON:

```json
{
  "query": "nike",
  "search_type": "user",
  "results": [
    {
      "pk": "19021285",
      "username": "nike",
      "full_name": "Nike",
      "is_private": false,
      "is_verified": true,
      "profile_pic_url": "https://…",
      "follower_count": 302000000
    }
  ]
}
```

| Field | Present for |
|---|---|
| `pk` / `id` | all types |
| `username` | user, top |
| `full_name` | user, top |
| `tag_name` / `name` | hashtag, place |
| `is_private` | user, top |
| `is_verified` | user, top |
| `profile_pic_url` | user, top |
| `follower_count` | user, top (when available) |

---

### Session management

| File | Purpose |
|---|---|
| `session.json` | Stores cookies, User-Agent, and instagrapi device settings. **Do not commit this file.** |

`session.json` is already listed in `.gitignore` patterns for sensitive files. If your session expires (Instagram invalidates the cookie), the script detects it automatically and re-opens Chrome for a fresh login.

---

### Error reference

| Message | Cause | Fix |
|---|---|---|
| `LoginRequired` | Session cookie expired | Run with `--reset-session` |
| `ChallengeRequired` | Instagram security challenge | Wait a few minutes, then run with `--reset-session` |
| `TimeoutError` (login) | Login not completed in 5 min | Re-run the script and log in faster |
| Network errors | Rate limit or connectivity | Wait and retry |
