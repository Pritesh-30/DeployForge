"""
The code view: what it shows, and that GitHub is asked as little as possible.

GitHub is replaced by a recording fake, so these tests can count requests —
the claim worth proving is that a file at a commit is fetched once, however
many times it is viewed.
"""

from __future__ import annotations

import base64
import uuid

import pytest

from app.github import code


class FakeGitHub:
    """Answers the handful of endpoints the code view uses, and counts calls."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.blobs = {
            "b-readme": b"# Hello\n\nThe app.",
            "b-main": b"print('hi')\n",
            "b-img": b"\x89PNG\x00\x00binary",
            "b-big": b"x" * 10,
        }

    async def get(self, token, path, **params):
        self.calls.append(path)
        if path.endswith("/commits/main"):
            return {"sha": "a" * 40}
        if "/git/trees/" in path:
            return {"tree": [
                {"path": "README.md", "type": "blob", "size": 18, "sha": "b-readme"},
                {"path": "src", "type": "tree", "sha": "t-src"},
                {"path": "src/main.py", "type": "blob", "size": 12, "sha": "b-main"},
                {"path": "logo.png", "type": "blob", "size": 14, "sha": "b-img"},
                {"path": "huge.bin", "type": "blob", "size": 10 * 1024 * 1024, "sha": "b-big"},
            ], "truncated": False}
        if "/git/blobs/" in path:
            sha = path.rsplit("/", 1)[1]
            return {"content": base64.b64encode(self.blobs[sha]).decode()}
        if path.endswith("/branches"):
            return [{"name": "main", "commit": {"sha": "a" * 40}}, {"name": "dev", "commit": {"sha": "b" * 40}}]
        raise AssertionError(f"unexpected GitHub call {path}")


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(code, "_get", fake.get)
    return fake


def test_languages_are_detected():
    assert code.language_for("src/app/page.tsx") == "tsx"
    assert code.language_for("Dockerfile") == "docker"
    assert code.language_for("Dockerfile.prod") == "docker"
    assert code.language_for("requirements.txt") == "text"
    assert code.language_for("LICENSE") == "text"


def test_binary_detection_matches_git():
    assert code.looks_binary(b"\x89PNG\x00")
    assert not code.looks_binary("naïve café".encode())


async def test_a_branch_resolves_to_a_commit(github):
    assert await code.resolve("t", "o/r", "main") == "a" * 40


async def test_a_full_sha_is_not_looked_up(github):
    assert await code.resolve("t", "o/r", "c" * 40) == "c" * 40
    assert github.calls == []


async def test_a_file_at_a_commit_is_fetched_from_github_once(github):
    """Content-addressed, so cached for a week — the whole point of the cache."""
    sha = "a" * 40
    for _ in range(5):
        shown = await code.file("t", "o/r", sha, "src/main.py")
        assert shown["content"] == "print('hi')\n"
        assert shown["language"] == "python"

    assert sum("/git/blobs/" in c for c in github.calls) == 1
    assert sum("/git/trees/" in c for c in github.calls) == 1


async def test_a_binary_file_is_not_sent_as_text(github):
    shown = await code.file("t", "o/r", "a" * 40, "logo.png")
    assert shown["binary"] is True
    assert shown["content"] is None


async def test_a_huge_file_is_offered_as_a_link_not_downloaded(github):
    shown = await code.file("t", "o/r", "a" * 40, "huge.bin")
    assert shown["too_large"] is True
    assert shown["content"] is None
    assert "/git/blobs/" not in "".join(github.calls)
    assert shown["html_url"].startswith("https://github.com/o/r/blob/")


async def test_a_missing_file_is_a_404(github):
    with pytest.raises(code.GitHubApiError) as caught:
        await code.file("t", "o/r", "a" * 40, "nope.txt")
    assert caught.value.status_code == 404


async def test_the_readme_for_a_directory_is_found(github):
    found = await code.readme("t", "o/r", "a" * 40, "")
    assert found["name"] == "README.md"
    assert found["content"].startswith("# Hello")
    assert await code.readme("t", "o/r", "a" * 40, "src") is None


async def test_a_redis_failure_falls_through_to_github(github, monkeypatch):
    """A cache that takes the page down when it breaks is worse than none."""
    class Broken:
        async def get(self, *a, **k):
            raise ConnectionError("down")

        async def set(self, *a, **k):
            raise ConnectionError("down")

    monkeypatch.setattr(code, "get_redis", lambda: Broken())
    assert await code.resolve("t", "o/r", "main") == "a" * 40


# --- Through the API --------------------------------------------------------

async def _app_with_token(client, db_session, credentials, monkeypatch):
    from app.api import app_routes
    from app.models.repository import DetectedType, Repository

    res = await client.post("/auth/signup", json=credentials)
    headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    user_id = uuid.UUID(res.json()["user"]["id"])
    repo = Repository(
        user_id=user_id, github_repo_id=5, name="r", full_name="o/r",
        default_branch="main", clone_url="https://x", detected_type=DetectedType.DOCKER,
    )
    db_session.add(repo)
    await db_session.commit()

    async def token(db, uid):
        return "gho_test"

    monkeypatch.setattr(app_routes, "get_access_token", token)
    return headers, repo


async def test_the_tree_endpoint(client, db_session, user_credentials, github, monkeypatch):
    headers, repo = await _app_with_token(client, db_session, user_credentials, monkeypatch)
    body = (await client.get(f"/apps/{repo.id}/code/tree", headers=headers)).json()
    assert body["sha"] == "a" * 40
    assert {"path": "src", "type": "dir"}.items() <= next(e for e in body["entries"] if e["path"] == "src").items()


async def test_the_file_endpoint(client, db_session, user_credentials, github, monkeypatch):
    headers, repo = await _app_with_token(client, db_session, user_credentials, monkeypatch)
    res = await client.get(f"/apps/{repo.id}/code/file", params={"path": "src/main.py"}, headers=headers)
    assert res.status_code == 200
    assert res.json()["content"] == "print('hi')\n"


async def test_another_users_code_is_not_visible(
    client, db_session, user_credentials, admin_credentials, github, monkeypatch
):
    _, repo = await _app_with_token(client, db_session, user_credentials, monkeypatch)
    other = await client.post("/auth/signup", json=admin_credentials)
    headers = {"Authorization": f"Bearer {other.json()['access_token']}"}
    assert (await client.get(f"/apps/{repo.id}/code/tree", headers=headers)).status_code == 404


async def test_switching_to_a_branch_that_does_not_exist_is_refused(
    client, db_session, user_credentials, github, monkeypatch
):
    headers, repo = await _app_with_token(client, db_session, user_credentials, monkeypatch)
    res = await client.patch(f"/apps/{repo.id}", json={"branch": "nope"}, headers=headers)
    assert res.status_code == 400
    ok = await client.patch(f"/apps/{repo.id}", json={"branch": "dev", "auto_deploy": False}, headers=headers)
    assert ok.status_code == 200
    assert ok.json()["default_branch"] == "dev"
    assert ok.json()["auto_deploy"] is False
