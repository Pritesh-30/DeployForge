"""
Verify the identity token a GitHub Actions run presents.

A workflow running in a student's repository calls DeployForge back to say
"I am building this app" and later "here is the image". Nothing is shared in
advance to authenticate those calls — no secret is stored in the repository.
Instead the run asks GitHub for an OIDC token: a JWT signed by GitHub, naming
the repository it runs in, the commit, and the run. Verifying GitHub's
signature is what makes the `repository_id` claim trustworthy, and that claim
is matched against the repository the app was connected from.

So a run can only ever report on apps connected from its own repository, and a
token minted for some other service (a different audience) is refused.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx
from jose import jwt
from jose.exceptions import JWTError

from app.config import settings
from app.core.errors import AppError

logger = logging.getLogger(__name__)

# GitHub rotates its signing keys rarely; an hour of caching saves a request
# per callback, and an unknown key id always triggers a refetch anyway.
_JWKS_TTL_SECONDS = 3600
_jwks_cache: dict[str, Any] = {"keys": None, "fetched_at": 0.0}


class InvalidRunTokenError(AppError):
    code = "invalid_run_token"
    status_code = 401


async def _fetch_jwks() -> list[dict[str, Any]]:
    url = f"{settings.ci_oidc_issuer.rstrip('/')}/.well-known/jwks"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            keys = response.json().get("keys")
    except (httpx.HTTPError, ValueError) as exc:
        raise InvalidRunTokenError(
            f"Could not fetch GitHub's signing keys: {type(exc).__name__}"
        ) from exc
    if not isinstance(keys, list):
        raise InvalidRunTokenError("GitHub's signing keys were unreadable.")
    return keys


async def _signing_key(kid: str | None) -> dict[str, Any]:
    """The JWK for `kid`, refetching once if it is not in the cache."""
    fresh = time.monotonic() - _jwks_cache["fetched_at"] < _JWKS_TTL_SECONDS
    for attempt in range(2):
        if attempt or not fresh or _jwks_cache["keys"] is None:
            _jwks_cache["keys"] = await _fetch_jwks()
            _jwks_cache["fetched_at"] = time.monotonic()
        for key in _jwks_cache["keys"]:
            if key.get("kid") == kid:
                return key
    raise InvalidRunTokenError("The token was not signed by a known GitHub key.")


async def verify_run_token(token: str) -> dict[str, Any]:
    """
    The claims of a valid GitHub Actions OIDC token.

    Checks the signature, issuer, audience and expiry. What the claims are
    then *used for* — matching a repository — is the caller's decision.
    """
    if not token:
        raise InvalidRunTokenError("A GitHub Actions identity token is required.")
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise InvalidRunTokenError("The identity token is malformed.") from exc

    key = await _signing_key(header.get("kid"))
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.oidc_audience,
            issuer=settings.ci_oidc_issuer.rstrip("/"),
        )
    except JWTError as exc:
        raise InvalidRunTokenError(f"The identity token was refused: {exc}") from exc

    for claim in ("repository_id", "repository", "sha", "run_id"):
        if not claims.get(claim):
            raise InvalidRunTokenError(f"The identity token has no {claim} claim.")
    return claims
