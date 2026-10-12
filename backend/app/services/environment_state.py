"""
Whether an app is running with the environment variables it has now.

Environment variables are read in two places: when an app *starts* (every
variable is handed to the container) and, for some builds, when it is
*built* (buildpacks see them, and frameworks inline variables like
`NEXT_PUBLIC_*` into the bundle). Saving a variable therefore needs one of
three things to take effect:

  * nothing — the app is not running, and the next start uses the new set;
  * a restart — the container is recreated with the new values, in seconds;
  * a redeploy — the value is baked into the build, so only a new build
    carries it.

Each start records a digest of the environment it used — a short hash per
key, never the values — so the platform can say exactly which variables are
not yet in effect, and the student is never left guessing whether an edit
"took".
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.deployment import BuildMethod, Deployment, DeploymentStatus

# Variables frameworks inline into the build output: changing one after the
# build changes nothing the browser sees until the app is built again.
BUILD_TIME_PREFIXES = (
    "NEXT_PUBLIC_",
    "VITE_",
    "REACT_APP_",
    "NUXT_PUBLIC_",
    "PUBLIC_",
    "EXPO_PUBLIC_",
    "GATSBY_",
    "VUE_APP_",
    "BP_",
)
# Read by buildpacks themselves while building.
BUILD_TIME_KEYS = {"NODE_ENV", "NODE_VERSION", "PYTHON_VERSION", "BP_NODE_VERSION"}

LIVE = (DeploymentStatus.RUNNING, DeploymentStatus.LIVE, DeploymentStatus.STARTING)


def digest(env: dict[str, str]) -> dict[str, str]:
    """A short hash of each value: enough to see a change, useless to read."""
    return {
        key: hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
        for key, value in env.items()
    }


def changed_keys(applied: dict[str, str] | None, env: dict[str, str]) -> list[str]:
    """Keys added, removed or changed since `applied` was recorded."""
    current = digest(env)
    before = applied or {}
    return sorted(
        key for key in set(before) | set(current) if before.get(key) != current.get(key)
    )


def is_build_time(key: str) -> bool:
    return key in BUILD_TIME_KEYS or key.startswith(BUILD_TIME_PREFIXES)


@dataclass
class EnvState:
    # "not_running" | "in_effect" | "restart" | "rebuild"
    state: str
    changed: list[str] = field(default_factory=list)
    # The changed keys only a new build can carry.
    build_time: list[str] = field(default_factory=list)
    deployment: Deployment | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "changed": self.changed,
            "build_time": self.build_time,
            "deployment_id": str(self.deployment.id) if self.deployment else None,
        }


async def live_deployment(db: AsyncSession, repository_id) -> Deployment | None:
    return (
        await db.execute(
            select(Deployment)
            .where(Deployment.repository_id == repository_id, Deployment.status.in_(LIVE))
            .order_by(Deployment.runtime_started_at.desc().nulls_last())
            .limit(1)
        )
    ).scalar_one_or_none()


def state_for(live: Deployment | None, env: dict[str, str]) -> EnvState:
    if live is None:
        return EnvState("not_running")
    if live.runtime_env is None:
        # Started before the platform recorded what it started with: the
        # only safe answer is that the current set may not be in effect.
        changed = sorted(env)
    else:
        changed = changed_keys(live.runtime_env, env)
    if not changed:
        return EnvState("in_effect", deployment=live)

    # Only a build that saw the environment can have baked a value in.
    # A Dockerfile build never sees it; a buildpack build (here or in
    # GitHub Actions) does.
    build_saw_env = live.build_method is BuildMethod.BUILDPACK
    build_time = [key for key in changed if build_saw_env and is_build_time(key) and key in env]
    return EnvState(
        "rebuild" if build_time else "restart",
        changed=changed, build_time=build_time, deployment=live,
    )
