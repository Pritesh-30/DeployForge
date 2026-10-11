"""
Instant redeploys: never build the same thing twice.

An image is a pure function of what went into it — the commit, the directory
built, how it was built, and (for buildpacks) the environment the build saw.
When a redeploy asks for exactly that again, the image already exists in the
registry, so building it a second time spends minutes of a shared machine to
produce a byte-identical result.

So every successful build records a fingerprint of its inputs, and a new build
first looks for an earlier deployment of the same app with the same
fingerprint whose image can still be found. If there is one, the build is
skipped: the new deployment points at that image and is ready in seconds.

What is deliberately *in* the fingerprint:

  * the commit and the directory — the source;
  * the build method — the same source built two ways is two images;
  * for buildpacks, the environment and the builder: buildpacks read env vars
    at build time (NODE_ENV, BP_* settings), and a different builder or run
    image produces a different image.

A Dockerfile build does not see the app's environment variables (they are
given to the container when it starts), so changing one does not force a
rebuild — it only needs a restart, which is what the student wanted.

`fresh=True` on a redeploy skips all of this, for the rare build that depends
on something outside the repository (a `latest` base image, a package
registry that changed under it).
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.runtime import docker

logger = logging.getLogger(__name__)

# A deployment whose image is known good: it built, and may have run since.
_REUSABLE = (
    DeploymentStatus.BUILT,
    DeploymentStatus.STARTING,
    DeploymentStatus.RUNNING,
    DeploymentStatus.LIVE,
    DeploymentStatus.STOPPED,
)
# Bump when the fingerprint's meaning changes, so old ones stop matching.
_VERSION = 1


def fingerprint(
    *,
    commit_sha: str | None,
    deploy_path: str | None,
    method: BuildMethod | None,
    env: dict[str, str],
) -> str | None:
    """The build's inputs, hashed. None when they cannot be pinned down."""
    if not commit_sha or method is None or method is BuildMethod.COMPOSE:
        # Without a commit the source is "whatever the branch was"; a compose
        # stack builds from a working copy at start time and has no one image.
        return None
    parts: dict[str, object] = {
        "v": _VERSION,
        "commit": commit_sha,
        "path": deploy_path or "",
        "method": method.value,
    }
    if method is BuildMethod.BUILDPACK:
        parts["env"] = hashlib.sha256(
            json.dumps(sorted(env.items())).encode()
        ).hexdigest()
        parts["builder"] = {
            name: str(getattr(settings, name))
            for name in sorted(type(settings).model_fields)
            if name.startswith("pack_") and name != "pack_binary"
        }
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()


async def find_reusable(
    db: AsyncSession,
    *,
    repository_id: uuid.UUID,
    exclude: uuid.UUID,
    commit_sha: str | None,
    deploy_path: str | None,
    env: dict[str, str],
) -> Deployment | None:
    """
    An earlier deployment of this app built from exactly these inputs, whose
    image is still on this machine or can be pulled from the registry.
    """
    if not commit_sha:
        return None
    candidates = (
        await db.execute(
            select(Deployment)
            .where(
                Deployment.repository_id == repository_id,
                Deployment.id != exclude,
                Deployment.commit_sha == commit_sha,
                Deployment.build_fingerprint.is_not(None),
                Deployment.image_ref.is_not(None),
                Deployment.status.in_(_REUSABLE),
            )
            .order_by(Deployment.build_finished_at.desc().nulls_last())
            .limit(5)
        )
    ).scalars().all()

    for prior in candidates:
        expected = fingerprint(
            commit_sha=commit_sha, deploy_path=deploy_path,
            method=prior.build_method, env=env,
        )
        if expected is None or expected != prior.build_fingerprint:
            continue
        if await _image_available(prior.image_ref):
            return prior
    return None


async def _image_available(image_ref: str | None) -> bool:
    if not image_ref:
        return False
    try:
        if await docker.image_present(image_ref):
            return True
        if settings.registry_push:
            return (await docker.pull_image(image_ref, timeout_seconds=300)).ok
    except Exception:  # noqa: BLE001 — not reusable is a safe answer
        logger.debug("Could not check for %s", image_ref, exc_info=True)
    return False
