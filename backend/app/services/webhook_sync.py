"""
Keep every app's GitHub webhook pointing at this server.

Run at startup and whenever an app is deployed or has push deploys switched
on. On a laptop whose tunnel address changed, restarting the API is enough:
the sync re-points every hook to the new address.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.github import webhooks
from app.github.token import get_access_token
from app.models.repository import Repository

logger = logging.getLogger(__name__)


async def ensure_for(db: AsyncSession, repository: Repository) -> str | None:
    """Create or re-point one app's hook. Returns what happened, never raises."""
    if not webhooks.enabled() or not repository.auto_deploy:
        return None
    try:
        token = await get_access_token(db, repository.user_id)
        return await webhooks.ensure(token, repository.full_name, repository.id)
    except Exception as exc:  # noqa: BLE001 — a deploy must not fail over its webhook
        logger.warning("Webhook for %s: %s", repository.full_name, getattr(exc, "message", exc))
        return f"failed: {getattr(exc, 'message', exc)}"


async def remove_for(db: AsyncSession, repository: Repository) -> None:
    try:
        token = await get_access_token(db, repository.user_id)
    except Exception:  # noqa: BLE001
        return
    await webhooks.remove(token, repository.full_name, repository.id)


async def sync_all() -> dict[str, int]:
    """Every app with push deploys on. Returns a count per outcome."""
    counts: dict[str, int] = {}
    if not webhooks.enabled():
        return counts
    async with AsyncSessionLocal() as db:
        repositories = (
            await db.execute(select(Repository).where(Repository.auto_deploy.is_(True)))
        ).scalars().all()
        for repository in repositories:
            outcome = await ensure_for(db, repository) or "skipped"
            key = outcome.split(":")[0]
            counts[key] = counts.get(key, 0) + 1
    logger.info("Webhooks synced: %s", counts)
    return counts
