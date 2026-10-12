"""
The platform's Redis connection.

Redis holds what is fast-moving or derived: the build queue, rate-limit
state, resource metrics and cached GitHub responses. PostgreSQL stays the
source of truth for everything a person did. Losing Redis costs queue
positions and graphs; it never loses a deployment.

A connection pool belongs to the event loop that opened it. A server can
start on one loop and serve on another (the lifespan in `main.py` explains
why), and a pooled connection used from the wrong loop fails in ways that
look nothing like the cause. So the client is cached per loop rather than
once per process.
"""

from __future__ import annotations

import asyncio
import logging

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)

_clients: dict[int, aioredis.Redis] = {}
# Set by tests to an in-process fake; wins over everything else.
_override: aioredis.Redis | None = None


def key(*parts: object) -> str:
    """A namespaced key: key("q", "job", 7) -> "df:q:job:7"."""
    return ":".join([settings.redis_namespace, *(str(p) for p in parts)])


def get_redis() -> aioredis.Redis:
    """The Redis client for the running event loop."""
    if _override is not None:
        return _override

    loop_id = id(asyncio.get_running_loop())
    client = _clients.get(loop_id)
    if client is None:
        client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            # Fail fast: a request should report that Redis is down, not hang
            # for the default TCP timeout while the user watches a spinner.
            socket_connect_timeout=2,
            socket_timeout=5,
            health_check_interval=30,
        )
        _clients[loop_id] = client
    return client


def use_client(client: aioredis.Redis | None) -> None:
    """Replace the client (tests). None restores the real one."""
    global _override
    _override = client


async def ping() -> bool:
    """Whether Redis answers. Never raises."""
    try:
        return bool(await get_redis().ping())
    except Exception:  # noqa: BLE001 — reporting, not failing
        return False


async def close_all() -> None:
    """Close every pooled connection. Called when the server stops."""
    for client in list(_clients.values()):
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            logger.debug("Redis close failed", exc_info=True)
    _clients.clear()
