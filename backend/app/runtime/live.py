"""
Live updates: the console hears about a change the moment it happens.

Every step of a deployment's life is written to its timeline through
`runtime.service.record` — queued, building, copied into the registry,
started, crashed, rolled back. That same call publishes a small notice here,
on Redis pub/sub, and each open console holds one stream (`GET /live`) that
relays the notices meant for it. The page then re-reads what changed.

So a push that starts a build in GitHub Actions appears in the console within
a second, with no refresh and no polling interval to wait out — whether the
build was started by the webhook, by the workflow, or by someone else.

Notices carry ids and the new status, never log text or values: what a page
shows still comes from the API, with its usual access checks. A student's
stream carries only their own apps; an administrator's carries everything.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator

from app.core.redis import get_redis, key

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 15
# A stream ends after this long and the console reconnects at once. Bounded
# so no server restart has to wait on a page left open all day.
MAX_STREAM_SECONDS = 5 * 60


def user_channel(user_id) -> str:
    return key("live", "user", user_id)


ALL_CHANNEL = key("live", "all")


async def publish(
    *,
    user_id: uuid.UUID,
    app_id: uuid.UUID,
    deployment_id: uuid.UUID,
    status: str | None,
    stage: str | None = None,
    level: str | None = None,
) -> None:
    """Tell open consoles about a change. Never raises."""
    notice = json.dumps({
        "app_id": str(app_id),
        "deployment_id": str(deployment_id),
        "status": status,
        "stage": stage,
        "level": level,
        "at": int(time.time() * 1000),
    })
    try:
        redis = get_redis()
        await redis.publish(user_channel(user_id), notice)
        await redis.publish(ALL_CHANNEL, notice)
    except Exception:  # noqa: BLE001 — live updates are a nicety
        logger.debug("Could not publish a live update", exc_info=True)


async def stream(channel: str, is_disconnected) -> AsyncIterator[str]:
    """Server-sent events for one channel, with a heartbeat, until the client goes."""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(channel)
    try:
        yield "event: ready\ndata: {}\n\n"
        last = opened = time.monotonic()
        while True:
            if await is_disconnected() or time.monotonic() - opened > MAX_STREAM_SECONDS:
                return
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message and message.get("type") == "message":
                yield f"event: change\ndata: {message['data']}\n\n"
                last = time.monotonic()
            elif time.monotonic() - last > HEARTBEAT_SECONDS:
                # Keeps proxies (and ngrok) from closing an idle stream.
                yield ": keep-alive\n\n"
                last = time.monotonic()
            else:
                await asyncio.sleep(0)
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
        except Exception:  # noqa: BLE001
            pass
