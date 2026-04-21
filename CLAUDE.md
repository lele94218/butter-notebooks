# butter-notebooks

Claude-powered Markdown notebook web app with chat, notes viewer, and Python code sandbox.

## Architecture

- **Frontend**: React + Vite → deployed to VPS via rsync
- **Backend**: FastAPI + Claude CLI subprocess → runs on Mac Mini (port 8765)
- **Live URL**: https://your-site.example.com

## Deploy Frontend

```bash
bash deploy.sh
```

Builds frontend with `npm run build`, then rsync's `dist/` to VPS:
- Host: `root@vmi868767.your-tailnet.ts.net`
- Path: `/var/www/butter-notebooks/`
- SSH key: `~/.ssh/id_ed25519`

> ⚠️ **Always use `deploy.sh` — never bare `rsync -a`.**
> `rsync -a` preserves the Mac's UID 501 / staff + `0600`/`0700` perms on the
> webroot. nginx (www-data) then can't traverse the directory → site returns 403.
> Happened twice: 2026-04-17 and 2026-04-19. `deploy.sh` sets `--chmod=D755,F644`
> on transfer and runs `chown www-data:www-data` over the webroot afterwards,
> skipping `_stats/` (goaccess-managed).
>
> If the site is already 403, recover manually with:
> ```bash
> ssh -i ~/.ssh/id_ed25519 root@vmi868767.your-tailnet.ts.net "
>   chown -R www-data:www-data /var/www/butter-notebooks &&
>   find /var/www/butter-notebooks -type d -exec chmod 755 {} \; &&
>   find /var/www/butter-notebooks -type f -exec chmod 644 {} \;"
> ```

## Backend (Mac Mini)

### Start / Restart

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.butter-notebooks
```

### Config

- **plist**: `~/Library/LaunchAgents/ai.openclaw.butter-notebooks.plist`
- **launcher**: `/Applications/ButterNotebooks.app/Contents/MacOS/butter-notebooks`
- **env**: `backend/.env`
- **logs**: `/tmp/butter-notebooks.log`

### Key env vars

```
API_TOKEN=...
NOTES_ROOT=/Users/you/Library/Mobile Documents/iCloud~md~obsidian/Documents/claw-learning
CODE_ROOT=/Users/you/works/deep-learnings
SANDBOX_PYTHON=/Users/you/works/ComfyUI/venv/bin/python3
```

### Notes

- Must use `--loop asyncio` (uvloop hangs under launchd)
- Homebrew `Python.app` needs **Full Disk Access** (FDA) in System Settings > Privacy & Security for iCloud Drive access:
  `/opt/homebrew/Cellar/python@3.13/3.13.12_1/Frameworks/Python.framework/Versions/3.13/Resources/Python.app`
  (If Python version upgrades, Cellar path changes — re-grant FDA)
- Backend venv uses Homebrew Python 3.13: `backend/.venv`
- Code sandbox uses ComfyUI venv (has torch 2.10.0 / numpy / matplotlib): `SANDBOX_PYTHON` env var
- File scan for notes uses `subprocess find` (not `rglob`) to avoid blocking asyncio event loop under launchd TCC restrictions

## Known Issues / Gotchas

- **iOS scroll on notes**: Only `.note-panel` should be a scroll container. Inner elements (`.prose` etc.) must have `overflow: visible`, not `overflow: hidden/auto`, or iOS creates a second scroll context that blocks touch events.
- **Claude session_id vs convId**: Claude CLI returns a new `session_id` on every `--resume` call. Frontend keeps a stable `convId` (UUID) separate from `sessionId` (for `--resume` only). Don't conflate them.
- **Extended thinking**: Claude thinking blocks come as `type: 'thinking'` SSE events, not `delta`. Frontend renders them as a dimmed block above the response.

## Development

```bash
# Frontend dev server
cd frontend && npm run dev

# Backend dev
cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8765
```
