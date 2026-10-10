"""
Instagram Worker Server
-----------------------
Standalone FastAPI server that wraps instagram_search.py.
Deploy on any non-datacenter IP (Fly.io, Railway, DigitalOcean, etc.)
so Instagram doesn't block login attempts.

Next.js on Vercel sets INSTAGRAM_API_URL=https://<this-worker>/rpc
and all Instagram API calls route through here.

Auth: WORKER_SECRET env var — must match the same var in Vercel.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# instagram_search.py lives one level up (monorepo root)
_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_root))

import instagram_search as ig
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
import uvicorn

WORKER_SECRET = os.environ.get("WORKER_SECRET", "").strip()

app = FastAPI(title="Instagram Worker", docs_url=None, redoc_url=None)


# ── Auth dependency ───────────────────────────────────────────────────────────

def verify_secret(request: Request):
    if WORKER_SECRET:
        incoming = request.headers.get("X-Worker-Secret", "")
        if incoming != WORKER_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/")
@app.get("/rpc")
async def health():
    return {"ok": True, "service": "instagram-worker"}


# ── Main RPC endpoint ─────────────────────────────────────────────────────────

@app.post("/rpc", dependencies=[Depends(verify_secret)])
async def rpc(request: Request):
    try:
        payload: dict = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON body"}, status_code=400)

    cmd = payload.get("cmd", "")
    print(f"[worker] cmd={cmd}", flush=True)

    try:
        if cmd == "login":
            result = ig.rpc_login(
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                poll=bool(payload.get("poll")),
            )
        elif cmd == "login_by_sessionid":
            result = ig.rpc_login_by_sessionid(str(payload.get("sessionid", "")))
        elif cmd == "challenge":
            result = ig.rpc_challenge(
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                str(payload.get("code", "")),
            )
        elif cmd == "logout":
            result = ig.rpc_logout(payload.get("session", {}))
        elif cmd == "search":
            result = ig.rpc_search(payload)
        elif cmd == "browser_login":
            result = {
                "ok": False,
                "error": "Browser login is not available on the worker server. Use credentials or session ID.",
            }
        else:
            result = {"ok": False, "error": f"Unknown command: {cmd!r}"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        result = {"ok": False, "error": f"Worker error: {type(e).__name__}: {e}"}

    print(f"[worker] result ok={result.get('ok')} error={result.get('error', '')[:100]}", flush=True)
    return JSONResponse(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
