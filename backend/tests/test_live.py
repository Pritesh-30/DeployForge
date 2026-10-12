"""Live updates: a recorded step reaches the owner's open console at once."""

from __future__ import annotations

import asyncio
import json
import uuid

from app.core.redis import get_redis
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.repository import DetectedType, Repository
from app.runtime import live
from app.runtime import service as runtime


async def test_a_published_change_is_streamed():
    async def connected():
        return False

    events = live.stream(live.user_channel("u1"), connected)
    assert (await events.__anext__()).startswith("event: ready")

    async def later():
        await asyncio.sleep(0.2)
        await live.publish(user_id="u1", app_id=uuid.uuid4(), deployment_id=uuid.uuid4(), status="building")

    asyncio.create_task(later())
    message = await asyncio.wait_for(events.__anext__(), timeout=5)
    assert message.startswith("event: change")
    assert json.loads(message.split("data: ", 1)[1])["status"] == "building"
    await events.aclose()


async def test_recording_a_step_announces_it(client, db_session, user_credentials):
    res = await client.post("/auth/signup", json=user_credentials)
    uid = uuid.UUID(res.json()["user"]["id"])
    repo = Repository(user_id=uid, github_repo_id=7, name="a", full_name="o/a", default_branch="main",
                      clone_url="https://x", detected_type=DetectedType.DOCKER)
    db_session.add(repo)
    await db_session.flush()
    dep = Deployment(repository_id=repo.id, user_id=uid, status=DeploymentStatus.BUILDING,
                     build_method=BuildMethod.DOCKER)
    db_session.add(dep)
    await db_session.commit()

    pubsub = get_redis().pubsub()
    await pubsub.subscribe(live.user_channel(uid))
    await pubsub.get_message(timeout=1)  # the subscribe confirmation

    await runtime.record(db_session, dep.id, "build", "Building.")

    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=2)
    notice = json.loads(message["data"])
    assert notice == {**notice, "app_id": str(repo.id), "deployment_id": str(dep.id), "status": "building", "stage": "build"}
    await pubsub.aclose()


async def test_the_live_stream_needs_a_login(client):
    assert (await client.get("/live")).status_code == 401
