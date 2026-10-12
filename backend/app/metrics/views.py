"""
Turning stored samples into what a chart needs.

Kept apart from the routes so the student's view of one app and the
administrator's view of the machine shape their answers the same way.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from app.metrics import store

DEFAULT_POINTS = 120


async def app_metrics(app_id: uuid.UUID, *, window: str, points: int = DEFAULT_POINTS) -> dict[str, Any]:
    samples = await store.read(store.app_key(app_id), since_ms=store.window_start(window))
    summary = store.summarize(samples)
    latest = samples[-1] if samples else None
    return {
        "window": window,
        "samples": len(samples),
        "series": {
            "cpu": store.series(samples, "cpu", points),
            "mem": store.series(samples, "mem", points),
            "latency": store.series(
                [(t, v) for t, v in samples if 0 < v.get("status", 0) < 500], "latency", points
            ),
            "net_rx": _lttb_rates(samples, "net_rx", points),
            "net_tx": _lttb_rates(samples, "net_tx", points),
        },
        "summary": summary.__dict__,
        "latest": {"ts": latest[0], **latest[1]} if latest else None,
    }


async def apps_overview(app_ids: list[uuid.UUID], *, points: int = 30) -> dict[str, Any]:
    """
    For list views: each app's latest sample, an hour's CPU sparkline and its
    uptime over the hour — concurrently, one stream read per app.
    """
    since = store.window_start("1h")

    async def one(app_id: uuid.UUID) -> tuple[str, dict[str, Any]]:
        samples = await store.read(store.app_key(app_id), since_ms=since)
        summary = store.summarize(samples)
        latest = samples[-1] if samples else None
        return str(app_id), {
            "latest": {"ts": latest[0], **latest[1]} if latest else None,
            "cpu": store.series(samples, "cpu", points),
            "mem": store.series(samples, "mem", points),
            "uptime": summary.uptime,
            "latency_p50": summary.latency_p50,
        }

    pairs = await asyncio.gather(*(one(a) for a in app_ids))
    return dict(pairs)


async def host_metrics(*, window: str, points: int = DEFAULT_POINTS) -> dict[str, Any]:
    samples = await store.read(store.host_key(), since_ms=store.window_start(window))
    latest = samples[-1] if samples else None
    return {
        "window": window,
        "samples": len(samples),
        "series": {
            name: store.series(samples, name, points)
            for name in ("cpu", "mem", "apps", "builds", "containers")
        },
        "latest": {"ts": latest[0], **latest[1]} if latest else None,
    }


def _lttb_rates(samples, field: str, points: int):
    from app.metrics.lttb import lttb

    return lttb(store.rates(samples, field), points)
