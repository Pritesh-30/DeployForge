"""
Live logs over Server-Sent Events.

Polling a log every few seconds shows it in lurches and re-sends what the
browser already has. A stream sends each new chunk once, as it is written.

Two sources:

  * the build log is a file the builder appends to, so it is tailed from a
    byte offset — the client can reconnect with the offset it reached and
    lose nothing;
  * a running app's output comes from `docker logs --follow`, read on a
    thread for the same reason every Docker call here is (it works under any
    event loop), and the process is killed the moment the client goes away.

Every event is one JSON object, so text with newlines needs no SSE escaping.
A comment line every 15 seconds keeps proxies from closing a quiet stream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import threading
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

from app.config import settings
from app.runtime.docker import _environment

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 15.0
POLL_SECONDS = 0.6
STATUS_EVERY_SECONDS = 2.0
# A stream is a convenience, not a connection to hold open for ever.
MAX_STREAM_SECONDS = 45 * 60
CHUNK_BYTES = 64 * 1024

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # nginx and some proxies buffer responses unless told not to.
    "X-Accel-Buffering": "no",
}


def event(name: str, data: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def comment(text: str = "ping") -> str:
    return f": {text}\n\n"


async def tail_file(
    path: Path,
    *,
    offset: int,
    is_finished: Callable[[], Awaitable[str | None]],
    is_disconnected: Callable[[], Awaitable[bool]],
) -> AsyncIterator[str]:
    """
    Stream a growing file from `offset` until `is_finished()` returns a final
    status and every byte written before that has been sent.

    `is_finished` returns None while the writer is still going, or the final
    status once it has stopped — checked every couple of seconds, not every
    poll, since it is a database read.
    """
    position = max(0, offset)
    started = last_sent = last_status_check = time.monotonic()
    finished: str | None = None

    while True:
        if await is_disconnected():
            return
        now = time.monotonic()

        chunk = await asyncio.to_thread(_read_from, path, position)
        if chunk:
            position += len(chunk)
            yield event("log", {"text": chunk.decode("utf-8", errors="replace"), "offset": position})
            last_sent = now
            continue  # there may be more already; drain before sleeping

        if finished is not None:
            yield event("end", {"status": finished, "offset": position})
            return

        if now - last_status_check >= STATUS_EVERY_SECONDS:
            last_status_check = now
            status = await is_finished()
            if status is not None:
                # One more read: the writer may have flushed after our last one.
                finished = status
                continue

        if now - started > MAX_STREAM_SECONDS:
            yield event("end", {"status": "timeout", "offset": position})
            return
        if now - last_sent > HEARTBEAT_SECONDS:
            yield comment()
            last_sent = now
        await asyncio.sleep(POLL_SECONDS)


def _read_from(path: Path, position: int) -> bytes:
    try:
        with path.open("rb") as handle:
            handle.seek(position)
            return handle.read(CHUNK_BYTES)
    except OSError:
        return b""


async def follow_command(
    command: list[str],
    *,
    is_disconnected: Callable[[], Awaitable[bool]],
) -> AsyncIterator[str]:
    """
    Run a command that follows a log (`docker logs -f`) and stream its lines
    until it exits or the client leaves — at which point it is killed, so an
    abandoned browser tab does not leave a `docker logs` process behind.
    """
    loop = asyncio.get_running_loop()
    lines: asyncio.Queue[str | None] = asyncio.Queue(maxsize=2000)

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=_environment(None),
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        yield event("end", {"status": "error", "message": str(exc)})
        return

    exited = threading.Event()

    def offer(line: str) -> None:
        # Runs on the loop. A client that cannot keep up loses lines rather
        # than the server losing memory.
        try:
            lines.put_nowait(line)
        except asyncio.QueueFull:
            pass

    def pump() -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                try:
                    loop.call_soon_threadsafe(offer, line)
                except RuntimeError:  # the loop has closed
                    return
        finally:
            # A flag, not a sentinel in the queue: a full queue must not be
            # able to swallow the news that the process ended.
            exited.set()

    reader = threading.Thread(target=pump, name="log-follow", daemon=True)
    reader.start()
    started = last_sent = time.monotonic()
    batch: list[str] = []

    try:
        while True:
            if await is_disconnected():
                return
            try:
                line = await asyncio.wait_for(lines.get(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                line = None if (exited.is_set() and lines.empty()) else ""
            if line is None:
                if batch:
                    yield event("log", {"text": "".join(batch)})
                yield event("end", {"status": "exited"})
                return
            if line:
                batch.append(line)
                # Send in small batches: one event per line is wasteful when a
                # busy app prints hundreds a second.
                if len(batch) < 50 and not lines.empty():
                    continue
            now = time.monotonic()
            if batch:
                yield event("log", {"text": "".join(batch)})
                batch = []
                last_sent = now
            elif now - last_sent > HEARTBEAT_SECONDS:
                yield comment()
                last_sent = now
            if now - started > MAX_STREAM_SECONDS:
                yield event("end", {"status": "timeout"})
                return
    finally:
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def runtime_log_command(
    *, container: str | None, compose_project: str | None, tail: int = 300
) -> list[str] | None:
    """The `docker` invocation that follows an app's output."""
    docker = settings.docker_binary
    if compose_project:
        return [docker, "compose", "--project-name", compose_project, "logs",
                "--follow", "--no-color", "--timestamps", "--tail", str(tail)]
    if container:
        return [docker, "logs", "--follow", "--timestamps", "--tail", str(tail), container]
    return None


def stream_id() -> str:
    return uuid.uuid4().hex[:12]
