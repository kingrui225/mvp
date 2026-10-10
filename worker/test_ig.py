"""Quick IP test — run with: railway run python3 worker/test_ig.py"""
import subprocess, sys

# Install instagrapi in Railway's environment
subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'instagrapi', '-q'])

from instagrapi import Client
from instagrapi.exceptions import (
    ClientThrottledError, RateLimitError, FeedbackRequired,
    ChallengeRequired, SentryBlock, PleaseWaitFewMinutes, BadPassword,
)

USERNAME = "agenticfruit_usa"
PASSWORD = input("Instagram password: ")

print(f"\nTesting Instagram login from Railway IP...")
cl = Client()
cl.delay_range = [1, 3]

try:
    cl.login(USERNAME, PASSWORD)
    print(f"\n✅ SUCCESS — Railway IPs work! Username: {cl.username}")
except (ClientThrottledError, RateLimitError) as e:
    print(f"\n❌ RATE LIMITED — Railway IPs blocked: {type(e).__name__}")
    print(f"   {e}")
except ChallengeRequired as e:
    print(f"\n⚠️  CHALLENGE REQUIRED — Instagram wants verification code")
    print(f"   This means the IP works but needs 2FA (good sign!)")
    print(f"   {e}")
except FeedbackRequired as e:
    print(f"\n❌ FEEDBACK REQUIRED — Account flagged: {e}")
except SentryBlock as e:
    print(f"\n❌ SENTRY BLOCK — IP is banned: {e}")
except PleaseWaitFewMinutes as e:
    print(f"\n❌ WAIT — Rate limiting: {e}")
except BadPassword as e:
    print(f"\n⚠️  BAD PASSWORD — IP works but wrong password: {e}")
except Exception as e:
    print(f"\n❓ OTHER ERROR ({type(e).__name__}): {e}")
