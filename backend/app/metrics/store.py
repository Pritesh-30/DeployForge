"""
Time series in Redis streams.

A stream entry's id is the millisecond it was written, so a stream is already
a time-ordered log with range queries by time (`XRANGE <from-ms> <to-ms>`)
and cheap trimming by length (`XADD ... MAXLEN ~`). No extra index, no time
series module, nothing to install.

One stream per app (not per deployment), so a graph runs straight through a
redeploy — that is the moment someone most wants to compare before and after.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from app.config import settings
from app.core.redis import get_redis, key
from app.metrics.lttb import lttb

# Fields every app sample carries.
APP_FIELDS = (
    "cpu", "mem", "mem_limit", "net_rx", "net_tx", "pids", "containers",
    "status", "latency",
)
HOST_FIELDS = (
    "cpu", "cpus", "mem", "mem_total", "containers", "apps", "builds",
)


def app_key(app_id: object) -> str:
    return key("m", "app", app_id)


def host_key() -> str:
    return key("m", "host")


def _max_entries() -> int:
    per_hour = 3600 / max(1, settings.metrics_interval_seconds)
    return int(per_hour * settings.metrics_retention_hours * 1.1) + 10


async def append(stream: str, fields: dict[str, Any], *, ts_ms: int | None = None) -> None:
    clean = {k: _num(v) for k, v in fields.items() if v is not None}
    await get_redis().xadd(
        stream,
        clean,
        id=f"{ts_ms}-*" if ts_ms is not None else "*",
        maxlen=_max_entries(),
        approximate=True,
    )


def _num(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float):
        return f"{value:.4f}".rstrip("0").rstrip(".") or "0"
    return str(value)


async def read(stream: str, *, since_ms: int, until_ms: int | None = None) -> list[tuple[int, dict[str, float]]]:
    """Every sample in a window, oldest first, values as floats."""
    entries = await get_redis().xrange(
        stream, min=str(since_ms), max=str(until_ms) if until_ms else "+"
    )
    out: list[tuple[int, dict[str, float]]] = []
    for entry_id, values in entries:
        ts = int(entry_id.split("-", 1)[0])
        parsed: dict[str, float] = {}
        for name, raw in values.items():
            try:
                parsed[name] = float(raw)
            except (TypeError, ValueError):
                continue
        out.append((ts, parsed))
    return out


async def latest(stream: str) -> tuple[int, dict[str, float]] | None:
    entries = await get_redis().xrevrange(stream, count=1)
    if not entries:
        return None
    entry_id, values = entries[0]
    parsed = {}
    for name, raw in values.items():
        try:
            parsed[name] = float(raw)
        except (TypeError, ValueError):
            pass
    return int(entry_id.split("-", 1)[0]), parsed


@dataclass
class Summary:
    """What a window of samples adds up to, beside the series themselves."""

    samples: int
    uptime: float | None         # fraction of probes that answered below 500
    latency_p50: float | None
    latency_p95: float | None
    cpu_avg: float | None
    cpu_max: float | None
    mem_avg: float | None
    mem_max: float | None


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile; None for no data."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, int(round(q * (len(ordered) - 1)))))
    return ordered[rank]


def rates(samples: list[tuple[int, dict[str, float]]], field: str) -> list[tuple[float, float]]:
    """
    Per-second rate of a cumulative counter (network bytes).

    Docker reports totals since the container started, so the rate is the
    difference between samples over the time between them. A negative
    difference means the container restarted and its counter began again;
    that interval is reported as zero rather than as a huge negative spike.
    """
    out: list[tuple[float, float]] = []
    previous: tuple[int, float] | None = None
    for ts, values in samples:
        if field not in values:
            continue
        current = values[field]
        if previous is not None:
            dt = (ts - previous[0]) / 1000
            delta = current - previous[1]
            if dt > 0:
                out.append((ts, max(0.0, delta) / dt))
        previous = (ts, current)
    return out


def series(
    samples: list[tuple[int, dict[str, float]]], field: str, points: int
) -> list[tuple[float, float]]:
    raw = [(ts, values[field]) for ts, values in samples if field in values]
    return lttb(raw, points)


def summarize(samples: list[tuple[int, dict[str, float]]]) -> Summary:
    probes = [v for _, v in samples if "status" in v]
    answered = [v for v in probes if 0 < v["status"] < 500]
    latencies = [v["latency"] for v in answered if "latency" in v]
    cpu = [v["cpu"] for _, v in samples if "cpu" in v]
    mem = [v["mem"] for _, v in samples if "mem" in v]
    return Summary(
        samples=len(samples),
        uptime=(len(answered) / len(probes)) if probes else None,
        latency_p50=percentile(latencies, 0.50),
        latency_p95=percentile(latencies, 0.95),
        cpu_avg=(sum(cpu) / len(cpu)) if cpu else None,
        cpu_max=max(cpu) if cpu else None,
        mem_avg=(sum(mem) / len(mem)) if mem else None,
        mem_max=max(mem) if mem else None,
    )


WINDOWS = {"1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600}


def window_start(window: str) -> int:
    seconds = WINDOWS.get(window, 3600)
    return int((time.time() - seconds) * 1000)
