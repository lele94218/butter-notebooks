from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import tempfile
import traceback
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

load_dotenv(override=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from tts import strip_markdown_for_tts, synthesize_speech
from stt import whisper_transcribe

# --- Config ---
API_TOKEN = os.environ["API_TOKEN"]
NOTES_ROOT = os.environ.get("NOTES_ROOT", str(Path.home()))
DATA_DIR = Path(os.environ.get("DATA_DIR", Path.home() / ".butter-notebooks"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONV_FILE = DATA_DIR / "conversations.json"


# --- Conversations persistence ---
def _load_convs() -> dict:
    try:
        return json.loads(CONV_FILE.read_text()) if CONV_FILE.exists() else {}
    except Exception:
        return {}


def _save_convs(data: dict):
    CONV_FILE.write_text(json.dumps(data, ensure_ascii=False))


# --- Auth ---
def verify_token(authorization: Optional[str]):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    if authorization[7:] != API_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")


limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="butter-notebooks")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda req, exc: Response("Too many requests", status_code=429))
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash"
CLAUDE_SYSTEM_PROMPT = (
    "You are a helpful assistant in a web app that renders Markdown and LaTeX via KaTeX. "
    "When writing math formulas, ALWAYS use LaTeX delimiters: "
    "inline math with $...$ and block/display math with $$...$$. "
    "Never put math formulas inside code blocks. "
    "Markdown tables, bold, italic, and headers are all rendered correctly."
)


# --- Agent chat via claude CLI ---
async def run_agent_stream(prompt: str, session_id: Optional[str] = None):
    """Run `claude -p --output-format stream-json`, read events line-by-line, yield SSE."""
    cmd = [
        CLAUDE_BIN, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--allowed-tools", CLAUDE_ALLOWED_TOOLS,
        "--permission-mode", "acceptEdits",
        "--dangerously-skip-permissions",
        "--system-prompt", CLAUDE_SYSTEM_PROMPT,
        prompt,
    ]
    if session_id:
        cmd += ["--resume", session_id]

    # Strip CLAUDECODE so nested claude CLI doesn't refuse to start
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=NOTES_ROOT,
            env=env,
        )
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"
        return

    new_session_id = session_id
    buf = b""

    try:
        # stream-json: stdout emits one JSON object per line
        async for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue

            event_type = obj.get("type")

            if event_type == "system":
                # init event carries session_id
                sid = obj.get("session_id")
                if sid:
                    new_session_id = sid
                    yield f"data: {json.dumps({'type': 'session', 'session_id': sid})}\n\n"

            elif event_type == "assistant":
                # assistant message — extract text content blocks
                msg = obj.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            yield f"data: {json.dumps({'type': 'delta', 'text': text}, ensure_ascii=False)}\n\n"

            elif event_type == "result":
                sid = obj.get("session_id")
                if sid:
                    new_session_id = sid
                if obj.get("is_error"):
                    yield f"data: {json.dumps({'type': 'error', 'text': obj.get('result', 'unknown error')})}\n\n"
                    return
                yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"
                return

        # If we reach here without a result event, send done anyway
        await proc.wait()
        yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"

    except Exception:
        logger.error(f"Agent error: {traceback.format_exc()}")
        yield f"data: {json.dumps({'type': 'error', 'text': 'Agent failed'})}\n\n"


# --- Routes ---

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None


class TTSRequest(BaseModel):
    text: str


@app.get("/health")
@limiter.limit("30/minute")
async def health(request: Request):
    return {"status": "ok", "notes_root": NOTES_ROOT}


@app.post("/v1/tts")
@limiter.limit("20/minute")
async def tts_endpoint(request: Request, body: TTSRequest, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    audio = await synthesize_speech(strip_markdown_for_tts(body.text))
    return Response(content=audio, media_type="audio/mpeg")


@app.post("/v1/chat")
@limiter.limit("30/minute")
async def chat(request: Request, req: ChatRequest, authorization: Optional[str] = Header(None)):
    """SSE stream: transcription → delta text → done."""
    verify_token(authorization)

    return StreamingResponse(
        run_agent_stream(req.message, req.session_id),
        media_type="text/event-stream",
    )


@app.post("/v1/chat/voice")
async def chat_voice(
    file: UploadFile = File(...),
    session_id: Optional[str] = None,
    authorization: Optional[str] = Header(None),
):
    """Voice input → SSE stream with transcription + agent reply."""
    verify_token(authorization)

    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    file_size = Path(tmp_path).stat().st_size
    if file_size < 1000:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="录音太短")

    try:
        text = await whisper_transcribe(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
        Path(tmp_path).with_suffix(".txt").unlink(missing_ok=True)

    if not text:
        raise HTTPException(status_code=400, detail="No speech detected")

    async def event_stream():
        yield f"data: {json.dumps({'type': 'transcription', 'text': text}, ensure_ascii=False)}\n\n"

        full_reply = ""
        new_session_id = None

        async for event in run_agent_stream(text, session_id):
            yield event
            # capture reply for TTS
            try:
                data = json.loads(event[6:])  # strip "data: "
                if data.get("type") == "delta":
                    full_reply += data.get("text", "")
                elif data.get("type") == "done":
                    new_session_id = data.get("session_id")
            except Exception:
                pass

        # TTS on full reply
        if full_reply:
            try:
                audio_bytes = await synthesize_speech(strip_markdown_for_tts(full_reply))
                audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
                yield f"data: {json.dumps({'type': 'audio', 'data': audio_b64})}\n\n"
            except Exception:
                logger.error(f"TTS error: {traceback.format_exc()}")

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/v1/notes")
@limiter.limit("60/minute")
async def list_notes(request: Request, path: str = "", authorization: Optional[str] = Header(None)):
    """List markdown files under NOTES_ROOT/path."""
    verify_token(authorization)
    base = Path(NOTES_ROOT) / path
    if not base.exists() or not base.is_dir():
        raise HTTPException(status_code=404, detail="Path not found")
    files = []
    for p in sorted(base.rglob("*.md")):
        files.append(str(p.relative_to(NOTES_ROOT)))
    return {"files": files, "root": NOTES_ROOT}


@app.get("/v1/notes/read")
@limiter.limit("60/minute")
async def read_note(request: Request, path: str = "", authorization: Optional[str] = Header(None)):
    """Read a markdown file."""
    verify_token(authorization)
    target = Path(NOTES_ROOT) / path
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    # Prevent path traversal
    try:
        target.resolve().relative_to(Path(NOTES_ROOT).resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")
    return {"path": path, "content": target.read_text()}


class ConvUpsert(BaseModel):
    id: str
    title: str
    messages: list
    updatedAt: int


@app.get("/v1/conversations")
@limiter.limit("60/minute")
async def list_conversations(request: Request, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    convs = _load_convs()
    # Return sorted newest first
    items = sorted(convs.values(), key=lambda c: c.get("updatedAt", 0), reverse=True)
    return {"conversations": items[:100]}


@app.put("/v1/conversations/{conv_id}")
@limiter.limit("60/minute")
async def upsert_conversation(request: Request, conv_id: str, body: ConvUpsert, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    convs = _load_convs()
    convs[conv_id] = body.model_dump()
    _save_convs(convs)
    return {"ok": True}


@app.delete("/v1/conversations/{conv_id}")
@limiter.limit("30/minute")
async def delete_conversation(request: Request, conv_id: str, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    convs = _load_convs()
    convs.pop(conv_id, None)
    _save_convs(convs)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
