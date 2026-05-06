"""
kernel.py — runs as a subprocess worker.
Reads JSON commands from stdin, writes JSON responses to stdout.
Maintains a persistent exec namespace so variables survive between runs.
"""
from __future__ import annotations

import base64
import io
import json
import sys
import traceback

# Shared namespace — persists across exec() calls
_ns: dict = {}

# Reference to the real JSON output stream (set in main() before any execute)
_out: "io.TextIOWrapper | None" = None


def _write_event(ev: dict) -> None:
    """Write a single JSON event line to the real kernel stdout."""
    if _out is not None:
        _out.write(json.dumps(ev, ensure_ascii=False) + "\n")
        _out.flush()


class _StreamWriter(io.TextIOBase):
    """Wraps sys.stdout/stderr during exec() and streams output in real-time.

    Buffers within a line (flushes on '\\n') to keep event count manageable
    while still showing output as it's produced.
    """

    def __init__(self, event_type: str) -> None:
        self._type = event_type
        self._buf = ""

    def write(self, s: str) -> int:  # type: ignore[override]
        if not s:
            return 0
        self._buf += s
        # Emit a complete line as soon as we see a newline
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            _write_event({"type": self._type, "text": line + "\n"})
        return len(s)

    def flush(self) -> None:
        # Called by print(flush=True) etc. — emit whatever is buffered
        if self._buf:
            _write_event({"type": self._type, "text": self._buf})
            self._buf = ""

    def flush_remaining(self) -> None:
        """Emit any trailing text that didn't end with a newline."""
        if self._buf:
            _write_event({"type": self._type, "text": self._buf})
            self._buf = ""

    # TextIOBase protocol
    def readable(self) -> bool:
        return False

    def writable(self) -> bool:
        return True


def _capture_figure() -> str | None:
    """If matplotlib has open figures, render the last one to PNG base64."""
    try:
        import matplotlib.pyplot as plt
        if not plt.get_fignums():
            return None
        buf = io.BytesIO()
        plt.savefig(buf, format="png", bbox_inches="tight", dpi=120)
        plt.close("all")
        buf.seek(0)
        return base64.b64encode(buf.read()).decode("ascii")
    except Exception:
        return None


def _run(code: str) -> None:
    """Execute code, streaming stdout/stderr events in real-time."""
    old_stdout, old_stderr = sys.stdout, sys.stderr
    stdout_writer = _StreamWriter("stdout")
    stderr_writer = _StreamWriter("stderr")
    sys.stdout = stdout_writer  # type: ignore[assignment]
    sys.stderr = stderr_writer  # type: ignore[assignment]

    try:
        exec(compile(code, "<sandbox>", "exec"), _ns)  # noqa: S102
    except SystemExit:
        pass
    except Exception:
        tb = traceback.format_exc()
        sys.stderr.write(tb)
    finally:
        stdout_writer.flush_remaining()
        stderr_writer.flush_remaining()
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    # Matplotlib figures can only be captured after exec() completes
    img = _capture_figure()
    if img:
        _write_event({"type": "image", "data": img})


def main() -> None:
    global _out

    # Use line-buffered I/O
    stdin  = io.TextIOWrapper(sys.stdin.buffer,  line_buffering=True)
    stdout = io.TextIOWrapper(sys.stdout.buffer, line_buffering=True)
    _out = stdout

    # Patch matplotlib to use non-interactive backend before any imports
    try:
        import matplotlib
        matplotlib.use("Agg")
    except Exception:
        pass

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception:
            continue

        action = cmd.get("action")

        if action == "execute":
            code = cmd.get("code", "")
            _run(code)
            stdout.write(json.dumps({"type": "done"}) + "\n")
            stdout.flush()

        elif action == "reset":
            _ns.clear()
            try:
                import matplotlib.pyplot as plt
                plt.close("all")
            except Exception:
                pass
            stdout.write(json.dumps({"type": "reset_ok"}) + "\n")
            stdout.flush()

        elif action == "ping":
            stdout.write(json.dumps({"type": "pong"}) + "\n")
            stdout.flush()


if __name__ == "__main__":
    main()
