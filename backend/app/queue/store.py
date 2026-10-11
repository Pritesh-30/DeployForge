"""
A durable, fair job queue on Redis.

Layout (every key under the configured namespace):

    q:ring          LIST  tenants that have pending work, in service order
    q:ringset       SET   the same tenants, for O(1) membership
    q:t:<tenant>    LIST  that tenant's pending job ids, oldest first
    q:job:<id>      HASH  one job: kind, payload, attempts, state, timestamps
    q:lease         ZSET  running job -> lease deadline (ms)
    q:delayed       ZSET  job waiting to retry -> when it may run (ms)
    q:recent        LIST  finished job ids, newest first, capped
    q:stats         HASH  lifetime counters

States: pending -> running -> done | failed | cancelled, with
running -> delayed -> pending for a retry, and running -> pending when a
lease lapses because the worker holding it died.

Every transition is a single Lua script, so it is atomic: two workers can
never take the same job, and a crash between two commands can never leave a
job in neither place. That is the whole reason this is not five lines of
LPUSH/BRPOP — those lose the job if the worker dies after popping it.

Fair dispatch across tenants is explained in `fairness.py`.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import redis.asyncio as aioredis

from app.config import settings
from app.core.redis import get_redis
from app.queue.fairness import dispatch_order, queue_position

# How many finished jobs to keep for the admin view.
RECENT_LIMIT = 200
# How long a finished job's record survives, for the deployment page to read.
FINISHED_TTL_SECONDS = 7 * 24 * 3600

_ENQUEUE = """
local p, id, tenant = ARGV[1], ARGV[2], ARGV[3]
local jk = p .. ':q:job:' .. id
local state = redis.call('HGET', jk, 'state')
if state == 'pending' or state == 'running' or state == 'delayed' then
  return 0
end
redis.call('DEL', jk)
redis.call('HSET', jk,
  'id', id, 'tenant', tenant, 'kind', ARGV[5], 'payload', ARGV[6],
  'attempts', 0, 'max_attempts', ARGV[7], 'enqueued_at', ARGV[4],
  'state', 'pending', 'label', ARGV[8])
redis.call('RPUSH', p .. ':q:t:' .. tenant, id)
if redis.call('SADD', p .. ':q:ringset', tenant) == 1 then
  redis.call('RPUSH', p .. ':q:ring', tenant)
end
redis.call('HINCRBY', p .. ':q:stats', 'enqueued', 1)
return 1
"""

_DEQUEUE = """
local p, now, lease, worker = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
local ring = p .. ':q:ring'
local n = redis.call('LLEN', ring)
for i = 1, n do
  local tenant = redis.call('LPOP', ring)
  if not tenant then return false end
  local tq = p .. ':q:t:' .. tenant
  local id = redis.call('LPOP', tq)
  if redis.call('LLEN', tq) > 0 then
    redis.call('RPUSH', ring, tenant)
  else
    redis.call('SREM', p .. ':q:ringset', tenant)
  end
  if id then
    local jk = p .. ':q:job:' .. id
    if redis.call('HGET', jk, 'state') == 'pending' then
      redis.call('HSET', jk, 'state', 'running', 'started_at', now, 'worker', worker)
      redis.call('HINCRBY', jk, 'attempts', 1)
      redis.call('ZADD', p .. ':q:lease', now + lease, id)
      return id
    end
  end
end
return false
"""

_HEARTBEAT = """
local p, id, worker, deadline = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local jk = p .. ':q:job:' .. id
if redis.call('HGET', jk, 'state') ~= 'running' then return 0 end
if redis.call('HGET', jk, 'worker') ~= worker then return 0 end
redis.call('ZADD', p .. ':q:lease', deadline, id)
return 1
"""

# Shared by every path that ends a job, so finishing is recorded one way.
_FINISH_FN = """
local function finish(p, id, now, state, err)
  local jk = p .. ':q:job:' .. id
  redis.call('ZREM', p .. ':q:lease', id)
  redis.call('HSET', jk, 'state', state, 'finished_at', now, 'error', err)
  redis.call('EXPIRE', jk, %(ttl)d)
  redis.call('LPUSH', p .. ':q:recent', id)
  local dropped = redis.call('LRANGE', p .. ':q:recent', %(limit)d, -1)
  for _, old in ipairs(dropped) do
    local s = redis.call('HGET', p .. ':q:job:' .. old, 'state')
    if s == 'done' or s == 'failed' or s == 'cancelled' then
      redis.call('DEL', p .. ':q:job:' .. old)
    end
  end
  redis.call('LTRIM', p .. ':q:recent', 0, %(limit)d - 1)
  redis.call('HINCRBY', p .. ':q:stats', state, 1)
end
""" % {"ttl": FINISHED_TTL_SECONDS, "limit": RECENT_LIMIT}

_COMPLETE = _FINISH_FN + """
local p, id, worker, now, state, err = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6]
local jk = p .. ':q:job:' .. id
if redis.call('HGET', jk, 'worker') ~= worker then return 0 end
if redis.call('HGET', jk, 'state') ~= 'running' then return 0 end
finish(p, id, now, state, err)
return 1
"""

_RETRY = """
local p, id, worker, run_at, err = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
local jk = p .. ':q:job:' .. id
if redis.call('HGET', jk, 'worker') ~= worker then return 0 end
if redis.call('HGET', jk, 'state') ~= 'running' then return 0 end
redis.call('ZREM', p .. ':q:lease', id)
redis.call('HSET', jk, 'state', 'delayed', 'error', err, 'run_at', run_at, 'worker', '')
redis.call('ZADD', p .. ':q:delayed', run_at, id)
redis.call('HINCRBY', p .. ':q:stats', 'retried', 1)
return 1
"""

_MAINTAIN = _FINISH_FN + """
local p, now = ARGV[1], tonumber(ARGV[2])
local function ring_add(tenant)
  if redis.call('SADD', p .. ':q:ringset', tenant) == 1 then
    redis.call('RPUSH', p .. ':q:ring', tenant)
  end
end

-- Retries whose wait is over join the back of their tenant's queue.
local due = redis.call('ZRANGEBYSCORE', p .. ':q:delayed', '-inf', now, 'LIMIT', 0, 100)
for _, id in ipairs(due) do
  redis.call('ZREM', p .. ':q:delayed', id)
  local jk = p .. ':q:job:' .. id
  if redis.call('HGET', jk, 'state') == 'delayed' then
    local tenant = redis.call('HGET', jk, 'tenant')
    redis.call('HSET', jk, 'state', 'pending')
    redis.call('RPUSH', p .. ':q:t:' .. tenant, id)
    ring_add(tenant)
  end
end

-- A lapsed lease means the worker died mid-job. The job goes back to the
-- *front* of its tenant's queue: it already had its turn, and losing its
-- place because a machine fell over would be unfair. Out of attempts, it
-- is given up on and reported so its owner can be told.
local dead = {}
local expired = redis.call('ZRANGEBYSCORE', p .. ':q:lease', '-inf', now, 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  local jk = p .. ':q:job:' .. id
  local attempts = tonumber(redis.call('HGET', jk, 'attempts') or '0')
  local max = tonumber(redis.call('HGET', jk, 'max_attempts') or '1')
  if attempts >= max then
    finish(p, id, now, 'failed', 'The worker running this job stopped responding.')
    table.insert(dead, id)
  else
    redis.call('ZREM', p .. ':q:lease', id)
    local tenant = redis.call('HGET', jk, 'tenant')
    redis.call('HSET', jk, 'state', 'pending', 'worker', '')
    redis.call('LPUSH', p .. ':q:t:' .. tenant, id)
    ring_add(tenant)
    redis.call('HINCRBY', p .. ':q:stats', 'reclaimed', 1)
  end
end
return dead
"""

_CANCEL = _FINISH_FN + """
local p, id, now = ARGV[1], ARGV[2], ARGV[3]
local jk = p .. ':q:job:' .. id
local state = redis.call('HGET', jk, 'state')
if not state then return false end
if state == 'pending' then
  local tenant = redis.call('HGET', jk, 'tenant')
  local tq = p .. ':q:t:' .. tenant
  redis.call('LREM', tq, 0, id)
  if redis.call('LLEN', tq) == 0 then
    redis.call('SREM', p .. ':q:ringset', tenant)
    redis.call('LREM', p .. ':q:ring', 0, tenant)
  end
  finish(p, id, now, 'cancelled', '')
elseif state == 'delayed' then
  redis.call('ZREM', p .. ':q:delayed', id)
  finish(p, id, now, 'cancelled', '')
elseif state == 'running' then
  -- A running job cannot be pulled out from under its worker; it is asked to
  -- stop and checks between steps.
  redis.call('HSET', jk, 'cancel_requested', '1')
end
return state
"""


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Job:
    """One job as stored."""

    id: str
    kind: str
    tenant: str
    payload: dict[str, Any]
    state: str
    attempts: int = 0
    max_attempts: int = 1
    label: str = ""
    enqueued_at: int | None = None
    started_at: int | None = None
    finished_at: int | None = None
    run_at: int | None = None
    worker: str = ""
    error: str = ""
    cancel_requested: bool = False

    @classmethod
    def from_hash(cls, data: dict[str, str]) -> "Job":
        def as_int(name: str) -> int | None:
            value = data.get(name)
            try:
                return int(float(value)) if value not in (None, "") else None
            except ValueError:
                return None

        try:
            payload = json.loads(data.get("payload") or "{}")
        except ValueError:
            payload = {}
        return cls(
            id=data.get("id", ""),
            kind=data.get("kind", ""),
            tenant=data.get("tenant", ""),
            payload=payload,
            state=data.get("state", ""),
            attempts=as_int("attempts") or 0,
            max_attempts=as_int("max_attempts") or 1,
            label=data.get("label", ""),
            enqueued_at=as_int("enqueued_at"),
            started_at=as_int("started_at"),
            finished_at=as_int("finished_at"),
            run_at=as_int("run_at"),
            worker=data.get("worker", ""),
            error=data.get("error", ""),
            cancel_requested=data.get("cancel_requested") == "1",
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "tenant": self.tenant,
            "label": self.label,
            "state": self.state,
            "attempts": self.attempts,
            "max_attempts": self.max_attempts,
            "enqueued_at": self.enqueued_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "run_at": self.run_at,
            "worker": self.worker,
            "error": self.error,
            "payload": self.payload,
        }


@dataclass
class QueueSnapshot:
    """The whole queue at one moment, for the admin view."""

    ring: list[str]
    pending: dict[str, list[Job]]
    running: list[Job]
    delayed: list[Job]
    recent: list[Job]
    stats: dict[str, int]
    order: list[str] = field(default_factory=list)


class JobQueue:
    """The queue's operations. Stateless apart from compiled scripts."""

    def __init__(self, client: aioredis.Redis | None = None) -> None:
        self._client = client
        self._scripts: dict[int, dict[str, Any]] = {}

    @property
    def redis(self) -> aioredis.Redis:
        return self._client or get_redis()

    @property
    def prefix(self) -> str:
        return settings.redis_namespace

    def _key(self, *parts: object) -> str:
        return ":".join([self.prefix, "q", *(str(p) for p in parts)])

    def _script(self, name: str, source: str):
        client = self.redis
        compiled = self._scripts.setdefault(id(client), {})
        if name not in compiled:
            compiled[name] = client.register_script(source)
        return compiled[name]

    async def _call(self, name: str, source: str, *args: object):
        return await self._script(name, source)(keys=[], args=[self.prefix, *args])

    # --- producing ---------------------------------------------------------

    async def enqueue(
        self,
        *,
        kind: str,
        tenant: str,
        payload: dict[str, Any],
        job_id: str | None = None,
        label: str = "",
        max_attempts: int | None = None,
    ) -> str:
        """
        Add a job. Idempotent on `job_id`: a job that is already waiting or
        running is left as it is, so a double-clicked button cannot build the
        same thing twice.
        """
        job_id = job_id or f"{kind}:{uuid.uuid4().hex}"
        await self._call(
            "enqueue", _ENQUEUE,
            job_id, tenant, now_ms(), kind, json.dumps(payload),
            max_attempts or settings.queue_max_attempts, label,
        )
        return job_id

    async def cancel(self, job_id: str) -> str | None:
        """Cancel a job. Returns the state it was in, or None if unknown."""
        return await self._call("cancel", _CANCEL, job_id, now_ms())

    # --- consuming ---------------------------------------------------------

    async def dequeue(self, worker: str, *, lease_seconds: int | None = None) -> Job | None:
        """Take the next job, fairly across tenants, and lease it to `worker`."""
        lease = (
            lease_seconds if lease_seconds is not None else settings.queue_lease_seconds
        ) * 1000
        job_id = await self._call("dequeue", _DEQUEUE, now_ms(), lease, worker)
        if not job_id:
            return None
        return await self.get(job_id)

    async def heartbeat(self, job_id: str, worker: str, *, lease_seconds: int | None = None) -> bool:
        """Extend a lease. False means it was lost, and the work should stop."""
        lease = (
            lease_seconds if lease_seconds is not None else settings.queue_lease_seconds
        ) * 1000
        return bool(await self._call("heartbeat", _HEARTBEAT, job_id, worker, now_ms() + lease))

    async def complete(self, job_id: str, worker: str, *, state: str = "done", error: str = "") -> bool:
        if state not in ("done", "failed", "cancelled"):
            raise ValueError(f"not a final state: {state}")
        return bool(
            await self._call("complete", _COMPLETE, job_id, worker, now_ms(), state, error[:2000])
        )

    async def retry(self, job_id: str, worker: str, *, delay_seconds: float, error: str = "") -> bool:
        run_at = now_ms() + int(delay_seconds * 1000)
        return bool(await self._call("retry", _RETRY, job_id, worker, run_at, error[:2000]))

    async def maintain(self) -> list[str]:
        """
        Promote retries that are due and reclaim jobs whose worker died.
        Returns the jobs given up on, so the caller can tell their owners.
        """
        dead = await self._call("maintain", _MAINTAIN, now_ms())
        return list(dead or [])

    # --- reading -----------------------------------------------------------

    async def get(self, job_id: str) -> Job | None:
        data = await self.redis.hgetall(self._key("job", job_id))
        return Job.from_hash(data) if data else None

    async def position(self, job_id: str) -> tuple[int, int] | None:
        """
        (jobs ahead of this one, jobs waiting in total), or None when the job
        is not waiting. Computed from the ring in one round trip, not by
        simulating the queue.
        """
        job = await self.get(job_id)
        if job is None or job.state != "pending":
            return None

        ring = await self.redis.lrange(self._key("ring"), 0, -1)
        if job.tenant not in ring:
            return None
        pipe = self.redis.pipeline()
        for tenant in ring:
            pipe.llen(self._key("t", tenant))
        pipe.lpos(self._key("t", job.tenant), job_id)
        results = await pipe.execute()
        lengths = dict(zip(ring, results[:-1]))
        index = results[-1]
        if index is None:
            return None
        return queue_position(ring, lengths, job.tenant, index), sum(lengths.values())

    async def stats(self) -> dict[str, int]:
        raw = await self.redis.hgetall(self._key("stats"))
        return {k: int(v) for k, v in raw.items()}

    async def snapshot(self, *, recent: int = 50) -> QueueSnapshot:
        """Everything the admin's queue page shows, in two round trips."""
        r = self.redis
        pipe = r.pipeline()
        pipe.lrange(self._key("ring"), 0, -1)
        pipe.zrange(self._key("lease"), 0, -1)
        pipe.zrange(self._key("delayed"), 0, -1)
        pipe.lrange(self._key("recent"), 0, recent - 1)
        pipe.hgetall(self._key("stats"))
        ring, leased, delayed, recent_ids, stats = await pipe.execute()

        pipe = r.pipeline()
        for tenant in ring:
            pipe.lrange(self._key("t", tenant), 0, -1)
        queued_ids = await pipe.execute() if ring else []
        queues = dict(zip(ring, queued_ids))

        wanted = [*leased, *delayed, *recent_ids, *(i for ids in queued_ids for i in ids)]
        pipe = r.pipeline()
        for job_id in wanted:
            pipe.hgetall(self._key("job", job_id))
        hashes = await pipe.execute() if wanted else []
        jobs = {j: Job.from_hash(h) for j, h in zip(wanted, hashes) if h}

        return QueueSnapshot(
            ring=ring,
            pending={t: [jobs[i] for i in ids if i in jobs] for t, ids in queues.items()},
            running=[jobs[i] for i in leased if i in jobs],
            delayed=[jobs[i] for i in delayed if i in jobs],
            recent=[jobs[i] for i in recent_ids if i in jobs],
            stats={k: int(v) for k, v in stats.items()},
            order=dispatch_order(ring, queues),
        )


queue = JobQueue()
