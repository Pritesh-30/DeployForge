"""
Shared test fixtures.

Database tests run against the real PostgreSQL database, but each test is
wrapped in a transaction that is rolled back afterwards, so the suite never
leaves rows behind. The app's `get_db` dependency is overridden to hand out a
session bound to that same transaction.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import NullPool
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings
from app.db import get_db
from app.main import app


@pytest.fixture(autouse=True)
def laptop_defaults(monkeypatch):
    """
    The suite assumes a plain laptop install, whatever backend/.env says:
    a developer demoing through a tunnel (BUILD_BACKEND=actions, a webhook
    secret, a public address) must not change what the tests exercise.
    Tests that need those settings set them themselves.
    """
    monkeypatch.setattr(settings, "build_backend", "local")
    monkeypatch.setattr(settings, "github_webhook_secret", "")
    monkeypatch.setattr(settings, "public_api_url", "http://localhost:8000")


@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """
    A session inside a transaction that is rolled back when the test ends.

    The engine is created per test with NullPool: pytest-asyncio gives each
    test its own event loop, and a pooled asyncpg connection cannot be reused
    across loops.
    """
    test_engine = create_async_engine(settings.database_url, poolclass=NullPool)
    try:
        async with test_engine.connect() as connection:
            transaction = await connection.begin()
            # `create_savepoint` means a commit() in application code releases a
            # SAVEPOINT rather than the outer transaction, so the rollback wins.
            session = async_sessionmaker(
                bind=connection,
                expire_on_commit=False,
                autoflush=False,
                join_transaction_mode="create_savepoint",
            )()
            try:
                yield session
            finally:
                await session.close()
                if transaction.is_active:
                    await transaction.rollback()
    finally:
        await test_engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """An HTTP client driving the real app in-process, on the test session."""

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest_asyncio.fixture(autouse=True)
async def fake_redis():
    """
    An in-process Redis for every test, empty each time.

    With Lua enabled, so the queue's atomic scripts run exactly as they do
    against a real server. No test can reach — or pollute — the developer's
    own Redis.
    """
    import fakeredis

    from app.core import redis as redis_core

    client = fakeredis.FakeAsyncRedis(decode_responses=True)
    redis_core.use_client(client)
    try:
        yield client
    finally:
        redis_core.use_client(None)
        await client.aclose()


@pytest.fixture
def user_credentials() -> dict[str, str]:
    return {"email": "person@example.com", "password": "correct-horse-battery"}


@pytest.fixture
def admin_credentials() -> dict[str, str]:
    return {"email": "boss@example.com", "password": "admin-horse-battery"}
