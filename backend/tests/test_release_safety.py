"""
What happens around a release: environment variables taking effect, builds
going live by themselves, a crashing release being rolled back, and the
progress of a build running in GitHub Actions.

Docker is stubbed; what is under test is what the platform decides.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.builder import stack
from app.ci.progress import summarize
from app.core.crypto import encrypt_value
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.environment import EnvironmentVariable
from app.models.event import DeploymentEvent
from app.models.repository import DetectedType, Repository
from app.models.user import User
from app.services import environment_state as es


@pytest.fixture
def docker_ok(monkeypatch):
    from app.runtime import service as runtime

    async def ok(*a, **k):
        return None

    async def yes(*a, **k):
        return True

    async def exposed(*a, **k):
        return [3000]

    async def run(*a, **k):
        return SimpleNamespace(ok=True, stdout="cafe", message="")

    async def state(*a, **k):
        return {"Running": True, "ExitCode": 0}

    for name, fn in {
        "daemon_available": yes, "ensure_network": ok, "image_exposed_ports": exposed,
        "run_container": run, "container_state": state, "stop_container": ok,
        "remove_container": ok,
    }.items():
        monkeypatch.setattr(runtime.docker, name, fn)
    monkeypatch.setattr(runtime.settings, "app_start_grace_seconds", 0)


async def _signup(client, creds):
    res = await client.post("/auth/signup", json=creds)
    return {"Authorization": f"Bearer {res.json()['access_token']}"}, uuid.UUID(res.json()["user"]["id"])


async def _app(db, owner_id, *, method=BuildMethod.DOCKER, name="todo") -> Repository:
    repo = Repository(
        user_id=owner_id, github_repo_id=uuid.uuid4().int % 10**9, name=name, full_name=f"o/{name}",
        default_branch="main", clone_url="https://x", detected_type=DetectedType.DOCKER,
    )
    db.add(repo)
    await db.commit()
    return repo


async def _deployment(db, repo, *, status, method=BuildMethod.DOCKER, started_ago=None, age=0, **kw) -> Deployment:
    # Explicit, because every row made inside the test's transaction would
    # otherwise share one `now()`, and order matters here.
    kw.setdefault("created_at", datetime.now(timezone.utc) - timedelta(seconds=age))
    dep = Deployment(
        repository_id=repo.id, user_id=repo.user_id, status=status, build_method=method,
        image_ref=f"localhost:5000/df/{repo.name}:{uuid.uuid4().hex[:6]}",
        container_name=f"df-{uuid.uuid4().hex[:8]}", **kw,
    )
    if started_ago is not None:
        dep.runtime_started_at = datetime.now(timezone.utc) - timedelta(seconds=started_ago)
    db.add(dep)
    await db.commit()
    return dep


# --- Environment state ------------------------------------------------------

def test_digest_hides_values_but_shows_changes():
    assert "hunter2" not in str(es.digest({"P": "hunter2"}))
    before = es.digest({"A": "1", "B": "2"})
    assert es.changed_keys(before, {"A": "1", "B": "3", "C": "x"}) == ["B", "C"]
    assert es.changed_keys(before, {"A": "1"}) == ["B"]  # removed counts
    assert es.changed_keys(before, {"A": "1", "B": "2"}) == []


def test_state_says_what_a_change_needs():
    live = SimpleNamespace(runtime_env=es.digest({"API_URL": "a"}), build_method=BuildMethod.DOCKER, id=uuid.uuid4())
    assert es.state_for(None, {"X": "1"}).state == "not_running"
    assert es.state_for(live, {"API_URL": "a"}).state == "in_effect"
    assert es.state_for(live, {"API_URL": "b"}).state == "restart"

    # A Dockerfile build never saw the variable, so a rebuild would not help.
    assert es.state_for(live, {"API_URL": "a", "NEXT_PUBLIC_X": "1"}).state == "restart"

    # A buildpack build inlined NEXT_PUBLIC_*: only a new build carries it.
    live.build_method = BuildMethod.BUILDPACK
    state = es.state_for(live, {"API_URL": "a", "NEXT_PUBLIC_X": "1"})
    assert state.state == "rebuild"
    assert state.build_time == ["NEXT_PUBLIC_X"]


def test_a_generated_stack_takes_the_current_environment():
    text = stack.compose_file(services={"api": "img-a", "web": "img-b"}, env={"OLD": "1"})
    refreshed = stack.with_environment(text, {"NEW": "2"})
    assert '"NEW": "2"' in refreshed
    assert "OLD" not in refreshed
    assert "API_URL" in refreshed  # the wiring survives
    assert stack.with_environment("services:\n  web:\n    image: x\n", {}) is None


async def test_a_start_records_the_environment_it_used(client, db_session, user_credentials, docker_ok):
    from app.runtime import service as runtime

    _, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    db_session.add(EnvironmentVariable(repository_id=repo.id, key="TOKEN", value_enc=encrypt_value("s3cret")))
    await db_session.commit()
    dep = await _deployment(db_session, repo, status=DeploymentStatus.BUILT)

    await runtime.start(db_session, dep, repo, await db_session.get(User, uid))

    assert dep.runtime_env == es.digest({"TOKEN": "s3cret"})
    assert "s3cret" not in str(dep.runtime_env)


async def test_saving_a_variable_then_applying_restarts_with_it(client, db_session, user_credentials, docker_ok):
    headers, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    dep = await _deployment(db_session, repo, status=DeploymentStatus.RUNNING, started_ago=600,
                            runtime_env=es.digest({}))

    await client.put(f"/repos/{repo.id}/env", json={"variables": [{"key": "API_URL", "value": "x"}]}, headers=headers)
    status = (await client.get(f"/apps/{repo.id}/environment/status", headers=headers)).json()
    assert status["state"] == "restart"
    assert status["changed"] == ["API_URL"]

    applied = (await client.post(f"/apps/{repo.id}/environment/apply", headers=headers)).json()
    assert applied["action"] == "restarted"
    assert applied["state"] == "in_effect"

    await db_session.refresh(dep)
    assert dep.runtime_env == es.digest({"API_URL": "x"})


async def test_applying_when_nothing_runs_does_nothing(client, db_session, user_credentials):
    headers, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    applied = (await client.post(f"/apps/{repo.id}/environment/apply", headers=headers)).json()
    assert applied["action"] == "none"
    assert applied["state"] == "not_running"


# --- Going live ---------------------------------------------------------------

async def test_a_finished_build_goes_live_and_replaces_the_old_version(client, db_session, user_credentials, docker_ok):
    from app.runtime import service as runtime

    _, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    old = await _deployment(db_session, repo, status=DeploymentStatus.RUNNING, started_ago=600, age=900)
    new = await _deployment(db_session, repo, status=DeploymentStatus.BUILT)

    assert await runtime.go_live(db_session, new, repo, await db_session.get(User, uid), actor="owner")
    await db_session.refresh(old)
    assert new.status is DeploymentStatus.RUNNING
    assert old.status is DeploymentStatus.STOPPED


async def test_an_overtaken_build_does_not_go_live(client, db_session, user_credentials, docker_ok):
    from app.runtime import service as runtime

    _, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    older = await _deployment(db_session, repo, status=DeploymentStatus.BUILT, age=60)
    await _deployment(db_session, repo, status=DeploymentStatus.BUILDING)

    assert not await runtime.go_live(db_session, older, repo, await db_session.get(User, uid), actor="owner")
    assert older.status is DeploymentStatus.BUILT


# --- Automatic rollback -------------------------------------------------------

async def test_a_release_that_crashes_soon_after_going_live_is_rolled_back(
    client, db_session, user_credentials, docker_ok, monkeypatch
):
    from app.runtime import guardian

    _, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    previous = await _deployment(db_session, repo, status=DeploymentStatus.STOPPED, started_ago=3600, age=7200)
    crashed = await _deployment(db_session, repo, status=DeploymentStatus.RUNNING, started_ago=40)

    async def state(name):
        if name == crashed.container_name:
            return {"Running": False, "ExitCode": 1, "RestartCount": 0}
        return {"Running": True, "ExitCode": 0}

    async def logs(*a, **k):
        return "Error: DATABASE_URL is not set"

    monkeypatch.setattr(guardian.docker, "container_state", state)
    monkeypatch.setattr(guardian.docker, "container_logs", logs)

    assert await guardian.rollback(db_session, crashed)

    await db_session.refresh(crashed)
    await db_session.refresh(previous)
    assert previous.status is DeploymentStatus.RUNNING
    assert crashed.status is DeploymentStatus.FAILED
    assert "put back automatically" in crashed.error_message

    messages = [e.message for e in (await db_session.execute(
        DeploymentEvent.__table__.select().where(DeploymentEvent.deployment_id == crashed.id)
    )).all()]
    assert any("DATABASE_URL" in m for m in messages)

    # It does not happen twice for the same release.
    assert not await guardian.rollback(db_session, crashed)


async def test_a_crash_with_nothing_to_return_to_is_only_recorded(
    client, db_session, user_credentials, docker_ok, monkeypatch
):
    from app.runtime import guardian

    _, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    only = await _deployment(db_session, repo, status=DeploymentStatus.RUNNING, started_ago=40)

    async def state(name):
        return {"Running": False, "ExitCode": 1}

    monkeypatch.setattr(guardian.docker, "container_state", state)
    assert not await guardian.rollback(db_session, only)


async def test_crash_detection():
    from app.runtime import guardian

    async def fake(state):
        guardian.docker.container_state = lambda name: _value(state)
        return await guardian.crashed(SimpleNamespace(container_name="c"))

    original = guardian.docker.container_state
    try:
        assert await fake({"Running": True, "RestartCount": 0}) is None
        assert "exit code 137" in await fake({"Running": False, "ExitCode": 137})
        assert "kept crashing" in await fake({"Running": True, "Restarting": True, "RestartCount": 3})
        assert await fake(None) is None
    finally:
        guardian.docker.container_state = original


async def _value(v):
    return v


# --- GitHub Actions progress --------------------------------------------------

def test_actions_steps_are_summarized_without_githubs_bookkeeping():
    run = {"status": "in_progress", "conclusion": None, "html_url": "https://github.com/o/r/actions/runs/1"}
    jobs = [{"steps": [
        {"number": 1, "name": "Set up job", "status": "completed", "conclusion": "success"},
        {"number": 2, "name": "Check out", "status": "completed", "conclusion": "success"},
        {"number": 3, "name": "Build image", "status": "in_progress", "conclusion": None},
        {"number": 4, "name": "Push", "status": "queued", "conclusion": None},
        {"number": 5, "name": "Post Check out", "status": "queued", "conclusion": None},
    ]}]
    out = summarize(run, jobs)
    assert [s["name"] for s in out["steps"]] == ["Check out", "Build image", "Push"]
    assert out["completed"] == 1 and out["total"] == 3
    assert out["current"] == "Build image"


async def test_progress_before_github_picks_the_run_up_is_empty(client, db_session, user_credentials):
    headers, uid = await _signup(client, user_credentials)
    repo = await _app(db_session, uid)
    dep = await _deployment(db_session, repo, status=DeploymentStatus.QUEUED, ci_trigger="dashboard")
    body = (await client.get(f"/deployments/{dep.id}/ci-progress", headers=headers)).json()
    assert body["steps"] == [] and body["status"] is None
