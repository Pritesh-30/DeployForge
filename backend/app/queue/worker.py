"""
Workers that run the queue's jobs.

A worker opens up to `build_concurrency_max` slots, and how many of them may
take work is read from the queue on every pass — so an administrator raising
or lowering "builds at once" takes effect within seconds, without a restart.
Lowering it never stops a running build: the slots above the new limit finish
what they hold and then stay idle. Each slot takes a job, holds a lease on
it while it runs and renews the lease on a heartbeat, then reports how it
ended. If the process dies, the heartbeat stops, the lease lapses, and the
maintenance loop of any surviving worker — or this one, once it is back —
puts the job back on the queue. A build interrupted by a restart is therefore
picked up again, instead of being left for the student to notice and redo.

What happens when a job fails depends on why:

  * the handler raised something `is_transient` (the network, GitHub's 5xx,
    a Docker daemon that did not answer) and attempts remain: it is retried
    after an exponential, jittered backoff;
  * anything else, or the last attempt: it is finished as failed. The handler
    is expected to have recorded *why* on the thing it was working on; the
    queue only records that it ended.

Run standalone with `python -m app.worker`, or embedded in the API process
(the default for a single machine; see `WORKER_EMBEDDED`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.config import settings
from app.core.errors import is_transient
from app.queue.fairness import backoff_delay
from app.queue.store import Job, JobQueue, queue as default_queue

logger = logging.getLogger(__name__)

# How long an idle slot waits before looking again. Builds take minutes, so a
# second of latency before one starts is invisible.
_IDLE_SECONDS = 1.0
_MAINTENANCE_SECONDS = 5.0
_LIMIT_TTL_SECONDS = 2.0
# A worker refreshes its "alive" key every maintenance pass; three missed
# passes and its leases are treated as orphaned.
_ALIVE_TTL_SECONDS = int(_MAINTENANCE_SECONDS * 3)


@dataclass
class JobContext:
    """What a handler may want to know about the attempt it is running."""

    job: Job
    queue: JobQueue

    @property
    def attempt(self) -> int:
        return self.job.attempts

    @property
    def is_final_attempt(self) -> bool:
        return self.job.attempts >= self.job.max_attempts

    async def cancel_requested(self) -> bool:
        current = await self.queue.get(self.job.id)
        return bool(current and current.cancel_requested)


Handler = Callable[[Job, JobContext], Awaitable[None]]
# Called when a job is given up on without its handler finishing it — the
# worker died too many times — so the owner can be told.
DeadHandler = Callable[[Job, str], Awaitable[None]]
# Called when a job whose worker died is put back in line, so what the owner
# sees can say "waiting to resume" instead of "building" with nothing behind it.
ReclaimedHandler = Callable[[Job], Awaitable[None]]


@dataclass
class JobType:
    run: Handler
    on_dead: DeadHandler | None = None
    on_reclaimed: ReclaimedHandler | None = None


class Worker:
    """A pool of slots consuming one queue."""

    def __init__(
        self,
        handlers: dict[str, JobType],
        *,
        concurrency: int | None = None,
        queue: JobQueue | None = None,
        name: str | None = None,
    ) -> None:
        self.handlers = handlers
        # A fixed number (tests, or a deliberately pinned worker) or, by
        # default, whatever limit the queue currently holds.
        self.fixed = max(1, concurrency) if concurrency else None
        self.slots = self.fixed or max(1, settings.build_concurrency_max)
        self.queue = queue or default_queue
        self.name = name or f"{socket.gethostname()}:{os.getpid()}"
        self.active: dict[int, str] = {}
        self._limit = (0.0, self.fixed or settings.build_concurrency)

    async def limit(self) -> int:
        """The current limit, read at most every couple of seconds."""
        if self.fixed:
            return self.fixed
        read_at, value = self._limit
        if time.monotonic() - read_at > _LIMIT_TTL_SECONDS:
            try:
                value = await self.queue.concurrency()
            except Exception:  # noqa: BLE001 — keep the last known limit
                logger.debug("Could not read the concurrency limit", exc_info=True)
            self._limit = (time.monotonic(), value)
        return value

    async def run(self, stop: asyncio.Event) -> None:
        """Run until `stop` is set. Never raises because of one bad job."""
        logger.info("Worker %s starting: %d build(s) at once, up to %d",
                    self.name, await self.limit(), self.slots)
        # Alive before the first job is taken, so no other worker mistakes
        # this one's fresh leases for orphans.
        try:
            await self.queue.mark_alive(self.name, ttl_seconds=_ALIVE_TTL_SECONDS)
        except Exception:  # noqa: BLE001 — Redis down: the slots will wait too
            logger.debug("Could not mark the worker alive", exc_info=True)
        tasks = [
            asyncio.create_task(self._slot(i, stop), name=f"queue-slot-{i}")
            for i in range(self.slots)
        ]
        tasks.append(asyncio.create_task(self._maintenance(stop), name="queue-maintenance"))
        try:
            await stop.wait()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.info("Worker %s stopped", self.name)

    async def _slot(self, index: int, stop: asyncio.Event) -> None:
        slot_name = f"{self.name}/{index}"
        while not stop.is_set():
            if index >= await self.limit():
                # Above the limit: stay idle until an administrator raises it.
                await _sleep_or_stop(stop, _IDLE_SECONDS)
                continue
            try:
                job = await self.queue.dequeue(slot_name)
            except Exception:  # noqa: BLE001 — Redis down: wait and try again
                logger.warning("Could not read the queue", exc_info=True)
                await _sleep_or_stop(stop, _IDLE_SECONDS * 5)
                continue

            if job is None:
                await _sleep_or_stop(stop, _IDLE_SECONDS)
                continue

            self.active[index] = job.id
            try:
                await self.run_job(job, slot_name)
            finally:
                self.active.pop(index, None)

    async def run_job(self, job: Job, worker: str) -> None:
        """Run one leased job to an outcome. Public so tests can drive it."""
        job_type = self.handlers.get(job.kind)
        if job_type is None:
            logger.error("No handler for job kind %r (%s)", job.kind, job.id)
            await self.queue.complete(job.id, worker, state="failed",
                                      error=f"Unknown job kind {job.kind!r}")
            return

        lost = asyncio.Event()
        heartbeat = asyncio.create_task(self._heartbeat(job.id, worker, lost))
        context = JobContext(job=job, queue=self.queue)
        try:
            await job_type.run(job, context)
        except asyncio.CancelledError:
            # The worker is stopping. Leave the lease to lapse so the job is
            # reclaimed and rerun rather than recorded as failed.
            raise
        except Exception as exc:  # noqa: BLE001 — every job must end somewhere
            await self._failed(job, worker, exc)
            return
        finally:
            heartbeat.cancel()

        if lost.is_set():
            logger.warning("Lost the lease on %s while running it", job.id)
            return
        await self.queue.complete(job.id, worker, state="done")

    async def _failed(self, job: Job, worker: str, exc: Exception) -> None:
        message = f"{type(exc).__name__}: {exc}"
        if is_transient(exc) and job.attempts < job.max_attempts:
            delay = backoff_delay(
                job.attempts,
                base=settings.queue_backoff_base_seconds,
                cap=settings.queue_backoff_cap_seconds,
            )
            logger.info("Retrying %s in %.1fs after: %s", job.id, delay, message)
            await self.queue.retry(job.id, worker, delay_seconds=delay, error=message)
            return
        logger.warning("Job %s failed: %s", job.id, message)
        await self.queue.complete(job.id, worker, state="failed", error=message)

    async def _heartbeat(self, job_id: str, worker: str, lost: asyncio.Event) -> None:
        interval = max(1.0, settings.queue_lease_seconds / 3)
        while True:
            await asyncio.sleep(interval)
            try:
                if not await self.queue.heartbeat(job_id, worker):
                    lost.set()
                    return
            except Exception:  # noqa: BLE001 — a missed beat is not fatal
                logger.debug("Heartbeat failed for %s", job_id, exc_info=True)

    async def _maintenance(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.maintain_once()
            await _sleep_or_stop(stop, _MAINTENANCE_SECONDS)

    async def maintain_once(self) -> None:
        """One pass: stay alive, reclaim orphans, promote retries."""
        try:
            await self.queue.mark_alive(self.name, ttl_seconds=_ALIVE_TTL_SECONDS)
            orphans = await self.queue.expire_orphans()
            if orphans:
                logger.info("Reclaiming %d build(s) whose worker stopped: %s", len(orphans), orphans)
            dead, reclaimed = await self.queue.maintain_detailed()
        except Exception:  # noqa: BLE001
            logger.debug("Queue maintenance failed", exc_info=True)
            return
        for job_id in dead:
            await self._dead(job_id)
        for job_id in reclaimed:
            await self._reclaimed(job_id)

    async def _reclaimed(self, job_id: str) -> None:
        job = await self.queue.get(job_id)
        if job is None:
            return
        job_type = self.handlers.get(job.kind)
        if job_type and job_type.on_reclaimed:
            try:
                await job_type.on_reclaimed(job)
            except Exception:  # noqa: BLE001
                logger.exception("on_reclaimed handler failed for %s", job_id)

    async def _dead(self, job_id: str) -> None:
        job = await self.queue.get(job_id)
        if job is None:
            return
        job_type = self.handlers.get(job.kind)
        if job_type and job_type.on_dead:
            try:
                await job_type.on_dead(job, job.error)
            except Exception:  # noqa: BLE001
                logger.exception("on_dead handler failed for %s", job_id)


async def _sleep_or_stop(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
