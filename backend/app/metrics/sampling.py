"""
Reading resource usage from Docker, and response times from the apps.

Docker reports usage as human strings — "12.3MiB / 512MiB", "1.05kB / 0B",
"3.21%" — so the parsing lives here, pure and tested, apart from the calls
that fetch it.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass

import httpx

from app.config import settings
from app.runtime import docker

logger = logging.getLogger(__name__)

_UNITS = {
    "b": 1,
    "kb": 1000, "mb": 1000**2, "gb": 1000**3, "tb": 1000**4,
    "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4,
}
_SIZE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)\s*$")


def parse_size(text: str) -> int:
    """'12.3MiB' -> bytes. Unknown or empty -> 0, never an exception."""
    match = _SIZE.match(text or "")
    if not match:
        return 0
    number, unit = match.groups()
    return int(float(number) * _UNITS.get(unit.lower() or "b", 1))


def parse_pair(text: str) -> tuple[int, int]:
    """'12.3MiB / 512MiB' -> (used, total) in bytes."""
    left, _, right = (text or "").partition("/")
    return parse_size(left), parse_size(right)


def parse_percent(text: str) -> float:
    try:
        return float((text or "").strip().rstrip("%") or 0)
    except ValueError:
        return 0.0


@dataclass
class ContainerStats:
    name: str
    cpu_percent: float      # of one core; 200 means two cores flat out
    mem_bytes: int
    mem_limit_bytes: int
    net_rx_bytes: int
    net_tx_bytes: int
    block_read_bytes: int
    block_write_bytes: int
    pids: int

    @classmethod
    def from_docker(cls, row: dict) -> "ContainerStats":
        mem, limit = parse_pair(row.get("MemUsage", ""))
        rx, tx = parse_pair(row.get("NetIO", ""))
        read, write = parse_pair(row.get("BlockIO", ""))
        try:
            pids = int(row.get("PIDs") or 0)
        except ValueError:
            pids = 0
        return cls(
            name=row.get("Name") or row.get("Container") or "",
            cpu_percent=parse_percent(row.get("CPUPerc", "")),
            mem_bytes=mem,
            mem_limit_bytes=limit,
            net_rx_bytes=rx,
            net_tx_bytes=tx,
            block_read_bytes=read,
            block_write_bytes=write,
            pids=pids,
        )


def parse_json_lines(text: str) -> list[dict]:
    rows: list[dict] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def parse_labels(text: str) -> dict[str, str]:
    """`docker ps` prints labels as 'a=1,b=2'."""
    labels: dict[str, str] = {}
    for part in (text or "").split(","):
        name, sep, value = part.partition("=")
        if sep:
            labels[name.strip()] = value.strip()
    return labels


async def stats_for_all() -> dict[str, ContainerStats]:
    """Usage of every running container, by name. One `docker stats` call."""
    result = await docker._run(
        "stats", "--no-stream", "--format", "{{json .}}", timeout=30
    )
    if not result.ok:
        return {}
    stats = (ContainerStats.from_docker(r) for r in parse_json_lines(result.stdout))
    return {s.name: s for s in stats if s.name}


async def running_containers() -> list[dict]:
    """Every running container with its labels parsed."""
    result = await docker._run("ps", "--format", "{{json .}}", timeout=30)
    if not result.ok:
        return []
    rows = parse_json_lines(result.stdout)
    for row in rows:
        row["LabelMap"] = parse_labels(row.get("Labels", ""))
    return rows


async def daemon_info() -> dict:
    """CPU count, memory and container counts of the Docker host."""
    result = await docker._run("info", "--format", "{{json .}}", timeout=30)
    if not result.ok:
        return {}
    rows = parse_json_lines(result.stdout)
    return rows[0] if rows else {}


async def disk_usage() -> list[dict]:
    """`docker system df`: space used by images, containers, volumes, cache."""
    result = await docker._run("system", "df", "--format", "{{json .}}", timeout=60)
    if not result.ok:
        return []
    return parse_json_lines(result.stdout)


@dataclass
class Probe:
    ok: bool
    status: int      # HTTP status, or 0 when nothing answered
    latency_ms: float


async def probe(
    client: httpx.AsyncClient, *, subdomain: str, container: str | None, port: int | None
) -> Probe:
    """
    Request the app's front page and time it.

    "router" mode goes through the router with the app's Host header — the
    exact path a visitor takes, and the only one available when the API runs
    on the host and apps live on a Docker network it cannot reach. "direct"
    mode goes to the container over the shared network, for an API that runs
    beside the apps (the deployed platform), where going out through the
    public HTTPS address and back would measure the internet instead.

    Anything below 500 counts as up: a 404 from an API with no root route is
    an app that is running fine.
    """
    if settings.probe_mode == "direct" and container and port:
        url, headers = f"http://{container}:{port}/", {}
    else:
        base = settings.router_probe_url.rstrip("/")
        url = f"{base}/"
        headers = {"Host": f"{subdomain}.{settings.app_domain}"}

    started = time.perf_counter()
    try:
        response = await client.get(url, headers=headers, follow_redirects=False)
    except httpx.HTTPError:
        return Probe(ok=False, status=0, latency_ms=(time.perf_counter() - started) * 1000)
    latency = (time.perf_counter() - started) * 1000
    return Probe(ok=response.status_code < 500, status=response.status_code, latency_ms=latency)
