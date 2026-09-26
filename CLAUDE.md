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
│  VPS (your-vps.example.com)                          │
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
- **Claude** (`_cli_attempt`): `claude -p ... --dangerously-skip-permissions`, stream-json. Models in `CLAUDE_MODELS`; default `claude-opus-5-5`. To add a model, put its id in `CLAUDE_MODELS` (backend) + `AGENTS` (frontend) and verify the CLI actually uses it (session `.jsonl` records `"model":"..."` — watch for silent fallback).
- **Codex** (`_codex_attempt`): `codex exec --json --dangerously-bypass-approvals-and-sandbox` (skip-permission, mirrors claude). `CODEX_MODELS` maps internal ids (`codex`, `codex-luna`, …) → `{model, effort}`. GPT-6 codename models that work on a **ChatGPT-account** Codex: `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol` (each medium + high via `model_reasoning_effort`). `gpt-6` / `gpt-6-pro` return "not supported when using Codex with a ChatGPT account". Resume via `codex exec resume <thread_id>`. Codex JSONL events (`thread.started`, `item.completed{agent_message|reasoning|command_execution}`, `turn.completed`) are mapped to the SSE contract.
- **session_id** is backend-specific and **not interchangeable** (claude `--resume` token vs codex `thread_id`). Switching backends mid-conversation is **forbidden by design**: the frontend disables the other agent once a chat has started; the backend returns **409** as a safety net.
- **Self-heal**: an expired/foreign session (resume yields no output) retries once with a fresh session.
- Both are skip-permission → can read/write/run freely on the Mac. `cwd=NOTES_ROOT`.

### Chat resilience

- **In-flight refresh**: the active conv id is stored in `localStorage['butter_active_conv']` at send time; on reload App restores it and ChatPanel's pending/resume effect reattaches the live stream (question + thinking indicator survive a refresh).
- **Sidebar running dot**: `/v1/conversations` returns a per-conv `running` flag (any `status='streaming'` message); the sidebar shows a pulsing green dot, polled every 4s, so an in-flight run is visible from any chat.
- **Errors**: backend error SSE events carry a `code`; the frontend renders an inline error card and persists it to the transcript so it survives a refresh.

### OpenAI-compatible shim

`GET /v1/models` + `POST /v1/chat/completions` let generic OpenAI clients (e.g. **Chatbox iOS**) use the backend. Stateless: the client sends the full history each call, flattened into one prompt run fresh (no session resume). Codex ids are exposed under their official names via `SHIM_MODEL_ALIASES` (e.g. `gpt-6-astra` ↔ internal `codex`). Client config: API host `https://your-site.example.com/v1`, path `/chat/completions`, key = `API_TOKEN`.

- **CORS**: `allow_origin_regex=".*"` (echoes the caller's origin) so webview clients' preflights pass — auth is the Bearer `API_TOKEN`, not CORS.
- **Images**: `GET /v1/img?p=<abs>&t=<API_TOKEN>` serves image files under allowed roots (`$HOME` + `/tmp` + `/private/tmp`, image-only); token via query so a markdown `<img>` works. The shim rewrites **markdown images only** — `![alt](/local/path)` or `![alt](file:///…)` → `![alt](<served url>)` (`_rewrite_md_images`); bare paths in prose are left alone. Streaming holds back a forming image markdown (`_safe_emit_len`) until complete, then rewrites in place (no broken/duplicate image). The agent still has to actually produce the file. `PUBLIC_BASE_URL` env sets the public host.
- **Caveat**: no resume. iOS backgrounding drops the connection → the turn fails with no recovery (unlike the web app's `/v1/chat`, which persists + resumes). Use the web app for long turns.

## Deploy

```bash
./deploy.sh              # frontend only (build + rsync to VPS)
./deploy.sh --frontend   # same as above
./deploy.sh --backend    # restart backend only (launchctl kickstart)
./deploy.sh --all        # frontend + backend
```

- Frontend: builds with `npm run build`, rsync's to VPS, fixes perms
- Backend: `launchctl kickstart -k` the plist, verifies process started
- VPS host: `root@your-vps.example.com`, path `/var/www/butter-notebooks/`

> **Never bare `rsync -a`** — preserves Mac UID/perms → nginx 403.
> `deploy.sh` runs `chmod` + `chown www-data` after transfer.

> **If frontend and backend touch the same API contract, use `--all`.**
> Otherwise the mismatch causes silent failures (e.g. frontend stops sending
> a field the old backend still expects).

### Config

| Item | Path |
|------|------|
| plist | `~/Library/LaunchAgents/ai.openclaw.butter-notebooks.plist` (copy in `infra/launchd/`) |
| launcher | `infra/launchd/butter-notebooks-launcher.sh` (repo-tracked; plist points here — no longer `/Applications`) |
| env | `backend/.env` |
| logs | `/tmp/butter-notebooks.log` |
| database | `~/.butter-notebooks/chat.db` |
| nginx config | `infra/nginx/your-site.example.com.conf` |

### Key env vars

```
API_TOKEN=...
NOTES_ROOT=$HOME/path/to/your/notes-vault
CODE_ROOT=$HOME/path/to/your/code
SANDBOX_PYTHON=$HOME/path/to/sandbox-venv/bin/python3
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
- Jupyter runs from ComfyUI venv (`$HOME/path/to/sandbox-venv/bin/jupyter-notebook`), port 8888, `--ip=0.0.0.0`. Must listen on all interfaces for Tailscale proxy to reach it. nginx strips `X-Frame-Options` and `Content-Security-Policy` headers to allow iframe embedding.

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
