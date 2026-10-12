"""
The jobs DeployForge puts on its queue, and what runs them.

Only builds are queued. Starting, stopping and restarting an app take seconds
and the person who asked is waiting on the answer, so they stay on the
request. A build takes minutes, competes for the machine with everyone
else's, and is exactly the work that has to be scheduled fairly and survive a
restart.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from app.db import AsyncSessionLocal
from app.models.deployment import Deployment, DeploymentStatus
from app.models.event import EventLevel
from app.queue.store import Job, JobQueue, queue
from app.queue.worker import JobContext, JobType

logger = logging.getLogger(__name__)

BUILD = "build"


def build_job_id(deployment_id: uuid.UUID) -> str:
    """
    Deterministic, so the queue can answer "is this deployment's build still
    coming?" from the deployment alone — which is how startup recovery tells a
    build that will be resumed from one that was lost.
    """
    return f"{BUILD}:{deployment_id}"


async def enqueue_build(
    deployment: Deployment,
    *,
    label: str,
    fresh: bool = False,
    actor: str = "owner",
    q: JobQueue | None = None,
) -> str:
    """Put a deployment's build on the queue, under its owner's fair share."""
    payload: dict = {"deployment_id": str(deployment.id), "actor": actor}
    if fresh:
        payload["fresh"] = True
    return await (q or queue).enqueue(
        kind=BUILD,
        job_id=build_job_id(deployment.id),
        tenant=str(deployment.user_id),
        payload=payload,
        label=label,
    )


async def _run_build(job: Job, context: JobContext) -> None:
    from app.builder.service import run_build

    deployment_id = uuid.UUID(job.payload["deployment_id"])
    await run_build(
        deployment_id,
        final_attempt=context.is_final_attempt,
        fresh=bool(job.payload.get("fresh")),
    )
    await _go_live(deployment_id, actor=job.payload.get("actor") or "owner")


async def _go_live(deployment_id: uuid.UUID, *, actor: str) -> None:
    """A build that finished here goes live, exactly as one from Actions does."""
    from app.models.repository import Repository
    from app.models.user import User
    from app.runtime.service import go_live

    async with AsyncSessionLocal() as db:
        deployment = await db.get(Deployment, deployment_id)
        if deployment is None or deployment.status is not DeploymentStatus.BUILT:
            return
        repository = await db.get(Repository, deployment.repository_id)
        user = await db.get(User, deployment.user_id)
        if repository is None or user is None:
            return
        try:
            await go_live(db, deployment, repository, user, actor=actor)
        except Exception:  # noqa: BLE001 — the build itself succeeded
            logger.exception("Could not put %s live", deployment_id)


async def _build_dead(job: Job, reason: str) -> None:
    """The worker died on this build on every attempt: say so on the row."""
    from app.runtime.service import record

    deployment_id = uuid.UUID(job.payload["deployment_id"])
    async with AsyncSessionLocal() as db:
        deployment = await db.get(Deployment, deployment_id)
        if deployment is None or deployment.status not in (
            DeploymentStatus.QUEUED, DeploymentStatus.BUILDING, DeploymentStatus.PUSHING,
        ):
            return
        deployment.status = DeploymentStatus.FAILED
        deployment.build_finished_at = datetime.now(timezone.utc)
        deployment.error_message = (
            f"The build was interrupted {job.attempts} times — the server "
            "running it stopped each time. Nothing is wrong with your project; "
            "press Redeploy, and tell an administrator if it keeps happening."
        )
        await db.commit()
        await record(
            db, deployment_id, "build",
            f"Gave up after {job.attempts} interrupted attempts: {reason}",
            level=EventLevel.ERROR,
        )


async def _build_reclaimed(job: Job) -> None:
    """
    The server running this build stopped, and the build is back in line.
    Say so on the row: it is waiting again, not building, and it will resume
    by itself — nobody needs to press anything.
    """
    from app.runtime.service import record

    deployment_id = uuid.UUID(job.payload["deployment_id"])
    async with AsyncSessionLocal() as db:
        deployment = await db.get(Deployment, deployment_id)
        if deployment is None or deployment.status not in (
            DeploymentStatus.BUILDING, DeploymentStatus.PUSHING,
        ):
            return
        deployment.status = DeploymentStatus.QUEUED
        await db.commit()
        await record(
            db, deployment_id, "queue",
            "The server stopped during this build. It is back at the front of "
            "the queue and will start again by itself.",
            level=EventLevel.WARNING,
        )


HANDLERS: dict[str, JobType] = {
    BUILD: JobType(run=_run_build, on_dead=_build_dead, on_reclaimed=_build_reclaimed),
}
