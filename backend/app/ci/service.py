"""
Builds that run in GitHub Actions, from the server's side.

The life of one:

  1. `dispatch`  — the dashboard's Deploy button. Commits the workflow file to
                   the student's repository (once; unchanged files are not
                   recommitted) and starts it. A push starts it too, without
                   this step.
  2. `begin`     — the run calls in. The server checks the run really belongs
                   to the app's repository, records it as a deployment, and
                   answers with what to build and the environment to build with.
  3. `finish`    — the run reports the image(s) it pushed, and its log.
  4. `after_build` — the server readies what the images need to run (a compose
                   stack's working copy, a multi-service stack file) and starts
                   the app, which replaces the version that was running.

Nothing is built on the server, and nothing about the run is trusted beyond
what GitHub signed: the repository, the commit and the run id.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.builder import diagnose
from app.builder import service as builder
from app.builder import stack
from app.ci import workflow
from app.config import settings
from app.core.errors import AppError, NotFoundError, PermissionError_
from app.db import AsyncSessionLocal
from app.detection.candidates import ROOT_PATH, resolve_path
from app.github import client as github_client
from app.github.download import downloaded_repository
from app.github.token import get_access_token, get_connection
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.event import EventLevel
from app.models.repository import Repository
from app.models.user import User
from app.runtime import compose
from app.runtime import service as runtime
from app.runtime.service import record

logger = logging.getLogger(__name__)

# The OAuth scopes a student's GitHub connection needs for this build path.
REQUIRED_SCOPES = ("workflow", "read:packages")

# How long to keep asking GitHub to start a workflow it has just been given.
# A freshly committed workflow file takes a few seconds to register.
_DISPATCH_ATTEMPTS = 6
_DISPATCH_DELAY_SECONDS = 4.0

# The most of a run's log the server keeps. Enough for any error, bounded so a
# runaway build cannot fill the disk.
MAX_LOG_CHARS = 1_000_000

_IN_FLIGHT = (
    DeploymentStatus.QUEUED,
    DeploymentStatus.BUILDING,
    DeploymentStatus.PUSHING,
)


class CiNotConfiguredError(AppError):
    code = "ci_not_configured"
    status_code = 503


class MissingScopeError(AppError):
    code = "github_scope_missing"
    status_code = 403


# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

def ensure_configured() -> None:
    """Refuse early when GitHub could not call this server back."""
    url = settings.public_api_url.strip().lower()
    if not url.startswith("https://") or "localhost" in url or "127.0.0.1" in url:
        raise CiNotConfiguredError(
            "Builds run in GitHub Actions, which has to call this server back, "
            f"but PUBLIC_API_URL is {settings.public_api_url!r}. Set it to the "
            "server's public https address, or set BUILD_BACKEND=local."
        )


def missing_scopes(connection) -> list[str]:
    """The scopes this build path needs that `connection` was not granted."""
    granted = {
        s.strip() for s in ((connection.scopes or "") if connection else "").split(",")
    }
    # `write:packages` implies read; `repo` alone does not grant workflows.
    if "write:packages" in granted:
        granted.add("read:packages")
    return [s for s in REQUIRED_SCOPES if s not in granted]


async def ensure_scopes(db: AsyncSession, user_id: uuid.UUID) -> None:
    """
    The student's GitHub connection must allow writing workflows and reading
    packages. Connections made before builds moved to Actions do not, and the
    fix — reconnecting — is something only they can do.
    """
    missing = missing_scopes(await get_connection(db, user_id))
    if missing:
        raise MissingScopeError(
            "Builds now run in GitHub Actions in your own repository. Reconnect "
            "GitHub (Deploy new → Reconnect GitHub) and approve the new "
            f"permissions: {', '.join(missing)}."
        )


def _write_log(deployment: Deployment, text: str) -> Path:
    path = (
        Path(deployment.logs_ref)
        if deployment.logs_ref
        else builder.log_path_for(deployment.id)
    )
    deployment.logs_ref = str(path)
    builder._append(path, text)
    return path


def _run_url(claims: dict[str, Any]) -> str:
    return f"https://github.com/{claims['repository']}/actions/runs/{claims['run_id']}"


# ---------------------------------------------------------------------------
# 1. Dispatch
# ---------------------------------------------------------------------------

async def queue(db: AsyncSession, repository: Repository, user: User) -> Deployment:
    """
    Record a dashboard-requested build, before GitHub has been asked to run it.

    `build_started_at` is set now so that a run that never starts is
    eventually released (see `runtime.ci_build_abandoned`).
    """
    deployment = Deployment(
        repository_id=repository.id,
        user_id=user.id,
        status=DeploymentStatus.QUEUED,
        built_on_actions=True,
        ci_trigger="dashboard",
        build_started_at=datetime.now(timezone.utc),
    )
    db.add(deployment)
    await db.commit()
    await db.refresh(deployment)
    _write_log(
        deployment,
        f"Building {repository.target_label} in GitHub Actions\n"
        f"  repository {repository.full_name}\n"
        f"  branch     {repository.default_branch}\n"
        f"  workflow   {workflow.workflow_path(repository)}\n\n"
        "Asking GitHub to start the workflow...\n",
    )
    await db.commit()
    return deployment


async def dispatch(deployment_id: uuid.UUID, db: AsyncSession | None = None) -> None:
    """Commit the workflow (if it changed) and start it. Never raises."""
    if db is not None:
        await _dispatch(db, deployment_id)
        return
    async with AsyncSessionLocal() as own_session:
        await _dispatch(own_session, deployment_id)


async def _dispatch(db: AsyncSession, deployment_id: uuid.UUID) -> None:
    deployment = await db.get(Deployment, deployment_id)
    if deployment is None or deployment.status is not DeploymentStatus.QUEUED:
        return
    repository = await db.get(Repository, deployment.repository_id)
    if repository is None:
        return

    try:
        token = await get_access_token(db, repository.user_id)
        committed = await github_client.put_file(
            token,
            repository.full_name,
            workflow.workflow_path(repository),
            content=workflow.render(repository),
            branch=repository.default_branch,
            # `[skip ci]` keeps this commit from triggering the workflow it
            # adds: the dispatch below is the one build this deploy wants.
            message="Add DeployForge deploy workflow [skip ci]",
        )
        if committed:
            _write_log(
                deployment,
                f"Committed {workflow.workflow_path(repository)} to "
                f"{repository.default_branch}.\n",
            )
            await record(
                db, deployment.id, "build",
                f"Added {workflow.workflow_path(repository)} to "
                f"{repository.full_name}. Every push to "
                f"{repository.default_branch} now deploys automatically.",
            )

        started = False
        for attempt in range(_DISPATCH_ATTEMPTS):
            started = await github_client.dispatch_workflow(
                token,
                repository.full_name,
                workflow.workflow_filename(repository),
                ref=repository.default_branch,
                inputs={"deployment": str(deployment.id)},
            )
            if started:
                break
            await asyncio.sleep(_DISPATCH_DELAY_SECONDS * (attempt + 1) / 2)
        if not started:
            raise AppError(
                "GitHub did not recognise the DeployForge workflow in "
                f"{repository.full_name}. Check that Actions is enabled for the "
                "repository, then deploy again."
            )
    except AppError as exc:
        await _fail(db, deployment, exc.message)
        return
    except Exception as exc:  # noqa: BLE001 — never leave a build stuck
        logger.exception("Dispatch for %s failed", deployment_id)
        await _fail(db, deployment, f"{type(exc).__name__}: {exc}")
        return

    _write_log(deployment, "Workflow started. Waiting for a GitHub runner...\n")
    await db.commit()
    await record(
        db, deployment.id, "build",
        "Workflow started in GitHub Actions. Waiting for a runner.",
    )


async def _fail(db: AsyncSession, deployment: Deployment, message: str) -> None:
    deployment.status = DeploymentStatus.FAILED
    deployment.error_message = message
    deployment.build_finished_at = datetime.now(timezone.utc)
    _write_log(deployment, f"\n{message}\n")
    await db.commit()
    await record(db, deployment.id, "build", message, level=EventLevel.ERROR)


# ---------------------------------------------------------------------------
# 2. Begin
# ---------------------------------------------------------------------------

def _refusal(
    repository: Repository,
    user: User,
    siblings: list[Deployment],
    claims: dict[str, Any],
) -> str | None:
    """Why this run may not build, or None if it may."""
    branch_ref = f"refs/heads/{repository.default_branch}"
    if claims.get("ref") != branch_ref:
        return (
            f"{claims.get('ref')} is not {branch_ref}, the branch this app "
            "deploys from."
        )
    if not user.is_active:
        return "The DeployForge account that owns this app is disabled."
    if not user.can_deploy:
        return (
            user.deploy_block_reason
            or "An administrator has revoked this account's permission to deploy."
        )
    if any(d.suspended_by_admin for d in siblings):
        return "An administrator has suspended this app."
    return None


def _skip(reason: str) -> dict[str, Any]:
    """An answer telling the run there is nothing to build, and why."""
    return {"build": False, "reason": reason}


async def _owned_by_run(
    db: AsyncSession, repository_id: uuid.UUID, claims: dict[str, Any]
) -> Repository:
    """The app, provided the run calling about it is in the app's repository."""
    repository = await db.get(Repository, repository_id)
    if repository is None:
        raise NotFoundError(
            "This app is no longer connected to DeployForge. Delete the "
            "DeployForge workflow file from the repository to stop these runs."
        )
    # The numeric id, not the name: a renamed repository keeps its id, and a
    # new repository created under an old name does not inherit it.
    if str(repository.github_repo_id) != str(claims["repository_id"]):
        raise PermissionError_(
            "This run is not in the repository the app was connected from."
        )
    return repository


async def begin(
    db: AsyncSession,
    claims: dict[str, Any],
    *,
    target: uuid.UUID,
    deployment_id: uuid.UUID | None,
) -> dict[str, Any]:
    """Register a run as a deployment and tell it what to build."""
    repository = await _owned_by_run(db, target, claims)
    user = await db.get(User, repository.user_id)
    if user is None:
        raise NotFoundError("The owner of this app no longer exists.")

    siblings = (
        await db.execute(
            select(Deployment).where(Deployment.repository_id == repository.id)
        )
    ).scalars().all()

    reason = _refusal(repository, user, siblings, claims)
    if reason is not None:
        # The dashboard's own request is closed with the reason rather than
        # left queued until it is given up on.
        queued = next(
            (
                d for d in siblings
                if d.id == deployment_id and d.status is DeploymentStatus.QUEUED
            ),
            None,
        )
        if queued is not None:
            await _fail(db, queued, reason)
        return _skip(reason)

    deployment = None
    if deployment_id is not None:
        deployment = next((d for d in siblings if d.id == deployment_id), None)
        # A re-run of a finished dispatch carries the same id; it becomes a
        # new deployment rather than rewriting the history of the old one.
        if deployment is not None and deployment.status is not DeploymentStatus.QUEUED:
            deployment = None

    trigger = "dashboard" if claims.get("event_name") == "workflow_dispatch" else "push"
    if deployment is None:
        deployment = Deployment(
            repository_id=repository.id, user_id=user.id, built_on_actions=True
        )
        db.add(deployment)
        await db.flush()

    # Only the newest build of an app matters. The workflow cancels the run it
    # replaces; this releases that run's row, which will never hear back.
    for older in siblings:
        if older.id != deployment.id and older.status in _IN_FLIGHT:
            older.status = DeploymentStatus.FAILED
            older.build_finished_at = datetime.now(timezone.utc)
            older.error_message = (
                f"Replaced by a newer build of commit {claims['sha'][:7]}."
            )

    deployment.status = DeploymentStatus.BUILDING
    deployment.built_on_actions = True
    deployment.ci_trigger = trigger
    deployment.ci_run_id = int(claims["run_id"])
    deployment.ci_run_url = _run_url(claims)
    deployment.commit_sha = claims["sha"]
    deployment.build_started_at = deployment.build_started_at or datetime.now(timezone.utc)
    deployment.build_finished_at = None
    deployment.error_message = None
    deployment.image_ref = None
    _write_log(
        deployment,
        f"\nRun {deployment.ci_run_url}\n"
        f"  commit     {claims['sha']}\n"
        f"  trigger    {'push by ' + str(claims.get('actor')) if trigger == 'push' else 'dashboard'}\n"
        "\nBuilding... the live output is on GitHub; this log fills in when the "
        "run finishes.\n",
    )
    await db.commit()
    await record(
        db, deployment.id, "build",
        (
            f"Push of {claims['sha'][:7]} by {claims.get('actor')} is being built "
            "in GitHub Actions."
            if trigger == "push"
            else "GitHub Actions picked up the build."
        ),
        actor="github",
    )

    return {
        "build": True,
        "deployment_id": str(deployment.id),
        "plan": workflow.build_plan(repository, claims["sha"]),
        "env": await builder._environment_for(db, repository.id),
        "buildpacks": {
            "builder": settings.pack_builder,
            "run_image": settings.pack_run_image,
            "default_node_version": settings.default_node_version,
        },
    }


# ---------------------------------------------------------------------------
# 3. Finish
# ---------------------------------------------------------------------------

async def finish(
    db: AsyncSession,
    claims: dict[str, Any],
    *,
    deployment_id: uuid.UUID,
    status: str,
    method: str | None,
    image: str | None,
    services: dict[str, str] | None,
    log: str,
    error: str | None,
) -> dict[str, str] | None:
    """
    Record a run's outcome.

    Returns the images to run when the build succeeded and there is something
    left to do (`after_build`), else None.
    """
    deployment = await db.get(Deployment, deployment_id)
    if deployment is None:
        raise NotFoundError("Deployment not found.")
    repository = await _owned_by_run(db, deployment.repository_id, claims)

    # Only the run that claimed this deployment may close it, and only once.
    if deployment.ci_run_id != int(claims["run_id"]):
        raise PermissionError_("This deployment belongs to a different run.")
    if deployment.status is not DeploymentStatus.BUILDING:
        return None

    log_file = _write_log(
        deployment,
        "\n" + "=" * 72 + "\nOutput from GitHub Actions\n" + "=" * 72 + "\n"
        + log[-MAX_LOG_CHARS:] + "\n",
    )

    if status != "success":
        if status == "cancelled":
            message = "The run was cancelled on GitHub."
        else:
            message = diagnose.explain(
                diagnose.read_tail(log_file),
                error or "The build failed. See the build log.",
            )
        await _fail(db, deployment, message)
        return None

    images: dict[str, str] = {}
    try:
        if repository.is_multi_service:
            expected = {stack.service_name(p) for p in repository.service_paths or []}
            images = dict(services or {})
            if set(images) != expected:
                raise ValueError(
                    f"expected images for {sorted(expected)}, got {sorted(images)}"
                )
            deployment.build_method = BuildMethod.COMPOSE
        elif method == BuildMethod.COMPOSE.value:
            images = dict(services or {})
            deployment.build_method = BuildMethod.COMPOSE
        elif method in (BuildMethod.DOCKER.value, BuildMethod.BUILDPACK.value):
            if not image:
                raise ValueError("no image was reported")
            images = {"": image}
            deployment.build_method = BuildMethod(method)
        else:
            raise ValueError(f"unknown build method {method!r}")
        for ref in images.values():
            if not workflow.image_belongs_to(repository, ref):
                raise ValueError(f"{ref} is not one of this app's images")
    except ValueError as exc:
        await _fail(db, deployment, f"The build reported an unusable result: {exc}.")
        return None

    if "" in images:
        deployment.image_ref = images[""]
    await db.commit()

    built = images.get("") or ", ".join(f"{k}={v}" for k, v in images.items())
    await record(
        db, deployment.id, "build",
        f"Built in GitHub Actions: {built or 'no images to build'}.",
        level=EventLevel.SUCCESS,
        actor="github",
    )
    return images


# ---------------------------------------------------------------------------
# 4. After the build
# ---------------------------------------------------------------------------

async def after_build(
    deployment_id: uuid.UUID,
    images: dict[str, str],
    db: AsyncSession | None = None,
) -> None:
    """Ready the images to run, then start them. Never raises."""
    if db is not None:
        await _after_build(db, deployment_id, images)
        return
    async with AsyncSessionLocal() as own_session:
        await _after_build(own_session, deployment_id, images)


async def _after_build(
    db: AsyncSession, deployment_id: uuid.UUID, images: dict[str, str]
) -> None:
    deployment = await db.get(Deployment, deployment_id)
    if deployment is None or deployment.status is not DeploymentStatus.BUILDING:
        return
    repository = await db.get(Repository, deployment.repository_id)
    user = await db.get(User, deployment.user_id)
    if repository is None or user is None:
        return

    try:
        if repository.is_multi_service:
            await builder.write_stack(
                db, deployment,
                images=images,
                env=await builder._environment_for(db, repository.id),
                log_file=Path(deployment.logs_ref or builder.log_path_for(deployment.id)),
            )
        elif deployment.build_method is BuildMethod.COMPOSE:
            error = await _prepare_compose_stack(db, deployment, repository, images)
            if error:
                await _fail(db, deployment, error)
                return
    except Exception as exc:  # noqa: BLE001 — never leave a build stuck
        logger.exception("Preparing %s failed", deployment_id)
        await _fail(db, deployment, f"{type(exc).__name__}: {exc}")
        return

    deployment.status = DeploymentStatus.BUILT
    deployment.build_finished_at = datetime.now(timezone.utc)
    await db.commit()

    # Deploying is the point of the build: a push should end with the new
    # version live, not with a button to press. A newer build that has already
    # overtaken this one wins, though — it is what the student pushed last.
    newer = (
        await db.execute(
            select(Deployment.id).where(
                Deployment.repository_id == repository.id,
                Deployment.created_at > deployment.created_at,
                Deployment.status.in_([*_IN_FLIGHT, DeploymentStatus.BUILT]),
            )
        )
    ).first()
    if newer is not None:
        await record(
            db, deployment.id, "start",
            "Not started: a newer build of this app is on its way.",
        )
        return

    try:
        await runtime.start(db, deployment, repository, user, actor="github")
    except AppError as exc:
        # A failed start has already been recorded and explained by the
        # runtime. A refusal before starting (quota, a block) leaves the build
        # usable, and the student can start it once the reason is gone.
        if deployment.status is DeploymentStatus.BUILT:
            await record(
                db, deployment.id, "start",
                f"Built, but not started: {exc.message}",
                level=EventLevel.WARNING,
            )


async def _prepare_compose_stack(
    db: AsyncSession,
    deployment: Deployment,
    repository: Repository,
    images: dict[str, str],
) -> str | None:
    """
    Give a compose app the working copy it runs from.

    A compose file refers to files beside it — configuration it mounts, env
    files — so the stack still runs from the repository at the built commit.
    Only the images are new: the override written here points each service
    the run built at its image, so nothing is built on this server.
    """
    token = await get_access_token(db, repository.user_id)
    ref = deployment.commit_sha or repository.default_branch
    async with downloaded_repository(token, repository.full_name, ref) as download:
        try:
            source = resolve_path(download.path, repository.deploy_path or ROOT_PATH)
        except ValueError as exc:
            return str(exc)
        compose_file = compose.find_compose_file(source) if source.is_dir() else None
        if compose_file is None:
            return (
                "GitHub Actions built this app as a compose stack, but no compose "
                f"file was found in {repository.target_label} at {ref[:7]}."
            )
        log_file = Path(deployment.logs_ref or builder.log_path_for(deployment.id))
        ok, error = await builder._prepare_compose(
            db, deployment, compose_file=compose_file, source=source, log_file=log_file
        )
        if not ok:
            return error or "The compose stack could not be prepared."

    stack_dir = compose.stack_dir_for(deployment.id)
    if images:
        compose.write_images_override(stack_dir, images)
    return None
