from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Optional


SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    msg_id TEXT PRIMARY KEY,
    conv_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'streaming',
    session_id TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error_text TEXT
);

CREATE TABLE IF NOT EXISTS message_chunks (
    msg_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (msg_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv
    ON messages(conv_id, started_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
    conv_id TEXT PRIMARY KEY,
    title TEXT,
    messages TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    session_id TEXT,
    model TEXT
);

CREATE INDEX IF NOT EXISTS idx_conv_updated
    ON conversations(updated_at DESC);
"""


def _conv_row_to_dict(row) -> dict:
    return {
        "id": row[0],
        "title": row[1],
        "messages": json.loads(row[2]) if row[2] else [],
        "updatedAt": row[3],
        "sessionId": row[4],
        "model": row[5] if len(row) > 5 else None,
    }


TERMINAL_STATUSES = ("done", "error", "cancelled")


def _now_ms() -> int:
    return int(time.time() * 1000)


class ChatStore:
    """SQLite-backed per-message chunk log with async notifications.

    Writes are serialised through sqlite3 (WAL) and the event loop is kept
    unblocked via asyncio.to_thread. Each msg_id has an asyncio.Condition that
    is notified on every append / terminal transition so tailers can wake up
    without polling.
    """

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conditions: dict[str, asyncio.Condition] = {}
        self._init_schema()

    # --- connection helpers ----------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=10.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_schema(self):
        conn = self._conn()
        try:
            conn.executescript(SCHEMA)
            cols = {r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()}
            if "model" not in cols:
                conn.execute("ALTER TABLE conversations ADD COLUMN model TEXT")
            n = conn.execute(
                "UPDATE messages SET status='error', error_text='server restarted', "
                "finished_at=CAST(strftime('%%s','now')*1000 AS INTEGER) "
                "WHERE status='streaming'"
            ).rowcount
            conn.commit()
            if n:
                import logging
                logging.getLogger("chat_store").warning(f"cleaned up {n} orphaned streaming message(s)")
        finally:
            conn.close()

    def _condition(self, msg_id: str) -> asyncio.Condition:
        cond = self._conditions.get(msg_id)
        if cond is None:
            cond = asyncio.Condition()
            self._conditions[msg_id] = cond
        return cond

    async def _notify(self, msg_id: str):
        cond = self._condition(msg_id)
        async with cond:
            cond.notify_all()

    # --- sync DB ops (invoked via asyncio.to_thread) ---------------------

    def _create_message_sync(self, conv_id: str, msg_id: str):
        conn = self._conn()
        try:
            conn.execute(
                "INSERT INTO messages (msg_id, conv_id, status, started_at) "
                "VALUES (?, ?, 'streaming', ?)",
                (msg_id, conv_id, _now_ms()),
            )
            conn.commit()
        finally:
            conn.close()

    def _append_chunk_sync(self, msg_id: str, type_: str, payload: dict) -> int:
        conn = self._conn()
        try:
            cur = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM message_chunks WHERE msg_id=?",
                (msg_id,),
            )
            seq = cur.fetchone()[0]
            conn.execute(
                "INSERT INTO message_chunks (msg_id, seq, type, payload, ts) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    msg_id,
                    seq,
                    type_,
                    json.dumps(payload, ensure_ascii=False),
                    _now_ms(),
                ),
            )
            conn.commit()
            return seq
        finally:
            conn.close()

    def _finish_message_sync(
        self,
        msg_id: str,
        status: str,
        session_id: Optional[str],
        error_text: Optional[str],
    ):
        conn = self._conn()
        try:
            conn.execute(
                "UPDATE messages SET status=?, session_id=COALESCE(?, session_id), "
                "finished_at=?, error_text=? WHERE msg_id=?",
                (status, session_id, _now_ms(), error_text, msg_id),
            )
            conn.commit()
        finally:
            conn.close()

    def _get_message_sync(self, msg_id: str) -> Optional[dict]:
        conn = self._conn()
        try:
            row = conn.execute(
                "SELECT msg_id, conv_id, status, session_id, started_at, "
                "finished_at, error_text FROM messages WHERE msg_id=?",
                (msg_id,),
            ).fetchone()
            if not row:
                return None
            return {
                "msg_id": row[0],
                "conv_id": row[1],
                "status": row[2],
                "session_id": row[3],
                "started_at": row[4],
                "finished_at": row[5],
                "error_text": row[6],
            }
        finally:
            conn.close()

    def _get_chunks_after_sync(
        self, msg_id: str, after_seq: int
    ) -> list[tuple[int, str, str]]:
        conn = self._conn()
        try:
            return conn.execute(
                "SELECT seq, type, payload FROM message_chunks "
                "WHERE msg_id=? AND seq>? ORDER BY seq",
                (msg_id, after_seq),
            ).fetchall()
        finally:
            conn.close()

    def _get_streaming_msg_sync(self, conv_id: str) -> Optional[str]:
        conn = self._conn()
        try:
            row = conn.execute(
                "SELECT msg_id FROM messages WHERE conv_id=? AND status='streaming' "
                "ORDER BY started_at DESC LIMIT 1",
                (conv_id,),
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    # --- async API --------------------------------------------------------

    async def create_message(
        self, conv_id: str, msg_id: Optional[str] = None
    ) -> str:
        msg_id = msg_id or uuid.uuid4().hex
        await asyncio.to_thread(self._create_message_sync, conv_id, msg_id)
        return msg_id

    async def append_chunk(self, msg_id: str, type_: str, payload: dict) -> int:
        seq = await asyncio.to_thread(self._append_chunk_sync, msg_id, type_, payload)
        await self._notify(msg_id)
        return seq

    async def finish_message(
        self,
        msg_id: str,
        status: str = "done",
        session_id: Optional[str] = None,
        error_text: Optional[str] = None,
    ):
        await asyncio.to_thread(
            self._finish_message_sync, msg_id, status, session_id, error_text
        )
        await self._notify(msg_id)

    async def get_message(self, msg_id: str) -> Optional[dict]:
        return await asyncio.to_thread(self._get_message_sync, msg_id)

    async def get_streaming_msg(self, conv_id: str) -> Optional[str]:
        return await asyncio.to_thread(self._get_streaming_msg_sync, conv_id)

    async def get_chunks_after(
        self, msg_id: str, after_seq: int
    ) -> list[tuple[int, str, str]]:
        return await asyncio.to_thread(
            self._get_chunks_after_sync, msg_id, after_seq
        )

    async def wait_for_update(self, msg_id: str, timeout: float = 30.0) -> bool:
        cond = self._condition(msg_id)
        async with cond:
            try:
                await asyncio.wait_for(cond.wait(), timeout=timeout)
                return True
            except asyncio.TimeoutError:
                return False

    # --- conversations (shadow persistence; JSON remains primary) ---------

    def _upsert_conversation_sync(
        self,
        conv_id: str,
        title: Optional[str],
        messages: list,
        updated_at: int,
        session_id: Optional[str],
        model: Optional[str],
    ):
        conn = self._conn()
        try:
            conn.execute(
                "INSERT INTO conversations (conv_id, title, messages, updated_at, session_id, model) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(conv_id) DO UPDATE SET "
                "title=excluded.title, messages=excluded.messages, "
                "updated_at=excluded.updated_at, session_id=excluded.session_id, "
                "model=excluded.model",
                (
                    conv_id,
                    title,
                    json.dumps(messages, ensure_ascii=False),
                    updated_at,
                    session_id,
                    model,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _list_conversations_sync(self, limit: int) -> list[dict]:
        conn = self._conn()
        try:
            rows = conn.execute(
                "SELECT conv_id, title, messages, updated_at, session_id, model "
                "FROM conversations ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [_conv_row_to_dict(r) for r in rows]
        finally:
            conn.close()

    def _get_conversation_sync(self, conv_id: str) -> Optional[dict]:
        conn = self._conn()
        try:
            row = conn.execute(
                "SELECT conv_id, title, messages, updated_at, session_id, model "
                "FROM conversations WHERE conv_id=?",
                (conv_id,),
            ).fetchone()
            return _conv_row_to_dict(row) if row else None
        finally:
            conn.close()

    def _delete_conversation_sync(self, conv_id: str) -> bool:
        conn = self._conn()
        try:
            cur = conn.execute(
                "DELETE FROM conversations WHERE conv_id=?", (conv_id,)
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    def _bulk_import_conversations_sync(self, items: list[dict]) -> int:
        conn = self._conn()
        try:
            count = 0
            for item in items:
                conv_id = item.get("id")
                if not conv_id:
                    continue
                messages = item.get("messages") or []
                conn.execute(
                    "INSERT OR IGNORE INTO conversations "
                    "(conv_id, title, messages, updated_at, session_id, model) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        conv_id,
                        item.get("title"),
                        json.dumps(messages, ensure_ascii=False),
                        int(item.get("updatedAt") or 0),
                        item.get("sessionId"),
                        item.get("model"),
                    ),
                )
                count += 1
            conn.commit()
            return count
        finally:
            conn.close()

    def _count_conversations_sync(self) -> int:
        conn = self._conn()
        try:
            row = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()

    async def upsert_conversation(
        self,
        conv_id: str,
        title: Optional[str],
        messages: list,
        updated_at: int,
        session_id: Optional[str],
        model: Optional[str] = None,
    ):
        await asyncio.to_thread(
            self._upsert_conversation_sync,
            conv_id,
            title,
            messages,
            updated_at,
            session_id,
            model,
        )

    async def list_conversations(self, limit: int = 100) -> list[dict]:
        return await asyncio.to_thread(self._list_conversations_sync, limit)

    async def get_conversation(self, conv_id: str) -> Optional[dict]:
        return await asyncio.to_thread(self._get_conversation_sync, conv_id)

    async def delete_conversation(self, conv_id: str) -> bool:
        return await asyncio.to_thread(self._delete_conversation_sync, conv_id)

    async def bulk_import_conversations(self, items: list[dict]) -> int:
        return await asyncio.to_thread(
            self._bulk_import_conversations_sync, items
        )

    async def count_conversations(self) -> int:
        return await asyncio.to_thread(self._count_conversations_sync)
