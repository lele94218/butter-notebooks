#!/bin/bash
# Launcher for the butter-notebooks FastAPI backend (recreated 2026-09-21 after
# the .app was deleted). WorkingDirectory + env come from the launchd plist.
cd /Users/you/works/claude-projects/butter-notebooks/backend || exit 78
exec .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8765 --loop asyncio
