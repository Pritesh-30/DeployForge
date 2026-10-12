"""
Where GitHub delivers push events. See app/github/webhooks.py.

The delivery is authenticated by its HMAC signature, not by a login: GitHub
signs every delivery with the shared secret, and anything unsigned or signed
with another secret is refused before the body is even parsed.

A push deploys the app when all of these hold:

  * it is to the branch the app deploys from, and not a branch deletion;
  * push deploys are on for the app (Settings → Automatic deploys);
  * it touched the app's own directory — in a monorepo, a push to another
    app's folder does not rebuild this one;
  * it is not only DeployForge's own workflow file being committed;
  * on the GitHub Actions backend, the workflow in the repository is not
    already going to build it (it runs on the same push).

Every outcome is answered with a short reason, which GitHub shows under the
webhook's "Recent deliveries" — the first place to look when a push did not
deploy.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.builder.trigger import trigger_build
from app.ci import workflow
from app.config import settings
from app.core.errors import AppError
from app.db import get_db
from app.github import webhooks
from app.models.deployment import Deployment
from app.models.event import EventLevel
from app.models.repository import Repository
from app.models.user import User
from app.runtime.service import record

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


def _answer(code: int, message: str, **extra) -> JSONResponse:
    return JSONResponse({"message": message, **extra}, status_code=code)


@router.post(webhooks.PATH)
async def github_webhook(
    request: Request,
    db: DbSession,
    app: Annotated[uuid.UUID, Query()],
    x_github_event: Annotated[str | None, Header()] = None,
    x_hub_signature_256: Annotated[str | None, Header()] = None,
):
    body = await request.body()
    if not webhooks.verify(body, x_hub_signature_256):
        return _answer(status.HTTP_401_UNAUTHORIZED, "Signature does not match GITHUB_WEBHOOK_SECRET.")

    if x_github_event == "ping":
        return _answer(200, "DeployForge is listening.")
    if x_github_event != "push":
        return _answer(202, f"Ignored: {x_github_event} events do not deploy.")

    try:
        payload = json.loads(body)
    except ValueError:
        return _answer(400, "The body is not JSON.")

    repository = await db.get(Repository, app)
    if repository is None:
        return _answer(404, "No such app: it was deleted. Remove this webhook.")
    if (payload.get("repository") or {}).get("id") != repository.github_repo_id:
        return _answer(403, "This webhook belongs to a different repository.")

    reason = _skip_reason(repository, payload)
    if reason is None and settings.builds_on_actions:
        reason = await _actions_will_build(db, repository)
    if reason:
        return _answer(202, f"Not deploying: {reason}")

    owner = await db.get(User, repository.user_id)
    if owner is None or not owner.is_active or not owner.can_deploy:
        return _answer(202, "Not deploying: the owner may not deploy right now.")

    head = payload.get("head_commit") or {}
    try:
        deployment = await trigger_build(db, repository, owner, actor="github")
    except AppError as exc:
        # Most often a build already in flight; it was asked for moments ago.
        return _answer(202, f"Not deploying: {exc.message}")

    await record(
        db, deployment.id, "build",
        f"Push of {str(payload.get('after', ''))[:7]} by "
        f"{(payload.get('pusher') or {}).get('name', 'someone')}: "
        f"{str(head.get('message', '')).splitlines()[0][:120] if head.get('message') else 'no message'}",
        level=EventLevel.INFO, actor="github",
    )
    logger.info("Push to %s deployed as %s", repository.full_name, deployment.id)
    return _answer(202, "Deploying.", deployment_id=str(deployment.id))


def _skip_reason(repository: Repository, payload: dict) -> str | None:
    branch = repository.default_branch
    if payload.get("ref") != f"refs/heads/{branch}":
        return f"the app deploys from {branch}, not {str(payload.get('ref', '')).removeprefix('refs/heads/')}."
    if payload.get("deleted"):
        return "the branch was deleted."
    if not repository.auto_deploy:
        return "push deploys are turned off for this app."

    files = webhooks.changed_paths(payload)
    if files is None:
        return None
    if files and all(f == workflow.workflow_path(repository) for f in files):
        return "only DeployForge's workflow file changed."
    roots = [p for p in (repository.service_paths or [repository.deploy_path]) if p]
    if roots and files and not any(f == r or f.startswith(r.rstrip("/") + "/") for f in files for r in roots):
        return f"nothing under {', '.join(r + '/' for r in roots)} changed."
    return None


async def _actions_will_build(db: AsyncSession, repository: Repository) -> str | None:
    """
    On the Actions backend the workflow committed into the repository runs on
    the same push, so building from the webhook as well would build twice.
    Until that workflow exists — the app has never been built on Actions —
    the webhook is what starts the first build, which also commits it.
    """
    on_actions = (
        await db.execute(
            select(Deployment.id)
            .where(Deployment.repository_id == repository.id, Deployment.built_on_actions.is_(True))
            .limit(1)
        )
    ).first()
    if on_actions:
        return "the DeployForge workflow in the repository builds this push on GitHub Actions."
    return None
