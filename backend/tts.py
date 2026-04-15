"""TTS module — copied from butter-voice-bridge, no modifications."""
import os
import re

import edge_tts
import httpx

TTS_VOICE_ZH = os.environ.get("TTS_VOICE_ZH", "zh-CN-XiaoxiaoNeural")
TTS_VOICE_EN = os.environ.get("TTS_VOICE_EN", "en-US-JennyNeural")
TTS_ENGINE = os.environ.get("TTS_ENGINE", "edge").lower()
OPENAI_TTS_VOICE = os.environ.get("OPENAI_TTS_VOICE", "nova")
OPENAI_TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "tts-1")
_raw_openai_key = os.environ.get("OPENAI_API_KEY", "")
OPENAI_API_KEY = _raw_openai_key if _raw_openai_key.startswith("sk-") else ""


def detect_voice(text: str) -> str:
    if not text:
        return TTS_VOICE_ZH
    zh_count = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    ratio = zh_count / len(text)
    return TTS_VOICE_ZH if ratio > 0.15 else TTS_VOICE_EN


async def _synthesize_edge(text: str, voice: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice)
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


async def _synthesize_openai(text: str) -> bytes:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": OPENAI_TTS_MODEL, "voice": OPENAI_TTS_VOICE, "input": text, "response_format": "mp3"},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"OpenAI TTS error {resp.status_code}: {resp.text}")
        return resp.content


async def synthesize_speech(text: str, voice: str = None) -> bytes:
    if TTS_ENGINE == "openai":
        return await _synthesize_openai(text)
    voice = voice or detect_voice(text)
    return await _synthesize_edge(text, voice)


def strip_markdown_for_tts(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    text = re.sub(r"~~(.+?)~~", r"\1", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*>\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"---+", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[\U00010000-\U0010ffff]", "", text, flags=re.UNICODE)
    text = re.sub(r"[\U00002600-\U000027BF]", "", text)
    text = re.sub(r"[\U0001F300-\U0001F9FF]", "", text)
    text = re.sub(r"[\U00002702-\U000027B0]", "", text)
    text = re.sub(r" +", " ", text)
    return text.strip()
