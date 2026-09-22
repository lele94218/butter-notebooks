# butter-notebooks

Claude-powered Markdown notebook web app with chat, notes viewer, and Python code sandbox.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (https://your-site.example.com)                            │
│  React + Vite SPA                                           │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS (Tailscale / nginx reverse proxy)
┌──────────────────────▼──────────────────────────────────────┐
│  VPS (vmi868767.your-tailnet.ts.net)                          │
│  nginx serves static dist/ + proxies /v1/* & /jupyter/*     │
└──────────────────────┬──────────────────────────────────────┘
                       │ Tailscale internal
┌──────────────────────▼──────────────────────────────────────┐
│  Mac Mini (local)   port 8765                               │
│  FastAPI (uvicorn)                                          │
│  ├── Claude CLI subprocess (--resume, stream-json)          │
│  ├── Python kernel (code sandbox via exec)                  │
│  ├── Jupyter Notebook (port 8888, /jupyter/)                │
│  ├── SQLite WAL (chat.db at ~/.butter-notebooks/)           │
│  └── iCloud Drive (Obsidian notes, read-only)               │
└─────────────────────────────────────────────────────────────┘
```

- **Frontend**: React + Vite → built and rsync'd to VPS
- **Backend**: FastAPI + Claude CLI subprocess → runs on Mac Mini (port 8765)
- **Data**: SQLite at `~/.butter-notebooks/chat.db` (conversations, messages, chunks)
- **Live URL**: https://your-site.example.com

## Frontend Structure

```
frontend/src/
├── App.jsx              # Layout shell: auth, theme, sidebar, tab routing (~175 lines)
├── App.css              # Layout + sidebar + shared .prose styles (~380 lines)
├── lib/
│   ├── constants.js     # API_BASE, TOKEN_KEY, MODELS, DEFAULT_MODEL
│   ├── api.js           # getToken, headers, fetchConversations, apiDeleteConv
│   └── theme.js         # ThemeContext, applyThemeColor
└── components/
    ├── ChatPanel.jsx/css    # SSE streaming chat, model selector, image attachments
    ├── NotesPanel.jsx/css   # Markdown note viewer (read-only from Obsidian vault)
    ├── CodePanel.jsx/css    # Monaco editor, file tree, Python kernel execution
    ├── NotebookPanel.jsx/css # Embedded JupyterLab iframe with token auth + loading bar
    ├── LoginScreen.jsx/css  # Token-based auth
    ├── MdMessage.jsx        # Memo-wrapped Markdown renderer (shared by Chat + Notes)
    ├── CodeBlock.jsx        # SyntaxHighlighter + copy button
    ├── FileTree.jsx         # Recursive sidebar file tree + buildTree helper
    └── AuthImage.jsx        # Blob URL auth image loader
```

## Backend Structure

```
backend/
├── main.py              # FastAPI app: chat SSE, notes, files, code execution routes
├── chat_store.py        # SQLite WAL: conversations, messages, message_chunks
├── kernel.py            # Python subprocess sandbox (exec + matplotlib capture)
├── kernel_manager.py    # Kernel lifecycle management
├── tts.py               # Text-to-speech (Edge TTS)
├── stt.py               # Speech-to-text
└── .env                 # Runtime config (API_TOKEN, paths, etc.)
```

## Session & Conversation Model

```
Frontend (convId)                    Backend (session_id)
─────────────────                    ────────────────────
convId = stable UUID                 session_id = Claude CLI --resume token
assigned on first send               returned by CLI, stored in chat.db
sent as conv_id in every request     looked up from DB, never sent by frontend
```

- **convId** (frontend): Stable conversation identifier. Generated once via `crypto.randomUUID()` on first message, then reused for all subsequent turns.
- **session_id** (backend-only): Claude CLI `--resume` token. Backend looks it up from `conversations.session_id` in SQLite when processing a chat request. Frontend never sees or sends it.
- After each turn, `_persist_conversation_after_turn` saves the (possibly new) `session_id` from Claude CLI back to the DB.
- **Important**: Deploying frontend changes that touch the chat flow requires restarting the backend too (`launchctl kickstart`), since the backend is not auto-reloaded.

## Agents / Backends (Claude + Codex)

The chat backend runs one of two CLIs, chosen by the request's `model`. The frontend splits selection into two dropdowns: **Agent** (Claude / Codex) + **Model**.

- **Dispatch**: `run_agent_stream` picks `_codex_attempt` if `_is_codex_model(model)` else `_cli_attempt`. Both yield the same SSE event contract (`session` / `thinking` / `tool_use` / `tool_result` / `delta` / `done` / `error`), so the frontend renders both identically.
- **Claude** (`_cli_attempt`): `claude -p ... --dangerously-skip-permissions`, stream-json. Models in `CLAUDE_MODELS`.
- **Codex** (`_codex_attempt`): `codex exec --json --dangerously-bypass-approvals-and-sandbox` (skip-permission, mirrors claude). `CODEX_MODELS` maps ids → `{model, effort}`; only `gpt-6-astra` has full metadata here. Resume via `codex exec resume <thread_id>`. Codex JSONL events (`thread.started`, `item.completed{agent_message|reasoning|command_execution}`, `turn.completed`) are mapped to the SSE contract.
- **session_id** is backend-specific and **not interchangeable** (claude `--resume` token vs codex `thread_id`). Switching backends mid-conversation is **forbidden by design**: the frontend disables the other agent once a chat has started; the backend returns **409** as a safety net.
- **Self-heal**: an expired/foreign session (resume yields no output) retries once with a fresh session.
- Both are skip-permission → can read/write/run freely on the Mac. `cwd=NOTES_ROOT`.

### Chat resilience

- **In-flight refresh**: the active conv id is stored in `localStorage['butter_active_conv']` at send time; on reload App restores it and ChatPanel's pending/resume effect reattaches the live stream (question + thinking indicator survive a refresh).
- **Sidebar running dot**: `/v1/conversations` returns a per-conv `running` flag (any `status='streaming'` message); the sidebar shows a pulsing green dot, polled every 4s, so an in-flight run is visible from any chat.
- **Errors**: backend error SSE events carry a `code`; the frontend renders an inline error card and persists it to the transcript so it survives a refresh.

## Deploy

```bash
./deploy.sh              # frontend only (build + rsync to VPS)
./deploy.sh --frontend   # same as above
./deploy.sh --backend    # restart backend only (launchctl kickstart)
./deploy.sh --all        # frontend + backend
```

- Frontend: builds with `npm run build`, rsync's to VPS, fixes perms
- Backend: `launchctl kickstart -k` the plist, verifies process started
- VPS host: `root@vmi868767.your-tailnet.ts.net`, path `/var/www/butter-notebooks/`

> **Never bare `rsync -a`** — preserves Mac UID/perms → nginx 403.
> `deploy.sh` runs `chmod` + `chown www-data` after transfer.

> **If frontend and backend touch the same API contract, use `--all`.**
> Otherwise the mismatch causes silent failures (e.g. frontend stops sending
> a field the old backend still expects).

### Config

| Item | Path |
|------|------|
| plist | `~/Library/LaunchAgents/ai.openclaw.butter-notebooks.plist` |
| launcher | `/Applications/ButterNotebooks.app/Contents/MacOS/butter-notebooks` (copy in `infra/launchd/butter-notebooks-launcher.sh`) |
| env | `backend/.env` |
| logs | `/tmp/butter-notebooks.log` |
| database | `~/.butter-notebooks/chat.db` |
| nginx config | `infra/nginx/your-site.example.com.conf` |

### Key env vars

```
API_TOKEN=...
NOTES_ROOT=/Users/you/Library/Mobile Documents/iCloud~md~obsidian/Documents/claw-learning
CODE_ROOT=/Users/you/works/deep-learnings
SANDBOX_PYTHON=/Users/you/works/ComfyUI/venv/bin/python3
TTS_ENGINE=edge
JUPYTER_TOKEN=...           # must match --NotebookApp.token= on jupyter-notebook
JUPYTER_BASE_URL=/jupyter/  # must match --NotebookApp.base_url=
```

## Backend Notes

- Must use `--loop asyncio` (uvloop hangs under launchd)
- Homebrew `Python.app` needs **Full Disk Access** (FDA) for iCloud Drive:
  `/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app`
  (Python version upgrade → Cellar path changes → re-grant FDA, **and** the old
  `backend/.venv` breaks — recreate it: `rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`)
- Backend venv: Homebrew Python 3.14 (`backend/.venv`)
- Code sandbox venv: ComfyUI (`SANDBOX_PYTHON`, has torch/numpy/matplotlib)
- Notes file scan uses `subprocess find` (not `rglob`) to avoid blocking asyncio under launchd TCC
- Jupyter runs from ComfyUI venv (`/Users/you/works/ComfyUI/venv/bin/jupyter-notebook`), port 8888, `--ip=0.0.0.0`. Must listen on all interfaces for Tailscale proxy to reach it. nginx strips `X-Frame-Options` and `Content-Security-Policy` headers to allow iframe embedding.

## Known Issues / Gotchas

- **iOS scroll**: Only `.note-panel` should be a scroll container. Inner `.prose` must have `overflow: visible`, not `hidden/auto`, or iOS creates a second scroll context.
- **Extended thinking**: Claude thinking blocks arrive as `type: 'thinking'` SSE events. Frontend renders them dimmed above the response.
- **Kernel plots**: `kernel.py` patches matplotlib to Agg backend and captures figures via `_capture_figure()`. User code just calls `plt.show()` — output streams as base64 PNG via SSE.
- **Frontend + backend deploy mismatch**: Frontend deploys instantly (rsync to VPS), backend requires `launchctl kickstart`. If they touch the same API contract, deploy both and restart backend.
- **Jupyter iframe**: Embedded via `/jupyter/lab` (JupyterLab SPA) so files open inside the iframe, not in new browser tabs. Token is fetched from `/v1/jupyter-token` (auth-gated) and passed via URL param. Jupyter must be started with `--ip=0.0.0.0 --NotebookApp.base_url=/jupyter/ --NotebookApp.token=<TOKEN> --NotebookApp.allow_origin=https://your-site.example.com`.
- **Backend `exit=78` / won't start**: means launchd can't exec the launcher (`/Applications/ButterNotebooks.app/...` missing or the job is stuck in a failed state). `launchctl kickstart -k` does NOT recover from this — do a full reload: `launchctl bootout gui/$(id -u)/ai.openclaw.butter-notebooks && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.butter-notebooks.plist`. If the launcher itself is gone, restore it from `infra/launchd/butter-notebooks-launcher.sh`.

## Development

```bash
# Frontend dev server
cd frontend && npm run dev

# Backend dev (with auto-reload)
cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8765
```
