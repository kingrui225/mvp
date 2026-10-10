# Instagram Worker Server

Standalone server that handles Instagram API calls from a non-datacenter IP,
bypassing the block Vercel IPs face from Instagram's anti-bot detection.

## Deploy options

### Option 1: Fly.io (recommended — free tier available)

```bash
# Install flyctl
brew install flyctl

# Login
fly auth login

# Launch (one-time setup — picks up fly.toml in repo root)
fly launch --no-deploy
fly secrets set WORKER_SECRET=<generate a long random string>
fly deploy

# Get your worker URL
fly status
# → https://agenticfruit-ig-worker.fly.dev
```

Then in Vercel dashboard, set:
```
INSTAGRAM_API_URL = https://agenticfruit-ig-worker.fly.dev/rpc
WORKER_SECRET     = <same secret you set above>
```

### Option 2: Railway

1. Go to railway.app → New Project → Deploy from GitHub repo
2. Set Root Directory: `/` (repo root)
3. Set Start Command: `python worker/server.py`
4. Add env var: `WORKER_SECRET=<random secret>`
5. Copy the generated URL → set as `INSTAGRAM_API_URL` in Vercel

### Option 3: Render

Same as Railway. Use `python worker/server.py` as start command.

## How it works

```
User enters credentials
    ↓
Next.js on Vercel
    ↓  POST /rpc  (X-Worker-Secret header)
This server (non-Vercel IP — Instagram allows login)
    ↓
Instagram's private API ✅
    ↓
Session returned to Next.js → encrypted → saved to Supabase
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WORKER_SECRET` | Recommended | Shared secret with Next.js to prevent unauthorized use |
| `INSTAGRAM_LOGIN_PROXY` | Optional | Residential proxy URL for extra IP diversity |
| `PORT` | Optional | Server port (default 8000) |
