"""
GCRA rate limiting: a burst, then a steady rate, enforced atomically.

Time is passed in explicitly, so these tests prove the arithmetic rather than
racing the clock.
"""

from __future__ import annotations

import pytest

from app.core.ratelimit import RateLimitedError, RateLimiter


async def test_a_burst_is_allowed_then_refused():
    limiter = RateLimiter("t", rate=60, period=60, burst=3)  # 1/s, burst 3
    decisions = [await limiter.hit("u", now_ms=1_000_000) for _ in range(4)]
    assert [d.allowed for d in decisions] == [True, True, True, False]


async def test_remaining_counts_down_through_the_burst():
    limiter = RateLimiter("t", rate=60, period=60, burst=3)
    remaining = [(await limiter.hit("u", now_ms=0)).remaining for _ in range(3)]
    assert remaining == [2, 1, 0]


async def test_the_wait_is_exactly_one_interval():
    limiter = RateLimiter("t", rate=60, period=60, burst=1)
    await limiter.hit("u", now_ms=10_000)
    refused = await limiter.hit("u", now_ms=10_000)
    assert not refused.allowed
    assert refused.retry_after == pytest.approx(1.0)


async def test_capacity_refills_at_the_steady_rate():
    limiter = RateLimiter("t", rate=60, period=60, burst=2)
    await limiter.hit("u", now_ms=0)
    await limiter.hit("u", now_ms=0)
    assert not (await limiter.hit("u", now_ms=0)).allowed
    assert (await limiter.hit("u", now_ms=1_000)).allowed  # one interval later


async def test_subjects_are_limited_separately():
    """One student hitting the limit must not lock out another."""
    limiter = RateLimiter("t", rate=60, period=60, burst=1)
    await limiter.hit("alice", now_ms=0)
    assert not (await limiter.hit("alice", now_ms=0)).allowed
    assert (await limiter.hit("bob", now_ms=0)).allowed


async def test_check_raises_a_429_with_retry_after():
    limiter = RateLimiter("t", rate=1, period=3600, burst=1)
    await limiter.check("u")
    with pytest.raises(RateLimitedError) as caught:
        await limiter.check("u")
    assert caught.value.status_code == 429
    assert int(caught.value.headers["Retry-After"]) > 3500
    assert "minute" in caught.value.message


async def test_the_limiter_fails_open_when_redis_is_down(monkeypatch):
    """Refusing everyone because the limiter's store is down protects nothing."""
    from app.core import ratelimit

    class Broken:
        async def eval(self, *args, **kwargs):
            raise ConnectionError("redis is gone")

    monkeypatch.setattr(ratelimit, "get_redis", lambda: Broken())
    limiter = RateLimiter("t", rate=1, period=3600, burst=1)
    assert (await limiter.check("u")).allowed


def test_nonsense_limits_are_refused():
    with pytest.raises(ValueError):
        RateLimiter("t", rate=0, period=60, burst=1)


async def test_deploying_too_fast_is_a_429(client, db_session, user_credentials, monkeypatch):
    """End to end: the build endpoint enforces the deploy limit."""
    import uuid

    from app.core import ratelimit
    from app.models.repository import DetectedType, Repository

    monkeypatch.setattr(ratelimit, "deploy_limiter", RateLimiter("deploy-test", rate=1, period=3600, burst=1))
    from app.api import repository_routes

    monkeypatch.setattr(repository_routes, "deploy_limiter", ratelimit.deploy_limiter)

    res = await client.post("/auth/signup", json=user_credentials)
    headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    user_id = uuid.UUID(res.json()["user"]["id"])
    repo = Repository(
        user_id=user_id, github_repo_id=77, name="r", full_name="o/r",
        default_branch="main", clone_url="https://x", detected_type=DetectedType.DOCKER,
    )
    db_session.add(repo)
    await db_session.commit()

    first = await client.post(f"/repos/{repo.id}/build", headers=headers)
    assert first.status_code == 202
    second = await client.post(f"/repos/{repo.id}/build", headers=headers)
    assert second.status_code == 429
    assert "Retry-After" in second.headers
