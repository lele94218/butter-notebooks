from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import tempfile
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
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
from kernel_manager import kernel_manager
from chat_store import ChatStore

# --- Config ---
API_TOKEN = os.environ["API_TOKEN"]
NOTES_ROOT = os.environ.get("NOTES_ROOT", str(Path.home()))
CODE_ROOT = os.environ.get("CODE_ROOT", str(Path.home()))
DATA_DIR = Path(os.environ.get("DATA_DIR", Path.home() / ".butter-notebooks"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONV_FILE = DATA_DIR / "conversations.json"
CHAT_DB = DATA_DIR / "chat.db"
UPLOADS_DIR = DATA_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_ROOT_RESOLVED = UPLOADS_DIR.resolve()
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
chat_store = ChatStore(CHAT_DB)

# msg_id -> background task running the claude subprocess. Kept so we can
# inspect / cancel later; tail_stream does not depend on it.
_agent_tasks: dict[str, asyncio.Task] = {}


# --- Conversations persistence (SQLite-only) ---
def _load_convs_for_migration() -> dict:
    """Read the legacy JSON file — used only for one-time startup migration."""
    try:
        return json.loads(CONV_FILE.read_text()) if CONV_FILE.exists() else {}
    except Exception:
        return {}


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

@app.on_event("startup")
async def _startup():
    kernel_manager.start_cleanup()
    try:
        existing = await chat_store.count_conversations()
        if existing == 0 and CONV_FILE.exists():
            convs = _load_convs_for_migration()
            items = list(convs.values())
            if items:
                n = await chat_store.bulk_import_conversations(items)
                logger.info(f"migrated {n} conversations from JSON to SQLite")
    except Exception:
        logger.error(
            f"conversations JSON→SQLite migration failed: {traceback.format_exc()}"
        )

@app.on_event("shutdown")
async def _shutdown():
    await kernel_manager.shutdown()

_allow_origins_env = os.environ.get("CORS_ALLOW_ORIGINS", "").strip()
ALLOW_ORIGINS = (
    [o.strip() for o in _allow_origins_env.split(",") if o.strip()]
    if _allow_origins_env
    else [
        "https://your-site.example.com",
        "http://localhost:5173",
        # Capacitor iOS app (bundled UI loads from these origins, calls the API cross-origin)
        "capacitor://localhost",
        "https://localhost",
    ]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash"
CLAUDE_MODELS = (
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
)
CLAUDE_DEFAULT_MODEL = "claude-opus-5"

# --- Codex CLI backend (OpenAI `codex exec`) ---
# Selected when the frontend picks one of these model IDs. Each maps to a codex
# `-m` slug and reasoning effort. Runs in skip-permission mode (bypass approvals
# + sandbox), mirroring claude's --dangerously-skip-permissions.
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
CODEX_MODELS: dict[str, dict] = {
    "codex":      {"model": "gpt-6-astra", "effort": "medium"},
    "codex-high": {"model": "gpt-6-astra", "effort": "high"},
}


def _is_codex_model(model: Optional[str]) -> bool:
    return bool(model) and model in CODEX_MODELS


def _normalize_model(model: Optional[str]) -> Optional[str]:
    """Pass through known model IDs (claude or codex); else let the CLI default."""
    if model and (model in CLAUDE_MODELS or model in CODEX_MODELS):
        return model
    return None
CLAUDE_SYSTEM_PROMPT = (
    "You are a helpful assistant in a web app that renders Markdown and LaTeX via KaTeX. "
    "When writing math formulas, ALWAYS use LaTeX delimiters: "
    "inline math with $...$ and block/display math with $$...$$. "
    "Never put math formulas inside code blocks. "
    "Markdown tables, bold, italic, and headers are all rendered correctly."
)


# --- Agent chat via claude CLI ---
def _build_user_message_payload(
    prompt: str,
    images: Optional[list[dict]] = None,
) -> dict:
    """Build a single stream-json user message: image blocks first, then text.

    Each image dict must have `path` (absolute, under UPLOADS_DIR) and `mime`
    (e.g. 'image/png'). The file is read and inlined as base64 — claude CLI's
    stream-json input expects full content blocks, not file paths.
    """
    content: list[dict] = []
    for img in images or []:
        p = Path(img["path"]).resolve()
        # Hard guard: reject anything that isn't under uploads dir.
        try:
            p.relative_to(UPLOADS_ROOT_RESOLVED)
        except ValueError:
            raise HTTPException(status_code=403, detail="Image path outside uploads dir")
        if not p.is_file():
            raise HTTPException(status_code=404, detail=f"Image not found: {img['path']}")
        data = base64.b64encode(p.read_bytes()).decode("ascii")
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.get("mime") or "image/png",
                "data": data,
            },
        })
    content.append({"type": "text", "text": prompt})
    return {
        "type": "user",
        "message": {"role": "user", "content": content},
    }


TOOL_RESULT_MAX = 4000


def _normalize_tool_result(content) -> str:
    """Flatten a tool_result `content` (string | list of blocks) to text.

    Truncates long output so the SSE payload and stored chunk stay bounded.
    """
    if content is None:
        text = ""
    elif isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
                elif b.get("type") == "image":
                    parts.append("[image]")
            elif isinstance(b, str):
                parts.append(b)
        text = "".join(parts)
    else:
        text = str(content)
    text = text.strip()
    if len(text) > TOOL_RESULT_MAX:
        text = text[:TOOL_RESULT_MAX] + f"\n… (+{len(text) - TOOL_RESULT_MAX} more chars)"
    return text


async def _cli_attempt(
    prompt: str,
    session_id: Optional[str] = None,
    model: Optional[str] = None,
    images: Optional[list[dict]] = None,
):
    """One `claude -p --input-format stream-json --output-format stream-json` run.

    The user message (text + optional image blocks) is written to stdin as a
    single JSON line; stdin is then closed. Output streaming is unchanged.
    """
    cmd = [
        CLAUDE_BIN, "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--allowed-tools", CLAUDE_ALLOWED_TOOLS,
        "--permission-mode", "acceptEdits",
        "--dangerously-skip-permissions",
        "--system-prompt", CLAUDE_SYSTEM_PROMPT,
    ]
    if session_id:
        cmd += ["--resume", session_id]
    picked_model = _normalize_model(model)
    if picked_model:
        cmd += ["--model", picked_model]

    # Strip CLAUDECODE so nested claude CLI doesn't refuse to start
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    try:
        user_msg_payload = _build_user_message_payload(prompt, images)
    except HTTPException as e:
        yield f"data: {json.dumps({'type': 'error', 'code': 'input', 'text': e.detail})}\n\n"
        return
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'code': 'image', 'text': f'image load failed: {e}'})}\n\n"
        return

    # The `claude` binary can vanish for a second or two while it auto-updates
    # (npm recreates the symlink), so a message sent in that window would spawn
    # a FileNotFoundError. Retry a few times with a short backoff instead of
    # failing the turn.
    proc = None
    for spawn_try in range(4):
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=NOTES_ROOT,
                env=env,
                limit=10 * 1024 * 1024,  # 10 MB — Claude tool results can be large
            )
            break
        except FileNotFoundError as e:
            if spawn_try < 3:
                logger.warning(
                    f"claude CLI not found (likely mid-update), retry {spawn_try + 1}/3: {e}"
                )
                await asyncio.sleep(1.5)
                continue
            yield f"data: {json.dumps({'type': 'error', 'code': 'cli_unavailable', 'text': f'claude CLI unavailable: {e}'})}\n\n"
            return
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'code': 'spawn', 'text': str(e)})}\n\n"
            return

    # Write the single user message line, then close stdin so claude stops
    # waiting for more input and processes what it has.
    try:
        proc.stdin.write((json.dumps(user_msg_payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
    except Exception as e:
        logger.error(f"failed to write stream-json input: {e}")
        yield f"data: {json.dumps({'type': 'error', 'code': 'stdin', 'text': f'stdin write failed: {e}'})}\n\n"
        try:
            proc.kill()
        except Exception:
            pass
        return

    new_session_id = session_id
    buf = b""
    has_sent_text = False

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
                blocks = msg.get("content", [])
                block_types = [b.get("type") for b in blocks]
                tool_names = [b.get("name") for b in blocks if b.get("type") == "tool_use"]
                if tool_names:
                    logger.info(f"[assistant] tool_use: {tool_names}")
                has_text = False
                for block in blocks:
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            if has_sent_text and not text.startswith("\n"):
                                text = "\n\n" + text
                            has_text = True
                            has_sent_text = True
                            yield f"data: {json.dumps({'type': 'delta', 'text': text}, ensure_ascii=False)}\n\n"
                    elif block.get("type") == "thinking":
                        thinking = block.get("thinking", "")
                        if thinking:
                            yield f"data: {json.dumps({'type': 'thinking', 'text': thinking}, ensure_ascii=False)}\n\n"
                    elif block.get("type") == "tool_use":
                        tu = {
                            "type": "tool_use",
                            "id": block.get("id"),
                            "name": block.get("name"),
                            "input": block.get("input", {}),
                        }
                        yield f"data: {json.dumps(tu, ensure_ascii=False)}\n\n"
                if not has_text:
                    logger.info(f"[assistant] no text, blocks={block_types}")

            elif event_type == "user":
                # user turn carries tool_result blocks (tool output)
                msg = obj.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "tool_result":
                        tr = {
                            "type": "tool_result",
                            "tool_use_id": block.get("tool_use_id"),
                            "text": _normalize_tool_result(block.get("content")),
                            "is_error": bool(block.get("is_error")),
                        }
                        yield f"data: {json.dumps(tr, ensure_ascii=False)}\n\n"

            elif event_type == "result":
                sid = obj.get("session_id")
                if sid:
                    new_session_id = sid
                is_error = obj.get("is_error", False)
                subtype = obj.get("subtype")
                stop_reason = obj.get("stop_reason", "unknown")
                denials = obj.get("permission_denials") or []
                cost = obj.get("total_cost_usd")
                logger.info(
                    f"[result] is_error={is_error} subtype={subtype} stop_reason={stop_reason} "
                    f"permission_denials={len(denials)} cost_usd={cost}"
                )
                if denials:
                    logger.warning(f"[result] denied tools: {[d.get('toolName') for d in denials]}")
                if is_error:
                    err_text = obj.get("result") or subtype or "unknown error"
                    logger.error(f"[result] error text: {err_text}")
                    yield f"data: {json.dumps({'type': 'error', 'code': subtype or 'agent_error', 'text': err_text})}\n\n"
                    return
                yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"
                return

        # If we reach here without a result event, send done anyway
        await proc.wait()
        yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"

    except Exception:
        logger.error(f"Agent error: {traceback.format_exc()}")
        yield f"data: {json.dumps({'type': 'error', 'code': 'agent', 'text': 'Agent failed'})}\n\n"


async def _codex_attempt(
    prompt: str,
    session_id: Optional[str] = None,
    model: Optional[str] = None,
    images: Optional[list[dict]] = None,
):
    """One `codex exec --json` run, mapped to the same SSE event contract as
    `_cli_attempt` (session / thinking / tool_use / tool_result / delta / done /
    error). Resumes `session_id` (codex thread_id) when provided.

    Codex emits JSONL: thread.started{thread_id}, turn.started, item.started /
    item.completed{item:{type: agent_message|reasoning|command_execution,...}},
    turn.completed{usage}, and error events.
    """
    # Codex reads image paths directly (-i FILE); no base64 inlining needed.
    img_args: list[str] = []
    for img in images or []:
        p = Path(img.get("path", "")).resolve()
        try:
            p.relative_to(UPLOADS_ROOT_RESOLVED)
        except ValueError:
            yield f"data: {json.dumps({'type': 'error', 'code': 'input', 'text': 'Image path outside uploads dir'})}\n\n"
            return
        if p.is_file():
            img_args += ["-i", str(p)]

    # Skip-permission mode: bypass approvals + sandbox, like claude's
    # --dangerously-skip-permissions. Codex can read/write/run freely.
    BYPASS = "--dangerously-bypass-approvals-and-sandbox"
    if session_id:
        cmd = [CODEX_BIN, "exec", "resume", session_id, "--json", "--skip-git-repo-check", BYPASS]
        cmd += img_args
        cmd.append(prompt)
    else:
        cmd = [CODEX_BIN, "exec", "--json", "--skip-git-repo-check", BYPASS]
        cfg = CODEX_MODELS.get(model or "", {})
        if cfg.get("model"):
            cmd += ["-m", cfg["model"]]
        if cfg.get("effort"):
            cmd += ["-c", f"model_reasoning_effort={cfg['effort']}"]
        cmd += img_args
        # Nudge output formatting to match the app's Markdown/KaTeX renderer.
        cmd.append(CLAUDE_SYSTEM_PROMPT + "\n\n" + prompt)

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=NOTES_ROOT,
            env=env,
            limit=10 * 1024 * 1024,
        )
    except FileNotFoundError as e:
        yield f"data: {json.dumps({'type': 'error', 'code': 'cli_unavailable', 'text': f'codex CLI unavailable: {e}'})}\n\n"
        return
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'code': 'spawn', 'text': str(e)})}\n\n"
        return

    new_session_id = session_id
    has_sent_text = False

    try:
        async for raw in proc.stdout:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue

            et = obj.get("type")

            if et == "thread.started":
                sid = obj.get("thread_id")
                if sid:
                    new_session_id = sid
                    yield f"data: {json.dumps({'type': 'session', 'session_id': sid})}\n\n"

            elif et == "item.started":
                item = obj.get("item", {})
                if item.get("type") == "command_execution":
                    tu = {
                        "type": "tool_use",
                        "id": item.get("id"),
                        "name": "Shell",
                        "input": {"command": item.get("command", "")},
                    }
                    yield f"data: {json.dumps(tu, ensure_ascii=False)}\n\n"

            elif et == "item.completed":
                item = obj.get("item", {})
                itype = item.get("type")
                if itype == "agent_message":
                    text = item.get("text", "")
                    if text:
                        if has_sent_text and not text.startswith("\n"):
                            text = "\n\n" + text
                        has_sent_text = True
                        yield f"data: {json.dumps({'type': 'delta', 'text': text}, ensure_ascii=False)}\n\n"
                elif itype == "reasoning":
                    text = item.get("text") or item.get("summary") or ""
                    if text:
                        yield f"data: {json.dumps({'type': 'thinking', 'text': text}, ensure_ascii=False)}\n\n"
                elif itype == "command_execution":
                    tr = {
                        "type": "tool_result",
                        "tool_use_id": item.get("id"),
                        "text": _normalize_tool_result(item.get("aggregated_output", "")),
                        "is_error": item.get("exit_code") not in (0, None),
                    }
                    yield f"data: {json.dumps(tr, ensure_ascii=False)}\n\n"

            elif et in ("turn.completed", "thread.completed"):
                yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"
                return

            elif et in ("error", "turn.failed", "thread.error"):
                msg = obj.get("message") or obj.get("error") or "codex error"
                if isinstance(msg, dict):
                    msg = msg.get("message") or str(msg)
                logger.error(f"[codex] error: {msg}")
                yield f"data: {json.dumps({'type': 'error', 'code': 'agent_error', 'text': msg})}\n\n"
                return

        # stream ended without an explicit terminal event
        rc = await proc.wait()
        if rc != 0:
            err = (await proc.stderr.read()).decode("utf-8", "replace").strip()[:TOOL_RESULT_MAX]
            logger.error(f"[codex] exited {rc}: {err}")
            yield f"data: {json.dumps({'type': 'error', 'code': 'agent_error', 'text': err or f'codex exited {rc}'})}\n\n"
            return
        yield f"data: {json.dumps({'type': 'done', 'session_id': new_session_id})}\n\n"

    except Exception:
        logger.error(f"Codex agent error: {traceback.format_exc()}")
        yield f"data: {json.dumps({'type': 'error', 'code': 'agent', 'text': 'Codex agent failed'})}\n\n"


async def run_agent_stream(
    prompt: str,
    session_id: Optional[str] = None,
    model: Optional[str] = None,
    images: Optional[list[dict]] = None,
):
    """Stream a turn as SSE, self-healing stale Claude CLI sessions.

    If resuming `session_id` fails or yields an empty turn (no content) — which
    happens when the CLI session has expired ("No conversation found") — retry
    once with a fresh session so the question still gets answered. The caller
    persists the new session_id, so the conversation continues from there.
    """
    attempt_fn = _codex_attempt if _is_codex_model(model) else _cli_attempt
    attempt_session = session_id
    for attempt_no in (1, 2):
        produced = False
        retry = False
        async for sse in attempt_fn(prompt, attempt_session, model, images):
            ev = _parse_sse_line(sse) or {}
            et = ev.get("type")
            if et in ("delta", "thinking", "tool_use", "tool_result"):
                produced = True
                yield sse
            elif et == "session":
                yield sse
            elif et in ("done", "error"):
                # Empty/failed resume: retry once with a fresh session.
                if attempt_session and not produced and attempt_no == 1:
                    retry = True
                    break
                yield sse
                return
            else:
                yield sse
        if retry:
            logger.warning(
                f"resume of session {attempt_session} produced no output "
                f"(likely expired); retrying with a fresh session"
            )
            attempt_session = None
            continue
        return


# --- Persistent background agent runner ---

def _parse_sse_line(sse: str) -> Optional[dict]:
    """Extract the JSON body from a 'data: {...}\n\n' SSE line."""
    if not sse.startswith("data: "):
        return None
    body = sse[6:]
    if body.endswith("\n\n"):
        body = body[:-2]
    try:
        return json.loads(body)
    except Exception:
        return None


def _build_assistant_msg_from_chunks(chunks: list[tuple[int, str, str]]) -> dict:
    """Reconstruct the front-end assistant message shape from stored chunks.

    Front-end schema: {role: 'assistant', text, thinking?, tools?, streaming: false}.
    Concatenates `delta` text and `thinking` payloads, and rebuilds the ordered
    `tools` list from tool_use / tool_result events (matched by id).
    """
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    tools: list[dict] = []
    tool_index: dict[str, int] = {}
    error: Optional[dict] = None
    for _seq, _type, payload in chunks:
        try:
            data = json.loads(payload)
        except Exception:
            continue
        et = data.get("type")
        if et == "delta":
            t = data.get("text")
            if t:
                text_parts.append(t)
        elif et == "thinking":
            t = data.get("text")
            if t:
                thinking_parts.append(t)
        elif et == "tool_use":
            tid = data.get("id")
            entry = {"id": tid, "name": data.get("name"), "input": data.get("input", {})}
            if tid is not None:
                tool_index[tid] = len(tools)
            tools.append(entry)
        elif et == "tool_result":
            tid = data.get("tool_use_id")
            idx = tool_index.get(tid)
            if idx is not None:
                tools[idx]["result"] = data.get("text", "")
                tools[idx]["is_error"] = bool(data.get("is_error"))
        elif et == "error":
            error = {"code": data.get("code") or "error", "text": data.get("text") or "unknown error"}
    msg: dict = {"role": "assistant", "text": "".join(text_parts), "streaming": False}
    if thinking_parts:
        msg["thinking"] = "".join(thinking_parts)
    if tools:
        msg["tools"] = tools
    if error:
        msg["error"] = error
    return msg


async def _write_provisional_conversation(
    save_conv_id: str,
    prompt: str,
    model: Optional[str],
    images: Optional[list[dict]] = None,
):
    """Persist the conversation at turn START: prior messages + the new user
    message + a streaming placeholder. This makes an in-flight turn visible in
    the sidebar and reopenable after a refresh (fixes: new topic mid-answer not
    in DB; existing topic's new question lost on refresh).

    The trailing placeholder is replaced with the real answer by
    _persist_conversation_after_turn when the turn completes.
    """
    existing = await chat_store.get_conversation(save_conv_id)
    prior_messages = (existing.get("messages") if existing else None) or []

    user_msg: dict = {"role": "user", "text": prompt}
    if images:
        user_msg["images"] = images
    placeholder: dict = {"role": "assistant", "text": "", "streaming": True}
    new_messages = list(prior_messages) + [user_msg, placeholder]

    if existing and existing.get("title"):
        title = existing["title"]
    else:
        title = (prompt[:48] + ("…" if len(prompt) > 48 else "")) if prompt else "New conversation"

    import time as _time
    updated_at = int(_time.time() * 1000)

    effective_model = _normalize_model(model)
    if not effective_model and existing:
        effective_model = existing.get("model")

    session_id = existing.get("sessionId") if existing else None

    await chat_store.upsert_conversation(
        conv_id=save_conv_id,
        title=title,
        messages=new_messages,
        updated_at=updated_at,
        session_id=session_id,
        model=effective_model,
    )


async def _persist_conversation_after_turn(
    req_conv_id: Optional[str],
    prompt: str,
    msg_id: str,
    session_id: Optional[str],
    model: Optional[str],
    images: Optional[list[dict]] = None,
):
    """Build the merged messages array for this turn and write to SQLite.

    conv_id is always provided by the frontend. session_id is looked up from
    the DB and may be updated if Claude CLI returns a new one.
    """
    save_conv_id = req_conv_id or msg_id

    chunks = await chat_store.get_chunks_after(msg_id, 0)
    assistant_msg = _build_assistant_msg_from_chunks(chunks)

    existing = await chat_store.get_conversation(save_conv_id)
    prior_messages = (existing.get("messages") if existing else None) or []

    if (
        len(prior_messages) >= 2
        and isinstance(prior_messages[-1], dict)
        and prior_messages[-1].get("role") == "assistant"
        and prior_messages[-1].get("streaming")
    ):
        # Provisional placeholder written at turn start — replace it in place
        # (the user message just before it is already persisted).
        new_messages = list(prior_messages[:-1]) + [assistant_msg]
    else:
        user_msg: dict = {"role": "user", "text": prompt}
        if images:
            user_msg["images"] = images
        new_messages = list(prior_messages) + [user_msg, assistant_msg]

    if existing and existing.get("title"):
        title = existing["title"]
    else:
        first_user_text = ""
        for m in new_messages:
            if m.get("role") == "user":
                first_user_text = m.get("text", "") or ""
                break
        title = first_user_text[:48] + ("…" if len(first_user_text) > 48 else "") \
            if first_user_text else "New conversation"

    import time as _time
    updated_at = int(_time.time() * 1000)

    effective_model = _normalize_model(model)
    if not effective_model and existing:
        effective_model = existing.get("model")

    old_sid = existing.get("sessionId") if existing else None
    if old_sid and session_id and old_sid != session_id:
        logger.warning(
            f"session_id overwrite: conv={save_conv_id} old={old_sid} new={session_id}"
        )

    await chat_store.upsert_conversation(
        conv_id=save_conv_id,
        title=title,
        messages=new_messages,
        updated_at=updated_at,
        session_id=session_id,
        model=effective_model,
    )


async def _run_agent_persistent(
    msg_id: str,
    prompt: str,
    session_id: Optional[str],
    conv_id: Optional[str],
    model: Optional[str],
    images: Optional[list[dict]] = None,
):
    """Drive run_agent_stream and persist every event to chat_store.

    Runs as a detached asyncio task: keeps going even if the HTTP client
    disconnects, so the subprocess output is never lost.
    """
    new_session_id = session_id
    status = "done"
    error_text: Optional[str] = None

    try:
        async for sse_line in run_agent_stream(prompt, session_id, model, images):
            event = _parse_sse_line(sse_line)
            if event is None:
                continue

            etype = event.get("type")
            if etype == "session" and event.get("session_id"):
                new_session_id = event["session_id"]
            elif etype == "done" and event.get("session_id"):
                new_session_id = event["session_id"]
            elif etype == "error":
                status = "error"
                error_text = event.get("text")

            # Persist every event (including done/error) so tailers see the
            # terminal transition even if they joined late.
            await chat_store.append_chunk(msg_id, etype or "unknown", event)
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except Exception as e:
        status = "error"
        error_text = str(e)
        logger.error(f"persistent agent failed: {traceback.format_exc()}")
        try:
            await chat_store.append_chunk(
                msg_id, "error", {"type": "error", "text": error_text}
            )
        except Exception:
            pass
    finally:
        await chat_store.finish_message(
            msg_id,
            status=status,
            session_id=new_session_id,
            error_text=error_text,
        )
        # Backend-authoritative conversation persistence. On a clean turn this
        # writes the real answer; on an error turn it writes the assistant
        # message carrying the error (code + text) so the failure survives a
        # hard refresh instead of collapsing back to an empty bubble. Only
        # "cancelled" is skipped (leaves the provisional placeholder as-is).
        # Wrapped so persistence bugs can't break SSE delivery.
        if status in ("done", "error"):
            if status == "done" and session_id != new_session_id:
                logger.warning(
                    f"session_id changed during turn: "
                    f"conv_id={conv_id} original={session_id} new={new_session_id}"
                )
            try:
                await _persist_conversation_after_turn(
                    conv_id, prompt, msg_id, new_session_id, model, images
                )
            except Exception:
                logger.error(
                    f"auto conversation persist failed for msg {msg_id}: "
                    f"{traceback.format_exc()}"
                )
        _agent_tasks.pop(msg_id, None)


async def _tail_message(msg_id: str, after_seq: int = 0):
    """SSE generator that tails chat_store chunks for a given message.

    Yields every chunk strictly greater than `after_seq`, then blocks on the
    store's Condition until new chunks arrive or the message reaches a terminal
    status. Multiple tailers (e.g. two browser tabs) can run concurrently on
    the same msg_id.
    """
    while True:
        chunks = await chat_store.get_chunks_after(msg_id, after_seq)
        for seq, _type, payload in chunks:
            after_seq = seq
            yield f"data: {payload}\n\n"

        msg = await chat_store.get_message(msg_id)
        if msg is None:
            return
        if msg["status"] != "streaming":
            # Drain anything written between the last fetch and the status
            # update so the terminal event is always delivered.
            chunks = await chat_store.get_chunks_after(msg_id, after_seq)
            for seq, _type, payload in chunks:
                after_seq = seq
                yield f"data: {payload}\n\n"
            return

        await chat_store.wait_for_update(msg_id, timeout=30.0)


# --- Routes ---

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    conv_id: Optional[str] = None
    msg_id: Optional[str] = None
    model: Optional[str] = None
    # images: list of {"path": str, "mime": str}. Paths must live under UPLOADS_DIR.
    images: Optional[list[dict]] = None


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
    """SSE stream backed by SQLite.

    The claude subprocess runs as a detached asyncio task that persists every
    event to chat_store. The HTTP response just tails the store — so if the
    browser disconnects, the background task keeps writing and a later
    /v1/chat/resume/{msg_id} call picks up where we left off.
    """
    verify_token(authorization)

    # Validate images up-front so the caller gets a 4xx instead of an in-stream error.
    images = req.images or None
    if images:
        for img in images:
            if not isinstance(img, dict) or "path" not in img or "mime" not in img:
                raise HTTPException(status_code=400, detail="Each image needs {path, mime}")
            try:
                p = Path(img["path"]).resolve()
                p.relative_to(UPLOADS_ROOT_RESOLVED)
            except ValueError:
                raise HTTPException(status_code=403, detail="Image path outside uploads dir")
            if not p.is_file():
                raise HTTPException(status_code=404, detail=f"Image not found: {img['path']}")

    conv_id = req.conv_id or "default"

    # Look up the conversation first — a started chat is locked to one backend
    # (claude vs codex sessions are not interchangeable). Switching backends
    # mid-conversation is forbidden by design; reject it before creating any
    # message row. The frontend disables cross-backend options, so this only
    # trips a stale client or a direct API call.
    existing_conv = await chat_store.get_conversation(conv_id)
    session_id = existing_conv.get("sessionId") if existing_conv else None
    if existing_conv and (existing_conv.get("messages") or session_id):
        prev_backend = "codex" if _is_codex_model(existing_conv.get("model")) else "claude"
        new_backend = "codex" if _is_codex_model(req.model) else "claude"
        if prev_backend != new_backend:
            raise HTTPException(
                status_code=409,
                detail=f"This chat is running on {prev_backend}; start a new chat to use {new_backend}.",
            )

    msg_id = await chat_store.create_message(conv_id, req.msg_id)

    # Persist a provisional conversation (user message + streaming placeholder)
    # so a refresh mid-answer can find and reopen this turn.
    save_conv_id = req.conv_id or msg_id
    try:
        await _write_provisional_conversation(save_conv_id, req.message, req.model, images)
    except Exception:
        logger.warning(f"provisional conv write failed: {traceback.format_exc()}")

    task = asyncio.create_task(
        _run_agent_persistent(
            msg_id, req.message, session_id, req.conv_id, req.model, images
        )
    )
    _agent_tasks[msg_id] = task

    async def stream():
        yield (
            "data: "
            + json.dumps(
                {"type": "message_start", "msg_id": msg_id, "conv_id": conv_id},
                ensure_ascii=False,
            )
            + "\n\n"
        )
        async for chunk in _tail_message(msg_id, after_seq=0):
            yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/v1/chat/resume/{msg_id}")
@limiter.limit("60/minute")
async def resume_chat(
    request: Request,
    msg_id: str,
    after_seq: int = 0,
    authorization: Optional[str] = Header(None),
):
    """Replay + live-tail a message by id. Safe to call after a disconnect."""
    verify_token(authorization)

    msg = await chat_store.get_message(msg_id)
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")

    async def stream():
        yield (
            "data: "
            + json.dumps(
                {
                    "type": "message_start",
                    "msg_id": msg_id,
                    "conv_id": msg["conv_id"],
                    "status": msg["status"],
                    "resumed": True,
                },
                ensure_ascii=False,
            )
            + "\n\n"
        )
        async for chunk in _tail_message(msg_id, after_seq=after_seq):
            yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/v1/chat/pending/{conv_id}")
@limiter.limit("60/minute")
async def pending_message(
    request: Request,
    conv_id: str,
    authorization: Optional[str] = Header(None),
):
    verify_token(authorization)
    msg_id = await chat_store.get_streaming_msg(conv_id)
    return {"msg_id": msg_id}


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


# --- Image upload & serve ---

_IMAGE_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
}


@app.post("/v1/upload")
@limiter.limit("60/minute")
async def upload_image(
    request: Request,
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
):
    """Accept a single image file (<10MB) and store it under uploads/YYYY-MM-DD/."""
    verify_token(authorization)

    mime = (file.content_type or "").lower()
    if not mime.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"Not an image (content-type={mime})")

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_BYTES} bytes)")

    ext = _IMAGE_EXT_BY_MIME.get(mime)
    if not ext:
        # Fall back to the upload's filename extension if we don't know the mime.
        ext = Path(file.filename or "").suffix.lower() or ".bin"

    day = datetime.utcnow().strftime("%Y-%m-%d")
    day_dir = UPLOADS_DIR / day
    day_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    dest = day_dir / name
    dest.write_bytes(data)

    rel = f"{day}/{name}"
    abs_path = str(dest.resolve())
    logger.info(f"[upload] {rel} ({len(data)} bytes, {mime})")
    return {
        "path": abs_path,
        "mime": mime,
        "url": f"/v1/uploads/{rel}",
    }


@app.get("/v1/uploads/{path:path}")
@limiter.limit("120/minute")
async def serve_upload(
    request: Request,
    path: str,
    authorization: Optional[str] = Header(None),
):
    """Serve an uploaded image. Auth via Authorization header only — frontend
    fetches with the header and wraps the response in a blob URL."""
    verify_token(authorization)

    # Reject traversal: resolve and confirm result is still under uploads root.
    if ".." in path.split("/"):
        raise HTTPException(status_code=403, detail="Access denied")
    target = (UPLOADS_DIR / path).resolve()
    try:
        target.relative_to(UPLOADS_ROOT_RESOLVED)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    mime, _ = mimetypes.guess_type(str(target))
    return FileResponse(str(target), media_type=mime or "application/octet-stream")


@app.get("/v1/notes")
@limiter.limit("60/minute")
async def list_notes(request: Request, path: str = "", authorization: Optional[str] = Header(None)):
    """List markdown files under NOTES_ROOT/path."""
    verify_token(authorization)
    base = Path(NOTES_ROOT) / path
    if not base.exists() or not base.is_dir():
        raise HTTPException(status_code=404, detail="Path not found")

    def _scan():
        import subprocess
        # Use find via subprocess — runs in its own process, won't block the event loop
        result = subprocess.run(
            ["find", str(base), "-name", "*.md", "-type", "f"],
            capture_output=True, text=True, timeout=10
        )
        files = []
        for line in sorted(result.stdout.splitlines()):
            p = Path(line.strip())
            try:
                files.append(str(p.relative_to(NOTES_ROOT)))
            except ValueError:
                pass
        return files

    try:
        files = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, _scan),
            timeout=10
        )
    except Exception as e:
        logger.warning(f"[notes] scan failed: {e}")
        files = []

    logger.info(f"[notes] count={len(files)}")
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


def _attach_image_urls(conversations: list[dict]) -> list[dict]:
    """Backfill image.url from image.path for messages persisted before the
    AuthImage migration — historical records only stored {path, mime}."""
    for conv in conversations:
        for msg in conv.get("messages") or []:
            for img in msg.get("images") or []:
                if img.get("url") or not img.get("path"):
                    continue
                try:
                    rel = Path(img["path"]).resolve().relative_to(UPLOADS_ROOT_RESOLVED)
                except (ValueError, OSError):
                    continue
                img["url"] = f"/v1/uploads/{rel.as_posix()}"
    return conversations


@app.get("/v1/conversations")
@limiter.limit("60/minute")
async def list_conversations(request: Request, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    items = await chat_store.list_conversations(limit=100)
    items = _attach_image_urls(items)
    # Mark which conversations have an in-flight run so the sidebar can show a
    # live "running" dot regardless of which chat is open.
    running = await chat_store.get_running_conv_ids()
    for it in items:
        it["running"] = it.get("id") in running
    return {"conversations": items}


def _clean_title(text: str) -> str:
    """Normalize a model-generated title: one line, no wrapping quotes, ≤60 chars."""
    t = (text or "").strip()
    # take the first non-empty line
    for line in t.splitlines():
        if line.strip():
            t = line.strip()
            break
    # strip common wrapping quotes / trailing punctuation
    t = t.strip().strip('"“”‘’\'`').strip()
    t = t.rstrip(".。!！?？").strip()
    if len(t) > 60:
        t = t[:60].rstrip() + "…"
    return t


TITLE_PROMPT = (
    "Based on our conversation so far, give it a concise title of at most 6 words, "
    "in the same language as the conversation. Reply with ONLY the title text — "
    "no quotes, no surrounding punctuation, no preamble, no explanation."
)


@app.post("/v1/conversations/{conv_id}/generate-title")
@limiter.limit("20/minute")
async def generate_title(request: Request, conv_id: str, authorization: Optional[str] = Header(None)):
    """Ask the conversation's own session (resume) for a short title, then set it
    as the conversation name. Does not add a visible turn to the transcript."""
    verify_token(authorization)
    conv = await chat_store.get_conversation(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="conversation not found")
    session_id = conv.get("sessionId")
    if not session_id:
        raise HTTPException(status_code=409, detail="conversation has no session yet")
    model = conv.get("model")

    parts: list[str] = []
    new_session_id = session_id
    async for sse in run_agent_stream(TITLE_PROMPT, session_id, model, None):
        ev = _parse_sse_line(sse) or {}
        et = ev.get("type")
        if et == "delta":
            parts.append(ev.get("text", ""))
        elif et in ("session", "done") and ev.get("session_id"):
            new_session_id = ev["session_id"]
        elif et == "error":
            raise HTTPException(status_code=502, detail=ev.get("text") or "title generation failed")

    title = _clean_title("".join(parts))
    if not title:
        raise HTTPException(status_code=502, detail="empty title")

    import time as _time
    await chat_store.upsert_conversation(
        conv_id=conv_id,
        title=title,
        messages=conv.get("messages") or [],
        updated_at=int(_time.time() * 1000),
        session_id=new_session_id,
        model=model,
    )
    return {"title": title}


@app.get("/v1/conversations/{conv_id}")
@limiter.limit("120/minute")
async def get_conversation(request: Request, conv_id: str, authorization: Optional[str] = Header(None)):
    """Current server-side state of one conversation, including the provisional
    user message + streaming placeholder written at the start of an in-flight
    turn. Used when opening a chat so a mid-flight question isn't stale."""
    verify_token(authorization)
    conv = await chat_store.get_conversation(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="conversation not found")
    conv = _attach_image_urls([conv])[0]
    running = await chat_store.get_running_conv_ids()
    conv["running"] = conv.get("id") in running
    return {"conversation": conv}


@app.delete("/v1/conversations/{conv_id}")
@limiter.limit("30/minute")
async def delete_conversation(request: Request, conv_id: str, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    await chat_store.delete_conversation(conv_id)
    return {"ok": True}


# ── Code sandbox ──────────────────────────────────────────────

def _safe_code_path(path: str) -> Path:
    """Resolve path under CODE_ROOT, reject traversal."""
    target = (Path(CODE_ROOT) / path).resolve()
    if not str(target).startswith(str(Path(CODE_ROOT).resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    return target


@app.get("/v1/files")
@limiter.limit("60/minute")
async def list_files(request: Request, path: str = "", authorization: Optional[str] = Header(None)):
    """List files/dirs under CODE_ROOT/path."""
    verify_token(authorization)
    base = _safe_code_path(path)
    if not base.exists() or not base.is_dir():
        raise HTTPException(status_code=404, detail="Path not found")

    entries = []
    for p in sorted(base.iterdir()):
        if p.name.startswith("."):
            continue
        entries.append({
            "name": p.name,
            "path": str(p.relative_to(CODE_ROOT)),
            "is_dir": p.is_dir(),
        })
    return {"entries": entries, "root": CODE_ROOT}


@app.get("/v1/files/read")
@limiter.limit("60/minute")
async def read_file(request: Request, path: str = "", authorization: Optional[str] = Header(None)):
    """Read a file under CODE_ROOT."""
    verify_token(authorization)
    target = _safe_code_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return {"path": path, "content": target.read_text(errors="replace")}


class WriteFileRequest(BaseModel):
    path: str
    content: str


@app.put("/v1/files/write")
@limiter.limit("60/minute")
async def write_file(request: Request, body: WriteFileRequest, authorization: Optional[str] = Header(None)):
    """Write/overwrite a file under CODE_ROOT."""
    verify_token(authorization)
    target = _safe_code_path(body.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content)
    return {"ok": True}


class ExecuteRequest(BaseModel):
    code: str
    session_id: str = "default"


@app.post("/v1/execute")
@limiter.limit("30/minute")
async def execute_code(request: Request, body: ExecuteRequest, authorization: Optional[str] = Header(None)):
    """Execute Python code in a persistent kernel, SSE stream output."""
    verify_token(authorization)

    async def stream():
        try:
            kernel = await kernel_manager.get(body.session_id)
            async for ev in kernel.execute(body.code):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'type': 'stderr', 'text': 'Execution timed out (60s)'})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'stderr', 'text': str(e)})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/v1/kernel/reset")
@limiter.limit("30/minute")
async def reset_kernel(request: Request, session_id: str = "default", authorization: Optional[str] = Header(None)):
    """Reset kernel state (clear variables) for a session."""
    verify_token(authorization)
    await kernel_manager.reset(session_id)
    return {"ok": True}


@app.get("/v1/jupyter-token")
async def jupyter_token(authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    token = os.environ.get("JUPYTER_TOKEN", "")
    base_url = os.environ.get("JUPYTER_BASE_URL", "/jupyter/")
    if not token:
        raise HTTPException(status_code=503, detail="Jupyter not configured")
    return {"token": token, "base_url": base_url}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
