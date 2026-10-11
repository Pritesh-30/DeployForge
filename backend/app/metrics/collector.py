"""
The sampler: every few seconds, record what each running app is using and
how fast it answers.

One pass makes two Docker calls in total — `docker ps` for labels and
`docker stats` for usage — however many apps are running, then probes the
apps concurrently with a bound. A compose stack's containers are summed into
its app, because "my app uses 400 MB" is the number its owner asked about,
not a list of five.

If several API processes run, only one samples per tick: each takes a short
lock in Redis first, so the graphs are not written twice.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

import httpx
from sqlalchemy import select

from app.config import settings
from app.core.redis import get_redis, key
from app.db import AsyncSessionLocal
from app.metrics import sampling, store
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus

logger = logging.getLogger(__name__)

_PROBE_CONCURRENCY = 8
# `docker info` barely changes; asking every tick would be waste.
_INFO_TTL_SECONDS = 300
_info_cache: tuple[float, dict] | None = None

COMPOSE_PROJECT_LABEL = "com.docker.compose.project"


@dataclass
class AppUsage:
    cpu: float = 0.0
    mem: int = 0
    mem_limit: int = 0
    net_rx: int = 0
    net_tx: int = 0
    pids: int = 0
    containers: int = 0
    names: list[str] = field(default_factory=list)

    def add(self, s: sampling.ContainerStats) -> None:
        self.cpu += s.cpu_percent
        self.mem += s.mem_bytes
        self.mem_limit += s.mem_limit_bytes
        self.net_rx += s.net_rx_bytes
        self.net_tx += s.net_tx_bytes
        self.pids += s.pids
        self.containers += 1
        self.names.append(s.name)


def usage_by_deployment(
    deployments: list[Deployment],
    containers: list[dict],
    stats: dict[str, sampling.ContainerStats],
) -> dict[str, AppUsage]:
    """
    Sum container usage into the deployments that own the containers.

    A single-image app owns the container it named; a compose stack owns
    every container Compose labelled with its project. Pure, so the mapping
    is tested without Docker.
    """
    by_project: dict[str, list[str]] = {}
    for row in containers:
        project = row.get("LabelMap", {}).get(COMPOSE_PROJECT_LABEL)
        name = row.get("Names") or row.get("Name")
        if project and name:
            by_project.setdefault(project, []).append(name)

    usage: dict[str, AppUsage] = {}
    for deployment in deployments:
        total = AppUsage()
        if deployment.build_method is BuildMethod.COMPOSE and deployment.compose_project:
            names = by_project.get(deployment.compose_project, [])
        else:
            names = [deployment.container_name] if deployment.container_name else []
        for name in names:
            if name in stats:
                total.add(stats[name])
        usage[str(deployment.id)] = total
    return usage


async def _daemon_info() -> dict:
    global _info_cache
    now = time.monotonic()
    if _info_cache and now - _info_cache[0] < _INFO_TTL_SECONDS:
        return _info_cache[1]
    info = await sampling.daemon_info()
    if info:
        _info_cache = (now, info)
    return info


async def collect_once(http: httpx.AsyncClient) -> int:
    """Sample everything once. Returns how many apps were sampled."""
    async with AsyncSessionLocal() as db:
        deployments = (
            await db.execute(
                select(Deployment).where(
                    Deployment.status.in_([DeploymentStatus.RUNNING, DeploymentStatus.LIVE])
                )
            )
        ).scalars().all()
        # Detach what is needed so the session can close before the slow part.
        rows = [
            (d, d.repository_id, d.subdomain, d.container_name, d.app_port)
            for d in deployments
        ]

    containers, stats, info = await asyncio.gather(
        sampling.running_containers(),
        sampling.stats_for_all(),
        _daemon_info(),
    )
    usage = usage_by_deployment([r[0] for r in rows], containers, stats)

    semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

    async def probe(subdomain, container, port):
        if not subdomain:
            return None
        async with semaphore:
            return await sampling.probe(http, subdomain=subdomain, container=container, port=port)

    probes = await asyncio.gather(*(probe(r[2], r[3], r[4]) for r in rows))

    now_ms = int(time.time() * 1000)
    for (deployment, app_id, *_), result in zip(rows, probes):
        u = usage.get(str(deployment.id), AppUsage())
        fields = {
            "cpu": round(u.cpu, 3),
            "mem": u.mem,
            "mem_limit": u.mem_limit,
            "net_rx": u.net_rx,
            "net_tx": u.net_tx,
            "pids": u.pids,
            "containers": u.containers,
        }
        if result is not None:
            fields["status"] = result.status
            fields["latency"] = round(result.latency_ms, 2)
        await store.append(store.app_key(app_id), fields, ts_ms=now_ms)

    cpus = int(info.get("NCPU") or 0) or 1
    try:
        builds = await get_redis().zcard(key("q", "lease"))
    except Exception:  # noqa: BLE001
        builds = 0
    await store.append(
        store.host_key(),
        {
            # Share of the whole machine: 100 means every core is busy.
            "cpu": round(sum(s.cpu_percent for s in stats.values()) / cpus, 3),
            "cpus": cpus,
            "mem": sum(s.mem_bytes for s in stats.values()),
            "mem_total": int(info.get("MemTotal") or 0),
            "containers": len(containers),
            "apps": len(rows),
            "builds": builds,
        },
        ts_ms=now_ms,
    )
    return len(rows)


async def run(stop: asyncio.Event) -> None:
    """Sample on an interval until `stop` is set. Never raises."""
    interval = max(5, settings.metrics_interval_seconds)
    async with httpx.AsyncClient(timeout=5.0) as http:
        while not stop.is_set():
            started = time.monotonic()
            try:
                # One sampler per tick across every API process.
                if await get_redis().set(key("m", "lock"), "1", nx=True, px=(interval - 1) * 1000):
                    await collect_once(http)
            except Exception:  # noqa: BLE001 — a bad tick must not end sampling
                logger.debug("Metrics tick failed", exc_info=True)
            elapsed = time.monotonic() - started
            try:
                await asyncio.wait_for(stop.wait(), timeout=max(1.0, interval - elapsed))
            except asyncio.TimeoutError:
                pass
