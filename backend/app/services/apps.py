"""
Apps as people think of them: a repository target, its current deployment,
its history, and what that history adds up to.

Shared by the student's routes and the administrator's, which differ in who
may see an app and what they may do to it — not in what an app *is*.
"""

from __future__ import annotations

import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deployment_routes import deployment_out
from app.models.deployment import Deployment, DeploymentStatus
from app.models.repository import Repository
from app.models.user import User
from app.schemas.app import AppDetailOut, AppOut, AppStats, DayCount

# An app is "up" when one of its deployments is.
LIVE = (DeploymentStatus.RUNNING, DeploymentStatus.LIVE)

# A build that produced something runnable, whatever happened to it after.
SUCCEEDED = (
    DeploymentStatus.BUILT,
    DeploymentStatus.STARTING,
    DeploymentStatus.RUNNING,
    DeploymentStatus.LIVE,
    DeploymentStatus.STOPPED,
)

HISTORY_DAYS = 14


def current_deployment(deployments: list[Deployment]) -> Deployment | None:
    """
    Which deployment the app currently *is*, given its history newest first.

    A running deployment wins over a newer failed one: if a student redeploys
    and the build fails, their app is still up and saying otherwise would be
    false. Otherwise the newest attempt is the current state of affairs —
    including when it failed, because that is what they need to look at.
    """
    for deployment in deployments:
        if deployment.status in LIVE:
            return deployment
    return deployments[0] if deployments else None


def real_builds(deployments: list[Deployment]) -> list[Deployment]:
    """
    Deployments the student actually caused. Connecting a target writes an
    `analyzed` row, which is bookkeeping: counting it would tell someone who
    has never deployed that they have.
    """
    return [d for d in deployments if d.status is not DeploymentStatus.ANALYZED]


def build_seconds(deployment: Deployment) -> float | None:
    if deployment.build_started_at and deployment.build_finished_at:
        seconds = (deployment.build_finished_at - deployment.build_started_at).total_seconds()
        return seconds if seconds >= 0 else None
    return None


def app_stats(deployments: list[Deployment], *, today: date | None = None) -> AppStats:
    """What an app's history adds up to. Pure."""
    builds = real_builds(deployments)
    finished = [d for d in builds if d.status in SUCCEEDED or d.status is DeploymentStatus.FAILED]
    succeeded = [d for d in finished if d.status in SUCCEEDED]
    failed = [d for d in finished if d.status is DeploymentStatus.FAILED]
    durations = sorted(s for s in (build_seconds(d) for d in succeeded) if s is not None)

    today = today or datetime.now(timezone.utc).date()
    first_day = today - timedelta(days=HISTORY_DAYS - 1)
    ok_by_day: Counter[date] = Counter()
    bad_by_day: Counter[date] = Counter()
    for d in finished:
        day = d.created_at.astimezone(timezone.utc).date()
        if day >= first_day:
            (ok_by_day if d.status in SUCCEEDED else bad_by_day)[day] += 1

    return AppStats(
        builds=len(builds),
        succeeded=len(succeeded),
        failed=len(failed),
        success_rate=(len(succeeded) / len(finished)) if finished else None,
        build_seconds_median=durations[len(durations) // 2] if durations else None,
        build_seconds_last=build_seconds(succeeded[0]) if succeeded else None,
        build_seconds_trend=[
            s for s in (build_seconds(d) for d in reversed(succeeded[:20])) if s is not None
        ],
        last_failure_at=failed[0].created_at if failed else None,
        daily=[
            DayCount(
                date=(first_day + timedelta(days=i)).isoformat(),
                succeeded=ok_by_day[first_day + timedelta(days=i)],
                failed=bad_by_day[first_day + timedelta(days=i)],
            )
            for i in range(HISTORY_DAYS)
        ],
    )


def app_out(
    repository: Repository,
    deployments: list[Deployment],
    *,
    detail: bool = False,
    owner: User | None = None,
) -> AppOut:
    """The response for one app, from its deployments newest first."""
    current = current_deployment(deployments)
    succeeded = [d for d in deployments if d.status in SUCCEEDED]
    email = owner.email if owner else None

    fields = dict(
        id=repository.id,
        name=repository.name,
        full_name=repository.full_name,
        target_label=repository.target_label,
        default_branch=repository.default_branch,
        deploy_path=repository.deploy_path,
        service_paths=repository.service_paths,
        is_multi_service=repository.is_multi_service,
        detected_type=repository.detected_type,
        detected_framework=repository.detected_framework,
        auto_deploy=repository.auto_deploy,
        created_at=repository.created_at,
        updated_at=repository.updated_at,
        current=deployment_out(current, repository, user_email=email) if current else None,
        deployment_count=len(real_builds(deployments)),
        last_deployed_at=(
            succeeded[0].build_finished_at or succeeded[0].created_at if succeeded else None
        ),
        owner_id=owner.id if owner else None,
        owner_email=email,
    )
    if not detail:
        return AppOut(**fields)
    return AppDetailOut(
        **fields,
        deployments=[deployment_out(d, repository, user_email=email) for d in real_builds(deployments)],
        stats=app_stats(deployments),
    )


async def deployments_for(
    db: AsyncSession, repository_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Deployment]]:
    """Every deployment of the given apps, newest first within each app."""
    if not repository_ids:
        return {}
    rows = (
        await db.execute(
            select(Deployment)
            .where(Deployment.repository_id.in_(repository_ids))
            # id breaks ties so the order is stable when two rows share a
            # timestamp, which they do when a build is queued and started in
            # the same instant.
            .order_by(Deployment.created_at.desc(), Deployment.id.desc())
        )
    ).scalars().all()

    grouped: dict[uuid.UUID, list[Deployment]] = {rid: [] for rid in repository_ids}
    for deployment in rows:
        grouped[deployment.repository_id].append(deployment)
    return grouped
