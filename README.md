# butter-notebooks

Self-hosted Claude-powered notebook web app running on Mac Mini. Chat with Claude, read Markdown notes with KaTeX math rendering, and run Python code in a sandboxed editor — all accessible remotely via browser.

**Live:** https://your-site.example.com

## Features

- **Chat** — Streaming Claude responses with Markdown/LaTeX rendering, extended thinking, conversation history
- **Notes** — Browse and read Obsidian vault notes (iCloud), full KaTeX math support
- **Code** — Monaco editor with file browser, persistent Python kernel, matplotlib output, Vim mode
- **Notebook** — Embedded JupyterLab with token auth, reverse-proxied through nginx

## Stack

- **Frontend**: React + Vite, KaTeX, Monaco Editor → deployed to VPS (nginx)
- **Backend**: Python FastAPI + Claude CLI subprocess → runs on Mac Mini (port 8765)
- **Data**: SQLite WAL (`~/.butter-notebooks/chat.db`) for conversations and messages
- **Python sandbox**: Persistent per-session kernel with matplotlib figure capture
- **Jupyter**: JupyterLab embedded via iframe, token-gated through backend API
- **Notes source**: iCloud Obsidian vault (read-only)

## Structure

```
butter-notebooks/
├── frontend/src/
│   ├── App.jsx/css          # Layout shell, sidebar, tab routing
│   ├── lib/                 # constants, api helpers, theme
│   └── components/          # ChatPanel, NotesPanel, CodePanel, NotebookPanel, etc.
├── backend/
│   ├── main.py              # FastAPI app, chat SSE, notes/files/code routes
│   ├── chat_store.py        # SQLite conversation & message storage
│   ├── kernel.py            # Python sandbox (exec + matplotlib capture)
│   ├── kernel_manager.py    # Per-session kernel lifecycle
│   ├── tts.py / stt.py      # Text-to-speech / speech-to-text
│   └── .env                 # Config (API_TOKEN, NOTES_ROOT, etc.)
├── infra/                   # nginx config, goaccess analytics
├── deploy.sh                # Build & deploy (frontend/backend/both)
└── CLAUDE.md                # Full deployment & ops guide
```

## Dev

```bash
cd frontend && npm install && npm run dev
cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8765
```

## Deploy

```bash
./deploy.sh              # frontend only
./deploy.sh --backend    # restart backend only
./deploy.sh --all        # both
```

See [CLAUDE.md](CLAUDE.md) for full deployment details, launchd setup, and macOS TCC notes.
