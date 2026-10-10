"""Tests for the repository preview shown when choosing what to deploy."""

from __future__ import annotations

import base64

import pytest

from app.api import repository_routes
from app.github import preview
from app.github.crypto import encrypt_token
from app.models.github import GitHubConnection


def _tree(root, files: dict[str, str]) -> None:
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def test_the_top_level_survives_the_entry_cap(tmp_path, monkeypatch):
    """A huge repository loses its deepest corners, not its top level."""
    monkeypatch.setattr(preview, "MAX_ENTRIES", 5)
    _tree(tmp_path, {
        "a/b/c/deep.txt": "", "a/b/other.txt": "", "z.txt": "", "README.md": "",
    })

    result = preview.build_preview(tmp_path)

    paths = [e["path"] for e in result["entries"]]
    assert {"a", "README.md", "z.txt"} <= set(paths)
    assert "a/b/c/deep.txt" not in paths
    assert result["truncated"]


def test_deployable_directories_get_their_readmes_first(tmp_path, monkeypatch):
    monkeypatch.setattr(preview, "MAX_READMES", 2)
    _tree(tmp_path, {
        "README.md": "root", "aaa/README.md": "aaa", "web/README.md": "web",
    })

    readmes = preview.build_preview(tmp_path, priority_dirs=["web"])["readmes"]
    assert set(readmes) == {"", "web"}


def test_a_long_readme_is_cut_short(tmp_path, monkeypatch):
    monkeypatch.setattr(preview, "MAX_README_BYTES", 10)
    _tree(tmp_path, {"README.md": "x" * 100})

    content = preview.build_preview(tmp_path)["readmes"][""]["content"]
    assert content.startswith("x" * 10)
    assert "truncated" in content


# --- The file viewer ---------------------------------------------------------

async def _connected(client, db_session, credentials):
    res = await client.post("/auth/signup", json=credentials)
    db_session.add(
        GitHubConnection(
            user_id=res.json()["user"]["id"],
            github_username="octocat",
            github_user_id=583231,
            access_token_enc=encrypt_token("gho_token"),
            scopes="repo",
        )
    )
    await db_session.commit()
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _github_file(monkeypatch, raw: bytes | None, size: int | None = None):
    async def fake(token, full_name, path, ref):
        if raw is None:
            return None
        return {"raw": raw, "size": len(raw) if size is None else size,
                "html_url": f"https://github.com/{full_name}/blob/{ref}/{path}"}

    monkeypatch.setattr(repository_routes.github_client, "get_file_details", fake)


def _get(client, headers, path="src/app.py"):
    return client.get(
        "/repos/file",
        params={"full_name": "octocat/amvex", "path": path, "ref": "main"},
        headers=headers,
    )


@pytest.mark.asyncio
async def test_a_text_file_is_shown(client, db_session, user_credentials, monkeypatch):
    headers = await _connected(client, db_session, user_credentials)
    _github_file(monkeypatch, b"print('hi')\n")

    body = (await _get(client, headers)).json()
    assert body["content"] == "print('hi')\n"
    assert body["binary"] is False


@pytest.mark.asyncio
async def test_a_binary_file_is_not(client, db_session, user_credentials, monkeypatch):
    headers = await _connected(client, db_session, user_credentials)
    _github_file(monkeypatch, b"\x89PNG\r\n\x1a\n\x00\x00")

    body = (await _get(client, headers, "logo.png")).json()
    assert body["binary"] is True
    assert body["content"] is None


@pytest.mark.asyncio
async def test_a_file_too_large_for_github_to_inline_is_marked(
    client, db_session, user_credentials, monkeypatch
):
    headers = await _connected(client, db_session, user_credentials)
    _github_file(monkeypatch, b"", size=5_000_000)

    body = (await _get(client, headers, "data.csv")).json()
    assert body["truncated"] is True
    assert body["content"] is None


@pytest.mark.asyncio
async def test_a_missing_file_is_a_404(client, db_session, user_credentials, monkeypatch):
    headers = await _connected(client, db_session, user_credentials)
    _github_file(monkeypatch, None)
    assert (await _get(client, headers)).status_code == 404


@pytest.mark.asyncio
async def test_paths_cannot_climb_out_of_the_repository(
    client, db_session, user_credentials, monkeypatch
):
    headers = await _connected(client, db_session, user_credentials)
    _github_file(monkeypatch, b"x")
    assert (await _get(client, headers, "../secrets")).status_code == 400


def test_base64_roundtrip_is_what_github_sends():
    # Sanity for the client's decoding: GitHub wraps base64 at 60 columns.
    encoded = base64.encodebytes(b"hello\n" * 30).decode()
    assert base64.b64decode(encoded) == b"hello\n" * 30
