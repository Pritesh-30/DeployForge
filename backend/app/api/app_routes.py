"""
App routes — the student's own apps: what they are, how they are doing, their
code, and what can be done to them.

`deployment_routes.py` reads and controls individual deployments. This module
is about the thing those deployments belong to. The database already modelled
it — one `repositories` row per connected target, many `deployments` beneath
it — and the shape every view here returns comes from `services/apps.py`, so
the administrator's console describes an app exactly as its owner sees it.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deployment_routes import deployment_out
from app.auth.dependencies import CurrentUser
from app.builder.trigger import trigger_build
from app.core.errors import AppError, ConflictError, NotFoundError
from app.core.ratelimit import deploy_limiter
from app.db import get_db
from app.github import code
from app.github.token import get_access_token
from app.metrics import views as metrics_views
from app.models.deployment import Deployment
from app.models.event import DeploymentEvent
from app.models.repository import Repository
from app.queue.jobs import build_job_id
from app.queue.store import queue
from app.runtime import service as runtime_service
from app.schemas.app import ActivityOut, AppDetailOut, AppOut, AppUpdate
from app.schemas.deployment import BuildStartedOut, DeploymentOut
from app.services.apps import app_out, deployments_for

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/apps", tags=["apps"])

DbSession = Annotated[AsyncSession, Depends(get_db)]
Window = Literal["1h", "6h", "24h"]


async def _owned_app(db: AsyncSession, app_id: uuid.UUID, user_id: uuid.UUID) -> Repository:
    repository = (
        await db.execute(
            select(Repository).where(Repository.id == app_id, Repository.user_id == user_id)
        )
    ).scalar_one_or_none()
    if repository is None:
        raise NotFoundError("App not found.")
    return repository


async def activity_for(
    db: AsyncSession, *, user_id: uuid.UUID | None = None,
    app_id: uuid.UUID | None = None, limit: int = 50,
) -> list[ActivityOut]:
    """Events across one app, or across everything one person owns."""
    stmt = (
        select(DeploymentEvent, Deployment.repository_id, Repository)
        .join(Deployment, DeploymentEvent.deployment_id == Deployment.id)
        .join(Repository, Deployment.repository_id == Repository.id)
        .order_by(DeploymentEvent.created_at.desc(), DeploymentEvent.id.desc())
        .limit(limit)
    )
    if user_id is not None:
        stmt = stmt.where(Repository.user_id == user_id)
    if app_id is not None:
        stmt = stmt.where(Repository.id == app_id)
    rows = (await db.execute(stmt)).all()
    return [
        ActivityOut(
            id=e.id,
            deployment_id=e.deployment_id,
            app_id=repo_id,
            app_label=repo.target_label,
            stage=e.stage,
            level=e.level.value,
            message=e.message,
            actor=e.actor,
            created_at=e.created_at,
        )
        for e, repo_id, repo in rows
    ]


# --- The list ---------------------------------------------------------------

@router.get("", response_model=list[AppOut])
async def list_my_apps(current_user: CurrentUser, db: DbSession) -> list[AppOut]:
    """
    Every app this student has connected, most recently connected first.
    Two queries regardless of how many apps there are.
    """
    repositories = (
        await db.execute(
            select(Repository)
            .where(Repository.user_id == current_user.id)
            .order_by(Repository.created_at.desc())
        )
    ).scalars().all()
    grouped = await deployments_for(db, [r.id for r in repositories])
    return [app_out(r, grouped.get(r.id, [])) for r in repositories]


@router.get("/metrics/overview")
async def my_apps_metrics(current_user: CurrentUser, db: DbSession) -> dict:
    """Each app's latest usage, an hour of CPU and its hour's uptime."""
    ids = (
        await db.execute(select(Repository.id).where(Repository.user_id == current_user.id))
    ).scalars().all()
    try:
        return await metrics_views.apps_overview(list(ids))
    except Exception:  # noqa: BLE001 — graphs are optional; the list is not
        logger.warning("Metrics overview unavailable", exc_info=True)
        return {}


@router.get("/activity", response_model=list[ActivityOut])
async def my_activity(
    current_user: CurrentUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[ActivityOut]:
    """Everything that happened to any of this student's apps, newest first."""
    return await activity_for(db, user_id=current_user.id, limit=limit)


# --- One app ----------------------------------------------------------------

@router.get("/{app_id}", response_model=AppDetailOut)
async def get_app(app_id: uuid.UUID, current_user: CurrentUser, db: DbSession) -> AppDetailOut:
    """One app, every deployment of it, and what that history adds up to."""
    repository = await _owned_app(db, app_id, current_user.id)
    grouped = await deployments_for(db, [repository.id])
    return app_out(repository, grouped.get(repository.id, []), detail=True)  # type: ignore[return-value]


@router.patch("/{app_id}", response_model=AppDetailOut)
async def update_app(
    app_id: uuid.UUID, payload: AppUpdate, current_user: CurrentUser, db: DbSession
) -> AppDetailOut:
    """
    Change the branch an app deploys from, or turn push deploys on or off.

    A branch is checked against GitHub before it is saved: a typo would
    otherwise surface minutes later as a failed build. The new branch takes
    effect on the next deploy — on the Actions backend, that deploy commits
    the workflow to it.
    """
    repository = await _owned_app(db, app_id, current_user.id)

    if payload.branch is not None and payload.branch != repository.default_branch:
        token = await get_access_token(db, current_user.id)
        names = {b["name"] for b in await code.branches(token, repository.full_name)}
        if payload.branch not in names:
            raise AppError(f"{repository.full_name} has no branch named {payload.branch!r}.")
        repository.default_branch = payload.branch
    if payload.auto_deploy is not None:
        repository.auto_deploy = payload.auto_deploy

    await db.commit()
    await db.refresh(repository)
    grouped = await deployments_for(db, [repository.id])
    return app_out(repository, grouped.get(repository.id, []), detail=True)  # type: ignore[return-value]


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_app(app_id: uuid.UUID, current_user: CurrentUser, db: DbSession) -> Response:
    """
    Remove the app: every container it is running, every deployment record,
    any build still waiting in the queue, and the connection to the repository.

    Deleting the deployments alone would leave the repository connected but
    invisible — nothing would list it, and reconnecting it would collide with
    the row still holding its place. So the app goes as a whole, and the
    repository becomes available to connect again.

    Refused while an administrator has any of it suspended: otherwise the owner
    could delete a suspended app, reconnect the same repository and have a
    clean one a moment later, which would make suspension meaningless.
    """
    repository = await _owned_app(db, app_id, current_user.id)
    deployments = (
        await db.execute(select(Deployment).where(Deployment.repository_id == repository.id))
    ).scalars().all()

    if any(d.suspended_by_admin for d in deployments):
        raise ConflictError(
            "This app has been suspended by an administrator and cannot be "
            "deleted. Contact them if you think that is a mistake."
        )

    for deployment in deployments:
        try:
            await queue.cancel(build_job_id(deployment.id))
        except Exception:  # noqa: BLE001 — a stale job finds no row and ends
            logger.debug("Could not cancel queued build", exc_info=True)
        await runtime_service.destroy(db, deployment)

    await db.delete(repository)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{app_id}/redeploy", response_model=BuildStartedOut, status_code=status.HTTP_202_ACCEPTED)
async def redeploy(
    app_id: uuid.UUID, current_user: CurrentUser, db: DbSession, background_tasks: BackgroundTasks
) -> BuildStartedOut:
    """Build the app again from the latest commit on its branch."""
    if not current_user.can_deploy:
        raise AppError(
            current_user.deploy_block_reason
            or "An administrator has revoked your permission to deploy.",
            status_code=403,
        )
    repository = await _owned_app(db, app_id, current_user.id)
    await deploy_limiter.check(current_user.id)
    deployment = await trigger_build(db, repository, current_user, background_tasks=background_tasks)
    return BuildStartedOut(
        deployment_id=deployment.id, status=deployment.status, target_label=repository.target_label
    )


@router.post("/{app_id}/deployments/{deployment_id}/promote", response_model=DeploymentOut)
async def promote(
    app_id: uuid.UUID, deployment_id: uuid.UUID, current_user: CurrentUser, db: DbSession
) -> DeploymentOut:
    """
    Roll back: make an earlier deployment the live one again. Runs the image
    that deployment built — seconds, not a rebuild — and retires the current
    one. Rate limited like a deploy, since it replaces what is running.
    """
    repository = await _owned_app(db, app_id, current_user.id)
    deployment = await db.get(Deployment, deployment_id)
    if deployment is None or deployment.repository_id != repository.id:
        raise NotFoundError("Deployment not found.")
    await deploy_limiter.check(current_user.id)
    await runtime_service.promote(db, deployment, repository, current_user)
    return deployment_out(deployment, repository)


@router.get("/{app_id}/activity", response_model=list[ActivityOut])
async def app_activity(
    app_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[ActivityOut]:
    repository = await _owned_app(db, app_id, current_user.id)
    return await activity_for(db, app_id=repository.id, limit=limit)


@router.get("/{app_id}/metrics")
async def app_metrics(
    app_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    window: Window = "1h",
    points: Annotated[int, Query(ge=10, le=500)] = 120,
) -> dict:
    """CPU, memory, network and response time over a window, downsampled."""
    repository = await _owned_app(db, app_id, current_user.id)
    return await metrics_views.app_metrics(repository.id, window=window, points=points)


# --- Code -------------------------------------------------------------------
#
# Read with the owner's own GitHub token: a student sees exactly what GitHub
# would let them see, and nothing is stored beyond a cache keyed by commit.

async def _code_context(
    db: AsyncSession, app_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[Repository, str]:
    repository = await _owned_app(db, app_id, user_id)
    token = await get_access_token(db, user_id)
    return repository, token


@router.get("/{app_id}/code/summary")
async def code_summary(
    app_id: uuid.UUID, current_user: CurrentUser, db: DbSession, ref: str | None = None
) -> dict:
    """The repository at a glance: metadata, languages, branches, the commit."""
    repository, token = await _code_context(db, app_id, current_user.id)
    ref = ref or repository.default_branch
    sha = await code.resolve(token, repository.full_name, ref)
    meta = await code.repository(token, repository.full_name)
    langs = await code.languages(token, repository.full_name)
    branch_list = await code.branches(token, repository.full_name)
    head = await code.commits(token, repository.full_name, sha, per_page=1)
    total = sum(langs.values()) or 1
    return {
        "repository": meta,
        "ref": ref,
        "sha": sha,
        "deploy_path": repository.deploy_path,
        "service_paths": repository.service_paths,
        "branch": repository.default_branch,
        "branches": branch_list,
        "languages": [
            {"name": name, "bytes": size, "share": size / total}
            for name, size in sorted(langs.items(), key=lambda kv: -kv[1])
        ],
        "head": head[0] if head else None,
    }


@router.get("/{app_id}/code/tree")
async def code_tree(
    app_id: uuid.UUID, current_user: CurrentUser, db: DbSession, ref: str | None = None
) -> dict:
    repository, token = await _code_context(db, app_id, current_user.id)
    sha = await code.resolve(token, repository.full_name, ref or repository.default_branch)
    listing = await code.tree(token, repository.full_name, sha)
    return {"sha": sha, **listing}


@router.get("/{app_id}/code/file")
async def code_file(
    app_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    path: Annotated[str, Query(min_length=1, max_length=1024)],
    ref: str | None = None,
) -> dict:
    repository, token = await _code_context(db, app_id, current_user.id)
    sha = await code.resolve(token, repository.full_name, ref or repository.default_branch)
    return await code.file(token, repository.full_name, sha, path.strip("/"))


@router.get("/{app_id}/code/readme")
async def code_readme(
    app_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    dir: str = "",
    ref: str | None = None,
) -> dict:
    repository, token = await _code_context(db, app_id, current_user.id)
    sha = await code.resolve(token, repository.full_name, ref or repository.default_branch)
    found = await code.readme(token, repository.full_name, sha, dir)
    return found or {"path": None, "name": None, "content": None}


@router.get("/{app_id}/code/commits")
async def code_commits(
    app_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    ref: str | None = None,
    path: str | None = None,
    page: Annotated[int, Query(ge=1, le=50)] = 1,
) -> list[dict]:
    repository, token = await _code_context(db, app_id, current_user.id)
    return await code.commits(
        token, repository.full_name, ref or repository.default_branch,
        path=path or None, page=page,
    )


@router.get("/{app_id}/code/compare")
async def code_compare(
    app_id: uuid.UUID,
    current_user: CurrentUser,
    db: DbSession,
    base: Annotated[str, Query(min_length=4, max_length=64)],
    head: Annotated[str, Query(min_length=4, max_length=64)],
) -> dict:
    """What changed between two deployments' commits."""
    repository, token = await _code_context(db, app_id, current_user.id)
    base_sha = await code.resolve(token, repository.full_name, base)
    head_sha = await code.resolve(token, repository.full_name, head)
    return await code.compare(token, repository.full_name, base_sha, head_sha)
