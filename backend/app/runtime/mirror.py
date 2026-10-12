"""
Keeping images built in GitHub Actions in the platform's own registry.

A build in Actions pushes its image to the student's GitHub registry, because
that is the one registry a workflow can push to with no secret stored in the
repository. Leaving it there has three costs:

  * every version of the app lives on GitHub's terms — a deleted package, a
    revoked token or an expired login and an old version can no longer be
    rolled back to;
  * private packages count against a free GitHub account's package storage,
    so each push quietly spends the student's quota;
  * the server pulls from the internet every time it starts a version.

So once a build succeeds, the server pulls the image (it had to anyway, to
run it), tags it into its own registry under the same name and commit, and
runs it from there. The copy on GitHub is then deleted when the student's
connection allows it (`delete:packages`); otherwise it is left, and the
build log says so.

Mirroring failing never fails a deployment: the image on GitHub still works,
and the app runs from there instead.
"""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.github.client import _send
from app.github.token import get_connection
from app.github.crypto import decrypt_token
from app.runtime import docker, registry

logger = logging.getLogger(__name__)


def mirror_target(ref: str) -> str | None:
    """
    Where a GitHub-registry image goes in the platform's registry.

    ghcr.io/alice/todo/app:1a2b3c4d5e6f
      -> localhost:5000/deployforge/alice/todo/app:1a2b3c4d5e6f

    Same path, same tag: the commit is the version, and an image is found by
    the same name in both places. None when there is nowhere to mirror to, or
    the ref is not from the GitHub registry.
    """
    prefix = settings.registry_prefix
    source = settings.ci_registry.strip().rstrip("/") + "/"
    if not prefix or not ref.startswith(source):
        return None
    return f"{prefix}{settings.image_namespace}/{ref[len(source):]}"


async def mirror_images(
    db: AsyncSession, user_id, images: dict[str, str], log_file: Path | None
) -> dict[str, str]:
    """
    Copy each image into the platform's registry. Returns the refs to run —
    the mirrored ones where that worked, the originals where it did not.
    """
    if not settings.mirror_ci_images:
        return images

    result = dict(images)
    async with registry.credentials_for(db, user_id) as config:
        for service, ref in images.items():
            target = mirror_target(ref)
            if target is None:
                continue
            pulled = await docker._run("pull", "--quiet", ref, timeout=900, docker_config=config)
            if not pulled.ok:
                _log(log_file, f"Could not pull {ref} to keep a copy: {pulled.message}")
                continue
            tagged = await docker._run("tag", ref, target)
            pushed = await docker._run("push", "--quiet", target, timeout=900) if tagged.ok else tagged
            if not pushed.ok:
                _log(log_file, f"Could not store {target}: {pushed.message}. Running from GitHub instead.")
                continue
            result[service] = target
            _log(log_file, f"Stored {target}")
    return result


async def delete_from_github(db: AsyncSession, user_id, refs: list[str], log_file: Path | None) -> int:
    """
    Delete the GitHub copies of images now kept here. Only images this app's
    own builds pushed are ever passed in, and only when the student's
    connection includes `delete:packages`. Returns how many were deleted.
    """
    if not settings.ci_cleanup_github_packages or not refs:
        return 0
    connection = await get_connection(db, user_id)
    if connection is None:
        return 0
    scopes = {s.strip() for s in (connection.scopes or "").replace(",", " ").split()}
    if "delete:packages" not in scopes:
        _log(log_file, "Kept the copy on GitHub: reconnect GitHub to let DeployForge "
                       "clear images it has already stored.")
        return 0
    try:
        token = decrypt_token(connection.access_token_enc)
    except Exception:  # noqa: BLE001
        return 0

    deleted = 0
    for ref in refs:
        try:
            if await _delete_version(token, connection.github_username, ref):
                deleted += 1
        except Exception:  # noqa: BLE001 — cleanup is best effort
            logger.debug("GitHub package cleanup failed for %s", ref, exc_info=True)
    if deleted:
        _log(log_file, f"Cleared {deleted} image(s) from the GitHub registry; "
                       "this server keeps the versions now.")
    return deleted


def package_of(ref: str) -> tuple[str, str, str] | None:
    """ghcr.io/alice/todo/app:abc -> ("alice", "todo/app", "abc")."""
    source = settings.ci_registry.strip().rstrip("/") + "/"
    if not ref.startswith(source) or ":" not in ref:
        return None
    path, _, tag = ref[len(source):].rpartition(":")
    owner, _, package = path.partition("/")
    if not owner or not package or not tag:
        return None
    return owner, package, tag


async def _delete_version(token: str, username: str | None, ref: str) -> bool:
    parsed = package_of(ref)
    if parsed is None:
        return False
    owner, package, tag = parsed
    # A student's own packages live under /user; an organisation's elsewhere.
    base = (
        "/user/packages/container"
        if username and owner.lower() == username.lower()
        else f"/orgs/{owner}/packages/container"
    )
    name = quote(package, safe="")
    listed = await _send(token, "GET", f"{base}/{name}/versions?per_page=100")
    if listed.status_code != 200:
        return False
    for version in listed.json():
        tags = ((version.get("metadata") or {}).get("container") or {}).get("tags") or []
        if tag in tags:
            removed = await _send(token, "DELETE", f"{base}/{name}/versions/{version['id']}")
            return removed.status_code in (204, 404)
    return False


def _log(log_file: Path | None, line: str) -> None:
    if log_file is None:
        return
    try:
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
