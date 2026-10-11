"""
DeployForge API — application entry point.

Creates the FastAPI app, configures CORS for the frontend, registers error
handlers and feature routers, and exposes the /health endpoint used to verify
that the API and database are reachable.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

import asyncio
import logging
import re
from contextlib import asynccontextmanager

from app.api import (
    admin_ops_routes,
    admin_routes,
    app_routes,
    auth_routes,
    ci_routes,
    deployment_routes,
    environment_routes,
    github_routes,
    internal_routes,
    repository_routes,
)
from app.config import settings
from app.core import redis as redis_core
from app.core.errors import register_error_handlers
from app.db import AsyncSessionLocal, engine
from app.metrics import collector as metrics_collector
from app.queue.jobs import HANDLERS
from app.queue.worker import Worker
from app.runtime import docker as docker_runtime
from app.runtime import service as runtime_service

logger = logging.getLogger(__name__)

_TOKEN_IN_QUERY = re.compile(r"([?&]token=)[^&\s]*")


class _RedactTokens(logging.Filter):
    """
    Keep the router's shared secret out of the access log.

    Traefik presents it as a query parameter every few seconds, so without
    this it would be written to the log thousands of times a day.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _TOKEN_IN_QUERY.sub(r"\1***", a) if isinstance(a, str) else a
                for a in record.args
            )
        return True


logging.getLogger("uvicorn.access").addFilter(_RedactTokens())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    Make the world match the database before serving the first request.

    Deployment rows outlive the process that wrote them: Docker Desktop
    restarts, the machine reboots, someone stops a container by hand. Without
    this, the dashboard shows apps as running that are not, and the router is
    handed routes to containers that no longer exist. Neither failure is
    allowed to stop the API from starting.
    """
    try:
        await docker_runtime.ensure_network()
    except Exception:  # noqa: BLE001 — the API is still useful without Docker
        logger.warning("Could not ensure the app network exists", exc_info=True)

    try:
        async with AsyncSessionLocal() as session:
            corrected = await runtime_service.reconcile(session)
            if corrected:
                logger.info("Reconciled %d deployment(s) at startup", corrected)
    except Exception:  # noqa: BLE001 — never block startup on this
        logger.warning("Startup reconciliation failed", exc_info=True)
    finally:
        # Empty the pool before serving. The connections opened above belong to
        # whichever event loop ran startup, which is not always the loop that
        # serves requests; handing one of those to a request handler surfaces as
        # `MissingGreenlet` on the first query and kills the worker. Disposing
        # here costs one reconnect and removes the whole class of problem.
        await engine.dispose()

    # Background work that belongs to the serving loop: the build queue's
    # workers (unless a separate `python -m app.worker` runs them) and the
    # sampler that records each running app's CPU, memory and response time.
    stop = asyncio.Event()
    background: list[asyncio.Task] = []
    if settings.worker_embedded:
        background.append(asyncio.create_task(Worker(HANDLERS).run(stop), name="build-queue"))
    if settings.metrics_enabled:
        background.append(asyncio.create_task(metrics_collector.run(stop), name="metrics"))

    yield

    stop.set()
    for task in background:
        try:
            await asyncio.wait_for(task, timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
        except Exception:  # noqa: BLE001
            logger.warning("Background task %s ended badly", task.get_name(), exc_info=True)
    await redis_core.close_all()
    await engine.dispose()

app = FastAPI(
    title="DeployForge API",
    version="0.1.0",
    description=(
        "Connect a GitHub repository, detect how it should be built, build it "
        "into an image, and run it behind a per-app URL."
    ),
    docs_url="/docs" if settings.is_development else None,
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_error_handlers(app)

app.include_router(auth_routes.router)
app.include_router(github_routes.router)
app.include_router(repository_routes.router)
app.include_router(environment_routes.router)
app.include_router(deployment_routes.router)
app.include_router(app_routes.router)
app.include_router(admin_routes.router)
app.include_router(admin_ops_routes.router)
app.include_router(internal_routes.router)
app.include_router(ci_routes.router)


@app.get("/health", tags=["health"])
async def health() -> dict:
    """
    Liveness/readiness probe.

    Returns "ok" when the API is up and the database answers, "degraded" when
    the API is up but the database is unreachable. Never raises — the point is
    to report the problem, not to become one.
    """
    database = "ok"
    detail: str | None = None
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - report any failure, don't crash
        database = "unavailable"
        detail = f"{type(exc).__name__}: {exc}"

    redis = "ok" if await redis_core.ping() else "unavailable"

    return {
        "status": "ok" if database == "ok" and redis == "ok" else "degraded",
        "service": "deployforge-api",
        "version": app.version,
        "environment": settings.app_env,
        "database": database,
        "redis": redis,
        "build_backend": settings.build_backend,
        "detail": detail,
    }


@app.get("/meta", tags=["health"])
async def meta() -> dict:
    """What this installation can do, so the console shows only what works."""
    from app.builder import ai_diagnosis

    return {
        "version": app.version,
        "build_backend": settings.build_backend,
        "app_domain": settings.app_domain,
        "https": settings.app_scheme == "https",
        "ai_diagnosis": ai_diagnosis.available(),
        "metrics": settings.metrics_enabled,
        "metrics_interval_seconds": settings.metrics_interval_seconds,
        "build_concurrency": settings.build_concurrency,
        "rate_limit_deploys_per_hour": settings.rate_limit_deploys_per_hour,
        "rate_limit_deploy_burst": settings.rate_limit_deploy_burst,
        "app_memory_limit": settings.app_memory_limit,
        "app_cpu_limit": settings.app_cpu_limit,
        "app_pids_limit": settings.app_pids_limit,
        "metrics_retention_hours": settings.metrics_retention_hours,
    }

