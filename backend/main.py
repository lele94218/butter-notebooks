import asyncio
import base64
import json
import logging
import os
import tempfile
import traceback
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

load_dotenv(override=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from tts import strip_markdown_for_tts, synthesize_speech
from stt import whisper_transcribe

# --- Config ---
API_TOKEN = os.environ["API_TOKEN"]
NOTES_ROOT = os.environ.get("NOTES_ROOT", str(Path.home()))


# --- Auth ---
def verify_token(authorization: str | None):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    if authorization[7:] != API_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")


app = FastAPI(title="butter-notebooks")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Agent chat (core) ---
async def run_agent_stream(prompt: str, session_id: str | None = None):
    """Run claude-agent-sdk query, yield SSE events."""
    from claude_agent_sdk import (
        query,
        ClaudeAgentOptions,
        AssistantMessage,
        TextBlock,
        ResultMessage,
        SystemMessage,
    )

    options = ClaudeAgentOptions(
        cwd=NOTES_ROOT,
        allowed_tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        permission_mode="acceptEdits",
        max_turns=30,
    )
    if session_id:
        options = ClaudeAgentOptions(
            cwd=NOTES_ROOT,
            allowed_tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            permission_mode="acceptEdits",
            max_turns=30,
            resume=session_id,
        )

    new_session_id = None
    full_reply = ""

    try:
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, SystemMessage) and message.subtype == "init":
                new_session_id = message.session_id
                yield f"data: {json.dumps({'type': 'session', 'session_id': new_session_id})}\n\n"

            elif isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text:
                        full_reply += block.text
                        yield f"data: {json.dumps({'type': 'delta', 'text': block.text}, ensure_ascii=False)}\n\n"

            elif isinstance(message, ResultMessage):
                yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"

    except Exception:
        logger.error(f"Agent error: {traceback.format_exc()}")
        yield f"data: {json.dumps({'type': 'error', 'text': 'Agent failed'})}\n\n"
        return

    return full_reply, new_session_id


# --- Routes ---

class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class TTSRequest(BaseModel):
    text: str


@app.get("/health")
async def health():
    return {"status": "ok", "notes_root": NOTES_ROOT}


@app.post("/v1/tts")
async def tts_endpoint(request: TTSRequest, authorization: str | None = Header(None)):
    verify_token(authorization)
    audio = await synthesize_speech(strip_markdown_for_tts(request.text))
    return Response(content=audio, media_type="audio/mpeg")


@app.post("/v1/chat")
async def chat(req: ChatRequest, authorization: str | None = Header(None)):
    """SSE stream: transcription → delta text → done."""
    verify_token(authorization)

    return StreamingResponse(
        run_agent_stream(req.message, req.session_id),
        media_type="text/event-stream",
    )


@app.post("/v1/chat/voice")
async def chat_voice(
    file: UploadFile = File(...),
    session_id: str | None = None,
    authorization: str | None = Header(None),
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
async def list_notes(path: str = "", authorization: str | None = Header(None)):
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
async def read_note(path: str, authorization: str | None = Header(None)):
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


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
