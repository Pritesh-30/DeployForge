"""
Workers that run the queue's jobs.

A worker has a fixed number of slots. Each slot takes a job, holds a lease on
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


@dataclass
class JobType:
    run: Handler
    on_dead: DeadHandler | None = None


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
        self.concurrency = max(1, concurrency or settings.build_concurrency)
        self.queue = queue or default_queue
        self.name = name or f"{socket.gethostname()}:{os.getpid()}"
        self.active: dict[int, str] = {}

    async def run(self, stop: asyncio.Event) -> None:
        """Run until `stop` is set. Never raises because of one bad job."""
        logger.info("Worker %s starting with %d slot(s)", self.name, self.concurrency)
        tasks = [
            asyncio.create_task(self._slot(i, stop), name=f"queue-slot-{i}")
            for i in range(self.concurrency)
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
            try:
                for job_id in await self.queue.maintain():
                    await self._dead(job_id)
            except Exception:  # noqa: BLE001
                logger.debug("Queue maintenance failed", exc_info=True)
            await _sleep_or_stop(stop, _MAINTENANCE_SECONDS)

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
