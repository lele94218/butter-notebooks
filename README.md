# butter-notebooks

Self-hosted Claude-powered notebook web app running on Mac Mini. Chat with Claude, read/edit Markdown notes with KaTeX math rendering, and run Python code in a sandboxed editor — all accessible remotely via browser.

**Live:** https://your-site.example.com

## Features

- **Chat** — Streaming Claude responses with Markdown/LaTeX rendering, extended thinking display, conversation history
- **Notes** — Browse and read Obsidian vault notes (iCloud), full KaTeX math support
- **Code** — Monaco editor with file browser, persistent Python kernel, matplotlib output, Vim mode

## Stack

- **Frontend**: React + Vite, KaTeX, Monaco Editor → deployed to VPS via rsync
- **Backend**: Python FastAPI + Claude CLI subprocess (`--output-format stream-json`)
- **Python sandbox**: Persistent per-session kernel, matplotlib figure capture
- **Storage**: Local files on Mac Mini + iCloud Obsidian vault for notes

## Structure

```
butter-notebooks/
├── frontend/           # React app (Vite)
├── backend/
│   ├── main.py         # FastAPI app, all API endpoints
│   ├── kernel.py       # Python sandbox worker process
│   ├── kernel_manager.py  # Per-session kernel lifecycle
│   ├── tts.py          # Edge TTS
│   ├── stt.py          # Whisper STT
│   └── .env            # Config (API_TOKEN, NOTES_ROOT, CODE_ROOT, etc.)
├── deploy.sh           # Build frontend + rsync to VPS
└── CLAUDE.md           # Deployment & ops guide
```

## Dev

```bash
# Frontend
cd frontend && npm install && npm run dev

# Backend
cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8765
```

## Deploy

```bash
bash deploy.sh
```

See [CLAUDE.md](CLAUDE.md) for full deployment, backend setup, and macOS TCC/launchd notes.
