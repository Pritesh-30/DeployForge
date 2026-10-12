"""
The scheduling arithmetic behind the build queue, free of Redis.

Two decisions live here because they are the ones worth getting exactly right
and they are easier to prove correct without a server in the way.

Fair share across tenants
-------------------------
A single FIFO is unfair on a shared machine. When one student pushes ten
commits in a minute, everyone queued behind them waits for all ten. The queue
instead keeps one FIFO per tenant and a ring of tenants that have work, and a
worker takes one job from the tenant at the head of the ring, then moves that
tenant to the back. This is round-robin — deficit round-robin with a quantum
of one job — and it bounds anyone's wait by the number of *tenants* ahead of
them, not the number of jobs.

Backoff
-------
A retried job waits an exponentially growing delay with full jitter
(`uniform(0, min(cap, base * 2**n))`). Without jitter, every job that failed
for the same reason — GitHub's API blinking for everyone at once — retries at
the same instant and fails together again.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence


def queue_position(
    ring: Sequence[str],
    lengths: Mapping[str, int],
    tenant: str,
    index: int,
) -> int:
    """
    How many jobs will be dispatched before the one at `index` in `tenant`'s
    queue, under round-robin across `ring`.

    Round-robin serves round 0 (the first job of every tenant, in ring order),
    then round 1, and so on, skipping tenants that have run out. The job at
    `index` is served in round `index`. Before it go:

      * every job any tenant has in rounds 0..index-1 — `min(len, index)` each;
      * in round `index` itself, the job of each tenant ahead of this one in
        the ring that still has a job at that depth.

    O(tenants), with no simulation. Returns a 0-based position: 0 means next.
    """
    if index < 0:
        raise ValueError("index must be non-negative")
    if tenant not in ring:
        raise ValueError(f"{tenant!r} is not in the ring")

    ahead = 0
    seen_self = False
    for other in ring:
        length = lengths.get(other, 0)
        ahead += min(length, index)
        if other == tenant:
            seen_self = True
            continue
        if not seen_self and length > index:
            ahead += 1
    return ahead


def dispatch_order(
    ring: Sequence[str], queues: Mapping[str, Sequence[str]]
) -> list[str]:
    """
    The full order jobs would be dispatched in, by simulation.

    Used by the admin view of the queue and as the reference that
    `queue_position` is tested against.
    """
    order: list[str] = []
    depth = 0
    remaining = sum(len(queues.get(t, ())) for t in ring)
    while len(order) < remaining:
        for tenant in ring:
            jobs = queues.get(tenant, ())
            if depth < len(jobs):
                order.append(jobs[depth])
        depth += 1
    return order


def backoff_delay(
    attempt: int,
    *,
    base: float,
    cap: float,
    rng: random.Random | None = None,
) -> float:
    """
    Seconds to wait before attempt number `attempt + 1`, with full jitter.

    `attempt` is how many attempts have already been made (1 after the first
    failure). The ceiling grows as base * 2**(attempt-1) up to `cap`, and the
    actual delay is uniform below it.
    """
    if attempt < 1:
        return 0.0
    ceiling = min(cap, base * (2 ** (attempt - 1)))
    return (rng or random).uniform(0, ceiling)
