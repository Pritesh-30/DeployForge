"""
API shapes for apps.

An *app* is a repository target a student has connected — one repository, or
one directory inside it, or several directories that run together. A
*deployment* is one attempt to build and run that app.

The distinction matters to the person using it: they have four apps, not
eleven deployments. Redeploying does not give them a new app, and a failed
build does not take an app away. So the list they see is a list of apps, and
each app carries the one deployment that is current plus a count of the rest.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.repository import DetectedType
from app.schemas.deployment import DeploymentOut


class DayCount(BaseModel):
    date: str
    succeeded: int = 0
    failed: int = 0


class AppStats(BaseModel):
    """What an app's build history adds up to."""

    builds: int = 0
    succeeded: int = 0
    failed: int = 0
    success_rate: float | None = None
    build_seconds_median: float | None = None
    build_seconds_last: float | None = None
    # Durations of recent successful builds, oldest first — for a sparkline.
    build_seconds_trend: list[float] = []
    last_failure_at: datetime | None = None
    # Builds per day for the last two weeks, oldest first.
    daily: list[DayCount] = []


class AppOut(BaseModel):
    """One app, with whichever of its deployments is current."""

    id: uuid.UUID
    name: str
    full_name: str
    target_label: str
    default_branch: str
    deploy_path: str | None = None
    service_paths: list[str] | None = None
    is_multi_service: bool = False
    detected_type: DetectedType | None = None
    detected_framework: str | None = None
    auto_deploy: bool = True
    created_at: datetime
    updated_at: datetime

    # The deployment the app's URL points at: the running one, or the most
    # recent attempt when nothing is up. None only for an app connected but
    # never built.
    current: DeploymentOut | None = None
    deployment_count: int = 0
    # When this app last had a successful build, for "deployed 2 days ago".
    last_deployed_at: datetime | None = None

    # Populated on administrator views only.
    owner_id: uuid.UUID | None = None
    owner_email: str | None = None


class AppDetailOut(AppOut):
    """An app together with its full deployment history, newest first."""

    deployments: list[DeploymentOut] = []
    stats: AppStats = AppStats()


class AppUpdate(BaseModel):
    """What the owner may change about an app after connecting it."""

    branch: str | None = Field(default=None, min_length=1, max_length=255)
    auto_deploy: bool | None = None


class ActivityOut(BaseModel):
    """One thing that happened to one of an app's deployments."""

    id: uuid.UUID
    deployment_id: uuid.UUID
    app_id: uuid.UUID
    app_label: str
    stage: str
    level: str
    message: str
    actor: str | None = None
    created_at: datetime
