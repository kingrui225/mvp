"""
Vercel Python serverless function — Instagram RPC handler.

Deployed alongside the Next.js app at /api/ig.
Next.js API routes call this via HTTP when VERCEL=1.
Locally, instagram_search.py is spawned as a subprocess instead.

Auth: X-Worker-Secret header must match WORKER_SECRET env var.
"""
from __future__ import annotations

import json
import os
import sys

# On Vercel, instagram_search.py is bundled alongside this file via includeFiles.
# Locally, it lives one level up. Try both locations.
_here = os.path.dirname(os.path.abspath(__file__))
_parent = os.path.dirname(_here)
for _p in [_here, _parent]:
    if os.path.exists(os.path.join(_p, "instagram_search.py")):
        sys.path.insert(0, _p)
        break

import instagram_search as ig
from http.server import BaseHTTPRequestHandler

WORKER_SECRET = os.environ.get("WORKER_SECRET", "")


class handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # suppress default access logs

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send_json(200, {"ok": True, "service": "instagram-worker"})

    def do_POST(self):
        # Auth check
        incoming_secret = self.headers.get("X-Worker-Secret", "")
        secret_ok = (not WORKER_SECRET) or (incoming_secret == WORKER_SECRET)
        print(f"[ig.py] POST WORKER_SECRET_SET={bool(WORKER_SECRET)} SECRET_MATCH={secret_ok}", flush=True)
        if not secret_ok:
            print("[ig.py] 401 auth rejected", flush=True)
            self._send_json(401, {"ok": False, "error": "Unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid JSON body"})
            return

        cmd = payload.get("cmd", "")
        print(f"[ig.py] dispatching cmd={cmd}", flush=True)

        try:
            if cmd == "login":
                result = ig.rpc_login(
                    str(payload.get("username", "")),
                    str(payload.get("password", "")),
                )
            elif cmd == "login_by_sessionid":
                result = ig.rpc_login_by_sessionid(str(payload.get("sessionid", "")))
            elif cmd == "challenge":
                result = ig.rpc_challenge(
                    str(payload.get("username", "")),
                    str(payload.get("password", "")),
                    str(payload.get("code", "")),
                )
            elif cmd == "search":
                result = ig.rpc_search(payload)
            elif cmd == "browser_login":
                result = {
                    "ok": False,
                    "error": "Browser login is not available in the cloud environment. Please use Instagram credentials instead.",
                }
            else:
                result = {"ok": False, "error": f"Unknown command: {cmd!r}"}
        except Exception as e:
            import traceback
            traceback.print_exc()
            result = {"ok": False, "error": f"Worker error: {type(e).__name__}: {e}"}

        self._send_json(200, result)
