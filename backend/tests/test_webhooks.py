"""
GitHub webhooks: a signed push to the app's branch deploys it, everything
else is answered with the reason it did not.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid

import pytest

from app.config import settings
from app.github import webhooks
from app.models.deployment import Deployment, DeploymentStatus
from app.models.repository import DetectedType, Repository

SECRET = "test-webhook-secret"


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "github_webhook_secret", SECRET)
    monkeypatch.setattr(settings, "public_api_url", "https://demo.ngrok-free.dev/backend")


@pytest.fixture
def builds(monkeypatch):
    """Record trigger_build calls instead of building."""
    from app.api import webhook_routes

    calls = []

    async def fake_trigger(db, repository, owner, *, actor="owner", **kw):
        calls.append((repository.id, actor))
        dep = Deployment(repository_id=repository.id, user_id=owner.id, status=DeploymentStatus.QUEUED)
        db.add(dep)
        await db.commit()
        return dep

    monkeypatch.setattr(webhook_routes, "trigger_build", fake_trigger)
    return calls


async def _app(client, db, creds, **kw) -> Repository:
    res = await client.post("/auth/signup", json=creds)
    uid = uuid.UUID(res.json()["user"]["id"])
    repo = Repository(
        user_id=uid, github_repo_id=4242, name="shop", full_name="o/shop",
        default_branch="main", clone_url="https://x", detected_type=DetectedType.DOCKER, **kw,
    )
    db.add(repo)
    await db.commit()
    return repo


def _push(**overrides) -> dict:
    payload = {
        "ref": "refs/heads/main",
        "after": "c" * 40,
        "deleted": False,
        "repository": {"id": 4242, "full_name": "o/shop"},
        "pusher": {"name": "vedant"},
        "head_commit": {"message": "Update catalog description\n\nmore"},
        "commits": [{"added": [], "modified": ["app/products/page.tsx"], "removed": []}],
    }
    payload.update(overrides)
    return payload


async def _deliver(client, repo, payload, *, event="push", secret=SECRET):
    body = json.dumps(payload).encode()
    signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return await client.post(
        f"/webhooks/github?app={repo.id}", content=body,
        headers={"X-GitHub-Event": event, "X-Hub-Signature-256": signature, "Content-Type": "application/json"},
    )


async def test_a_push_to_the_branch_deploys(client, db_session, user_credentials, builds):
    repo = await _app(client, db_session, user_credentials)
    res = await _deliver(client, repo, _push())
    assert res.status_code == 202, res.text
    assert res.json()["message"] == "Deploying."
    assert builds == [(repo.id, "github")]


async def test_an_unsigned_or_wrongly_signed_delivery_is_refused(client, db_session, user_credentials, builds):
    repo = await _app(client, db_session, user_credentials)
    assert (await _deliver(client, repo, _push(), secret="guess")).status_code == 401
    res = await client.post(f"/webhooks/github?app={repo.id}", json=_push(), headers={"X-GitHub-Event": "push"})
    assert res.status_code == 401
    assert builds == []


async def test_ping_is_answered(client, db_session, user_credentials, builds):
    repo = await _app(client, db_session, user_credentials)
    res = await _deliver(client, repo, {"zen": "hi"}, event="ping")
    assert res.status_code == 200


@pytest.mark.parametrize("payload, reason", [
    (_push(ref="refs/heads/feature"), "deploys from main"),
    (_push(deleted=True), "deleted"),
    (_push(commits=[{"added": [".github/workflows/deployforge-PLACEHOLDER.yml"], "modified": [], "removed": []}]), None),
])
async def test_pushes_that_should_not_deploy_say_why(client, db_session, user_credentials, builds, payload, reason):
    repo = await _app(client, db_session, user_credentials)
    if reason is None:
        from app.ci import workflow

        payload["commits"][0]["added"] = [workflow.workflow_path(repo)]
        reason = "workflow file"
    res = await _deliver(client, repo, payload)
    assert res.status_code == 202
    assert reason in res.json()["message"]
    assert builds == []


async def test_push_deploys_turned_off_are_respected(client, db_session, user_credentials, builds):
    repo = await _app(client, db_session, user_credentials, auto_deploy=False)
    res = await _deliver(client, repo, _push())
    assert "turned off" in res.json()["message"]
    assert builds == []


async def test_a_monorepo_app_only_builds_when_its_folder_changed(client, db_session, user_credentials, builds):
    repo = await _app(client, db_session, user_credentials, deploy_path="api")
    res = await _deliver(client, repo, _push())  # touched app/products/page.tsx
    assert "nothing under api/" in res.json()["message"]
    res = await _deliver(client, repo, _push(commits=[{"added": ["api/main.py"], "modified": [], "removed": []}]))
    assert res.json()["message"] == "Deploying."


async def test_a_delivery_for_another_repository_is_refused(client, db_session, user_credentials, builds):
    repo = await _app(client, db_session, user_credentials)
    res = await _deliver(client, repo, _push(repository={"id": 1, "full_name": "evil/x"}))
    assert res.status_code == 403
    assert builds == []


async def test_on_actions_the_repositorys_workflow_builds_instead(
    client, db_session, user_credentials, builds, monkeypatch
):
    monkeypatch.setattr(settings, "build_backend", "actions")
    repo = await _app(client, db_session, user_credentials)

    # Never built on Actions yet: the webhook starts the first build.
    assert (await _deliver(client, repo, _push())).json()["message"] == "Deploying."

    db_session.add(Deployment(repository_id=repo.id, user_id=repo.user_id,
                              status=DeploymentStatus.RUNNING, built_on_actions=True))
    await db_session.commit()
    res = await _deliver(client, repo, _push())
    assert "workflow in the repository" in res.json()["message"]
    assert len(builds) == 1


async def test_ensure_creates_then_repoints_the_hook(monkeypatch):
    from types import SimpleNamespace

    from app.github import client as gh

    app_id = uuid.uuid4()
    hooks: list[dict] = []
    sent = []

    async def fake_get(token, path, **params):
        return hooks

    async def fake_send(token, method, path, *, json=None):
        sent.append((method, path, json))
        if method == "POST":
            hooks.append({"id": 7, "active": True, "config": {"url": json["config"]["url"]}})
        return SimpleNamespace(status_code=201)

    monkeypatch.setattr(gh, "_get", fake_get)
    monkeypatch.setattr(gh, "_send", fake_send)

    assert await webhooks.ensure("t", "o/shop", app_id) == "created"
    assert sent[0][2]["config"]["url"] == f"https://demo.ngrok-free.dev/backend/webhooks/github?app={app_id}"
    assert sent[0][2]["config"]["secret"] == SECRET

    # The tunnel address changed: the same hook is re-pointed, not duplicated.
    monkeypatch.setattr(settings, "public_api_url", "https://other.ngrok-free.dev/backend")
    assert await webhooks.ensure("t", "o/shop", app_id) == "updated"
    assert sent[-1][0] == "PATCH" and sent[-1][1] == "/repos/o/shop/hooks/7"


def test_webhooks_need_a_secret_and_a_public_address(monkeypatch):
    assert webhooks.enabled()
    monkeypatch.setattr(settings, "public_api_url", "http://localhost:8000")
    assert not webhooks.enabled()
