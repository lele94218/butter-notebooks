"""
kernel_manager.py — manages per-session Python kernel subprocesses.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

SANDBOX_PYTHON = os.environ.get(
    "SANDBOX_PYTHON",
    str(Path(__file__).parent / "sandbox-venv" / "bin" / "python"),
)
KERNEL_SCRIPT = str(Path(__file__).parent / "kernel.py")
KERNEL_IDLE_TIMEOUT = int(os.environ.get("KERNEL_IDLE_TIMEOUT", "1800"))  # 30 min


class Kernel:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.proc: asyncio.subprocess.Process | None = None
        self.last_used = time.time()
        self._lock = asyncio.Lock()

    async def start(self):
        python = SANDBOX_PYTHON if Path(SANDBOX_PYTHON).exists() else "python3"
        self.proc = await asyncio.create_subprocess_exec(
            python, KERNEL_SCRIPT,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info(f"[kernel] started session={self.session_id} pid={self.proc.pid}")

    async def execute(self, code: str):
        """Send code, yield output events as dicts."""
        async with self._lock:
            self.last_used = time.time()
            if not self.proc or self.proc.returncode is not None:
                await self.start()

            cmd = json.dumps({"action": "execute", "code": code}) + "\n"
            self.proc.stdin.write(cmd.encode())
            await self.proc.stdin.drain()

            while True:
                line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=60)
                if not line:
                    break
                try:
                    ev = json.loads(line.decode().strip())
                except Exception:
                    continue
                yield ev
                if ev.get("type") == "done":
                    break

    async def reset(self):
        async with self._lock:
            if self.proc and self.proc.returncode is None:
                cmd = json.dumps({"action": "reset"}) + "\n"
                self.proc.stdin.write(cmd.encode())
                await self.proc.stdin.drain()
                try:
                    await asyncio.wait_for(self.proc.stdout.readline(), timeout=5)
                except Exception:
                    pass
            self.last_used = time.time()

    async def kill(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()
            await self.proc.wait()
        logger.info(f"[kernel] killed session={self.session_id}")

    @property
    def idle_seconds(self) -> float:
        return time.time() - self.last_used


class KernelManager:
    def __init__(self):
        self._kernels: dict[str, Kernel] = {}
        self._cleanup_task: asyncio.Task | None = None

    def start_cleanup(self):
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(300)  # check every 5 min
            expired = [
                sid for sid, k in self._kernels.items()
                if k.idle_seconds > KERNEL_IDLE_TIMEOUT
            ]
            for sid in expired:
                await self._kernels[sid].kill()
                del self._kernels[sid]
                logger.info(f"[kernel] expired session={sid}")

    async def get(self, session_id: str) -> Kernel:
        if session_id not in self._kernels:
            k = Kernel(session_id)
            await k.start()
            self._kernels[session_id] = k
        return self._kernels[session_id]

    async def reset(self, session_id: str):
        if session_id in self._kernels:
            await self._kernels[session_id].reset()

    async def kill(self, session_id: str):
        if session_id in self._kernels:
            await self._kernels[session_id].kill()
            del self._kernels[session_id]

    async def shutdown(self):
        for k in self._kernels.values():
            await k.kill()
        self._kernels.clear()


kernel_manager = KernelManager()
