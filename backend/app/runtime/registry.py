"""
Credentials for pulling an app's images from the student's GitHub registry.

An image built in GitHub Actions is pushed to `ghcr.io/<student>/...` and is
private whenever the repository is. The server pulls it with the student's own
GitHub token, which is granted `read:packages` when they connect GitHub — so
it can read their images, and nobody else's.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.github.crypto import decrypt_token
from app.github.token import get_connection


def _plugin_dirs() -> list[str]:
    """
    Where this machine's Docker CLI plugins live, as the user's own config sees it.

    A throwaway DOCKER_CONFIG hides plugins installed under the user's config
    directory — and on Docker Desktop that is where `docker compose` lives
    (`~/.docker/cli-plugins`). Without them `docker compose ... --file` is read
    as `docker --file` and fails with "unknown flag: --file". Linux packages
    put compose in a system directory Docker always searches, which is why a
    server never noticed.
    """
    home = Path(os.environ.get("DOCKER_CONFIG") or Path.home() / ".docker")
    dirs: list[str] = []
    try:
        config = json.loads((home / "config.json").read_text(encoding="utf-8"))
        dirs.extend(str(d) for d in config.get("cliPluginsExtraDirs") or [])
    except (OSError, ValueError):
        pass
    if (home / "cli-plugins").is_dir():
        dirs.append(str(home / "cli-plugins"))
    return list(dict.fromkeys(dirs))


def client_config(auths: dict) -> dict:
    """A Docker client config with these logins that still finds every plugin."""
    config: dict = {"auths": auths}
    plugins = _plugin_dirs()
    if plugins:
        config["cliPluginsExtraDirs"] = plugins
    return config


def needs_credentials(image_ref: str | None) -> bool:
    """Whether the image lives in the registry Actions builds push to."""
    registry = settings.ci_registry.strip().rstrip("/")
    return bool(image_ref and registry and image_ref.startswith(registry + "/"))


@asynccontextmanager
async def credentials_for(
    db: AsyncSession, user_id: uuid.UUID
) -> AsyncIterator[Path | None]:
    """
    A throwaway Docker client config holding this user's registry login.

    Yields None when the user has no GitHub connection; the pull is then
    attempted anonymously, which works for public images and fails with
    Docker's own message for private ones.
    """
    connection = await get_connection(db, user_id)
    if connection is None:
        yield None
        return
    try:
        token = decrypt_token(connection.access_token_enc)
    except Exception:  # noqa: BLE001 — an unreadable token is an anonymous pull
        yield None
        return

    directory = Path(tempfile.mkdtemp(prefix="deployforge-docker-"))
    try:
        auth = base64.b64encode(
            f"{connection.github_username}:{token}".encode()
        ).decode()
        registry = settings.ci_registry.strip().rstrip("/")
        (directory / "config.json").write_text(
            json.dumps(client_config({registry: {"auth": auth}})), encoding="utf-8"
        )
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)
