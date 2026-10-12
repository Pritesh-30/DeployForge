"""
Live progress of a build running in GitHub Actions, step by step.

While a build runs on GitHub, this server only waits for it to report back.
The workflow run's jobs and steps are what tell a student how far along it is
("Install dependencies", "Build image", "Push") — so the deployment page asks
GitHub for them and shows them inside the progress bar.

Answers are cached briefly: every open tab polls, and GitHub's rate limit is
per token. A finished run never changes again, so its answer is kept longer.
"""

from __future__ import annotations

import json
from typing import Any

from app.github import client as github_client
from app.github.code import cached
from app.core.redis import get_redis, key

_LIVE_TTL = 4
_DONE_TTL = 3600


def _step(step: dict[str, Any]) -> dict[str, Any]:
    return {
        "number": step.get("number"),
        "name": step.get("name"),
        "status": step.get("status"),          # queued | in_progress | completed
        "conclusion": step.get("conclusion"),  # success | failure | skipped | …
        "started_at": step.get("started_at"),
        "completed_at": step.get("completed_at"),
    }


def summarize(run: dict[str, Any] | None, jobs: list[dict[str, Any]]) -> dict[str, Any]:
    """The run and its steps, trimmed to what the progress bar needs."""
    steps = [
        _step(s)
        for job in jobs
        for s in (job.get("steps") or [])
        # GitHub's own bookkeeping steps say nothing about the build.
        if not str(s.get("name", "")).startswith(("Set up job", "Complete job", "Post "))
    ]
    done = sum(1 for s in steps if s["status"] == "completed")
    current = next((s for s in steps if s["status"] == "in_progress"), None)
    return {
        "status": (run or {}).get("status"),
        "conclusion": (run or {}).get("conclusion"),
        "html_url": (run or {}).get("html_url"),
        "steps": steps,
        "completed": done,
        "total": len(steps),
        "current": current["name"] if current else None,
    }


async def run_progress(access_token: str, full_name: str, run_id: int) -> dict[str, Any]:
    """Jobs and steps of one workflow run, cached for a few seconds."""

    async def load() -> dict[str, Any]:
        run = await github_client._get(access_token, f"/repos/{full_name}/actions/runs/{run_id}")
        jobs = await github_client._get(
            access_token, f"/repos/{full_name}/actions/runs/{run_id}/jobs", per_page=50
        )
        return summarize(run, (jobs or {}).get("jobs") or [])

    # A finished run cannot change any more, so its answer is kept long.
    done = key("gh", "run", full_name, run_id, "done")
    try:
        hit = await get_redis().get(done)
        if hit is not None:
            return json.loads(hit)
    except Exception:  # noqa: BLE001 — the cache is an optimisation
        pass
    value = await cached(key("gh", "run", full_name, run_id, "live"), _LIVE_TTL, load)
    if value.get("status") == "completed":
        try:
            await get_redis().set(done, json.dumps(value), ex=_DONE_TTL)
        except Exception:  # noqa: BLE001
            pass
    return value
