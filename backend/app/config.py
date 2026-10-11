"""
Application configuration.

Every setting comes from the environment (or a local `.env` file). Nothing is
hardcoded, and no secret has a usable default — see `.env.example` for the
documented list of variables.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# The backend package root, so `.env` is found no matter which directory the
# app, alembic, or pytest happens to be invoked from.
BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Settings loaded from environment variables (case-insensitive)."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App ---
    app_env: str = "development"
    database_url: str = (
        "postgresql+asyncpg://deployforge:deployforge@localhost:5432/deployforge"
    )

    # --- Auth (used from Task 2) ---
    jwt_secret: str = "change-me-long-random-string"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440

    # --- Token encryption (used from Task 3) ---
    token_encryption_key: str = ""

    # --- GitHub OAuth (used from Task 3) ---
    github_client_id: str = ""
    github_client_secret: str = ""
    github_callback_url: str = "http://localhost:8000/github/callback"
    # `repo` lists and downloads repositories; `workflow` lets DeployForge
    # commit the build workflow into one; `read:packages` lets the server pull
    # the image that workflow pushed to the student's GitHub registry, and
    # `delete:packages` lets it clear that copy once this server has stored it.
    github_oauth_scopes: str = "repo,workflow,read:packages,delete:packages"

    # --- Frontend ---
    frontend_origin: str = "http://localhost:3000"

    # --- Builds ---
    # The pack CLI (Cloud Native Buildpacks). Needs Docker on the same host.
    pack_binary: str = "pack"
    pack_builder: str = "paketobuildpacks/builder-jammy-base"
    # The run image the built app actually runs on. The base run image omits
    # system libraries that recent Node builds link against (libatomic), so an
    # app builds cleanly and then dies on boot with a missing .so. The full run
    # image carries them, and pairing it with the base builder keeps the 5 GB
    # builder download rather than doubling it.
    pack_run_image: str = ""
    # Node version used when a repository does not pin one itself.
    #
    # Left to its own devices the Node buildpack installs the newest release,
    # and Node 24 links against libatomic, which no Paketo run image ships — so
    # the image builds cleanly and then dies on boot with a missing shared
    # library. Defaulting to the current LTS is the difference between a
    # student's first deploy working and it failing for a reason they have no
    # way to diagnose. A repository that pins its own version still wins.
    default_node_version: str = "22.*"
    # Prefix for image tags, e.g. deployforge/<user>-<repo>:<sha>.
    image_namespace: str = "deployforge"
    # A build that has not finished by now is killed.
    build_timeout_seconds: int = 1800
    # Where build logs are written. Empty = alongside the repo workdir.
    build_log_dir: str = ""

    # Where builds run:
    #   "local"   — on this server, with docker / pack (a laptop, or no
    #               public URL GitHub could call back to);
    #   "actions" — in GitHub Actions, in the student's own repository. The
    #               image goes to their GitHub registry and only *runs* here.
    build_backend: str = "local"
    # The API's public URL. GitHub Actions calls it back, so it must be
    # reachable from the internet — `localhost` will not do.
    public_api_url: str = "http://localhost:8000"
    # The reusable workflow every student's workflow file calls. It lives in a
    # public repository so private repositories may use it.
    ci_workflow: str = (
        "Pritesh-30/DeployForge/.github/workflows/deployforge-build.yml@main"
    )
    # GitHub's OIDC issuer, and the audience runs must request their token
    # for. Empty audience = the public API URL, so a token minted for one
    # DeployForge server is refused by any other.
    ci_oidc_issuer: str = "https://token.actions.githubusercontent.com"
    ci_oidc_audience: str = ""
    ci_registry: str = "ghcr.io"
    # Copy each image an Actions build pushed into this server's own registry
    # and run it from there, so every version is kept here — rollback does not
    # depend on GitHub — and the student's package storage is not spent.
    mirror_ci_images: bool = True
    # Then delete the copy on GitHub, when the student's connection allows it
    # (the `delete:packages` scope). Only images the app's own builds pushed.
    ci_cleanup_github_packages: bool = True

    # --- Image registry ---
    # Where built images are pushed and run from. A build that only tags an
    # image locally cannot be run on another host later; pushing to a registry
    # is what makes the image an artifact rather than a side effect.
    registry_host: str = "localhost:5000"
    registry_push: bool = True

    # --- Runtime ---
    docker_binary: str = "docker"
    # The bridge network app containers and the router share. App containers
    # publish no host ports — the only way in is through the router.
    edge_network: str = "deployforge_edge"
    container_prefix: str = "df"
    # Apps are reachable at <subdomain>.<app_domain>. Browsers resolve any
    # *.localhost name to the loopback address with no DNS or hosts entry,
    # which is what makes per-app URLs work on a laptop.
    app_domain: str = "localhost"
    router_container: str = "deployforge-traefik"
    # Shared secret the router presents when polling for its configuration.
    traefik_provider_token: str = "deployforge-internal"
    # The Traefik certificate resolver that issues HTTPS certificates. Empty =
    # plain HTTP, which is what a laptop wants: Let's Encrypt cannot reach
    # `*.localhost`, so asking it for a certificate would only fail.
    tls_cert_resolver: str = ""
    # Hostnames the platform itself answers on when it runs behind the same
    # router as the apps (see docker-compose.yml). Empty = not routed, as when
    # the backend and frontend run straight on the host during development.
    console_host: str = ""
    api_host: str = ""
    # Where the router reaches them over the shared network.
    console_upstream: str = "http://frontend:3000"
    api_upstream: str = "http://backend:8000"

    # --- Per-app resource limits ---
    # A student's app must not be able to take the machine down.
    app_memory_limit: str = "512m"
    app_cpu_limit: str = "1.0"
    app_pids_limit: int = 256
    # How long to wait for a started container to still be alive.
    app_start_grace_seconds: int = 6
    # For this long after a new version goes live, a crash puts the previous
    # version back automatically (app/runtime/guardian.py). 0 turns it off.
    auto_rollback_window_seconds: int = 300

    # --- Quotas ---
    default_max_deployments: int = 3

    # Where compose stacks keep their working copy of the repository. Unlike a
    # single image, a compose stack needs its files at *run* time — the compose
    # file and every build context — so they cannot live in a temp directory
    # that is deleted when the build finishes. Empty = beside the build logs.
    stacks_dir: str = ""

    # --- GitHub webhooks (app/github/webhooks.py) ---
    # Signs every delivery. With it set and an https PUBLIC_API_URL, each app
    # gets a webhook and a push deploys it, whichever backend builds.
    github_webhook_secret: str = ""

    # --- Redis ---
    # Holds the build queue, rate-limit state, metrics and cached GitHub
    # responses. Everything in it is either reconstructible or short-lived:
    # the database stays the source of truth, so losing Redis loses queue
    # positions and graphs, never a deployment.
    # 127.0.0.1, not localhost: on Windows `localhost` resolves to ::1 first,
    # a container published on IPv4 does not answer there, and the connect
    # timeout runs out before the fallback to IPv4 is tried.
    redis_url: str = "redis://127.0.0.1:6379/0"
    # Prefix for every key, so one Redis can serve several installations.
    redis_namespace: str = "df"

    # --- Build queue ---
    # How many builds run at once on this server. A build pins a CPU core and
    # a few GB of RAM; on one shared machine, more slots than the machine can
    # carry makes every build slower rather than more of them faster.
    # This is the starting value; an administrator can change it from the
    # queue page while the server runs, up to `build_concurrency_max`.
    build_concurrency: int = 2
    # The most slots a worker will ever open. Each is an idle coroutine
    # until the limit lets it take a job, so this costs nothing to raise.
    build_concurrency_max: int = 8
    # Run the queue's workers inside the API process. Turn off when a separate
    # `python -m app.worker` process (or several) consumes the queue instead.
    worker_embedded: bool = True
    # A worker holds a lease on the job it runs and renews it while the build
    # is alive. A lease that lapses means the worker died, and the job goes
    # back on the queue for another one.
    queue_lease_seconds: int = 60
    # Attempts per job before it is given up on. Only infrastructure faults
    # are retried; a build that fails because of the project fails once.
    queue_max_attempts: int = 3
    # Exponential backoff between attempts, with full jitter.
    queue_backoff_base_seconds: float = 5.0
    queue_backoff_cap_seconds: float = 120.0

    # --- Rate limits (GCRA) ---
    # Deploy-shaped actions per user: a burst, then a steady rate. Stops one
    # account from turning a shared build machine into its own CI.
    rate_limit_deploys_per_hour: int = 30
    rate_limit_deploy_burst: int = 6

    # --- Metrics ---
    # How often running apps are sampled for CPU, memory and response time.
    metrics_interval_seconds: int = 15
    # How long samples are kept. Stored in Redis streams, trimmed by count.
    metrics_retention_hours: int = 24
    metrics_enabled: bool = True
    # How apps are probed for response time: "router" goes through the router
    # with the app's Host header (the path a visitor takes; the only one when
    # the API runs on the host), "direct" goes to the container over the
    # shared network (when the API runs beside the apps, as when deployed).
    probe_mode: str = "router"
    router_probe_url: str = "http://127.0.0.1:80"

    # --- Code browser ---
    # Largest file shown in the code view. Bigger ones are offered as a link.
    code_max_file_bytes: int = 512 * 1024

    # --- AI diagnosis ---
    # Optional. With a key, a failed deployment whose log matches no known
    # failure can be explained by Claude on request.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5-5"

    # --- Misc ---
    # Parent dir for temporary repo downloads. Empty = system temp.
    repo_workdir: str = ""

    @property
    def registry_prefix(self) -> str:
        """Registry host with a trailing separator, or "" when pushing is off."""
        host = self.registry_host.strip().rstrip("/")
        return f"{host}/" if host and self.registry_push else ""

    @property
    def builds_on_actions(self) -> bool:
        return self.build_backend.strip().lower() == "actions"

    @property
    def oidc_audience(self) -> str:
        return self.ci_oidc_audience.strip() or self.public_api_url.strip().rstrip("/")

    @property
    def app_scheme(self) -> str:
        """`https` once a certificate resolver is configured, else `http`."""
        return "https" if self.tls_cert_resolver.strip() else "http"

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() == "development"

    @property
    def cors_origins(self) -> list[str]:
        """Allowed browser origins, comma-separated in FRONTEND_ORIGIN."""
        return [o.strip() for o in self.frontend_origin.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    """Cached settings instance — read the environment once per process."""
    return Settings()


settings = get_settings()
