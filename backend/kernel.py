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


def _run(code: str) -> list[dict]:
    """Execute code, return list of output events."""
    events: list[dict] = []

    # Redirect stdout/stderr
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()

    try:
        exec(compile(code, "<sandbox>", "exec"), _ns)  # noqa: S102
    except SystemExit:
        pass
    except Exception:
        tb = traceback.format_exc()
        sys.stderr.write(tb)
    finally:
        stdout_val = sys.stdout.getvalue()
        stderr_val = sys.stderr.getvalue()
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    if stdout_val:
        events.append({"type": "stdout", "text": stdout_val})
    if stderr_val:
        events.append({"type": "stderr", "text": stderr_val})

    img = _capture_figure()
    if img:
        events.append({"type": "image", "data": img})

    return events


def main():
    # Use line-buffered I/O
    stdin = io.TextIOWrapper(sys.stdin.buffer, line_buffering=True)
    stdout = io.TextIOWrapper(sys.stdout.buffer, line_buffering=True)

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
            events = _run(code)
            for ev in events:
                stdout.write(json.dumps(ev) + "\n")
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
