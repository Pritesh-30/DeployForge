"""
Keeping Actions-built images in the platform's registry.

Docker and GitHub are recorded rather than called, so the tests can check the
exact sequence: pull from GitHub, tag, push here — and that a failure at any
step leaves the app running from GitHub rather than not running at all.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.runtime import mirror


@pytest.fixture
def our_registry(monkeypatch):
    monkeypatch.setattr(mirror.settings, "registry_host", "localhost:5000")
    monkeypatch.setattr(mirror.settings, "registry_push", True)
    monkeypatch.setattr(mirror.settings, "ci_registry", "ghcr.io")
    monkeypatch.setattr(mirror.settings, "image_namespace", "deployforge")
    monkeypatch.setattr(mirror.settings, "mirror_ci_images", True)


@pytest.fixture
def docker_calls(monkeypatch):
    calls: list[tuple] = []
    failing: set[str] = set()

    async def run(*args, timeout=None, docker_config=None):
        calls.append(args)
        ok = args[0] not in failing
        return SimpleNamespace(ok=ok, message="" if ok else f"{args[0]} failed")

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def creds(db, user_id):
        yield None

    monkeypatch.setattr(mirror.docker, "_run", run)
    monkeypatch.setattr(mirror.registry, "credentials_for", creds)
    return SimpleNamespace(calls=calls, failing=failing)


def test_the_mirrored_name_keeps_path_and_commit(our_registry):
    assert mirror.mirror_target("ghcr.io/alice/todo/app:1a2b3c4d5e6f") == (
        "localhost:5000/deployforge/alice/todo/app:1a2b3c4d5e6f"
    )


def test_only_github_registry_images_are_mirrored(our_registry):
    assert mirror.mirror_target("docker.io/library/nginx:1") is None


def test_nothing_is_mirrored_without_a_registry(our_registry, monkeypatch):
    monkeypatch.setattr(mirror.settings, "registry_push", False)
    assert mirror.mirror_target("ghcr.io/alice/todo/app:abc") is None


async def test_an_image_is_pulled_tagged_and_pushed(our_registry, docker_calls, tmp_path):
    ref = "ghcr.io/alice/todo/app:abc123"
    out = await mirror.mirror_images(None, "u", {"": ref}, tmp_path / "log")

    target = "localhost:5000/deployforge/alice/todo/app:abc123"
    assert out == {"": target}
    assert [c[0] for c in docker_calls.calls] == ["pull", "tag", "push"]
    assert docker_calls.calls[1] == ("tag", ref, target)
    assert "Stored" in (tmp_path / "log").read_text()


async def test_every_service_of_a_stack_is_mirrored(our_registry, docker_calls):
    images = {"web": "ghcr.io/a/r/web:1", "api": "ghcr.io/a/r/api:1"}
    out = await mirror.mirror_images(None, "u", images, None)
    assert out == {
        "web": "localhost:5000/deployforge/a/r/web:1",
        "api": "localhost:5000/deployforge/a/r/api:1",
    }


async def test_a_failed_push_falls_back_to_github(our_registry, docker_calls, tmp_path):
    """Mirroring is an improvement, never a reason for an app not to run."""
    docker_calls.failing.add("push")
    ref = "ghcr.io/alice/todo/app:abc"
    out = await mirror.mirror_images(None, "u", {"": ref}, tmp_path / "log")
    assert out == {"": ref}
    assert "Running from GitHub instead" in (tmp_path / "log").read_text()


async def test_mirroring_can_be_turned_off(our_registry, docker_calls, monkeypatch):
    monkeypatch.setattr(mirror.settings, "mirror_ci_images", False)
    images = {"": "ghcr.io/a/r/app:1"}
    assert await mirror.mirror_images(None, "u", images, None) == images
    assert docker_calls.calls == []


@pytest.mark.parametrize(
    "ref,expected",
    [
        ("ghcr.io/alice/todo/app:abc", ("alice", "todo/app", "abc")),
        ("ghcr.io/alice/todo:abc", ("alice", "todo", "abc")),
        ("docker.io/x/y:1", None),
        ("ghcr.io/alice:abc", None),
    ],
)
def test_package_names_parse(our_registry, ref, expected):
    assert mirror.package_of(ref) == expected


async def test_github_copies_are_kept_without_the_delete_scope(our_registry, monkeypatch, tmp_path):
    """No scope, no deletion — and the log says how to allow it."""
    connection = SimpleNamespace(scopes="repo,workflow,read:packages",
                                 github_username="alice", access_token_enc="x")

    async def get_connection(db, user_id):
        return connection

    sent = []

    async def send(*args, **kwargs):
        sent.append(args)

    monkeypatch.setattr(mirror, "get_connection", get_connection)
    monkeypatch.setattr(mirror, "_send", send)
    deleted = await mirror.delete_from_github(None, "u", ["ghcr.io/alice/todo/app:abc"], tmp_path / "log")
    assert deleted == 0
    assert sent == []
    assert "reconnect GitHub" in (tmp_path / "log").read_text()


async def test_only_the_tagged_version_is_deleted(our_registry, monkeypatch, tmp_path):
    connection = SimpleNamespace(scopes="repo read:packages delete:packages",
                                 github_username="alice", access_token_enc="x")

    async def get_connection(db, user_id):
        return connection

    requests = []

    async def send(token, method, path, **kwargs):
        requests.append((method, path))
        if method == "GET":
            return SimpleNamespace(status_code=200, json=lambda: [
                {"id": 1, "metadata": {"container": {"tags": ["old"]}}},
                {"id": 2, "metadata": {"container": {"tags": ["abc"]}}},
            ])
        return SimpleNamespace(status_code=204)

    monkeypatch.setattr(mirror, "get_connection", get_connection)
    monkeypatch.setattr(mirror, "decrypt_token", lambda enc: "gho")
    monkeypatch.setattr(mirror, "_send", send)

    deleted = await mirror.delete_from_github(None, "u", ["ghcr.io/alice/todo/app:abc"], tmp_path / "log")
    assert deleted == 1
    assert requests == [
        ("GET", "/user/packages/container/todo%2Fapp/versions?per_page=100"),
        ("DELETE", "/user/packages/container/todo%2Fapp/versions/2"),
    ]
