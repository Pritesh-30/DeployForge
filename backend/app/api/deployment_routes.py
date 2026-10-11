"""
Deployment routes — reading deployments and their build output.

Deployments are created by the analysis step in `repository_routes.py`, and
builds are started there too; this module only reads them back.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUser
from app.core.errors import ConflictError, NotFoundError
from app.db import AsyncSessionLocal, get_db
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.event import DeploymentEvent
from app.models.repository import Repository
from app.runtime import compose, docker, streams
from app.runtime import service as runtime_service
from app.schemas.deployment import (
    BuildLogsOut,
    DeploymentEventOut,
    DeploymentOut,
    RuntimeLogsOut,
)

router = APIRouter(prefix="/deployments", tags=["deployments"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


def deployment_out(
    deployment: Deployment,
    repository: Repository,
    *,
    user_email: str | None = None,
) -> DeploymentOut:
    return DeploymentOut(
        id=deployment.id,
        status=deployment.status,
        build_method=deployment.build_method,
        commit_sha=deployment.commit_sha,
        created_at=deployment.created_at,
        updated_at=deployment.updated_at,
        image_ref=deployment.image_ref,
        build_started_at=deployment.build_started_at,
        build_finished_at=deployment.build_finished_at,
        error_message=deployment.error_message,
        ai_diagnosis=deployment.ai_diagnosis,
        has_logs=bool(deployment.logs_ref),
        ci_run_url=deployment.ci_run_url,
        ci_trigger=deployment.ci_trigger,
        reused_from_id=deployment.reused_from_id,
        url=deployment.url,
        subdomain=deployment.subdomain,
        app_port=deployment.app_port,
        container_name=deployment.container_name,
        runtime_started_at=deployment.runtime_started_at,
        runtime_stopped_at=deployment.runtime_stopped_at,
        suspended_by_admin=deployment.suspended_by_admin,
        suspension_reason=deployment.suspension_reason,
        compose_project=deployment.compose_project,
        compose_services=deployment.compose_services,
        compose_web_service=deployment.compose_web_service,
        repository_id=repository.id,
        full_name=repository.full_name,
        deploy_path=repository.deploy_path,
        target_label=repository.target_label,
        detected_type=repository.detected_type,
        detected_framework=repository.detected_framework,
        user_id=deployment.user_id if user_email else None,
        user_email=user_email,
    )


@router.get("", response_model=list[DeploymentOut])
async def list_my_deployments(
    current_user: CurrentUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[DeploymentOut]:
    """This user's deployments, newest first."""
    rows = await db.execute(
        select(Deployment, Repository)
        .join(Repository, Deployment.repository_id == Repository.id)
        .where(Deployment.user_id == current_user.id)
        # id breaks ties so paging is stable when timestamps match
        .order_by(Deployment.created_at.desc(), Deployment.id.desc())
        .limit(limit)
    )
    return [deployment_out(d, r) for d, r in rows.all()]


async def _owned_deployment(
    db: AsyncSession, deployment_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[Deployment, Repository]:
    """Load a deployment with its repository, scoped to the caller."""
    row = (
        await db.execute(
            select(Deployment, Repository)
            .join(Repository, Deployment.repository_id == Repository.id)
            .where(Deployment.id == deployment_id, Deployment.user_id == user_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("Deployment not found.")
    return row[0], row[1]


@router.get("/{deployment_id}", response_model=DeploymentOut)
async def get_deployment(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> DeploymentOut:
    """One deployment, with its place in the build queue while it waits."""
    deployment, repository = await _owned_deployment(db, deployment_id, current_user.id)
    out = deployment_out(deployment, repository)
    if deployment.status is DeploymentStatus.QUEUED and not deployment.built_on_actions:
        await _attach_queue_position(out, deployment.id)
    return out


async def _attach_queue_position(out: DeploymentOut, deployment_id: uuid.UUID) -> None:
    from app.queue.jobs import build_job_id
    from app.queue.store import queue

    try:
        position = await queue.position(build_job_id(deployment_id))
    except Exception:  # noqa: BLE001 — a missing position is not an error
        return
    if position is not None:
        out.queue_position, out.queue_size = position


# A build log is a few hundred KB at most; only the tail is ever useful.
MAX_LOG_BYTES = 256 * 1024


def build_log_snapshot(deployment: Deployment) -> BuildLogsOut:
    """
    The build output produced so far — the tail, past a size limit.

    A missing file is not an error: a queued build has nothing to show yet.
    Shared with the admin console.
    """
    text = ""
    truncated = False
    if deployment.logs_ref:
        path = Path(deployment.logs_ref)
        try:
            if path.is_file():
                size = path.stat().st_size
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    if size > MAX_LOG_BYTES:
                        handle.seek(size - MAX_LOG_BYTES)
                        truncated = True
                    text = handle.read()
        except OSError as exc:
            text = f"(build log unavailable: {exc})"

    return BuildLogsOut(
        deployment_id=deployment.id,
        status=deployment.status,
        logs=text,
        truncated=truncated,
    )


@router.get("/{deployment_id}/logs", response_model=BuildLogsOut)
async def get_build_logs(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> BuildLogsOut:
    """The build output produced so far."""
    deployment, _ = await _owned_deployment(db, deployment_id, current_user.id)
    return build_log_snapshot(deployment)


# Statuses during which the build log is still being written.
_WRITING = (
    DeploymentStatus.QUEUED,
    DeploymentStatus.BUILDING,
    DeploymentStatus.PUSHING,
    DeploymentStatus.STARTING,
)


async def _status_of(deployment_id: uuid.UUID) -> str | None:
    """
    The deployment's status once its log has stopped growing, else None.

    Reads with its own session: a stream outlives the request that opened it,
    and the request's session is closed long before the build ends.
    """
    async with AsyncSessionLocal() as session:
        deployment = await session.get(Deployment, deployment_id)
        if deployment is None:
            return "deleted"
        return None if deployment.status in _WRITING else deployment.status.value


def build_log_stream(deployment: Deployment, request: Request, offset: int) -> StreamingResponse:
    """The build log as Server-Sent Events. Shared with the admin console."""
    from app.builder.service import log_path_for

    deployment_id = deployment.id
    path = Path(deployment.logs_ref) if deployment.logs_ref else log_path_for(deployment_id)

    async def finished() -> str | None:
        return await _status_of(deployment_id)

    return StreamingResponse(
        streams.tail_file(
            path, offset=offset, is_finished=finished,
            is_disconnected=request.is_disconnected,
        ),
        media_type="text/event-stream",
        headers=streams.SSE_HEADERS,
    )


def runtime_log_stream(deployment: Deployment, request: Request, tail: int) -> StreamingResponse:
    """What the running app prints, live. Shared with the admin console."""
    command = streams.runtime_log_command(
        container=deployment.container_name,
        compose_project=(
            deployment.compose_project
            if deployment.build_method is BuildMethod.COMPOSE else None
        ),
        tail=tail,
    )
    if command is None:
        raise ConflictError("This deployment has never run, so it has no output yet.")
    return StreamingResponse(
        streams.follow_command(command, is_disconnected=request.is_disconnected),
        media_type="text/event-stream",
        headers=streams.SSE_HEADERS,
    )


@router.get("/{deployment_id}/logs/stream")
async def stream_build_log(
    deployment_id: uuid.UUID,
    request: Request,
    current_user: CurrentUser,
    db: DbSession,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse:
    """
    The build log as Server-Sent Events, from byte `offset`, until the build
    ends. A client that reconnects passes the offset it reached and misses
    nothing.
    """
    deployment, _ = await _owned_deployment(db, deployment_id, current_user.id)
    return build_log_stream(deployment, request, offset)


@router.get("/{deployment_id}/runtime-logs/stream")
async def stream_runtime_log(
    deployment_id: uuid.UUID,
    request: Request,
    current_user: CurrentUser,
    db: DbSession,
    tail: Annotated[int, Query(ge=0, le=2000)] = 300,
) -> StreamingResponse:
    """What the running app prints, live — every service of a compose stack."""
    deployment, _ = await _owned_deployment(db, deployment_id, current_user.id)
    return runtime_log_stream(deployment, request, tail)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
# Starting and stopping happen inline rather than as background tasks: both
# take a second or two, and the user is watching a button. A build is minutes,
# which is why that one is backgrounded and polled.


@router.post("/{deployment_id}/start", response_model=DeploymentOut)
async def start_deployment(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> DeploymentOut:
    """
    Run this deployment's image and publish it at its URL.

    Enforces the account's running-app quota, and refuses while a build or an
    earlier start is still in flight.
    """
    deployment, repository = await _owned_deployment(db, deployment_id, current_user.id)
    if deployment.status.is_busy:
        raise ConflictError(
            f"This deployment is {deployment.status.value}. Wait for it to finish."
        )

    await runtime_service.start(db, deployment, repository, current_user)
    return deployment_out(deployment, repository)


@router.post("/{deployment_id}/stop", response_model=DeploymentOut)
async def stop_deployment(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> DeploymentOut:
    """Stop the app and take it off the router. Idempotent."""
    deployment, repository = await _owned_deployment(db, deployment_id, current_user.id)
    await runtime_service.stop(db, deployment)
    return deployment_out(deployment, repository)


@router.post("/{deployment_id}/restart", response_model=DeploymentOut)
async def restart_deployment(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> DeploymentOut:
    """Stop and start again, keeping the same image and the same URL."""
    deployment, repository = await _owned_deployment(db, deployment_id, current_user.id)
    if deployment.status.is_busy:
        raise ConflictError(
            f"This deployment is {deployment.status.value}. Wait for it to finish."
        )

    await runtime_service.restart(db, deployment, repository, current_user)
    return deployment_out(deployment, repository)


@router.delete("/{deployment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_deployment(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> Response:
    """
    Stop the app, remove its container, and delete the record.

    Refused while an administrator has it suspended: otherwise the owner could
    delete the suspended deployment, reconnect the same repository, and have a
    clean one a moment later — which would make suspension meaningless.
    """
    deployment, _ = await _owned_deployment(db, deployment_id, current_user.id)
    if deployment.suspended_by_admin:
        raise ConflictError(
            "This deployment has been suspended by an administrator and cannot "
            "be deleted. Contact them if you think that is a mistake."
        )
    await runtime_service.destroy(db, deployment)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{deployment_id}/runtime-logs", response_model=RuntimeLogsOut)
async def get_runtime_logs(
    deployment_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    tail: Annotated[int, Query(ge=10, le=2000)] = 500,
) -> RuntimeLogsOut:
    """
    What the running app has printed.

    Distinct from the build log: that one says why an image could not be
    produced, this one says why the app it produced will not stay up. A
    container that has exited still has logs, which is exactly when they
    matter most.
    """
    deployment, _ = await _owned_deployment(db, deployment_id, current_user.id)

    logs = ""
    running = False
    if deployment.build_method is BuildMethod.COMPOSE and deployment.compose_project:
        # Every service, not just the routed one: in a stack the reason the web
        # service is failing is usually printed by the database next to it.
        state = await docker.container_state(deployment.container_name or "")
        running = bool(state and state.get("Running"))
        logs = await compose.logs(deployment.compose_project, tail=tail)
        if not logs:
            logs = "(no output — this stack is not running)"
    elif deployment.container_name:
        state = await docker.container_state(deployment.container_name)
        running = bool(state and state.get("Running"))
        if state is not None:
            logs = await docker.container_logs(deployment.container_name, tail=tail)
        else:
            logs = "(no container — this deployment is not running)"

    return RuntimeLogsOut(
        deployment_id=deployment.id,
        status=deployment.status,
        logs=logs,
        running=running,
    )


async def events_of(db: AsyncSession, deployment_id: uuid.UUID) -> list[DeploymentEventOut]:
    """A deployment's timeline, oldest first. Shared with the admin console."""
    rows = (
        await db.execute(
            select(DeploymentEvent)
            .where(DeploymentEvent.deployment_id == deployment_id)
            .order_by(DeploymentEvent.created_at, DeploymentEvent.id)
        )
    ).scalars().all()
    return [DeploymentEventOut.model_validate(e, from_attributes=True) for e in rows]


@router.get("/{deployment_id}/ci-progress")
async def get_ci_progress(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> dict:
    """Where a GitHub Actions build has got to, step by step."""
    deployment, repository = await _owned_deployment(db, deployment_id, current_user.id)
    return await ci_progress_for(db, deployment, repository)


async def ci_progress_for(db: AsyncSession, deployment: Deployment, repository: Repository) -> dict:
    """
    The workflow run's steps, or an empty answer while there is no run yet
    (GitHub has not picked the workflow up) or the build was not on Actions.
    A GitHub error is reported in the answer rather than raised: progress is
    a nicety, and the page must not break because GitHub is slow.
    """
    from app.ci.progress import run_progress
    from app.github.token import get_access_token

    empty = {"status": None, "conclusion": None, "html_url": deployment.ci_run_url,
             "steps": [], "completed": 0, "total": 0, "current": None}
    if not deployment.ci_run_id:
        return empty
    try:
        token = await get_access_token(db, repository.user_id)
        return await run_progress(token, repository.full_name, deployment.ci_run_id)
    except Exception as exc:  # noqa: BLE001 — see docstring
        return {**empty, "error": str(getattr(exc, "message", exc))}


@router.get("/{deployment_id}/events", response_model=list[DeploymentEventOut])
async def get_events(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> list[DeploymentEventOut]:
    """The deployment's timeline, oldest first."""
    await _owned_deployment(db, deployment_id, current_user.id)
    return await events_of(db, deployment_id)


# ---------------------------------------------------------------------------
# AI diagnosis
# ---------------------------------------------------------------------------

async def diagnose_deployment(
    db: AsyncSession, deployment: Deployment, repository: Repository, *, refresh: bool = False
) -> dict:
    """
    Claude's explanation of why `deployment` failed — stored, so the second
    request for it is free. Shared with the admin console.
    """
    from datetime import datetime, timezone

    from app.builder import ai_diagnosis, diagnose

    if deployment.status is not DeploymentStatus.FAILED:
        raise ConflictError("Only a failed deployment can be diagnosed.")
    if deployment.ai_diagnosis and not refresh:
        return deployment.ai_diagnosis

    log = build_log_snapshot(deployment).logs
    if deployment.container_name and deployment.runtime_started_at:
        try:
            log += "\n\n--- runtime output ---\n" + await docker.container_logs(
                deployment.container_name, tail=150
            )
        except Exception:  # noqa: BLE001 — the build log alone is still useful
            pass
    known = diagnose.diagnose(log) or diagnose.diagnose_runtime(log)
    context = {
        "repository": repository.target_label,
        "build_method": deployment.build_method.value if deployment.build_method else None,
        "detected_type": repository.detected_type.value if repository.detected_type else None,
        "framework": repository.detected_framework,
        "error_recorded_by_platform": deployment.error_message,
        "known_signature": known.message() if known else None,
    }
    answer = await ai_diagnosis.explain(log, context)
    deployment.ai_diagnosis = {**answer, "created_at": datetime.now(timezone.utc).isoformat()}
    await db.commit()
    return deployment.ai_diagnosis


@router.post("/{deployment_id}/diagnose")
async def diagnose_with_ai(
    deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession, refresh: bool = False
) -> dict:
    """Ask Claude why this deployment failed. Rate limited: each call costs."""
    from app.core.ratelimit import ai_limiter

    deployment, repository = await _owned_deployment(db, deployment_id, current_user.id)
    if not deployment.ai_diagnosis or refresh:
        await ai_limiter.check(current_user.id)
    return await diagnose_deployment(db, deployment, repository, refresh=refresh)

