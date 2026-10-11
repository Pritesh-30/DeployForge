"""
Starting a build — the one place it happens.

A build is requested by the student pressing Deploy, by an administrator
redeploying someone's app, and (on the Actions backend) by a push. Every path
has to make the same checks in the same order, and there used to be only one
caller, so they lived in the route. Now there are several; they live here.

Where the build runs depends on the backend:

  * "local"   — on this server, through the fair build queue. The request
                returns as soon as the job is queued; a worker picks it up.
  * "actions" — in the student's GitHub Actions; the server only commits the
                workflow and starts it.
"""

from __future__ import annotations

import logging

from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.builder import pack
from app.ci import service as ci_service
from app.config import settings
from app.core.errors import AppError, ConflictError
from app.models.deployment import Deployment, DeploymentStatus
from app.models.event import EventLevel
from app.models.repository import DetectedType, Repository
from app.models.user import User
from app.queue.jobs import enqueue_build
from app.runtime.service import (
    app_suspension,
    ci_build_abandoned,
    record,
    release_abandoned_ci_build,
)

logger = logging.getLogger(__name__)

# Statuses that mean a build is already in flight for a target.
IN_FLIGHT = (DeploymentStatus.QUEUED, DeploymentStatus.BUILDING, DeploymentStatus.PUSHING)


class QueueUnavailableError(AppError):
    status_code = 503
    code = "queue_unavailable"


async def trigger_build(
    db: AsyncSession,
    repository: Repository,
    owner: User,
    *,
    actor: str = "owner",
    background_tasks: BackgroundTasks | None = None,
) -> Deployment:
    """
    Start a new build of `repository`, owned by `owner`.

    Refuses while one is already in flight — two builds of one app racing to
    replace each other is never what anyone meant. Returns the deployment
    that will hold the result.
    """
    if actor != "admin":
        suspension = await app_suspension(db, repository.id)
        if suspension is not None:
            raise ConflictError(suspension)

    if settings.builds_on_actions:
        return await _on_actions(db, repository, owner, actor, background_tasks)
    return await _on_queue(db, repository, owner, actor)


async def _on_queue(
    db: AsyncSession, repository: Repository, owner: User, actor: str
) -> Deployment:
    # Only a buildpack build needs `pack`. A repository with its own Dockerfile
    # is built by Docker alone, and demanding an unrelated tool before starting
    # would block the one path that needs nothing extra installed. The final
    # decision is made against the downloaded files (see `builder/service.py`);
    # this is the early, fixable version of it.
    if repository.detected_type is not DetectedType.DOCKER:
        await pack.check_toolchain()

    existing = (
        await db.execute(
            select(Deployment)
            .where(Deployment.repository_id == repository.id)
            .order_by(Deployment.created_at.desc(), Deployment.id.desc())
        )
    ).scalars().all()

    if any(d.status in IN_FLIGHT for d in existing):
        raise ConflictError(f"A build is already running for {repository.target_label}.")

    latest = existing[0] if existing else None
    if latest is not None and latest.status == DeploymentStatus.ANALYZED:
        deployment = latest  # the first build continues the analysis record
    else:
        deployment = Deployment(
            repository_id=repository.id,
            user_id=owner.id,
            commit_sha=latest.commit_sha if latest else None,
            build_method=latest.build_method if latest else None,
        )
        db.add(deployment)

    deployment.status = DeploymentStatus.QUEUED
    deployment.error_message = None
    deployment.image_ref = None
    deployment.build_started_at = None
    deployment.build_finished_at = None
    # Committed before it is queued: a worker that picks the job up at once
    # must find the row in its final state, not a version it cannot see yet.
    await db.commit()
    await db.refresh(deployment)

    try:
        await enqueue_build(deployment, label=repository.target_label)
    except Exception as exc:  # noqa: BLE001 — Redis down: say so, leave no stuck row
        logger.exception("Could not queue the build of %s", deployment.id)
        deployment.status = DeploymentStatus.FAILED
        deployment.error_message = (
            "The build queue is unavailable, so this build never started. "
            "Nothing is wrong with your project — try again in a minute."
        )
        await db.commit()
        raise QueueUnavailableError(
            "The build queue is unavailable right now. Try again in a minute."
        ) from exc

    await record(
        db, deployment.id, "build",
        "Queued for a build." if actor == "owner" else "Queued for a build by an administrator.",
        actor=actor,
    )
    return deployment


async def _on_actions(
    db: AsyncSession,
    repository: Repository,
    owner: User,
    actor: str,
    background_tasks: BackgroundTasks | None,
) -> Deployment:
    """
    Start a build in the owner's own GitHub Actions.

    The checks that need the owner — permissions only they can grant — are
    made here, in the request, so the error appears on the button that was
    pressed. Talking to GitHub happens in the background.
    """
    ci_service.ensure_configured()
    await ci_service.ensure_scopes(db, owner.id)

    in_flight = (
        await db.execute(
            select(Deployment).where(
                Deployment.repository_id == repository.id,
                Deployment.status.in_(IN_FLIGHT),
            )
        )
    ).scalars().all()
    for deployment in in_flight:
        if deployment.built_on_actions and ci_build_abandoned(deployment):
            release_abandoned_ci_build(deployment)
        else:
            raise ConflictError(f"A build is already running for {repository.target_label}.")
    await db.commit()

    deployment = await ci_service.queue(db, repository, owner)
    if actor != "owner":
        await record(
            db, deployment.id, "build",
            "Build requested by an administrator.", actor=actor,
            level=EventLevel.INFO,
        )
    if background_tasks is not None:
        background_tasks.add_task(ci_service.dispatch, deployment.id)
    else:
        await ci_service.dispatch(deployment.id)
    return deployment
