"""
The build queue: fairness, durability, and retrying only what can be fixed by
retrying.

The scheduling arithmetic is tested against a brute-force simulation over
many random queues, because "fair" is easy to claim and easy to get subtly
wrong. The Redis side runs on fakeredis with Lua, so the atomic scripts are
the ones production runs.
"""

from __future__ import annotations

import asyncio
import random

import pytest

from app.core.errors import AppError
from app.queue import fairness
from app.queue.store import JobQueue
from app.queue.worker import JobType, Worker


# --- Fair share -------------------------------------------------------------

def test_round_robin_interleaves_tenants():
    """
    The problem this solves: one student's ten pushes must not make everyone
    else wait for all ten.
    """
    order = fairness.dispatch_order(
        ["alice", "bob", "carol"],
        {"alice": ["a1", "a2", "a3", "a4"], "bob": ["b1"], "carol": ["c1", "c2"]},
    )
    assert order == ["a1", "b1", "c1", "a2", "c2", "a3", "a4"]


def test_a_tenant_with_many_jobs_cannot_starve_one_with_few():
    queues = {"heavy": [f"h{i}" for i in range(50)], "light": ["l1"]}
    order = fairness.dispatch_order(["heavy", "light"], queues)
    assert order.index("l1") == 1


@pytest.mark.parametrize("seed", range(40))
def test_position_formula_matches_simulation(seed):
    """The O(tenants) formula agrees with simulating the whole queue."""
    rng = random.Random(seed)
    ring = [f"t{i}" for i in range(rng.randint(1, 7))]
    queues = {t: [f"{t}-{j}" for j in range(rng.randint(1, 9))] for t in ring}
    order = fairness.dispatch_order(ring, queues)
    lengths = {t: len(q) for t, q in queues.items()}

    for tenant, jobs in queues.items():
        for index, job in enumerate(jobs):
            assert fairness.queue_position(ring, lengths, tenant, index) == order.index(job)


def test_position_rejects_nonsense():
    with pytest.raises(ValueError):
        fairness.queue_position(["a"], {"a": 1}, "b", 0)
    with pytest.raises(ValueError):
        fairness.queue_position(["a"], {"a": 1}, "a", -1)


# --- Backoff ----------------------------------------------------------------

def test_backoff_grows_exponentially_up_to_the_cap():
    class Max(random.Random):
        def uniform(self, a, b):  # the ceiling itself
            return b

    rng = Max()
    delays = [fairness.backoff_delay(n, base=5, cap=60, rng=rng) for n in range(1, 7)]
    assert delays == [5, 10, 20, 40, 60, 60]


def test_backoff_is_jittered_below_the_ceiling():
    """Jobs that failed together must not all retry at the same instant."""
    rng = random.Random(1)
    samples = {round(fairness.backoff_delay(3, base=5, cap=60, rng=rng), 3) for _ in range(50)}
    assert len(samples) > 40
    assert all(0 <= s <= 20 for s in samples)


def test_no_delay_before_the_first_attempt():
    assert fairness.backoff_delay(0, base=5, cap=60) == 0.0


# --- The Redis store --------------------------------------------------------

async def test_dequeue_is_fair_across_tenants():
    q = JobQueue()
    for i in range(3):
        await q.enqueue(kind="build", tenant="alice", payload={}, job_id=f"a{i}")
    await q.enqueue(kind="build", tenant="bob", payload={}, job_id="b0")

    taken = [(await q.dequeue("w")).id for _ in range(4)]
    assert taken == ["a0", "b0", "a1", "a2"]
    assert await q.dequeue("w") is None


async def test_enqueue_is_idempotent_while_the_job_is_live():
    """A double-clicked Deploy button must not build the same thing twice."""
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="same")
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="same")

    assert (await q.dequeue("w")).id == "same"
    assert await q.dequeue("w") is None


async def test_a_job_is_leased_to_exactly_one_worker():
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="j")

    first, second = await asyncio.gather(q.dequeue("w1"), q.dequeue("w2"))
    taken = [j for j in (first, second) if j is not None]
    assert len(taken) == 1
    assert taken[0].state == "running"
    assert taken[0].attempts == 1


async def test_a_dead_workers_job_goes_back_to_the_front_of_its_queue():
    """
    The failure this replaces: a build interrupted by a restart was marked
    failed and the student had to notice and press Rebuild.
    """
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="first")
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="second")
    await q.dequeue("doomed", lease_seconds=0)  # lease lapses immediately

    assert await q.maintain() == []
    job = await q.get("first")
    assert job.state == "pending"
    assert (await q.dequeue("survivor")).id == "first", "lost its place in line"


async def test_a_job_whose_worker_keeps_dying_is_given_up_on():
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="j", max_attempts=2)

    await q.dequeue("w", lease_seconds=0)
    assert await q.maintain() == []
    await q.dequeue("w", lease_seconds=0)
    assert await q.maintain() == ["j"]
    assert (await q.get("j")).state == "failed"


async def test_heartbeat_keeps_a_lease_and_detects_losing_it():
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="j")
    await q.dequeue("w")

    assert await q.heartbeat("j", "w") is True
    assert await q.heartbeat("j", "someone-else") is False


async def test_a_worker_cannot_complete_a_job_it_no_longer_holds():
    """After a lease lapses and the job is reclaimed, the old worker's late
    report must not overwrite the new attempt."""
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="j")
    await q.dequeue("old", lease_seconds=0)
    await q.maintain()
    await q.dequeue("new")

    assert await q.complete("j", "old") is False
    assert (await q.get("j")).state == "running"
    assert await q.complete("j", "new") is True
    assert (await q.get("j")).state == "done"


async def test_a_retry_waits_and_then_rejoins_the_queue():
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="j")
    await q.dequeue("w")
    await q.retry("j", "w", delay_seconds=0, error="network")

    assert (await q.get("j")).state == "delayed"
    await q.maintain()
    job = await q.dequeue("w")
    assert job.id == "j"
    assert job.attempts == 2


async def test_cancelling_a_waiting_job_removes_it():
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="j")
    assert await q.cancel("j") == "pending"

    assert (await q.get("j")).state == "cancelled"
    assert await q.dequeue("w") is None
    snapshot = await q.snapshot()
    assert snapshot.ring == []


async def test_queue_position_is_reported_fairly():
    q = JobQueue()
    for i in range(3):
        await q.enqueue(kind="build", tenant="alice", payload={}, job_id=f"a{i}")
    await q.enqueue(kind="build", tenant="bob", payload={}, job_id="b0")

    # Bob's only job is second, not fourth — that is the fairness, made visible.
    assert await q.position("b0") == (1, 4)
    assert await q.position("a2") == (3, 4)


async def test_snapshot_describes_the_whole_queue():
    q = JobQueue()
    await q.enqueue(kind="build", tenant="alice", payload={}, job_id="a0", label="alice/app")
    await q.enqueue(kind="build", tenant="bob", payload={}, job_id="b0")
    await q.dequeue("w")

    snapshot = await q.snapshot()
    assert [j.id for j in snapshot.running] == ["a0"]
    assert snapshot.running[0].label == "alice/app"
    assert [j.id for j in snapshot.pending["bob"]] == ["b0"]
    assert snapshot.stats["enqueued"] == 2


# --- The worker -------------------------------------------------------------

async def _one(worker: Worker, q: JobQueue) -> None:
    job = await q.dequeue("w")
    await worker.run_job(job, "w")


async def test_a_successful_job_is_done():
    q = JobQueue()
    seen = []

    async def run(job, ctx):
        seen.append(job.payload["n"])

    worker = Worker({"build": JobType(run=run)}, queue=q)
    await q.enqueue(kind="build", tenant="t", payload={"n": 7}, job_id="j")
    await _one(worker, q)

    assert seen == [7]
    assert (await q.get("j")).state == "done"


async def test_a_transient_failure_is_retried():
    q = JobQueue()

    async def run(job, ctx):
        raise AppError("GitHub returned 502", transient=True)

    worker = Worker({"build": JobType(run=run)}, queue=q)
    await q.enqueue(kind="build", tenant="t", payload={}, job_id="j", max_attempts=3)
    await _one(worker, q)

    job = await q.get("j")
    assert job.state == "delayed"
    assert "502" in job.error


async def test_a_project_failure_is_not_retried():
    """A build that fails because of the student's code fails once."""
    q = JobQueue()

    async def run(job, ctx):
        raise AppError("Cannot find module 'react'")

    worker = Worker({"build": JobType(run=run)}, queue=q)
    await q.enqueue(kind="build", tenant="t", payload={}, job_id="j", max_attempts=3)
    await _one(worker, q)

    assert (await q.get("j")).state == "failed"


async def test_the_last_attempt_is_not_retried_even_if_transient():
    q = JobQueue()

    async def run(job, ctx):
        raise AppError("still down", transient=True)

    worker = Worker({"build": JobType(run=run)}, queue=q)
    await q.enqueue(kind="build", tenant="t", payload={}, job_id="j", max_attempts=1)
    await _one(worker, q)

    assert (await q.get("j")).state == "failed"


async def test_the_handler_is_told_when_it_is_on_its_last_attempt():
    q = JobQueue()
    finals = []

    async def run(job, ctx):
        finals.append(ctx.is_final_attempt)
        raise AppError("down", transient=True)

    worker = Worker({"build": JobType(run=run)}, queue=q)
    await q.enqueue(kind="build", tenant="t", payload={}, job_id="j", max_attempts=2)
    await _one(worker, q)
    await q.maintain()  # zero-ish backoff is not guaranteed; force the retry due
    await q.redis.zadd("df:q:delayed", {"j": 0})
    await q.maintain()
    await _one(worker, q)

    assert finals == [False, True]


async def test_an_unknown_job_kind_fails_rather_than_looping():
    q = JobQueue()
    worker = Worker({}, queue=q)
    await q.enqueue(kind="mystery", tenant="t", payload={}, job_id="j")
    await _one(worker, q)
    assert (await q.get("j")).state == "failed"


async def test_a_running_worker_drains_the_queue_and_stops_cleanly():
    q = JobQueue()
    done = asyncio.Event()
    count = 0

    async def run(job, ctx):
        nonlocal count
        count += 1
        if count == 3:
            done.set()

    worker = Worker({"build": JobType(run=run)}, queue=q, concurrency=2)
    for i in range(3):
        await q.enqueue(kind="build", tenant=f"t{i % 2}", payload={}, job_id=f"j{i}")

    stop = asyncio.Event()
    runner = asyncio.create_task(worker.run(stop))
    await asyncio.wait_for(done.wait(), timeout=10)
    stop.set()
    await asyncio.wait_for(runner, timeout=10)

    for i in range(3):
        assert (await q.get(f"j{i}")).state == "done"
