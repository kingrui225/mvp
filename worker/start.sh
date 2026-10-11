#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# worker/start.sh — Railway startup script
#
# Upgrades critical Python packages to their latest PyPI release before
# launching the worker server.  Runs on every deploy and container restart so
# instagrapi (which tracks Instagram's private API closely) stays current
# without manual intervention.
#
# Controlled by AUTO_UPGRADE_PACKAGES env var (default "true").
# Set to "false" on Railway to disable if you need a pinned build.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

AUTO_UPGRADE="${AUTO_UPGRADE_PACKAGES:-true}"

if [[ "$AUTO_UPGRADE" == "true" ]]; then
  echo "[startup] Auto-upgrading critical packages from PyPI..."

  # Core Instagram client — upgraded first because Instagram pushes API changes
  # frequently and instagrapi releases same-day patches.
  pip install --quiet --upgrade --no-cache-dir instagrapi

  # Transcription stack
  pip install --quiet --upgrade --no-cache-dir faster-whisper static-ffmpeg

  # Web framework and Pydantic (conservative — only patch bumps expected)
  pip install --quiet --upgrade --no-cache-dir \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.30.0" \
    "pydantic>=2.0.0,<3.0.0"

  echo "[startup] Upgraded versions:"
  pip show instagrapi faster-whisper 2>/dev/null \
    | grep -E "^(Name|Version):" \
    | paste - - \
    | awk '{print "  " $2 " " $4}'
else
  echo "[startup] AUTO_UPGRADE_PACKAGES=false — skipping package upgrades"
fi

echo "[startup] Launching worker server..."
exec python worker/server.py
