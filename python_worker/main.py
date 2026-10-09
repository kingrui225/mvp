"""
FastAPI wrapper around instagram_search.py RPC functions.
Deploy this on Railway (or any server that supports Python + Chrome).

Endpoints mirror the JSON-RPC stdin/stdout protocol used locally,
but exposed over HTTP so Vercel (or any Next.js host) can call them.

Authentication: every request must include the header
  X-Worker-Secret: <WORKER_SECRET env var>
to prevent open access.
"""
from __future__ import annotations

import os
import sys

# Add parent directory so instagram_search.py can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any, Optional

import instagram_search as ig

app = FastAPI(title="Agenticfruit Instagram Worker")

WORKER_SECRET = os.environ.get("WORKER_SECRET", "")


def verify_secret(request: Request):
    if not WORKER_SECRET:
        raise HTTPException(status_code=500, detail="WORKER_SECRET not configured")
    if request.headers.get("X-Worker-Secret") != WORKER_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


class RpcRequest(BaseModel):
    cmd: str
    # login
    username: Optional[str] = None
    password: Optional[str] = None
    # challenge
    code: Optional[str] = None
    # browser_login
    timeout_seconds: Optional[int] = 300
    # login_by_sessionid
    sessionid: Optional[str] = None
    # search
    query: Optional[str] = None
    search_type: Optional[str] = "top"
    limit: Optional[int] = 12
    session: Optional[Any] = None


@app.post("/rpc", dependencies=[Depends(verify_secret)])
async def rpc(body: RpcRequest):
    cmd = body.cmd

    if cmd == "login":
        result = ig.rpc_login(body.username or "", body.password or "")

    elif cmd == "browser_login":
        result = ig.rpc_browser_login(body.timeout_seconds or 300)

    elif cmd == "login_by_sessionid":
        result = ig.rpc_login_by_sessionid(body.sessionid or "")

    elif cmd == "challenge":
        result = ig.rpc_challenge(
            body.username or "",
            body.password or "",
            body.code or "",
        )

    elif cmd == "search":
        result = ig.rpc_search({
            "query": body.query,
            "search_type": body.search_type,
            "limit": body.limit,
            "session": body.session,
        })

    else:
        result = {"ok": False, "error": f"Unknown command: {cmd!r}"}

    return JSONResponse(content=result)


@app.get("/health")
async def health():
    return {"ok": True}
