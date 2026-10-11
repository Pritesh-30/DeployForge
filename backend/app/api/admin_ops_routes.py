"""
Operating the platform: every app on it, the build queue, the machine, and
the record of what administrators did.

`admin_routes.py` manages accounts and reports analytics. This module is the
control room — an administrator can see any student's app exactly as its
owner does, and start, stop, restart, redeploy, suspend or remove it. Every
one of those actions is written to the audit log with who did it, because on
a machine a whole class shares, "who stopped my app?" deserves an answer.

Reading an app's *code* is deliberately absent: that would mean acting with
the student's own GitHub token, which they granted to deploy their app, not
to have it read by someone else.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.app_routes import activity_for
from app.api.deployment_routes import (
    build_log_snapshot,
    build_log_stream,
    deployment_out,
    diagnose_deployment,
    events_of,
    runtime_log_stream,
)
from app.auth.dependencies import AdminUser
from app.builder.trigger import trigger_build
from app.core.errors import ConflictError, NotFoundError
from app.db import get_db
from app.metrics import sampling
from app.metrics import views as metrics_views
from app.metrics.collector import usage_by_deployment
from app.models.audit import AuditEvent
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.github import GitHubConnection
from app.models.repository import Repository
from app.models.user import User
from app.queue.jobs import build_job_id
from app.queue.store import queue
from app.runtime import service as runtime_service
from app.schemas.app import ActivityOut, AppDetailOut, AppOut
from app.schemas.auth import UserOut
from app.schemas.deployment import (
    BuildLogsOut,
    BuildStartedOut,
    DeploymentEventOut,
    DeploymentOut,
    SuspendRequest,
)
from app.services.apps import LIVE, app_out, current_deployment, deployments_for, real_builds
from app.services.audit import audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-operations"])

DbSession = Annotated[AsyncSession, Depends(get_db)]
Window = Literal["1h", "6h", "24h"]


async def _app_with_owner(db: AsyncSession, app_id: uuid.UUID) -> tuple[Repository, User]:
    row = (
        await db.execute(
            select(Repository, User)
            .join(User, Repository.user_id == User.id)
            .where(Repository.id == app_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("App not found.")
    return row[0], row[1]


async def _detail(db: AsyncSession, repository: Repository, owner: User) -> AppDetailOut:
    grouped = await deployments_for(db, [repository.id])
    return app_out(repository, grouped.get(repository.id, []), detail=True, owner=owner)  # type: ignore[return-value]


def _runnable(deployments: list[Deployment]) -> Deployment | None:
    """
    What "start this app" should start: the live deployment if there is one,
    else the newest that built successfully. Not simply the newest: if the
    last build failed, starting means running the version before it.
    """
    for d in deployments:
        if d.status in LIVE:
            return d
    for d in deployments:
        if d.status in (DeploymentStatus.BUILT, DeploymentStatus.STOPPED):
            if d.image_ref or (d.build_method is BuildMethod.COMPOSE and d.compose_project):
                return d
    return None


# --- Apps -------------------------------------------------------------------

@router.get("/apps", response_model=list[AppOut])
async def all_apps(_admin: AdminUser, db: DbSession) -> list[AppOut]:
    """Every app on the platform with its owner, newest first."""
    rows = (
        await db.execute(
            select(Repository, User)
            .join(User, Repository.user_id == User.id)
            .order_by(Repository.created_at.desc())
        )
    ).all()
    grouped = await deployments_for(db, [r.id for r, _ in rows])
    return [app_out(r, grouped.get(r.id, []), owner=u) for r, u in rows]


@router.get("/apps/metrics/overview")
async def all_apps_metrics(_admin: AdminUser, db: DbSession) -> dict:
    ids = (await db.execute(select(Repository.id))).scalars().all()
    try:
        return await metrics_views.apps_overview(list(ids))
    except Exception:  # noqa: BLE001
        logger.warning("Metrics overview unavailable", exc_info=True)
        return {}


@router.get("/apps/{app_id}", response_model=AppDetailOut)
async def one_app(app_id: uuid.UUID, _admin: AdminUser, db: DbSession) -> AppDetailOut:
    repository, owner = await _app_with_owner(db, app_id)
    return await _detail(db, repository, owner)


@router.get("/apps/{app_id}/activity", response_model=list[ActivityOut])
async def one_app_activity(
    app_id: uuid.UUID, _admin: AdminUser, db: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[ActivityOut]:
    await _app_with_owner(db, app_id)
    return await activity_for(db, app_id=app_id, limit=limit)


@router.get("/apps/{app_id}/metrics")
async def one_app_metrics(
    app_id: uuid.UUID, _admin: AdminUser, db: DbSession,
    window: Window = "1h", points: Annotated[int, Query(ge=10, le=500)] = 120,
) -> dict:
    await _app_with_owner(db, app_id)
    return await metrics_views.app_metrics(app_id, window=window, points=points)


@router.post("/apps/{app_id}/start", response_model=AppDetailOut)
async def start_app(
    app_id: uuid.UUID, admin: AdminUser, db: DbSession, deployment: uuid.UUID | None = None
) -> AppDetailOut:
    """
    Run a student's app — or, given `deployment`, roll it back to that
    version. Bypasses their quota and deploy block — an administrator acting
    deliberately is the person those limits answer to — but not a
    suspension: lift that first, so the two decisions stay separate.
    """
    repository, owner = await _app_with_owner(db, app_id)
    suspension = await runtime_service.app_suspension(db, repository.id)
    if suspension is not None:
        raise ConflictError("This app is suspended. Resume it to run it again.")

    if deployment is not None:
        chosen = await db.get(Deployment, deployment)
        if chosen is None or chosen.repository_id != repository.id:
            raise NotFoundError("Deployment not found.")
        await runtime_service.promote(db, chosen, repository, owner, actor="admin")
        await audit(db, admin, "app.rollback", target_type="app", target_id=repository.id,
                    target_label=repository.target_label, subject_user_id=owner.id,
                    detail={"deployment": str(chosen.id)})
        return await _detail(db, repository, owner)

    grouped = await deployments_for(db, [repository.id])
    target = _runnable(grouped.get(repository.id, []))
    if target is None:
        raise ConflictError("This app has no successful build to run. Redeploy it.")
    if target.status not in LIVE:
        await runtime_service.start(db, target, repository, owner, actor="admin")
    await audit(db, admin, "app.start", target_type="app", target_id=repository.id,
                target_label=repository.target_label, subject_user_id=owner.id,
                detail={"deployment": str(target.id)})
    return await _detail(db, repository, owner)


@router.post("/apps/{app_id}/stop", response_model=AppDetailOut)
async def stop_app(app_id: uuid.UUID, admin: AdminUser, db: DbSession) -> AppDetailOut:
    repository, owner = await _app_with_owner(db, app_id)
    grouped = await deployments_for(db, [repository.id])
    for d in grouped.get(repository.id, []):
        if d.status in LIVE:
            await runtime_service.stop(db, d, actor="admin")
    await audit(db, admin, "app.stop", target_type="app", target_id=repository.id,
                target_label=repository.target_label, subject_user_id=owner.id)
    return await _detail(db, repository, owner)


@router.post("/apps/{app_id}/restart", response_model=AppDetailOut)
async def restart_app(app_id: uuid.UUID, admin: AdminUser, db: DbSession) -> AppDetailOut:
    repository, owner = await _app_with_owner(db, app_id)
    grouped = await deployments_for(db, [repository.id])
    live = next((d for d in grouped.get(repository.id, []) if d.status in LIVE), None)
    if live is None:
        raise ConflictError("This app is not running, so there is nothing to restart.")
    await runtime_service.restart(db, live, repository, owner, actor="admin")
    await audit(db, admin, "app.restart", target_type="app", target_id=repository.id,
                target_label=repository.target_label, subject_user_id=owner.id)
    return await _detail(db, repository, owner)


@router.post("/apps/{app_id}/redeploy", response_model=BuildStartedOut, status_code=status.HTTP_202_ACCEPTED)
async def redeploy_app(
    app_id: uuid.UUID, admin: AdminUser, db: DbSession, background_tasks: BackgroundTasks
) -> BuildStartedOut:
    """Build a student's app again from its branch, as they would."""
    repository, owner = await _app_with_owner(db, app_id)
    deployment = await trigger_build(
        db, repository, owner, actor="admin", background_tasks=background_tasks
    )
    await audit(db, admin, "app.redeploy", target_type="app", target_id=repository.id,
                target_label=repository.target_label, subject_user_id=owner.id,
                detail={"deployment": str(deployment.id)})
    return BuildStartedOut(
        deployment_id=deployment.id, status=deployment.status, target_label=repository.target_label
    )


@router.post("/apps/{app_id}/suspend", response_model=AppDetailOut)
async def suspend_app(
    app_id: uuid.UUID, admin: AdminUser, db: DbSession, payload: SuspendRequest | None = None,
) -> AppDetailOut:
    """
    Stop the app and keep it stopped: its owner cannot start, redeploy,
    delete or re-add it until an administrator resumes it.
    """
    repository, owner = await _app_with_owner(db, app_id)
    reason = payload.reason if payload else None
    grouped = await deployments_for(db, [repository.id])
    deployments = grouped.get(repository.id, [])
    target = current_deployment(real_builds(deployments)) or (deployments[0] if deployments else None)
    if target is None:
        raise ConflictError("This app has never been deployed, so there is nothing to suspend.")

    for d in deployments:
        if d.status in LIVE and d.id != target.id:
            await runtime_service.stop(db, d, actor="admin")
        try:
            await queue.cancel(build_job_id(d.id))
        except Exception:  # noqa: BLE001
            pass
    await runtime_service.stop(db, target, actor="admin", suspend=True, reason=reason)
    await audit(db, admin, "app.suspend", target_type="app", target_id=repository.id,
                target_label=repository.target_label, subject_user_id=owner.id,
                detail={"reason": reason} if reason else None)
    return await _detail(db, repository, owner)


@router.post("/apps/{app_id}/resume", response_model=AppDetailOut)
async def resume_app(app_id: uuid.UUID, admin: AdminUser, db: DbSession) -> AppDetailOut:
    """Lift the suspension. The app is left stopped; starting it is separate."""
    repository, owner = await _app_with_owner(db, app_id)
    grouped = await deployments_for(db, [repository.id])
    lifted = [d for d in grouped.get(repository.id, []) if d.suspended_by_admin]
    for d in lifted:
        d.suspended_by_admin = False
        d.suspension_reason = None
    await db.commit()
    for d in lifted:
        await runtime_service.record(db, d.id, "resume", "Suspension lifted by an administrator.",
                                     actor="admin")
    await audit(db, admin, "app.resume", target_type="app", target_id=repository.id,
                target_label=repository.target_label, subject_user_id=owner.id)
    return await _detail(db, repository, owner)


@router.delete("/apps/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_app(app_id: uuid.UUID, admin: AdminUser, db: DbSession) -> Response:
    """Remove an app entirely — containers, history and the connection."""
    repository, owner = await _app_with_owner(db, app_id)
    label = repository.target_label
    grouped = await deployments_for(db, [repository.id])
    for d in grouped.get(repository.id, []):
        try:
            await queue.cancel(build_job_id(d.id))
        except Exception:  # noqa: BLE001
            pass
        await runtime_service.destroy(db, d, actor="admin")
    await db.delete(repository)
    await db.commit()
    await audit(db, admin, "app.delete", target_type="app", target_id=app_id,
                target_label=label, subject_user_id=owner.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Students ---------------------------------------------------------------

@router.get("/users/{user_id}")
async def one_user(user_id: uuid.UUID, _admin: AdminUser, db: DbSession) -> dict:
    """One account in full: profile, apps, recent activity, and admin actions on it."""
    user = await db.get(User, user_id)
    if user is None:
        raise NotFoundError("Account not found.")
    repositories = (
        await db.execute(
            select(Repository).where(Repository.user_id == user.id).order_by(Repository.created_at.desc())
        )
    ).scalars().all()
    grouped = await deployments_for(db, [r.id for r in repositories])
    connection = (
        await db.execute(select(GitHubConnection).where(GitHubConnection.user_id == user.id))
    ).scalar_one_or_none()
    audits = (
        await db.execute(
            select(AuditEvent)
            .where(AuditEvent.subject_user_id == user.id)
            .order_by(AuditEvent.created_at.desc())
            .limit(50)
        )
    ).scalars().all()

    all_deployments = [d for ds in grouped.values() for d in ds]
    build_seconds = [
        (d.build_finished_at - d.build_started_at).total_seconds()
        for d in all_deployments
        if d.build_started_at and d.build_finished_at
    ]
    return {
        "user": UserOut.model_validate(user).model_dump(mode="json"),
        "github_username": connection.github_username if connection else None,
        "apps": [app_out(r, grouped.get(r.id, []), owner=user).model_dump(mode="json") for r in repositories],
        "activity": [a.model_dump(mode="json") for a in await activity_for(db, user_id=user.id, limit=40)],
        "audit": [_audit_out(a) for a in audits],
        "usage": {
            "apps": len(repositories),
            "running": sum(1 for d in all_deployments if d.status in LIVE),
            "builds": len(real_builds(all_deployments)),
            "failed": sum(1 for d in all_deployments if d.status is DeploymentStatus.FAILED),
            "build_minutes": round(sum(build_seconds) / 60, 1),
            "quota": user.max_deployments,
        },
    }


# --- The queue --------------------------------------------------------------

@router.get("/queue")
async def queue_snapshot(_admin: AdminUser, db: DbSession) -> dict:
    """
    The build queue right now: what is running, what waits in each student's
    lane and in what order the fair scheduler will take it, what is backing
    off before a retry, and what finished recently.
    """
    snapshot = await queue.snapshot(recent=40)
    tenant_ids = set(snapshot.ring)
    for job in [*snapshot.running, *snapshot.delayed, *snapshot.recent]:
        tenant_ids.add(job.tenant)
    emails: dict[str, str] = {}
    valid = []
    for t in tenant_ids:
        try:
            valid.append(uuid.UUID(t))
        except ValueError:
            continue
    if valid:
        for uid, email in (await db.execute(select(User.id, User.email).where(User.id.in_(valid)))).all():
            emails[str(uid)] = email

    def job(j):
        return {**j.to_dict(), "tenant_email": emails.get(j.tenant)}

    stats = await queue.stats()
    return {
        "ring": [{"tenant": t, "email": emails.get(t), "waiting": len(snapshot.pending.get(t, []))}
                 for t in snapshot.ring],
        "pending": {t: [job(j) for j in jobs] for t, jobs in snapshot.pending.items()},
        "order": snapshot.order,
        "running": [job(j) for j in snapshot.running],
        "delayed": [job(j) for j in snapshot.delayed],
        "recent": [job(j) for j in snapshot.recent],
        "stats": stats,
        "concurrency": _concurrency(),
    }


def _concurrency() -> int:
    from app.config import settings

    return settings.build_concurrency


@router.post("/queue/{job_id}/cancel")
async def cancel_job(job_id: str, admin: AdminUser, db: DbSession) -> dict:
    """Take a waiting build off the queue. Its deployment is marked failed."""
    previous = await queue.cancel(job_id)
    if previous is None:
        raise NotFoundError("No such job.")
    if previous == "running":
        return {"state": "running", "message": "A running build cannot be cancelled."}
    job = await queue.get(job_id)
    if job and job.kind == "build":
        deployment = await db.get(Deployment, uuid.UUID(job.payload["deployment_id"]))
        if deployment is not None and deployment.status is DeploymentStatus.QUEUED:
            deployment.status = DeploymentStatus.FAILED
            deployment.build_finished_at = datetime.now(timezone.utc)
            deployment.error_message = "An administrator removed this build from the queue."
            await db.commit()
    await audit(db, admin, "queue.cancel", target_type="job", target_id=job_id,
                target_label=job.label if job else None,
                subject_user_id=uuid.UUID(job.tenant) if job and _is_uuid(job.tenant) else None)
    return {"state": "cancelled"}


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


# --- The machine ------------------------------------------------------------

@router.get("/platform/metrics")
async def platform_metrics(
    _admin: AdminUser, window: Window = "1h", points: Annotated[int, Query(ge=10, le=500)] = 120,
) -> dict:
    """The whole machine over time: CPU, memory, apps running, builds running."""
    return await metrics_views.host_metrics(window=window, points=points)


@router.get("/platform/containers")
async def platform_containers(_admin: AdminUser, db: DbSession) -> dict:
    """
    Every container on the Docker host with its live usage, and which app —
    and whose — each one belongs to. Platform containers (database, router,
    registry) are listed too, marked as such.
    """
    containers, stats, info = await sampling.running_containers(), await sampling.stats_for_all(), await sampling.daemon_info()
    deployments = (
        await db.execute(
            select(Deployment, Repository, User)
            .join(Repository, Deployment.repository_id == Repository.id)
            .join(User, Deployment.user_id == User.id)
            .where(Deployment.status.in_(LIVE))
        )
    ).all()

    owner_of: dict[str, dict] = {}
    by_project = {d.compose_project: (d, r, u) for d, r, u in deployments if d.compose_project}
    by_name = {d.container_name: (d, r, u) for d, r, u in deployments if d.container_name}
    for row in containers:
        name = row.get("Names") or ""
        project = row.get("LabelMap", {}).get("com.docker.compose.project")
        match = by_name.get(name) or (by_project.get(project) if project else None)
        if match:
            d, r, u = match
            owner_of[name] = {"app_id": str(r.id), "app": r.target_label, "owner": u.email,
                              "deployment_id": str(d.id)}

    rows = []
    for row in containers:
        name = row.get("Names") or ""
        s = stats.get(name)
        rows.append({
            "name": name,
            "image": row.get("Image"),
            "status": row.get("Status"),
            "created": row.get("RunningFor"),
            "platform": name.startswith("deployforge-") or name.startswith("deployforge_"),
            "app": owner_of.get(name),
            "cpu": s.cpu_percent if s else None,
            "mem": s.mem_bytes if s else None,
            "mem_limit": s.mem_limit_bytes if s else None,
            "net_rx": s.net_rx_bytes if s else None,
            "net_tx": s.net_tx_bytes if s else None,
            "pids": s.pids if s else None,
        })
    rows.sort(key=lambda r: -(r["cpu"] or 0))
    return {
        "host": {
            "cpus": info.get("NCPU"),
            "mem_total": info.get("MemTotal"),
            "os": info.get("OperatingSystem"),
            "kernel": info.get("KernelVersion"),
            "docker": info.get("ServerVersion"),
            "containers_running": info.get("ContainersRunning"),
            "images": info.get("Images"),
        },
        "containers": rows,
    }


@router.get("/platform/disk")
async def platform_disk(_admin: AdminUser) -> list[dict]:
    """What Docker's images, containers, volumes and build cache take up."""
    return await sampling.disk_usage()


# --- The audit log ----------------------------------------------------------

def _audit_out(a: AuditEvent) -> dict:
    return {
        "id": str(a.id),
        "actor_email": a.actor_email,
        "actor_role": a.actor_role,
        "action": a.action,
        "target_type": a.target_type,
        "target_id": a.target_id,
        "target_label": a.target_label,
        "subject_user_id": str(a.subject_user_id) if a.subject_user_id else None,
        "detail": a.detail,
        "created_at": a.created_at.isoformat(),
    }


@router.get("/audit")
async def audit_log(
    _admin: AdminUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    action: str | None = None,
) -> dict:
    stmt = select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditEvent.action.startswith(action))
    events = (await db.execute(stmt)).scalars().all()
    counts = dict(
        (await db.execute(select(AuditEvent.action, func.count()).group_by(AuditEvent.action))).all()
    )
    return {"events": [_audit_out(a) for a in events], "counts": counts}


# --- Any deployment's logs --------------------------------------------------
# The same views the owner has, unscoped: diagnosing a student's failure is
# most of what an administrator is asked to do.

async def _any_deployment(db: AsyncSession, deployment_id: uuid.UUID) -> tuple[Deployment, Repository, User]:
    row = (
        await db.execute(
            select(Deployment, Repository, User)
            .join(Repository, Deployment.repository_id == Repository.id)
            .join(User, Deployment.user_id == User.id)
            .where(Deployment.id == deployment_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("Deployment not found.")
    return row[0], row[1], row[2]


@router.get("/deployments/{deployment_id}/detail", response_model=DeploymentOut)
async def any_deployment(deployment_id: uuid.UUID, _admin: AdminUser, db: DbSession) -> DeploymentOut:
    d, r, u = await _any_deployment(db, deployment_id)
    return deployment_out(d, r, user_email=u.email)


@router.get("/deployments/{deployment_id}/logs", response_model=BuildLogsOut)
async def any_build_log(deployment_id: uuid.UUID, _admin: AdminUser, db: DbSession) -> BuildLogsOut:
    d, _, _ = await _any_deployment(db, deployment_id)
    return build_log_snapshot(d)


@router.get("/deployments/{deployment_id}/events", response_model=list[DeploymentEventOut])
async def any_events(deployment_id: uuid.UUID, _admin: AdminUser, db: DbSession) -> list[DeploymentEventOut]:
    await _any_deployment(db, deployment_id)
    return await events_of(db, deployment_id)


@router.get("/deployments/{deployment_id}/logs/stream")
async def any_build_log_stream(
    deployment_id: uuid.UUID, request: Request, _admin: AdminUser, db: DbSession,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse:
    d, _, _ = await _any_deployment(db, deployment_id)
    return build_log_stream(d, request, offset)


@router.get("/deployments/{deployment_id}/runtime-logs/stream")
async def any_runtime_log_stream(
    deployment_id: uuid.UUID, request: Request, _admin: AdminUser, db: DbSession,
    tail: Annotated[int, Query(ge=0, le=2000)] = 300,
) -> StreamingResponse:
    d, _, _ = await _any_deployment(db, deployment_id)
    return runtime_log_stream(d, request, tail)


@router.post("/deployments/{deployment_id}/diagnose")
async def any_diagnose(
    deployment_id: uuid.UUID, admin: AdminUser, db: DbSession, refresh: bool = False
) -> dict:
    from app.core.ratelimit import ai_limiter

    d, r, _ = await _any_deployment(db, deployment_id)
    if not d.ai_diagnosis or refresh:
        await ai_limiter.check(admin.id)
    return await diagnose_deployment(db, d, r, refresh=refresh)

