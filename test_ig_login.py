#!/usr/bin/env python3
import os
import json
import getpass
from instagrapi import Client
from instagrapi.exceptions import ChallengeRequired, TwoFactorRequired

def sanitize_last_json(last_json):
    if not isinstance(last_json, dict):
        return {"type": type(last_json).__name__}
    keep = {}
    for k in ("status", "message", "error_type", "error_title", "step_name"):
        v = last_json.get(k)
        if isinstance(v, str) and v:
            keep[k] = v
    keep["top_keys"] = sorted(last_json.keys())[:40]
    return keep

def main():
    username = "agenticfruit_usa"
    password = os.getenv("IG_PASSWORD") or getpass.getpass("IG password: ").strip()

    proxy = os.getenv("INSTAGRAM_LOGIN_PROXY", "").strip()
    code_env = os.getenv("IG_2FA_CODE", "").strip()

    cl = Client()
    cl.delay_range = [1, 3]
    if proxy:
        cl.set_proxy(proxy)
        print(f"[info] proxy set: {proxy.split('@')[-1]}")

    try:
        print("[info] logging in...")
        if code_env:
            ok = cl.login(username, password, verification_code=code_env)
        else:
            ok = cl.login(username, password)
        print("[ok] login result:", bool(ok))
    except TwoFactorRequired:
        print("[2fa] TwoFactorRequired: enter 6-digit authenticator or 8-digit backup code")
        code = input("Code: ").strip()
        try:
            ok = cl.login(username, password, verification_code=code)
            print("[ok] login with code:", bool(ok))
        except Exception as e:
            print("[err] code submit failed:", type(e).__name__, str(e))
    except ChallengeRequired:
        print("[challenge] ChallengeRequired: approve in app, then press Enter to retry")
        input("Press Enter after approval...")
        try:
            ok = cl.login(username, password)
            print("[ok] login after app approval:", bool(ok))
        except Exception as e:
            print("[err] retry failed:", type(e).__name__, str(e))
    except Exception as e:
        print("[err] login failed:", type(e).__name__, str(e))
    finally:
        print("[debug] last_json:")
        print(json.dumps(sanitize_last_json(getattr(cl, "last_json", {})), indent=2))

if __name__ == "__main__":
    main()