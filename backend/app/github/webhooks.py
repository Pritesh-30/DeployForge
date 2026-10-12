"""
GitHub webhooks: a push deploys the app, the moment it happens.

Each app gets one webhook on its repository, pointing at

    {PUBLIC_API_URL}/webhooks/github?app=<app id>

and signed with GITHUB_WEBHOOK_SECRET. The app id in the address routes the
delivery: one repository connected as several apps (a monorepo) has one hook
per app, each building only when its own directory changed.

Hooks are found by that `?app=<id>` suffix rather than by a stored hook id,
so when the public address changes — a new tunnel on a laptop — the next sync
simply re-points the same hook instead of leaving a dead one behind.

Creating a hook needs the `repo` (or `admin:repo_hook`) scope, which every
connection already grants for deploying.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import uuid

from app.config import settings
from app.github import client as github_client

logger = logging.getLogger(__name__)

PATH = "/webhooks/github"


def enabled() -> bool:
    """Whether GitHub can deliver to this server at all."""
    url = settings.public_api_url.strip().lower()
    return bool(settings.github_webhook_secret.strip()) and url.startswith("https://")


def hook_url(app_id: uuid.UUID) -> str:
    return f"{settings.public_api_url.rstrip('/')}{PATH}?app={app_id}"


def _ours(hook: dict, app_id: uuid.UUID) -> bool:
    return str(hook.get("config", {}).get("url", "")).endswith(f"{PATH}?app={app_id}")


def verify(body: bytes, signature: str | None) -> bool:
    """GitHub's X-Hub-Signature-256: HMAC-SHA256 of the raw body."""
    secret = settings.github_webhook_secret.strip()
    if not secret or not signature or not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.removeprefix("sha256="))


async def ensure(access_token: str, full_name: str, app_id: uuid.UUID) -> str:
    """
    Make the app's webhook exist and point here. Returns what was done:
    "created", "updated" or "ok".
    """
    config = {
        "url": hook_url(app_id),
        "content_type": "json",
        "secret": settings.github_webhook_secret.strip(),
        "insecure_ssl": "0",
    }
    hooks = await github_client._get(access_token, f"/repos/{full_name}/hooks", per_page=100)
    mine = next((h for h in hooks or [] if _ours(h, app_id)), None)

    if mine is None:
        response = await github_client._send(
            access_token, "POST", f"/repos/{full_name}/hooks",
            json={"name": "web", "active": True, "events": ["push"], "config": config},
        )
        if response.status_code >= 400:
            raise github_client._write_error(response, "add a webhook to")
        return "created"

    # Patched even when the address is unchanged: GitHub never reveals the
    # secret, so this is how a rotated secret takes effect.
    response = await github_client._send(
        access_token, "PATCH", f"/repos/{full_name}/hooks/{mine['id']}",
        json={"active": True, "events": ["push"], "config": config},
    )
    if response.status_code >= 400:
        raise github_client._write_error(response, "update the webhook on")
    return "updated" if mine.get("config", {}).get("url") != config["url"] else "ok"


async def remove(access_token: str, full_name: str, app_id: uuid.UUID) -> bool:
    """Delete the app's webhook, if it has one. Never raises."""
    try:
        hooks = await github_client._get(access_token, f"/repos/{full_name}/hooks", per_page=100)
        for hook in hooks or []:
            if _ours(hook, app_id):
                await github_client._send(access_token, "DELETE", f"/repos/{full_name}/hooks/{hook['id']}")
                return True
    except Exception:  # noqa: BLE001
        logger.warning("Could not remove the webhook for %s", app_id, exc_info=True)
    return False


def changed_paths(payload: dict) -> list[str] | None:
    """
    Files the push touched, or None when GitHub did not list them all (it
    lists at most 20 commits) — in which case the push counts as touching
    everything.
    """
    commits = payload.get("commits") or []
    if len(commits) >= 20:
        return None
    files: list[str] = []
    for commit in commits:
        for key in ("added", "modified", "removed"):
            files.extend(commit.get(key) or [])
    return files
