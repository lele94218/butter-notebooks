"""STT module — copied from butter-voice-bridge, no modifications."""
import asyncio
import os
from pathlib import Path

import httpx
from fastapi import HTTPException

WHISPER_CMD = os.environ.get("WHISPER_CMD", "whisper")
_raw_openai_key = os.environ.get("OPENAI_API_KEY", "")
OPENAI_API_KEY = _raw_openai_key if _raw_openai_key.startswith("sk-") else ""
WHISPER_API_MODEL = os.environ.get("WHISPER_API_MODEL", "whisper-1")


async def whisper_transcribe(audio_path: str) -> str:
    if OPENAI_API_KEY:
        return await _transcribe_api(audio_path)
    return await _transcribe_local(audio_path)


async def _transcribe_api(audio_path: str) -> str:
    audio_bytes = Path(audio_path).read_bytes()
    filename = Path(audio_path).name
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={"file": (filename, audio_bytes, "audio/m4a")},
            data={"model": WHISPER_API_MODEL},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=500, detail=f"Whisper API error: {resp.text}")
        return resp.json().get("text", "").strip()


async def _transcribe_local(audio_path: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        WHISPER_CMD, audio_path,
        "--model", "large-v3-turbo",
        "--language", "zh",
        "--task", "transcribe",
        "--output_format", "txt",
        "--output_dir", str(Path(audio_path).parent),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Whisper failed: {stderr.decode()}")
    txt_path = Path(audio_path).with_suffix(".txt")
    if not txt_path.exists():
        raise HTTPException(status_code=500, detail="Whisper produced no output")
    return txt_path.read_text().strip()
