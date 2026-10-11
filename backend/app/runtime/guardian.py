"""
Automatic rollback: a new version that crashes soon after going live is
replaced by the version it replaced.

A redeploy only takes over once its container has started and stayed up
through the start-up grace period (see `runtime.start`), so an app that dies
on boot never takes a working one down. But plenty of bugs wait a little
longer — the first request hits a missing environment variable, a migration
fails after the server is listening, memory runs out under the first real
load. By then the old version has been stopped.

So for `auto_rollback_window_seconds` after a version goes live, the guardian
checks on it. If its container has stopped, or Docker is restarting it in a
loop, the version before it is started again — the exact image that was
serving a few minutes earlier — and the crashed one is marked failed with its
last output, so the student sees what happened and why the app is still up.

Two rules keep this from making things worse:

  * a version started *by* a rollback is not itself rolled back, so two bad
    versions cannot hand the app back and forth;
  * nothing is rolled back to a version that never ran successfully.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.config import settings
from app.core.redis import get_redis, key
from app.db import AsyncSessionLocal
from app.models.deployment import Deployment, DeploymentStatus
from app.models.event import EventLevel
from app.models.repository import Repository
from app.models.user import User
from app.runtime import docker
from app.runtime import service as runtime

logger = logging.getLogger(__name__)

_INTERVAL_SECONDS = 10
# Docker restarting a crashed container this many times means it is crash
# looping, not recovering from a blip.
_RESTARTS_MEANING_CRASH = 2


def _marker(deployment_id) -> str:
    return key("rollback", "started", deployment_id)


def _handled(deployment_id) -> str:
    return key("rollback", "handled", deployment_id)


async def run(stop: asyncio.Event) -> None:
    """Check recent releases on an interval until `stop` is set. Never raises."""
    if settings.auto_rollback_window_seconds <= 0:
        return
    while not stop.is_set():
        try:
            # One guardian per tick across every API process.
            if await get_redis().set(key("rollback", "lock"), "1", nx=True,
                                     px=(_INTERVAL_SECONDS - 1) * 1000):
                await check_once()
        except Exception:  # noqa: BLE001 — a bad tick must not end the watch
            logger.debug("Rollback check failed", exc_info=True)
        try:
            await asyncio.wait_for(stop.wait(), timeout=_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass


async def check_once() -> list[str]:
    """One pass over recent releases. Returns the deployments rolled back."""
    since = datetime.now(timezone.utc) - timedelta(seconds=settings.auto_rollback_window_seconds)
    async with AsyncSessionLocal() as db:
        recent = (
            await db.execute(
                select(Deployment).where(
                    Deployment.status.in_([DeploymentStatus.RUNNING, DeploymentStatus.LIVE]),
                    Deployment.runtime_started_at >= since,
                    Deployment.container_name.is_not(None),
                )
            )
        ).scalars().all()

        rolled_back = []
        for deployment in recent:
            if await crashed(deployment) and await rollback(db, deployment):
                rolled_back.append(str(deployment.id))
        return rolled_back


async def crashed(deployment: Deployment) -> str | None:
    """Why this release counts as crashed, or None if it is healthy."""
    state = await docker.container_state(deployment.container_name)
    if state is None:
        # Gone entirely: someone removed it by hand. Not a crash to act on.
        return None
    restarts = int(state.get("RestartCount") or 0)
    if state.get("Restarting") or restarts >= _RESTARTS_MEANING_CRASH:
        return f"it kept crashing (Docker restarted it {restarts} times)"
    if not state.get("Running"):
        return f"it stopped with exit code {state.get('ExitCode')}"
    return None


async def rollback(db, deployment: Deployment) -> bool:
    """Replace a crashed release with the one before it. Returns whether it did."""
    redis = get_redis()
    if await redis.exists(_marker(deployment.id)):
        return False  # itself a rollback: leave it to the owner
    if not await redis.set(_handled(deployment.id), "1", nx=True,
                           ex=settings.auto_rollback_window_seconds * 4):
        return False  # already handled (or being handled)

    reason = await crashed(deployment) or "it stopped"
    previous = (
        await db.execute(
            select(Deployment)
            .where(
                Deployment.repository_id == deployment.repository_id,
                Deployment.id != deployment.id,
                Deployment.created_at < deployment.created_at,
                Deployment.status == DeploymentStatus.STOPPED,
                Deployment.runtime_started_at.is_not(None),
                Deployment.suspended_by_admin.is_(False),
            )
            .order_by(Deployment.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if previous is None or (previous.image_ref is None and previous.compose_project is None):
        await runtime.record(
            db, deployment.id, "start",
            f"This version crashed after going live — {reason} — and there is no "
            "earlier version to fall back to.",
            level=EventLevel.ERROR,
        )
        return False

    repository = await db.get(Repository, deployment.repository_id)
    user = await db.get(User, deployment.user_id)
    if repository is None or user is None:
        return False

    logs = await docker.container_logs(deployment.container_name, tail=80)
    lived = int((datetime.now(timezone.utc) - deployment.runtime_started_at).total_seconds())
    await runtime.record(
        db, deployment.id, "start",
        f"Crashed {lived}s after going live — {reason}. Rolling back to "
        f"deployment {str(previous.id)[:8]}. Last output:\n{logs[-1500:]}",
        level=EventLevel.ERROR, actor="platform",
    )

    await redis.set(_marker(previous.id), "1", ex=settings.auto_rollback_window_seconds * 4)
    try:
        # `start` retires the crashed release once the previous one is up.
        await runtime.start(db, previous, repository, user, actor="platform")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Rollback of %s failed", deployment.id, exc_info=True)
        await runtime.record(
            db, deployment.id, "start",
            f"Tried to roll back to {str(previous.id)[:8]}, but it did not start: {exc}",
            level=EventLevel.ERROR, actor="platform",
        )
        return False

    await db.refresh(deployment)
    deployment.status = DeploymentStatus.FAILED
    deployment.error_message = (
        f"Crashed {lived}s after going live ({reason}). The previous version "
        f"({str(previous.id)[:8]}) was put back automatically, so the app stayed up. "
        "The runtime log says why this one died."
    )
    await db.commit()
    await runtime.record(
        db, previous.id, "start",
        f"Put back automatically: the newer version {str(deployment.id)[:8]} crashed "
        f"{lived}s after going live.",
        level=EventLevel.WARNING, actor="platform",
    )
    logger.info("Rolled %s back to %s", deployment.id, previous.id)
    return True
