"""
Tests for builds that run in GitHub Actions.

GitHub is never called. Run identity tokens are signed here with a throwaway
RSA key that stands in for GitHub's, so what is exercised is the server's
side: which runs it believes, what it tells them to build, what it does with
their results, and how the dashboard's Deploy button hands off to them.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwk, jwt

from app.api import repository_routes
from app.ci import oidc, workflow
from app.ci import service as ci_service
from app.config import settings
from app.github.crypto import encrypt_token
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.github import GitHubConnection
from app.models.repository import DetectedType, Repository
from app.runtime import compose, registry
from app.runtime import service as runtime

API_URL = "https://api.example.test"
GITHUB_REPO_ID = 1296269
SHA = "3bb876b2c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7"
RUN_ID = 4242

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PRIVATE_PEM = _KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
)
_PUBLIC_JWK = {
    **jwk.construct(
        _KEY.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ),
        "RS256",
    ).to_dict(),
    "kid": "test-key",
}


def run_token(*, private_pem: bytes = _PRIVATE_PEM, **overrides) -> str:
    """An identity token as GitHub would issue it to a run."""
    now = int(time.time())
    claims = {
        "iss": settings.ci_oidc_issuer,
        "aud": API_URL,
        "iat": now,
        "exp": now + 300,
        "repository_id": str(GITHUB_REPO_ID),
        "repository": "octocat/amvex",
        "sha": SHA,
        "run_id": str(RUN_ID),
        "ref": "refs/heads/main",
        "event_name": "push",
        "actor": "octocat",
        **overrides,
    }
    return jwt.encode(
        claims, private_pem, algorithm="RS256", headers={"kid": "test-key"}
    )


def bearer(token: str | None = None, **overrides) -> dict[str, str]:
    return {"Authorization": f"Bearer {token or run_token(**overrides)}"}


@pytest.fixture(autouse=True)
def github_actions(monkeypatch, tmp_path):
    """Builds go to Actions, and GitHub's signing key is ours."""

    async def fake_jwks():
        return [_PUBLIC_JWK]

    monkeypatch.setattr(oidc, "_fetch_jwks", fake_jwks)
    monkeypatch.setitem(oidc._jwks_cache, "keys", None)
    monkeypatch.setattr(settings, "build_backend", "actions")
    monkeypatch.setattr(settings, "public_api_url", API_URL)
    monkeypatch.setattr(settings, "ci_oidc_audience", "")
    monkeypatch.setattr(settings, "build_log_dir", str(tmp_path / "logs"))
    monkeypatch.setattr(settings, "stacks_dir", str(tmp_path / "stacks"))


async def _signed_up(client, credentials):
    res = await client.post("/auth/signup", json=credentials)
    return (
        {"Authorization": f"Bearer {res.json()['access_token']}"},
        uuid.UUID(res.json()["user"]["id"]),
    )


async def _connect_github(db, user_id, scopes="repo,workflow,read:packages"):
    db.add(
        GitHubConnection(
            user_id=user_id,
            github_username="octocat",
            github_user_id=583231,
            access_token_enc=encrypt_token("gho_token"),
            scopes=scopes,
        )
    )
    await db.commit()


async def _target(db, user_id, **kwargs) -> Repository:
    repository = Repository(
        user_id=user_id,
        github_repo_id=GITHUB_REPO_ID,
        name="Amvex",
        full_name="Octocat/Amvex",
        default_branch="main",
        clone_url="https://github.com/octocat/amvex.git",
        detected_type=DetectedType.FRAMEWORK,
        detected_framework="fastapi",
        **kwargs,
    )
    db.add(repository)
    await db.commit()
    await db.refresh(repository)
    return repository


async def _app(client, db, credentials, **kwargs):
    headers, user_id = await _signed_up(client, credentials)
    await _connect_github(db, user_id)
    return headers, user_id, await _target(db, user_id, **kwargs)


async def _begin(client, repository, deployment="", **claims):
    return await client.post(
        "/ci/runs",
        json={"target": str(repository.id), "deployment": deployment},
        headers=bearer(**claims),
    )


# --- Run identity -----------------------------------------------------------

@pytest.mark.asyncio
async def test_a_genuine_run_token_is_accepted():
    claims = await oidc.verify_run_token(run_token())
    assert claims["repository_id"] == str(GITHUB_REPO_ID)


@pytest.mark.asyncio
async def test_a_token_for_another_audience_is_refused():
    """A token minted for some other service must not work here."""
    with pytest.raises(oidc.InvalidRunTokenError):
        await oidc.verify_run_token(run_token(aud="https://elsewhere.example"))


@pytest.mark.asyncio
async def test_a_token_not_signed_by_github_is_refused():
    impostor = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = impostor.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    with pytest.raises(oidc.InvalidRunTokenError):
        await oidc.verify_run_token(run_token(private_pem=pem))


@pytest.mark.asyncio
async def test_an_expired_token_is_refused():
    past = int(time.time()) - 3600
    with pytest.raises(oidc.InvalidRunTokenError):
        await oidc.verify_run_token(run_token(iat=past - 300, exp=past))


@pytest.mark.asyncio
async def test_the_ci_endpoints_require_a_token(client):
    res = await client.post(
        "/ci/runs", json={"target": str(uuid.uuid4()), "deployment": ""}
    )
    assert res.status_code == 401


# --- Begin ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_push_becomes_a_deployment_and_gets_a_plan(
    client, db_session, user_credentials
):
    _, _, repository = await _app(client, db_session, user_credentials, deploy_path="api")

    res = await _begin(client, repository)
    assert res.status_code == 200
    body = res.json()

    assert body["build"] is True
    deployment = await db_session.get(Deployment, uuid.UUID(body["deployment_id"]))
    assert deployment.status is DeploymentStatus.BUILDING
    assert deployment.built_on_actions
    assert deployment.ci_trigger == "push"
    assert deployment.commit_sha == SHA
    assert deployment.ci_run_url.endswith(f"/actions/runs/{RUN_ID}")

    # Images live under the student's own account, named in lowercase.
    assert body["plan"] == {
        "kind": "single",
        "path": "api",
        "image": f"ghcr.io/octocat/amvex/api:{SHA[:12]}",
        "image_prefix": "ghcr.io/octocat/amvex/api",
        "tag": SHA[:12],
    }


@pytest.mark.asyncio
async def test_the_plan_carries_the_apps_environment(
    client, db_session, user_credentials
):
    headers, _, repository = await _app(client, db_session, user_credentials)
    await client.put(
        f"/repos/{repository.id}/env",
        json={"variables": [{"key": "API_KEY", "value": "s3cret-value"}]},
        headers=headers,
    )

    body = (await _begin(client, repository)).json()
    assert body["env"] == {"API_KEY": "s3cret-value"}


@pytest.mark.asyncio
async def test_a_run_from_another_repository_is_refused(
    client, db_session, user_credentials
):
    """A student cannot build into someone else's app from their own repo."""
    _, _, repository = await _app(client, db_session, user_credentials)

    res = await _begin(client, repository, repository_id="999")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_a_push_to_another_branch_is_not_deployed(
    client, db_session, user_credentials
):
    _, _, repository = await _app(client, db_session, user_credentials)

    body = (await _begin(client, repository, ref="refs/heads/feature")).json()
    assert body["build"] is False
    assert "refs/heads/main" in body["reason"]


@pytest.mark.asyncio
async def test_a_blocked_account_is_not_deployed_and_its_request_is_closed(
    client, db_session, user_credentials
):
    _, user_id, repository = await _app(client, db_session, user_credentials)
    from app.models.user import User

    user = await db_session.get(User, user_id)
    queued = await ci_service.queue(db_session, repository, user)
    user.can_deploy = False
    user.deploy_block_reason = "Paused for the exam."
    await db_session.commit()

    body = (await _begin(client, repository, deployment=str(queued.id))).json()

    assert body == {"build": False, "reason": "Paused for the exam."}
    await db_session.refresh(queued)
    assert queued.status is DeploymentStatus.FAILED


@pytest.mark.asyncio
async def test_a_dashboard_run_continues_the_queued_deployment(
    client, db_session, user_credentials
):
    _, user_id, repository = await _app(client, db_session, user_credentials)
    from app.models.user import User

    queued = await ci_service.queue(
        db_session, repository, await db_session.get(User, user_id)
    )
    body = (
        await _begin(
            client, repository, deployment=str(queued.id),
            event_name="workflow_dispatch",
        )
    ).json()

    assert body["deployment_id"] == str(queued.id)
    await db_session.refresh(queued)
    assert queued.status is DeploymentStatus.BUILDING
    assert queued.ci_trigger == "dashboard"


@pytest.mark.asyncio
async def test_a_newer_push_releases_the_build_it_replaces(
    client, db_session, user_credentials
):
    """The workflow cancels the older run; its row must not stay `building`."""
    _, _, repository = await _app(client, db_session, user_credentials)

    first = (await _begin(client, repository)).json()["deployment_id"]
    await _begin(client, repository, run_id="4243", sha="f" * 40)

    older = await db_session.get(Deployment, uuid.UUID(first))
    await db_session.refresh(older)
    assert older.status is DeploymentStatus.FAILED
    assert "newer build" in older.error_message


@pytest.mark.asyncio
async def test_a_stack_gets_one_image_per_directory(
    client, db_session, user_credentials
):
    _, _, repository = await _app(
        client, db_session, user_credentials, service_paths=["frontend", "backend"]
    )

    plan = (await _begin(client, repository)).json()["plan"]
    assert plan["kind"] == "stack"
    assert [s["name"] for s in plan["services"]] == ["frontend", "backend"]
    assert plan["services"][1]["image"] == f"ghcr.io/octocat/amvex/stack/backend:{SHA[:12]}"


# --- Finish -----------------------------------------------------------------

async def _building(client, db_session, credentials, **kwargs):
    _, _, repository = await _app(client, db_session, credentials, **kwargs)
    deployment_id = (await _begin(client, repository)).json()["deployment_id"]
    return repository, deployment_id


@pytest.mark.asyncio
async def test_a_successful_image_build_is_deployed(
    client, db_session, user_credentials, monkeypatch
):
    repository, deployment_id = await _building(client, db_session, user_credentials)
    scheduled = []
    monkeypatch.setattr(
        ci_service, "after_build",
        lambda *args, **kwargs: scheduled.append(args),
    )
    image = f"ghcr.io/octocat/amvex/app:{SHA[:12]}"

    res = await client.post(
        f"/ci/runs/{deployment_id}/result",
        json={"status": "success", "method": "docker", "image": image, "log": "built"},
        headers=bearer(),
    )

    assert res.json() == {"accepted": True}
    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    assert deployment.image_ref == image
    assert deployment.build_method is BuildMethod.DOCKER
    assert scheduled and scheduled[0][1] == {"": image}
    assert "built" in Path(deployment.logs_ref).read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_a_failed_build_is_explained_from_its_log(
    client, db_session, user_credentials
):
    _, deployment_id = await _building(client, db_session, user_credentials)

    log = "npm ERR! Missing script: \"build\"\n"
    await client.post(
        f"/ci/runs/{deployment_id}/result",
        json={"status": "failure", "log": log},
        headers=bearer(),
    )

    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    await db_session.refresh(deployment)
    assert deployment.status is DeploymentStatus.FAILED
    assert deployment.error_message


@pytest.mark.asyncio
async def test_an_image_outside_the_apps_namespace_is_refused(
    client, db_session, user_credentials
):
    """A run may not point the app at an image that is not its own."""
    _, deployment_id = await _building(client, db_session, user_credentials)

    await client.post(
        f"/ci/runs/{deployment_id}/result",
        json={"status": "success", "method": "docker", "image": "ghcr.io/evil/thing:1"},
        headers=bearer(),
    )

    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    await db_session.refresh(deployment)
    assert deployment.status is DeploymentStatus.FAILED
    assert "not one of this app's images" in deployment.error_message


@pytest.mark.asyncio
async def test_only_the_run_that_claimed_a_deployment_may_close_it(
    client, db_session, user_credentials
):
    _, deployment_id = await _building(client, db_session, user_credentials)

    res = await client.post(
        f"/ci/runs/{deployment_id}/result",
        json={"status": "failure", "log": ""},
        headers=bearer(run_id="1"),
    )
    assert res.status_code == 403


# --- After the build --------------------------------------------------------

@pytest.mark.asyncio
async def test_a_built_image_is_started_automatically(
    client, db_session, user_credentials, monkeypatch
):
    _, deployment_id = await _building(client, db_session, user_credentials)
    started = []

    async def fake_start(db, deployment, repository, user, *, actor):
        started.append((deployment.id, actor))
        return deployment

    monkeypatch.setattr(ci_service.runtime, "start", fake_start)
    await ci_service.finish(
        db_session, await oidc.verify_run_token(run_token()),
        deployment_id=uuid.UUID(deployment_id), status="success", method="docker",
        image=f"ghcr.io/octocat/amvex/app:{SHA[:12]}", services=None, log="", error=None,
    )
    await ci_service.after_build(
        uuid.UUID(deployment_id), {"": "x"}, db=db_session
    )

    assert started == [(uuid.UUID(deployment_id), "github")]
    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    assert deployment.status is DeploymentStatus.BUILT


@pytest.mark.asyncio
async def test_an_overtaken_build_is_not_started(
    client, db_session, user_credentials, monkeypatch
):
    """The student's latest push wins, even if an older one finishes later."""
    repository, older_id = await _building(client, db_session, user_credentials)
    older = await db_session.get(Deployment, uuid.UUID(older_id))

    newer = Deployment(
        repository_id=repository.id, user_id=older.user_id,
        status=DeploymentStatus.BUILDING, built_on_actions=True,
        created_at=datetime.now(timezone.utc) + timedelta(seconds=5),
    )
    db_session.add(newer)
    await db_session.commit()

    started = []

    async def fake_start(*args, **kwargs):
        started.append(args)

    monkeypatch.setattr(ci_service.runtime, "start", fake_start)
    await ci_service.after_build(older.id, {"": "x"}, db=db_session)
    assert started == []


# --- The Deploy button ------------------------------------------------------

@pytest.mark.asyncio
async def test_deploy_queues_a_github_actions_build(
    client, db_session, user_credentials, monkeypatch
):
    headers, _, repository = await _app(client, db_session, user_credentials)
    dispatched = []

    async def fake_dispatch(deployment_id):
        dispatched.append(deployment_id)

    monkeypatch.setattr(repository_routes.ci_service, "dispatch", fake_dispatch)

    res = await client.post(f"/repos/{repository.id}/build", headers=headers)

    assert res.status_code == 202
    deployment_id = uuid.UUID(res.json()["deployment_id"])
    assert dispatched == [deployment_id]
    deployment = await db_session.get(Deployment, deployment_id)
    assert deployment.status is DeploymentStatus.QUEUED
    assert deployment.built_on_actions


@pytest.mark.asyncio
async def test_deploy_asks_for_the_new_github_permissions(
    client, db_session, user_credentials
):
    """A connection made before builds moved to Actions must be renewed."""
    headers, user_id = await _signed_up(client, user_credentials)
    await _connect_github(db_session, user_id, scopes="repo")
    repository = await _target(db_session, user_id)

    res = await client.post(f"/repos/{repository.id}/build", headers=headers)

    assert res.status_code == 403
    assert "Reconnect GitHub" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_deploy_refuses_when_github_cannot_call_back(
    client, db_session, user_credentials, monkeypatch
):
    monkeypatch.setattr(settings, "public_api_url", "http://localhost:8000")
    headers, _, repository = await _app(client, db_session, user_credentials)

    res = await client.post(f"/repos/{repository.id}/build", headers=headers)
    assert res.status_code == 503


@pytest.mark.asyncio
async def test_dispatch_commits_the_workflow_and_starts_it(
    client, db_session, user_credentials, monkeypatch
):
    _, user_id, repository = await _app(client, db_session, user_credentials)
    from app.models.user import User

    deployment = await ci_service.queue(
        db_session, repository, await db_session.get(User, user_id)
    )
    calls = []

    async def fake_put(token, full_name, path, *, content, branch, message):
        calls.append(("put", path, branch, "[skip ci]" in message))
        return True

    attempts = iter([False, True])  # GitHub needs a moment to see a new file

    async def fake_dispatch(token, full_name, workflow_file, *, ref, inputs):
        calls.append(("dispatch", workflow_file, inputs["deployment"]))
        return next(attempts)

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(ci_service.github_client, "put_file", fake_put)
    monkeypatch.setattr(ci_service.github_client, "dispatch_workflow", fake_dispatch)
    monkeypatch.setattr(ci_service.asyncio, "sleep", no_sleep)

    await ci_service.dispatch(deployment.id, db=db_session)

    filename = workflow.workflow_filename(repository)
    assert calls[0] == ("put", f".github/workflows/{filename}", "main", True)
    assert calls[1:] == [("dispatch", filename, str(deployment.id))] * 2
    await db_session.refresh(deployment)
    assert deployment.status is DeploymentStatus.QUEUED  # now GitHub's to start


@pytest.mark.asyncio
async def test_a_dispatch_github_refuses_fails_the_deployment(
    client, db_session, user_credentials, monkeypatch
):
    _, user_id, repository = await _app(client, db_session, user_credentials)
    from app.core.errors import AppError
    from app.models.user import User

    deployment = await ci_service.queue(
        db_session, repository, await db_session.get(User, user_id)
    )

    async def refuse(*args, **kwargs):
        raise AppError("GitHub refused to write the workflow.")

    monkeypatch.setattr(ci_service.github_client, "put_file", refuse)
    await ci_service.dispatch(deployment.id, db=db_session)

    await db_session.refresh(deployment)
    assert deployment.status is DeploymentStatus.FAILED
    assert "refused" in deployment.error_message


# --- Restarts ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_restart_does_not_abandon_a_build_running_on_github(
    client, db_session, user_credentials
):
    """It is still running on GitHub's machine and will report back."""
    _, deployment_id = await _building(client, db_session, user_credentials)

    await runtime.release_interrupted_builds(db_session)

    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    await db_session.refresh(deployment)
    assert deployment.status is DeploymentStatus.BUILDING


@pytest.mark.asyncio
async def test_a_github_build_silent_past_the_timeout_is_released(
    client, db_session, user_credentials
):
    _, deployment_id = await _building(client, db_session, user_credentials)
    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    deployment.build_started_at = datetime.now(timezone.utc) - timedelta(
        seconds=settings.build_timeout_seconds + 60
    )
    await db_session.commit()

    await runtime.release_interrupted_builds(db_session)

    await db_session.refresh(deployment)
    assert deployment.status is DeploymentStatus.FAILED
    assert "never reported" in deployment.error_message


# --- The workflow file ------------------------------------------------------

def _repository(**kwargs) -> Repository:
    return Repository(
        id=uuid.UUID("4ac9b729-f76e-4a11-9e77-0000000000ff"),
        user_id=uuid.uuid4(),
        github_repo_id=GITHUB_REPO_ID,
        name="amvex",
        full_name="octocat/amvex",
        default_branch="trunk",
        clone_url="",
        **kwargs,
    )


def test_the_workflow_file_is_valid_and_calls_the_shared_build():
    parsed = yaml.safe_load(workflow.render(_repository(deploy_path="web")))

    # YAML reads the bare key `on` as True.
    triggers = parsed[True]
    assert triggers["push"]["branches"] == ["trunk"]
    assert triggers["push"]["paths"] == ["web/**"]
    assert "workflow_dispatch" in triggers
    assert parsed["permissions"]["id-token"] == "write"

    job = parsed["jobs"]["deploy"]
    assert job["uses"] == settings.ci_workflow
    assert job["with"]["api-url"] == API_URL
    assert job["with"]["target"] == "4ac9b729-f76e-4a11-9e77-0000000000ff"


def test_a_root_target_redeploys_on_any_change():
    parsed = yaml.safe_load(workflow.render(_repository()))
    assert "paths" not in parsed[True]["push"]


def test_the_shared_workflow_in_this_repository_parses():
    path = Path(__file__).resolve().parents[2] / ".github/workflows/deployforge-build.yml"
    parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert set(parsed[True]["workflow_call"]["inputs"]) == {
        "api-url", "target", "deployment",
    }


# --- Running what was built -------------------------------------------------

def test_the_images_override_replaces_build_sections(tmp_path):
    path = compose.write_images_override(
        tmp_path, {"web": "ghcr.io/octocat/amvex/app/web:abc"}
    )
    text = path.read_text(encoding="utf-8")
    assert '"web":' in text
    assert 'image: "ghcr.io/octocat/amvex/app/web:abc"' in text
    assert "build: !reset null" in text


@pytest.mark.asyncio
async def test_a_prebuilt_stack_is_pulled_not_built(tmp_path, monkeypatch):
    (tmp_path / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    compose.write_images_override(tmp_path, {"web": "ghcr.io/x/y/z:1"})
    commands = []

    async def fake_stream(command, log_path, timeout, docker_config=None):
        commands.append(command)

    monkeypatch.setattr(compose, "_stream", fake_stream)
    await compose.up(
        compose_file=tmp_path / "compose.yaml", project="df-x", log_path=tmp_path / "log"
    )

    assert "--build" not in commands[0]
    assert str(tmp_path / compose.IMAGES_OVERRIDE) in commands[0]


@pytest.mark.asyncio
async def test_registry_credentials_are_the_owners_and_are_thrown_away(
    client, db_session, user_credentials
):
    _, user_id = await _signed_up(client, user_credentials)
    await _connect_github(db_session, user_id)

    async with registry.credentials_for(db_session, user_id) as directory:
        config = (directory / "config.json").read_text(encoding="utf-8")
        assert "ghcr.io" in config
    assert not directory.exists()


def test_only_github_registry_images_need_credentials():
    assert registry.needs_credentials("ghcr.io/octocat/amvex/app:abc")
    assert not registry.needs_credentials("localhost:5000/deployforge/x:1")
    assert not registry.needs_credentials(None)


@pytest.mark.asyncio
async def test_an_old_connection_is_told_to_reconnect(
    client, db_session, user_credentials
):
    headers, user_id = await _signed_up(client, user_credentials)
    await _connect_github(db_session, user_id, scopes="repo")
    assert (await client.get("/github/status", headers=headers)).json()["needs_reconnect"]


@pytest.mark.asyncio
async def test_a_connection_with_the_new_scopes_is_not(
    client, db_session, user_credentials
):
    headers, user_id = await _signed_up(client, user_credentials)
    await _connect_github(db_session, user_id)
    status = (await client.get("/github/status", headers=headers)).json()
    assert status["needs_reconnect"] is False


@pytest.mark.asyncio
async def test_a_failed_build_still_records_how_it_was_built(
    client, db_session, user_credentials
):
    """The page should say "Docker Compose", not "Not built", for a failure."""
    _, deployment_id = await _building(client, db_session, user_credentials)

    await client.post(
        f"/ci/runs/{deployment_id}/result",
        json={"status": "failure", "method": "compose", "log": "unknown blob\n"},
        headers=bearer(),
    )

    deployment = await db_session.get(Deployment, uuid.UUID(deployment_id))
    await db_session.refresh(deployment)
    assert deployment.build_method is BuildMethod.COMPOSE
    assert "uploading it to GitHub's registry failed" in deployment.error_message
