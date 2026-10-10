"""
Endpoints a GitHub Actions run calls.

Not for browsers. Each request carries the run's GitHub OIDC token as a bearer
token; see `app/ci/oidc.py` for why that is enough.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.ci import service as ci
from app.ci.oidc import InvalidRunTokenError, verify_run_token
from app.db import get_db

router = APIRouter(prefix="/ci", tags=["ci"], include_in_schema=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]


async def run_claims(
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer":
        raise InvalidRunTokenError("A GitHub Actions identity token is required.")
    return await verify_run_token(token.strip())


RunClaims = Annotated[dict[str, Any], Depends(run_claims)]


class RunStartIn(BaseModel):
    target: uuid.UUID
    # Empty on a push; the dashboard's deployment id on a dispatch.
    deployment: str = ""


class RunResultIn(BaseModel):
    status: Literal["success", "failure", "cancelled", "skipped"]
    method: Literal["docker", "buildpack", "compose"] | None = None
    image: str | None = Field(default=None, max_length=512)
    services: dict[str, str] | None = None
    log: str = ""
    error: str | None = Field(default=None, max_length=4000)


@router.post("/runs")
async def start_run(body: RunStartIn, claims: RunClaims, db: DbSession) -> dict:
    """A run has started: register it and say what to build."""
    try:
        deployment_id = uuid.UUID(body.deployment) if body.deployment else None
    except ValueError:
        deployment_id = None
    return await ci.begin(
        db, claims, target=body.target, deployment_id=deployment_id
    )


@router.post("/runs/{deployment_id}/result")
async def finish_run(
    deployment_id: uuid.UUID,
    body: RunResultIn,
    claims: RunClaims,
    db: DbSession,
    background_tasks: BackgroundTasks,
) -> dict:
    """A run has finished: record it, and deploy what it built."""
    images = await ci.finish(
        db,
        claims,
        deployment_id=deployment_id,
        status="failure" if body.status == "skipped" else body.status,
        method=body.method,
        image=body.image,
        services=body.services,
        log=body.log,
        error=body.error,
    )
    if images is not None:
        background_tasks.add_task(ci.after_build, deployment_id, images)
    return {"accepted": images is not None}
