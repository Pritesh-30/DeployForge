"""Live log streams: nothing lost, nothing repeated, and they end."""

from __future__ import annotations

import json

from app.runtime import streams


def _events(chunks: list[str]) -> list[tuple[str, dict]]:
    out = []
    for chunk in chunks:
        if chunk.startswith(":"):
            continue
        name = chunk.split("\n", 1)[0].removeprefix("event: ")
        data = chunk.split("data: ", 1)[1].strip()
        out.append((name, json.loads(data)))
    return out


async def _never():
    return False


async def test_a_finished_build_log_is_sent_whole_then_ends(tmp_path, monkeypatch):
    monkeypatch.setattr(streams, "STATUS_EVERY_SECONDS", 0)
    path = tmp_path / "build.log"
    path.write_bytes("step 1\nstep 2\n".encode())

    async def finished():
        return "built"

    chunks = [c async for c in streams.tail_file(path, offset=0, is_finished=finished, is_disconnected=_never)]
    events = _events(chunks)
    assert events[0] == ("log", {"text": "step 1\nstep 2\n", "offset": 14})
    assert events[-1] == ("end", {"status": "built", "offset": 14})


async def test_a_reconnecting_client_resumes_from_its_offset(tmp_path, monkeypatch):
    monkeypatch.setattr(streams, "STATUS_EVERY_SECONDS", 0)
    path = tmp_path / "build.log"
    path.write_bytes("already seen\nnew line\n".encode())

    async def finished():
        return "failed"

    chunks = [c async for c in streams.tail_file(path, offset=13, is_finished=finished, is_disconnected=_never)]
    assert _events(chunks)[0][1]["text"] == "new line\n"


async def test_output_written_after_the_status_check_is_still_sent(tmp_path, monkeypatch):
    """The writer may flush its last line after the build was marked done."""
    monkeypatch.setattr(streams, "STATUS_EVERY_SECONDS", 0)
    monkeypatch.setattr(streams, "POLL_SECONDS", 0)
    path = tmp_path / "build.log"
    path.write_bytes("".encode())
    calls = 0

    async def finished():
        nonlocal calls
        calls += 1
        if calls == 1:
            path.write_bytes("last words\n".encode())
            return "built"
        return "built"

    chunks = [c async for c in streams.tail_file(path, offset=0, is_finished=finished, is_disconnected=_never)]
    events = _events(chunks)
    assert ("log", {"text": "last words\n", "offset": 11}) in events
    assert events[-1][0] == "end"


async def test_a_disconnected_client_stops_the_stream(tmp_path):
    path = tmp_path / "build.log"
    path.write_bytes("x\n".encode())

    async def gone():
        return True

    async def running():
        return None

    assert [c async for c in streams.tail_file(path, offset=0, is_finished=running, is_disconnected=gone)] == []


def test_the_runtime_command_covers_a_whole_stack():
    command = streams.runtime_log_command(container="df-x", compose_project="df-proj", tail=50)
    assert command[1:4] == ["compose", "--project-name", "df-proj"]
    assert "--follow" in command
    single = streams.runtime_log_command(container="df-x", compose_project=None)
    assert single[-1] == "df-x"
    assert streams.runtime_log_command(container=None, compose_project=None) is None
