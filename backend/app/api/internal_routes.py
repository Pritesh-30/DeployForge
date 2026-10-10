"""
The routing table the reverse proxy polls.

Traefik's HTTP provider fetches this endpoint every few seconds and reshapes
its routes to match. That makes the `deployments` table the single source of
truth for what is reachable: nothing writes proxy config files, nothing has to
be reloaded by hand, and a route cannot outlive the row that justifies it.

It is also why the proxy needs no access to the Docker socket. Socket access is
root-equivalent on the host, and handing it to an internet-facing process to
save writing this file would be a poor trade.

Not part of the public API: the token below is a shared secret, and the
endpoint is hidden from the docs.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.errors import PermissionError_
from app.db import get_db
from app.models.deployment import Deployment, DeploymentStatus

router = APIRouter(prefix="/internal", tags=["internal"], include_in_schema=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]

# Traefik's entrypoint names, as configured on the container: plain HTTP, and
# HTTPS for when a certificate resolver is configured.
WEB_ENTRYPOINT = "web"
WEBSECURE_ENTRYPOINT = "websecure"

# Keeps the returned configuration non-empty. See the note in `traefik_config`.
SENTINEL_NAME = "deployforge-sentinel"

# Router names for the platform's own console and API. Not valid subdomains
# (an app's always ends in a six-character id), so they cannot collide.
CONSOLE_NAME = "deployforge-console"
API_NAME = "deployforge-api"


def _router(host: str, service: str) -> dict:
    """
    A route for one hostname.

    With a certificate resolver configured it listens on HTTPS and Traefik
    obtains the certificate on the first request; HTTP is redirected to it by
    the entrypoint itself, so there is no plain-HTTP route to forget.
    """
    resolver = settings.tls_cert_resolver.strip()
    if not resolver:
        return {
            "rule": f"Host(`{host}`)",
            "service": service,
            "entryPoints": [WEB_ENTRYPOINT],
        }
    return {
        "rule": f"Host(`{host}`)",
        "service": service,
        "entryPoints": [WEBSECURE_ENTRYPOINT],
        "tls": {"certResolver": resolver},
    }


def _service(url: str) -> dict:
    return {"loadBalancer": {"servers": [{"url": url}], "passHostHeader": True}}


def _authorize(token: str | None) -> None:
    """Constant-time check of the shared secret."""
    expected = settings.traefik_provider_token
    if not expected:
        return  # no secret configured: the endpoint is open on localhost only
    if not token or not hmac.compare_digest(token, expected):
        raise PermissionError_("Invalid provider token.")


@router.get("/traefik/config")
async def traefik_config(
    db: DbSession, token: Annotated[str | None, Query()] = None
) -> dict:
    """
    Every running app, as Traefik dynamic configuration.

    Only deployments that are actually running are included. A stopped app
    disappears from the routing table within one poll interval, so its URL
    starts returning the proxy's 404 rather than hanging or, worse, reaching
    whatever later takes its container name.
    """
    _authorize(token)

    rows = (
        await db.execute(
            select(Deployment).where(
                Deployment.status.in_(
                    [DeploymentStatus.RUNNING, DeploymentStatus.LIVE]
                ),
                Deployment.subdomain.is_not(None),
                Deployment.container_name.is_not(None),
                Deployment.app_port.is_not(None),
            )
        )
    ).scalars().all()

    routers: dict[str, dict] = {}
    services: dict[str, dict] = {}

    for deployment in rows:
        name = deployment.subdomain
        routers[name] = _router(f"{name}.{settings.app_domain}", name)
        # Reached by container name over the shared network: Docker's embedded
        # DNS resolves it, so no host port is published and no container IP
        # has to be tracked as it changes on restart.
        services[name] = _service(
            f"http://{deployment.container_name}:{deployment.app_port}"
        )

    # The platform's own console and API, when they sit behind this router
    # too. Served from here rather than a config file so that one endpoint is
    # the whole routing table.
    for name, host, upstream in (
        (CONSOLE_NAME, settings.console_host, settings.console_upstream),
        (API_NAME, settings.api_host, settings.api_upstream),
    ):
        if host.strip():
            routers[name] = _router(host.strip(), name)
            services[name] = _service(upstream)

    # A configuration is never returned empty, and this is the reason:
    #
    #   * `{"routers": {}, "services": {}}` is *rejected* by Traefik's decoder
    #     ("routers cannot be a standalone element"), and a rejected payload
    #     leaves the previous configuration in place;
    #   * `{"http": {}}` is accepted but treated as nothing to apply, which
    #     also leaves the previous configuration in place.
    #
    # Either way, stopping the last running app would leave its route live,
    # pointing at a container that no longer exists — the exact failure this
    # endpoint exists to prevent. A sentinel entry keeps the payload non-empty
    # so removals always take effect. It matches a reserved `.invalid` host
    # (RFC 2606), which cannot resolve, so it never serves anything.
    routers[SENTINEL_NAME] = {
        "rule": "Host(`deployforge.invalid`)",
        "service": SENTINEL_NAME,
        "entryPoints": [WEB_ENTRYPOINT],
    }
    services[SENTINEL_NAME] = {
        "loadBalancer": {"servers": [{"url": "http://127.0.0.1:1"}]}
    }

    return {"http": {"routers": routers, "services": services}}
