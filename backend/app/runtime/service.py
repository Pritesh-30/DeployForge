"""
The app lifecycle: start, stop, restart, destroy.

Building produces an image; this is what turns an image into something a
student can open in a browser. It owns the container, the subdomain, and the
runtime columns on `Deployment` — the router reads those rows to build its
configuration (see `api/internal_routes.py`), so writing them here *is* the
act of publishing the app.

Every operation is idempotent and records a `DeploymentEvent`. A container
that is already gone is a successful stop; a container that already exists is
replaced rather than fought with.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.builder import diagnose
from app.config import settings
from app.core.crypto import decrypt_value
from app.core.errors import AppError
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.environment import EnvironmentVariable
from app.models.event import DeploymentEvent, EventLevel
from app.models.repository import Repository
from app.models.user import User
from app.runtime import compose, docker, naming, ports, registry

logger = logging.getLogger(__name__)


class RuntimeError_(AppError):
    """The app could not be started or stopped."""

    code = "runtime_error"
    status_code = 409


class QuotaExceededError(AppError):
    code = "quota_exceeded"
    status_code = 409


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------

async def record(
    db: AsyncSession,
    deployment_id: uuid.UUID,
    stage: str,
    message: str,
    *,
    level: EventLevel = EventLevel.INFO,
    actor: str | None = None,
    commit: bool = True,
) -> None:
    """
    Append one line to a deployment's timeline.

    Never raises: a deployment must not fail because its audit trail could not
    be written.
    """
    try:
        db.add(
            DeploymentEvent(
                deployment_id=deployment_id,
                stage=stage,
                message=message[:2000],
                level=level,
                actor=actor,
            )
        )
        if commit:
            await db.commit()
    except Exception:  # noqa: BLE001 — the timeline is not worth a failure
        logger.warning("Could not record %s event for %s", stage, deployment_id)


# --------------------------------------------------------------------------
# Quota
# --------------------------------------------------------------------------

async def running_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    """How many of this user's apps are currently running."""
    return (
        await db.execute(
            select(func.count())
            .select_from(Deployment)
            .where(
                Deployment.user_id == user_id,
                Deployment.status.in_(
                    [DeploymentStatus.RUNNING, DeploymentStatus.LIVE]
                ),
            )
        )
    ).scalar_one()


async def check_quota(
    db: AsyncSession,
    user: User,
    *,
    excluding: uuid.UUID | None = None,
    excluding_repository: uuid.UUID | None = None,
) -> None:
    """
    Refuse to start another app when the user is at their limit.

    The limit is on *apps*, not on builds. `excluding_repository` leaves out
    every deployment of the app being started: a redeploy briefly runs the new
    container alongside the one it replaces, and counting both would refuse a
    student their own slot. The app it is about to occupy is accounted for by
    comparing against the limit with `>=`.

    `excluding` skips a single deployment — the one being restarted, which
    already holds a slot and must not be counted against itself.
    """
    stmt = select(func.count()).select_from(Deployment).where(
        Deployment.user_id == user.id,
        Deployment.status.in_([DeploymentStatus.RUNNING, DeploymentStatus.LIVE]),
    )
    if excluding is not None:
        stmt = stmt.where(Deployment.id != excluding)
    if excluding_repository is not None:
        stmt = stmt.where(Deployment.repository_id != excluding_repository)
    running = (await db.execute(stmt)).scalar_one()

    if running >= user.max_deployments:
        raise QuotaExceededError(
            f"You already have {running} of {user.max_deployments} apps running. "
            "Stop one before starting another, or ask an administrator to raise "
            "your limit."
        )


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------

async def environment_for(db: AsyncSession, repository_id: uuid.UUID) -> dict[str, str]:
    """Decrypt this target's environment variables. A broken value is skipped."""
    rows = (
        await db.execute(
            select(EnvironmentVariable).where(
                EnvironmentVariable.repository_id == repository_id
            )
        )
    ).scalars().all()

    env: dict[str, str] = {}
    for row in rows:
        try:
            env[row.key] = decrypt_value(row.value_enc)
        except Exception:  # noqa: BLE001 — one bad value must not block a start
            logger.warning("Skipping unreadable environment variable %s", row.key)
    return env


# --------------------------------------------------------------------------
# Start
# --------------------------------------------------------------------------

async def start(
    db: AsyncSession,
    deployment: Deployment,
    repository: Repository,
    user: User,
    *,
    actor: str = "owner",
) -> Deployment:
    """
    Run the built image and publish it at its URL.

    Replaces any existing container for this deployment rather than refusing:
    "start" means "be running now", and a leftover container from a previous
    attempt is an implementation detail the student should not have to know
    about.
    """
    is_compose = deployment.build_method is BuildMethod.COMPOSE

    if not is_compose and deployment.image_ref is None:
        raise RuntimeError_(
            "This deployment has no image yet. Build it before starting it."
        )
    if is_compose and not deployment.compose_project:
        raise RuntimeError_(
            "This stack has not been prepared yet. Build it before starting it."
        )
    if actor != "admin":
        suspension = await app_suspension(db, repository.id)
        if suspension is not None:
            raise RuntimeError_(suspension)
    if not user.can_deploy and actor != "admin":
        raise RuntimeError_(
            user.deploy_block_reason
            or "An administrator has revoked your permission to deploy."
        )

    # An administrator starting a student's app has decided to, knowing the
    # quota they set; the quota is a bound on the student, not on them.
    if actor != "admin":
        await check_quota(
            db, user, excluding=deployment.id, excluding_repository=repository.id
        )

    if not await docker.daemon_available():
        raise RuntimeError_("The Docker daemon is not reachable on the server.")
    await docker.ensure_network()

    # The URL belongs to the app, not to one build of it. Every deployment of
    # this repository resolves to the same host, so redeploying replaces what
    # is behind the link rather than issuing a new one.
    deployment.subdomain = naming.subdomain_for(
        repository_id=repository.id,
        repository_name=repository.name,
        deploy_path=repository.deploy_path,
    )
    env = await environment_for(db, repository.id)

    deployment.status = DeploymentStatus.STARTING
    deployment.error_message = None
    await db.commit()

    if is_compose:
        container = await _start_compose(db, deployment, env, actor=actor)
    else:
        container = await _start_container(db, deployment, repository, env, actor=actor)

    # A container that exits immediately — a crash on boot, a bad start command
    # — is the most common failure, and "running" would be a lie. Give it a
    # moment, then check it is still alive.
    await asyncio.sleep(settings.app_start_grace_seconds)
    state = await docker.container_state(container)

    if not state or not state.get("Running"):
        # More than the 40 lines shown in the event: the reason a container
        # dies is often a stack trace, and the useful line is above its tail.
        logs = await docker.container_logs(container, tail=200)
        exit_code = (state or {}).get("ExitCode")
        message = diagnose.explain_exit(logs, exit_code)

        await _fail(db, deployment, message)
        await record(
            db,
            deployment.id,
            "start",
            f"Container exited on boot. Last output:\n{logs[-1500:]}",
            level=EventLevel.ERROR,
        )
        raise RuntimeError_(message)

    # The container is alive, so the deployment it replaces can go. This has to
    # happen before the promotion below, not after: two rows may not hold the
    # same hostname at once, and the database enforces that. Doing it any
    # earlier would take a working app down in order to put up one that turns
    # out not to boot.
    await _supersede(db, deployment, repository, actor=actor)

    deployment.status = DeploymentStatus.RUNNING
    deployment.runtime_started_at = datetime.now(timezone.utc)
    deployment.runtime_stopped_at = None
    deployment.error_message = None
    await db.commit()

    await record(
        db,
        deployment.id,
        "start",
        f"Running at {deployment.url}",
        level=EventLevel.SUCCESS,
        actor=actor,
    )
    return deployment


async def _supersede(
    db: AsyncSession,
    deployment: Deployment,
    repository: Repository,
    *,
    actor: str,
) -> None:
    """
    Retire the app's earlier deployments now that a newer one is up.

    An app is one thing with one URL. Its deployments are the attempts to run
    that thing, and exactly one of them is current — so promoting a new one
    means stopping whatever it replaced. Without this, a redeploy leaves the
    previous container running and two of them claim the same hostname; the
    router would have to pick, and the student's app would answer differently
    depending on which.

    A container that will not stop is logged and left: the new deployment is
    healthy and reporting the app as broken over a stale sibling would be a
    worse answer than a leaked container an admin can see.
    """
    siblings = (
        await db.execute(
            select(Deployment).where(
                Deployment.repository_id == repository.id,
                Deployment.id != deployment.id,
                Deployment.status.in_(
                    [
                        DeploymentStatus.RUNNING,
                        DeploymentStatus.LIVE,
                        DeploymentStatus.STARTING,
                    ]
                ),
            )
        )
    ).scalars().all()

    for old in siblings:
        try:
            await _tear_down(old)
        except Exception as exc:  # noqa: BLE001 — see docstring
            logger.warning(
                "Could not stop superseded deployment %s: %s", old.id, exc
            )
        old.status = DeploymentStatus.STOPPED
        old.container_id = None
        old.runtime_stopped_at = datetime.now(timezone.utc)

    if siblings:
        await db.commit()
        for old in siblings:
            await record(
                db,
                old.id,
                "stop",
                "Replaced by a newer deployment of this app.",
                actor=actor,
                commit=False,
            )
        await db.commit()


async def _start_container(
    db: AsyncSession,
    deployment: Deployment,
    repository: Repository,
    env: dict[str, str],
    *,
    actor: str,
) -> str:
    """Start a single-image deployment. Returns the container name."""
    container = deployment.container_name or naming.container_name_for(deployment.id)
    deployment.container_name = container

    await _pull_if_needed(db, deployment, actor=actor)

    exposed = await docker.image_exposed_ports(deployment.image_ref)
    port = ports.choose_port(
        exposed_ports=exposed,
        env=env,
        framework=repository.detected_framework,
        build_method=deployment.build_method.value if deployment.build_method else None,
    )
    deployment.app_port = port
    await db.commit()

    await record(
        db, deployment.id, "start",
        f"Starting {deployment.image_ref} on port {port}.", actor=actor,
    )

    # A container from a previous run would take the name; replace it.
    await docker.remove_container(container)

    # Buildpack launchers and most frameworks read PORT. Setting it makes the
    # app listen where the router expects, instead of hoping the two agree.
    result = await docker.run_container(
        name=container,
        image_ref=deployment.image_ref,
        port=port,
        env={"PORT": str(port), **env},
        labels={
            "deployforge.deployment": str(deployment.id),
            "deployforge.owner": str(deployment.user_id),
        },
    )
    if not result.ok:
        await _fail(db, deployment, f"Could not start the container: {result.message}")
        raise RuntimeError_(f"Could not start the container: {result.message}")

    deployment.container_id = result.stdout.strip()[:64] or None
    return container


async def _start_compose(
    db: AsyncSession,
    deployment: Deployment,
    env: dict[str, str],
    *,
    actor: str,
) -> str:
    """
    Bring a whole compose stack up. Returns the routed container's name.

    The stack runs on its own private network, which is what keeps one
    student's database unreachable from another's app. Only the web service is
    additionally attached to the shared edge network, so the router can reach
    it and nothing else in the stack is exposed.
    """
    project = deployment.compose_project
    stack_dir = compose.stack_dir_for(deployment.id)
    compose_file = compose.find_compose_file(stack_dir)

    if compose_file is None:
        await _fail(
            db, deployment,
            "The stack's working copy is missing. Rebuild this deployment.",
        )
        raise RuntimeError_(
            "The stack's working copy is missing. Rebuild this deployment."
        )

    await record(
        db, deployment.id, "start",
        f"Starting {len(deployment.compose_services or [])} service(s): "
        f"{', '.join(deployment.compose_services or [])}.",
        actor=actor,
    )

    # Environment variables reach compose through a .env file beside the
    # compose file, which is where Compose itself looks for them.
    _write_compose_env(stack_dir, env)

    log_file = _build_log_path(deployment)
    # A stack built in GitHub Actions pulls its images from the student's
    # registry, with their credentials; one built here needs none.
    if deployment.built_on_actions:
        async with registry.credentials_for(db, deployment.user_id) as docker_config:
            result = await compose.up(
                compose_file=compose_file, project=project, log_path=log_file,
                docker_config=docker_config,
            )
    else:
        result = await compose.up(
            compose_file=compose_file, project=project, log_path=log_file
        )
    if not result.ok:
        await _fail(
            db, deployment,
            f"The stack failed to start: {result.message}. See the build log.",
        )
        raise RuntimeError_(
            f"The stack failed to start: {result.message}. See the build log."
        )

    # What Compose actually named the container, rather than what it was
    # expected to. A predicted name that turns out to be wrong is not a
    # cosmetic problem: the container is never attached to the edge network,
    # the router is pointed at a host that does not exist, and the health
    # check below reports a perfectly healthy app as having died on boot.
    actual = await compose.container_names(project)
    container = actual.get(deployment.compose_web_service or "") or (
        deployment.container_name
    )
    if container != deployment.container_name:
        logger.info(
            "Compose named %s's container %s, not %s",
            deployment.compose_web_service, container, deployment.container_name,
        )
        deployment.container_name = container
        await db.commit()

    # Idempotent: already being on the network is not an error.
    await compose.attach_to_edge(container)
    return container


async def _pull_if_needed(
    db: AsyncSession, deployment: Deployment, *, actor: str
) -> None:
    """
    Fetch an image built in GitHub Actions, unless it is already here.

    Tags are commit SHAs, so an image that is present is the right one and is
    never pulled twice.
    """
    image_ref = deployment.image_ref
    if not registry.needs_credentials(image_ref):
        return
    if await docker.image_present(image_ref):
        return

    await record(db, deployment.id, "start", f"Pulling {image_ref}.", actor=actor)
    async with registry.credentials_for(db, deployment.user_id) as docker_config:
        result = await docker.pull_image(image_ref, docker_config=docker_config)
    if not result.ok:
        message = (
            f"Could not pull {image_ref}: {result.message}. If this keeps "
            "happening, reconnect GitHub so DeployForge can read your packages."
        )
        await _fail(db, deployment, message)
        raise RuntimeError_(message)


def _write_compose_env(stack_dir, env: dict[str, str]) -> None:
    """
    Write the stack's `.env` file. Never raises.

    Compose reads `.env` from the project directory for variable substitution
    *and* passes matching values through to services, which is the behaviour a
    student writing a compose file already expects.
    """
    if not env:
        return
    try:
        lines = [
            f"{key}={value}"
            for key, value in sorted(env.items())
            if "\n" not in value and "\r" not in value
        ]
        (stack_dir / ".env").write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        logger.warning("Could not write compose .env for %s", stack_dir)


def _build_log_path(deployment: Deployment):
    """The deployment's log file, so `compose up` output lands with the build."""
    from pathlib import Path

    if deployment.logs_ref:
        return Path(deployment.logs_ref)
    from app.builder.service import log_path_for

    return log_path_for(deployment.id)


async def _fail(db: AsyncSession, deployment: Deployment, message: str) -> None:
    deployment.status = DeploymentStatus.FAILED
    deployment.error_message = message
    deployment.runtime_stopped_at = datetime.now(timezone.utc)
    await db.commit()


# --------------------------------------------------------------------------
# Stop / restart / destroy
# --------------------------------------------------------------------------

async def stop(
    db: AsyncSession,
    deployment: Deployment,
    *,
    actor: str = "owner",
    suspend: bool = False,
    reason: str | None = None,
) -> Deployment:
    """
    Stop the app and take it off the router.

    A container that is already gone is success — the caller asked for it to
    not be running, and it is not running.
    """
    await _tear_down(deployment)

    deployment.status = DeploymentStatus.STOPPED
    deployment.container_id = None
    deployment.runtime_stopped_at = datetime.now(timezone.utc)
    if suspend:
        deployment.suspended_by_admin = True
        if reason:
            deployment.suspension_reason = reason
    await db.commit()

    await record(
        db,
        deployment.id,
        "stop",
        (reason or "Suspended by an administrator.") if suspend else "Stopped.",
        level=EventLevel.WARNING if suspend else EventLevel.INFO,
        actor=actor,
    )
    return deployment


async def _tear_down(deployment: Deployment) -> None:
    """
    Stop whatever this deployment is running — one container, or a whole stack.

    Absence is success in both cases: the caller asked for it not to be
    running, and it is not running.
    """
    if deployment.build_method is BuildMethod.COMPOSE and deployment.compose_project:
        await compose.down(deployment.compose_project)
        return

    if deployment.container_name:
        await docker.stop_container(deployment.container_name)
        await docker.remove_container(deployment.container_name)


async def restart(
    db: AsyncSession,
    deployment: Deployment,
    repository: Repository,
    user: User,
    *,
    actor: str = "owner",
) -> Deployment:
    """Stop and start again, on the same image and the same URL."""
    await _tear_down(deployment)
    return await start(db, deployment, repository, user, actor=actor)


async def app_suspension(db: AsyncSession, repository_id: uuid.UUID) -> str | None:
    """
    Why the app is suspended, or None if it is not.

    Suspension is recorded on the deployment an administrator stopped, but it
    applies to the *app*: otherwise the owner could redeploy, get a fresh
    deployment row without the flag, and start that instead — and suspending
    would stop nothing.
    """
    suspended = (
        await db.execute(
            select(Deployment)
            .where(
                Deployment.repository_id == repository_id,
                Deployment.suspended_by_admin.is_(True),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if suspended is None:
        return None
    return suspended.suspension_reason or (
        "An administrator has suspended this app. Contact them to have it resumed."
    )


async def promote(
    db: AsyncSession,
    deployment: Deployment,
    repository: Repository,
    user: User,
    *,
    actor: str = "owner",
) -> Deployment:
    """
    Make an earlier deployment the live one again — a rollback.

    The earlier build's image is still in the registry, so this is a start,
    not a rebuild: seconds, not minutes, and it runs exactly the code that ran
    before rather than whatever the branch says today. Starting it retires the
    deployment that replaced it, through the same path a redeploy uses.
    """
    if deployment.repository_id != repository.id:
        raise RuntimeError_("That deployment belongs to a different app.")
    if deployment.status in (DeploymentStatus.RUNNING, DeploymentStatus.LIVE):
        raise RuntimeError_("That deployment is already the live one.")
    if deployment.status not in (DeploymentStatus.BUILT, DeploymentStatus.STOPPED):
        raise RuntimeError_(
            "Only a deployment that built successfully can be rolled back to."
        )
    if deployment.build_method is BuildMethod.COMPOSE and deployment.compose_project:
        if compose.find_compose_file(compose.stack_dir_for(deployment.id)) is None:
            raise RuntimeError_(
                "This version's stack files are no longer kept on the server, "
                "so it cannot be started again. Redeploy instead."
            )

    await record(
        db, deployment.id, "start",
        "Rolling back to this deployment.", actor=actor,
    )
    return await start(db, deployment, repository, user, actor=actor)


async def destroy(
    db: AsyncSession, deployment: Deployment, *, actor: str = "owner"
) -> None:
    """
    Remove the container and forget the deployment.

    The image is left in the registry on purpose: it is the artifact of a
    build, other deployments may reference the same tag, and deleting it would
    make a redeploy re-run the whole build for no gain.

    A compose stack additionally has its volumes and working copy removed —
    those belong to this deployment alone and nothing else can reference them.
    """
    if deployment.build_method is BuildMethod.COMPOSE and deployment.compose_project:
        await compose.down(deployment.compose_project, remove_volumes=True)
        compose.remove_stack_dir(deployment.id)
    elif deployment.container_name:
        await docker.stop_container(deployment.container_name)
        await docker.remove_container(deployment.container_name)

    await db.delete(deployment)
    await db.commit()


# --------------------------------------------------------------------------
# Reconciliation
# --------------------------------------------------------------------------

async def release_interrupted_builds(db: AsyncSession) -> int:
    """
    Fail builds that were in flight when this process last stopped.

    A build runs as a background task owning a `docker build` or `pack` child
    process. Both die with the server — a restart, a crash, a reboot — and the
    row is left saying `building` with nothing building it. Because the UI
    refuses to start a second build while one is in flight, that state is a
    dead end: the deployment can never be built again.

    Nothing that was building when the process started can still be building,
    so this is safe to run unconditionally at startup. Returns how many rows it
    released.
    """
    in_flight = (
        await db.execute(
            select(Deployment).where(
                Deployment.status.in_(
                    [
                        DeploymentStatus.QUEUED,
                        DeploymentStatus.BUILDING,
                        DeploymentStatus.PUSHING,
                    ]
                )
            )
        )
    ).scalars().all()
    # A build running in GitHub Actions did not die with this process; it
    # will still report back. Only one that has gone silent for longer than
    # any build may take is given up on — see `ci_build_abandoned`.
    #
    # A build on the queue did not die with it either: the job is still in
    # Redis, and its lapsed lease puts it back in line for the next worker.
    # Only a build whose job is gone — Redis was wiped, or the row predates
    # the queue — is truly stuck.
    resumable = await _builds_still_queued([d for d in in_flight if not d.built_on_actions])
    stuck = [
        d for d in in_flight
        if (d.built_on_actions and ci_build_abandoned(d))
        or (not d.built_on_actions and d.id not in resumable)
    ]

    for deployment in stuck:
        if deployment.built_on_actions:
            release_abandoned_ci_build(deployment)
            continue
        deployment.status = DeploymentStatus.FAILED
        deployment.build_finished_at = datetime.now(timezone.utc)
        deployment.error_message = (
            "The build was interrupted when the server restarted, so it never "
            "finished. Nothing is wrong with your project — press Rebuild."
        )
        await record(
            db,
            deployment.id,
            "build",
            "Build interrupted by a server restart.",
            level=EventLevel.WARNING,
            commit=False,
        )

    if stuck:
        await db.commit()
        logger.info("Released %d interrupted build(s)", len(stuck))
    return len(stuck)


async def _builds_still_queued(deployments: list[Deployment]) -> set[uuid.UUID]:
    """
    Which of these deployments still have a live build job on the queue.

    If Redis cannot be asked, the answer is "none": the safe failure is the
    old behaviour — release them, and tell the student to press Redeploy —
    rather than leaving rows saying `building` with no way to know whether
    anything ever will.
    """
    if not deployments:
        return set()
    from app.queue.jobs import build_job_id
    from app.queue.store import queue

    live: set[uuid.UUID] = set()
    try:
        for deployment in deployments:
            job = await queue.get(build_job_id(deployment.id))
            if job and job.state in ("pending", "running", "delayed"):
                live.add(deployment.id)
    except Exception:  # noqa: BLE001
        logger.warning("Could not read the build queue at startup", exc_info=True)
        return set()
    return live


def ci_build_abandoned(deployment: Deployment) -> bool:
    """
    Whether a GitHub Actions build has been silent for too long to wait on.

    A run that was cancelled before it could report, or whose workflow never
    started (Actions disabled, the file deleted), leaves its deployment in
    flight with nothing behind it. The build timeout is the longest a real
    build can take, so past it the row is released and the app can be built
    again.
    """
    if deployment.status not in (
        DeploymentStatus.QUEUED, DeploymentStatus.BUILDING, DeploymentStatus.PUSHING
    ):
        return False
    since = deployment.build_started_at or deployment.updated_at
    if since is None:
        return False
    age = (datetime.now(timezone.utc) - since).total_seconds()
    return age > settings.build_timeout_seconds


def release_abandoned_ci_build(deployment: Deployment) -> None:
    """Fail a GitHub Actions build that never reported back. Caller commits."""
    deployment.status = DeploymentStatus.FAILED
    deployment.build_finished_at = datetime.now(timezone.utc)
    deployment.error_message = (
        "GitHub Actions never reported a result for this build. The run may "
        "have been cancelled, or Actions may be disabled for the repository"
        + (f" — see {deployment.ci_run_url}" if deployment.ci_run_url else "")
        + ". Press Deploy to try again."
    )


async def reconcile(db: AsyncSession) -> int:
    """
    Make the database agree with what Docker is actually running.

    The platform's rows outlive the process that wrote them: Docker Desktop
    restarts, the machine reboots, a student stops a container by hand. Without
    this, the dashboard confidently shows apps as running that are not, and the
    router advertises routes to containers that no longer exist.

    Called at startup. Returns how many rows it corrected.
    """
    corrected = await release_interrupted_builds(db)

    rows = (
        await db.execute(
            select(Deployment).where(
                Deployment.status.in_(
                    [
                        DeploymentStatus.RUNNING,
                        DeploymentStatus.LIVE,
                        DeploymentStatus.STARTING,
                    ]
                )
            )
        )
    ).scalars().all()

    if not rows:
        return corrected
    if not await docker.daemon_available():
        logger.warning("Docker unreachable; skipping container reconciliation")
        return corrected

    for deployment in rows:
        state = (
            await docker.container_state(deployment.container_name)
            if deployment.container_name
            else None
        )
        if state and state.get("Running"):
            # A build or start that was interrupted mid-flight is now healthy.
            if deployment.status is DeploymentStatus.STARTING:
                deployment.status = DeploymentStatus.RUNNING
                corrected += 1
            continue

        deployment.status = DeploymentStatus.STOPPED
        deployment.container_id = None
        deployment.runtime_stopped_at = datetime.now(timezone.utc)
        corrected += 1
        await record(
            db,
            deployment.id,
            "reconcile",
            "Marked stopped: no running container was found for it.",
            level=EventLevel.WARNING,
            commit=False,
        )

    if corrected:
        await db.commit()
        logger.info("Reconciled %d deployment(s) against Docker", corrected)
    return corrected
