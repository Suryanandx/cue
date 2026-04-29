"""Daemon launcher — wraps uvicorn.run with PID file management."""
from __future__ import annotations

import os
import signal
from pathlib import Path

import uvicorn

from cue.config import DATA_DIR, CueConfig
from cue.daemon.api import create_app

PID_FILE = DATA_DIR / "daemon.pid"


def is_running() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (ValueError, ProcessLookupError, PermissionError):
        PID_FILE.unlink(missing_ok=True)
        return None


def start(host: str | None = None, port: int | None = None, *, foreground: bool = False) -> None:
    cfg = CueConfig.load()
    bind = host or cfg.daemon.bind
    p = port or cfg.daemon.port
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if existing := is_running():
        raise RuntimeError(f"Daemon already running (pid {existing})")

    if not foreground:
        # Detach via double-fork
        if os.fork() != 0:
            return
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        # Redirect std streams in the daemon child
        with open(os.devnull, "rb", 0) as f:
            os.dup2(f.fileno(), 0)
        log = open(DATA_DIR / "daemon.log", "ab", 0)
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)

    PID_FILE.write_text(str(os.getpid()))
    try:
        uvicorn.run(create_app(cfg), host=bind, port=p, log_level="info")
    finally:
        PID_FILE.unlink(missing_ok=True)


def stop() -> bool:
    pid = is_running()
    if not pid:
        return False
    os.kill(pid, signal.SIGTERM)
    PID_FILE.unlink(missing_ok=True)
    return True


def status() -> dict:
    pid = is_running()
    cfg = CueConfig.load()
    return {
        "running": pid is not None,
        "pid": pid,
        "bind": cfg.daemon.bind,
        "port": cfg.daemon.port,
        "url": f"http://{cfg.daemon.bind}:{cfg.daemon.port}",
        "logs": str(DATA_DIR / "daemon.log"),
    }
