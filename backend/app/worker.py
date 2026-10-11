"""
Run queue workers as their own process: `python -m app.worker`.

For a server with more build capacity than one API process should carry, or
to keep builds running while the API is redeployed. Set WORKER_EMBEDDED=false
on the API when running these, so builds are not split between the two.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from app.core import redis as redis_core
from app.db import engine
from app.queue.jobs import HANDLERS
from app.queue.worker import Worker


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            # Windows: Ctrl+C arrives as KeyboardInterrupt instead.
            pass
    try:
        await Worker(HANDLERS).run(stop)
    finally:
        await redis_core.close_all()
        await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
