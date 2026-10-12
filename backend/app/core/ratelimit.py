"""
Rate limiting with GCRA, the generic cell rate algorithm.

A token bucket, but stored as a single number per key: the *theoretical
arrival time* (TAT) of the next request if requests came at exactly the
allowed rate. A request at time `now` is allowed when the TAT is no more than
the burst tolerance ahead of `now`; allowing it pushes the TAT one emission
interval further. There is no background refill, no list of timestamps, and
the whole check-and-update is one atomic Lua call — which is what makes it
correct when several API processes share one Redis.

    T   = period / rate          seconds between requests at the steady rate
    tau = T * (burst - 1)        how far ahead of `now` the TAT may run

With burst 6 and 30 per hour, a student can redeploy six times in a row,
then once every two minutes — enough for any real debugging session, and not
enough to turn a shared build machine into their personal CI.
"""

from __future__ import annotations

import logging
import math
import time
import uuid
from dataclasses import dataclass

from app.config import settings
from app.core.errors import AppError
from app.core.redis import get_redis, key

logger = logging.getLogger(__name__)

_GCRA = """
local now, T, tau = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
if tat - now > tau then
  return {0, tat - now - tau, 0}
end
local new_tat = tat + T
redis.call('SET', KEYS[1], new_tat, 'PX', math.ceil(new_tat - now + 1000))
local remaining = math.floor((tau - (new_tat - now)) / T) + 1
if remaining < 0 then remaining = 0 end
return {1, 0, remaining}
"""


class RateLimitedError(AppError):
    status_code = 429
    code = "rate_limited"

    def __init__(self, message: str, *, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.headers = {"Retry-After": str(max(1, math.ceil(retry_after)))}


@dataclass(frozen=True)
class Decision:
    allowed: bool
    retry_after: float  # seconds; 0 when allowed
    remaining: int      # further requests allowed immediately


class RateLimiter:
    """One named limit, e.g. "deploy": `rate` per `period` with a `burst`."""

    def __init__(self, name: str, *, rate: int, period: float, burst: int) -> None:
        if rate <= 0 or period <= 0 or burst <= 0:
            raise ValueError("rate, period and burst must be positive")
        self.name = name
        self.interval_ms = period * 1000 / rate
        self.tolerance_ms = self.interval_ms * (burst - 1)

    async def hit(self, subject: str | uuid.UUID, *, now_ms: float | None = None) -> Decision:
        """Count one request against `subject` and say whether it is allowed."""
        now = now_ms if now_ms is not None else time.time() * 1000
        client = get_redis()
        allowed, wait_ms, remaining = await client.eval(
            _GCRA, 1, key("rl", self.name, subject),
            int(now), self.interval_ms, self.tolerance_ms,
        )
        return Decision(bool(allowed), float(wait_ms) / 1000, int(remaining))

    async def check(self, subject: str | uuid.UUID) -> Decision:
        """
        Like `hit`, but raises 429 when the limit is reached.

        Fails open if Redis cannot be reached: a rate limit protects the
        machine, and refusing every request because the limiter's own store
        is down would protect it from everyone, including people doing
        nothing wrong.
        """
        try:
            decision = await self.hit(subject)
        except RateLimitedError:
            raise
        except Exception:  # noqa: BLE001
            logger.warning("Rate limiter unavailable; allowing", exc_info=True)
            return Decision(True, 0.0, 0)
        if not decision.allowed:
            raise RateLimitedError(
                f"Too many deploys in a short time. Try again in "
                f"{_human(decision.retry_after)}.",
                retry_after=decision.retry_after,
            )
        return decision


def _human(seconds: float) -> str:
    seconds = max(1, math.ceil(seconds))
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    minutes = math.ceil(seconds / 60)
    return f"{minutes} minute{'s' if minutes != 1 else ''}"


deploy_limiter = RateLimiter(
    "deploy",
    rate=settings.rate_limit_deploys_per_hour,
    period=3600,
    burst=settings.rate_limit_deploy_burst,
)

# AI diagnosis costs money per call; a handful an hour is plenty for debugging.
ai_limiter = RateLimiter("ai", rate=10, period=3600, burst=3)

