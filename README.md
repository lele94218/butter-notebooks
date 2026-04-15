# butter-notebooks

Self-hosted webapp running on Mac mini. Chat with Claude, render Markdown/LaTeX, manage notes — all accessible remotely via Tailscale.

## Stack

- **Frontend**: React + KaTeX (Markdown/LaTeX rendering)
- **Backend**: Python FastAPI + claude-agent-sdk
- **Access**: Tailscale (any device, browser-based)
- **Storage**: Local files on Mac mini

## Structure

```
butter-notebooks/
├── frontend/       # React app
├── backend/        # FastAPI + claude-agent-sdk
└── README.md
```

## Dev

```bash
# Backend
cd backend && pip install -r requirements.txt && uvicorn main:app --reload

# Frontend
cd frontend && npm install && npm run dev
```
