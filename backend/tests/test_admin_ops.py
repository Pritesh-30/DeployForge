"""
The administrator's control room: running anyone's app, suspension that
actually holds, rollback, and an audit trail of every action.

Docker is stubbed to start cleanly; what is under test is what the platform
decides and records.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from app.models.audit import AuditEvent
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.repository import DetectedType, Repository
from app.models.user import User, UserRole


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


async def _admin(client, db_session, creds):
    headers, uid = await _signup(client, creds)
    user = await db_session.get(User, uid)
    user.role = UserRole.ADMIN
    await db_session.commit()
    return headers, uid


async def _app(db_session, owner_id, *, status=DeploymentStatus.BUILT, name="todo") -> tuple[Repository, Deployment]:
    repo = Repository(
        user_id=owner_id, github_repo_id=hash(name) % 10**9, name=name, full_name=f"o/{name}",
        default_branch="main", clone_url="https://x", detected_type=DetectedType.DOCKER,
    )
    db_session.add(repo)
    await db_session.flush()
    dep = Deployment(
        repository_id=repo.id, user_id=owner_id, status=status,
        build_method=BuildMethod.DOCKER, image_ref=f"localhost:5000/df/{name}:abc",
    )
    db_session.add(dep)
    await db_session.commit()
    return repo, dep


async def test_admin_lists_every_app_with_its_owner(client, db_session, user_credentials, admin_credentials):
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    repo, _ = await _app(db_session, student)

    # The suite runs inside the real database, so other apps may be listed
    # too; this one must be, with its owner.
    apps = (await client.get("/admin/apps", headers=admin_headers)).json()
    mine = next(a for a in apps if a["id"] == str(repo.id))
    assert mine["owner_email"] == user_credentials["email"]


async def test_students_cannot_reach_the_control_room(client, user_credentials):
    headers, _ = await _signup(client, user_credentials)
    assert (await client.get("/admin/apps", headers=headers)).status_code == 403
    assert (await client.get("/admin/queue", headers=headers)).status_code == 403
    assert (await client.get("/admin/audit", headers=headers)).status_code == 403


async def test_admin_runs_a_students_app_and_it_is_audited(
    client, db_session, user_credentials, admin_credentials, docker_ok
):
    _, student = await _signup(client, user_credentials)
    admin_headers, admin_id = await _admin(client, db_session, admin_credentials)
    repo, dep = await _app(db_session, student)

    res = await client.post(f"/admin/apps/{repo.id}/start", headers=admin_headers)
    assert res.status_code == 200, res.text
    assert res.json()["current"]["status"] == "running"

    log = (await client.get("/admin/audit", headers=admin_headers)).json()
    entry = log["events"][0]
    assert entry["action"] == "app.start"
    assert entry["actor_email"] == admin_credentials["email"]
    assert entry["subject_user_id"] == str(student)


async def test_admin_start_ignores_the_students_quota(
    client, db_session, user_credentials, admin_credentials, docker_ok
):
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    user = await db_session.get(User, student)
    user.max_deployments = 0
    await db_session.commit()
    repo, _ = await _app(db_session, student)

    assert (await client.post(f"/admin/apps/{repo.id}/start", headers=admin_headers)).status_code == 200


async def test_admin_stops_a_running_app(client, db_session, user_credentials, admin_credentials, docker_ok):
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    repo, dep = await _app(db_session, student, status=DeploymentStatus.RUNNING)
    dep.container_name = "df-x"
    await db_session.commit()

    res = await client.post(f"/admin/apps/{repo.id}/stop", headers=admin_headers)
    assert res.json()["current"]["status"] == "stopped"


async def test_a_suspended_app_cannot_escape_by_redeploying(
    client, db_session, user_credentials, admin_credentials, docker_ok, monkeypatch
):
    """
    The hole this closes: suspension lived on one deployment row, so a
    redeploy produced a fresh row without the flag, which could be started.
    """
    from app.builder import trigger

    async def ok():
        return None

    monkeypatch.setattr(trigger.pack, "check_toolchain", ok)
    student_headers, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    repo, dep = await _app(db_session, student, status=DeploymentStatus.RUNNING)

    res = await client.post(f"/admin/apps/{repo.id}/suspend", json={"reason": "mining crypto"},
                            headers=admin_headers)
    assert res.status_code == 200

    redeploy = await client.post(f"/repos/{repo.id}/build", headers=student_headers)
    assert redeploy.status_code == 409
    assert "mining crypto" in redeploy.json()["error"]["message"]

    # Nor can a *different*, unsuspended deployment of the app be started.
    other = Deployment(repository_id=repo.id, user_id=student, status=DeploymentStatus.BUILT,
                       build_method=BuildMethod.DOCKER, image_ref="localhost:5000/df/todo:def")
    db_session.add(other)
    await db_session.commit()
    start = await client.post(f"/deployments/{other.id}/start", headers=student_headers)
    assert start.status_code >= 400

    # Nor deleted to be re-added clean.
    assert (await client.delete(f"/apps/{repo.id}", headers=student_headers)).status_code == 409


async def test_resuming_lifts_the_suspension_for_the_whole_app(
    client, db_session, user_credentials, admin_credentials, docker_ok
):
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    repo, dep = await _app(db_session, student, status=DeploymentStatus.RUNNING)
    await client.post(f"/admin/apps/{repo.id}/suspend", headers=admin_headers)

    res = await client.post(f"/admin/apps/{repo.id}/resume", headers=admin_headers)
    assert res.status_code == 200
    from app.runtime.service import app_suspension

    assert await app_suspension(db_session, repo.id) is None


async def test_admin_redeploy_queues_a_build_for_the_owner(
    client, db_session, user_credentials, admin_credentials, monkeypatch
):
    from app.builder import trigger
    from app.queue.jobs import build_job_id
    from app.queue.store import queue

    async def ok():
        return None

    monkeypatch.setattr(trigger.pack, "check_toolchain", ok)
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    repo, _ = await _app(db_session, student)

    res = await client.post(f"/admin/apps/{repo.id}/redeploy", headers=admin_headers)
    assert res.status_code == 202
    job = await queue.get(build_job_id(uuid.UUID(res.json()["deployment_id"])))
    # Counted against the *student's* fair share, not the administrator's.
    assert job.tenant == str(student)


async def test_changing_an_account_is_audited_with_what_changed(
    client, db_session, user_credentials, admin_credentials
):
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)

    await client.patch(f"/admin/users/{student}", json={"max_deployments": 7}, headers=admin_headers)
    entry = (await client.get("/admin/audit", headers=admin_headers)).json()["events"][0]
    assert entry["action"] == "user.quota"
    assert entry["detail"] == {"max_deployments": 7}


async def test_the_queue_view_names_students(client, db_session, user_credentials, admin_credentials):
    from app.queue.store import queue

    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    await queue.enqueue(kind="build", tenant=str(student), payload={"deployment_id": str(uuid.uuid4())},
                        job_id="build:x", label="o/todo")

    body = (await client.get("/admin/queue", headers=admin_headers)).json()
    assert body["ring"][0]["email"] == user_credentials["email"]
    assert body["order"] == ["build:x"]


async def test_student_detail_adds_up(client, db_session, user_credentials, admin_credentials):
    _, student = await _signup(client, user_credentials)
    admin_headers, _ = await _admin(client, db_session, admin_credentials)
    await _app(db_session, student, status=DeploymentStatus.RUNNING, name="a")
    await _app(db_session, student, status=DeploymentStatus.FAILED, name="b")

    body = (await client.get(f"/admin/users/{student}", headers=admin_headers)).json()
    assert body["usage"]["apps"] == 2
    assert body["usage"]["running"] == 1
    assert body["usage"]["failed"] == 1


# --- Rollback ---------------------------------------------------------------

async def test_rolling_back_runs_the_earlier_build_and_retires_the_current(
    client, db_session, user_credentials, docker_ok
):
    headers, student = await _signup(client, user_credentials)
    repo, current = await _app(db_session, student, status=DeploymentStatus.RUNNING)
    current.container_name = "df-current"
    current.subdomain = "todo-x"
    earlier = Deployment(repository_id=repo.id, user_id=student, status=DeploymentStatus.STOPPED,
                         build_method=BuildMethod.DOCKER, image_ref="localhost:5000/df/todo:old")
    db_session.add(earlier)
    await db_session.commit()

    res = await client.post(f"/apps/{repo.id}/deployments/{earlier.id}/promote", headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "running"
    await db_session.refresh(current)
    assert current.status is DeploymentStatus.STOPPED


async def test_a_failed_build_cannot_be_rolled_back_to(client, db_session, user_credentials, docker_ok):
    headers, student = await _signup(client, user_credentials)
    repo, _ = await _app(db_session, student, status=DeploymentStatus.RUNNING)
    failed = Deployment(repository_id=repo.id, user_id=student, status=DeploymentStatus.FAILED)
    db_session.add(failed)
    await db_session.commit()

    res = await client.post(f"/apps/{repo.id}/deployments/{failed.id}/promote", headers=headers)
    assert res.status_code == 409
    assert "built successfully" in res.json()["error"]["message"]


async def test_app_detail_reports_build_statistics(client, db_session, user_credentials):
    from datetime import datetime, timedelta, timezone

    headers, student = await _signup(client, user_credentials)
    repo, ok = await _app(db_session, student, status=DeploymentStatus.RUNNING)
    now = datetime.now(timezone.utc)
    ok.build_started_at, ok.build_finished_at = now - timedelta(seconds=90), now
    db_session.add(Deployment(repository_id=repo.id, user_id=student, status=DeploymentStatus.FAILED))
    await db_session.commit()

    stats = (await client.get(f"/apps/{repo.id}", headers=headers)).json()["stats"]
    assert stats["builds"] == 2
    assert stats["success_rate"] == 0.5
    assert stats["build_seconds_median"] == pytest.approx(90, abs=1)
    assert len(stats["daily"]) == 14


async def test_activity_spans_every_app(client, db_session, user_credentials):
    from app.runtime.service import record

    headers, student = await _signup(client, user_credentials)
    _, a = await _app(db_session, student, name="a")
    _, b = await _app(db_session, student, name="b")
    await record(db_session, a.id, "build", "built a")
    await record(db_session, b.id, "start", "started b")

    feed = (await client.get("/apps/activity", headers=headers)).json()
    assert {e["message"] for e in feed} == {"built a", "started b"}
