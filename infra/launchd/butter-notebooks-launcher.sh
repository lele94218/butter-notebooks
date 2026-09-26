#!/bin/bash
# Launcher for the butter-notebooks FastAPI backend (run by launchd).
# Resolves the repo from its own location, so no absolute path is baked in.
SELF="$(cd "$(dirname "$0")" && pwd)"          # <repo>/infra/launchd
REPO="$(cd "$SELF/../.." && pwd)"
cd "$REPO/backend" || exit 78
exec .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8765 --loop asyncio
