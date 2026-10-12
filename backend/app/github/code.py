"""
Reading a repository the way GitHub's code view does: tree, files, history,
branches, and the difference between two commits.

Caching is what makes this cheap. A git tree or blob is addressed by the hash
of its content, so the answer for a given SHA can never change — it is cached
for a week, not a minute, and every student browsing the same commit after
the first is served from Redis. Only the question "which commit is `main` at
right now?" goes to GitHub each time, and even that is held for half a minute.
That keeps a class of browsing students far below GitHub's 5,000 requests an
hour per token, and makes the second click on a file instant.
"""

from __future__ import annotations

import base64
import json
import logging
import posixpath
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

from app.config import settings
from app.core.redis import get_redis, key
from app.github.client import GitHubApiError, _get

logger = logging.getLogger(__name__)

IMMUTABLE_TTL = 7 * 24 * 3600   # anything addressed by a SHA
REF_TTL = 30                    # a branch name -> its current SHA
LIST_TTL = 60                   # commit lists, branches, repo metadata

# How much of a tree to return. GitHub itself truncates at 100k entries; a
# browser has no use for that many in one response.
MAX_TREE_ENTRIES = 20_000

_EXTENSIONS = {
    "py": "python", "pyi": "python", "js": "javascript", "mjs": "javascript",
    "cjs": "javascript", "jsx": "jsx", "ts": "typescript", "tsx": "tsx",
    "json": "json", "md": "markdown", "mdx": "mdx", "yml": "yaml", "yaml": "yaml",
    "toml": "toml", "html": "html", "htm": "html", "css": "css", "scss": "scss",
    "sass": "sass", "less": "less", "go": "go", "rs": "rust", "java": "java",
    "kt": "kotlin", "rb": "ruby", "php": "php", "c": "c", "h": "c",
    "cpp": "cpp", "cc": "cpp", "hpp": "cpp", "cs": "csharp", "swift": "swift",
    "sh": "bash", "bash": "bash", "zsh": "bash", "ps1": "powershell",
    "sql": "sql", "xml": "xml", "svg": "xml", "vue": "vue", "svelte": "svelte",
    "dart": "dart", "lua": "lua", "r": "r", "ini": "ini", "env": "dotenv",
    "graphql": "graphql", "gql": "graphql", "prisma": "prisma", "txt": "text",
}
_FILENAMES = {
    "dockerfile": "docker", "makefile": "makefile", "procfile": "text",
    ".gitignore": "text", ".dockerignore": "text", ".env.example": "dotenv",
    "requirements.txt": "text", "go.mod": "go",
}
README_NAMES = ("README.md", "readme.md", "Readme.md", "README.markdown", "README.rst", "README.txt", "README")


def language_for(path: str) -> str:
    """The syntax-highlighting language for a file name."""
    name = posixpath.basename(path).lower()
    if name in _FILENAMES:
        return _FILENAMES[name]
    if name.startswith("dockerfile"):
        return "docker"
    _, _, ext = name.rpartition(".")
    return _EXTENSIONS.get(ext, "text") if "." in name else "text"


def looks_binary(raw: bytes) -> bool:
    """A NUL byte in the first 8 KB is the same test git itself uses."""
    return b"\x00" in raw[:8192]


async def cached(cache_key: str, ttl: int, load: Callable[[], Awaitable[Any]]) -> Any:
    """
    `load()`'s value, from Redis when it is there.

    A Redis failure falls through to GitHub: a cache that takes the code view
    down with it when it breaks is worse than no cache.
    """
    client = get_redis()
    try:
        hit = await client.get(cache_key)
        if hit is not None:
            return json.loads(hit)
    except Exception:  # noqa: BLE001
        logger.debug("Code cache read failed", exc_info=True)

    value = await load()
    try:
        await client.set(cache_key, json.dumps(value), ex=ttl)
    except Exception:  # noqa: BLE001
        logger.debug("Code cache write failed", exc_info=True)
    return value


def _repo_path(full_name: str) -> str:
    if full_name.count("/") != 1:
        raise GitHubApiError(f"Not a valid repository name: {full_name!r}")
    return f"/repos/{full_name}"


async def resolve(token: str, full_name: str, ref: str) -> str:
    """The commit SHA `ref` names right now."""
    async def load():
        commit = await _get(token, f"{_repo_path(full_name)}/commits/{quote(ref, safe='')}")
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str):
            raise GitHubApiError(f"{ref!r} does not name a commit in {full_name}.")
        return sha

    if len(ref) == 40 and all(c in "0123456789abcdef" for c in ref.lower()):
        return ref.lower()
    return await cached(key("gh", "ref", full_name, ref), REF_TTL, load)


async def tree(token: str, full_name: str, sha: str) -> dict[str, Any]:
    """Every path in the repository at `sha`, directories included."""
    async def load():
        body = await _get(token, f"{_repo_path(full_name)}/git/trees/{sha}", recursive="1")
        raw = body.get("tree", []) if isinstance(body, dict) else []
        entries = [
            {
                "path": item["path"],
                "type": "dir" if item.get("type") == "tree" else "file",
                "size": item.get("size") or 0,
                "sha": item.get("sha"),
                "submodule": item.get("type") == "commit",
            }
            for item in raw
            if isinstance(item, dict) and "path" in item
        ]
        truncated = bool(body.get("truncated")) or len(entries) > MAX_TREE_ENTRIES
        return {"entries": entries[:MAX_TREE_ENTRIES], "truncated": truncated}

    return await cached(key("gh", "tree", full_name, sha), IMMUTABLE_TTL, load)


async def blob(token: str, full_name: str, blob_sha: str) -> bytes:
    """A file's bytes by its blob SHA. Works past the 1 MB contents-API limit."""
    async def load():
        body = await _get(token, f"{_repo_path(full_name)}/git/blobs/{blob_sha}")
        if not isinstance(body, dict):
            raise GitHubApiError("Unexpected response from GitHub for a file.")
        return body.get("content") or ""

    encoded = await cached(key("gh", "blob", full_name, blob_sha), IMMUTABLE_TTL, load)
    try:
        return base64.b64decode(encoded)
    except ValueError as exc:
        raise GitHubApiError("GitHub returned an unreadable file.") from exc


async def file(token: str, full_name: str, sha: str, path: str) -> dict[str, Any]:
    """
    One file at a commit, ready to show: text and language, or the reason it
    cannot be shown inline (binary, too large).
    """
    listing = await tree(token, full_name, sha)
    entry = next((e for e in listing["entries"] if e["path"] == path and e["type"] == "file"), None)
    if entry is None:
        raise GitHubApiError(f"{path} does not exist at this commit.", status_code=404)

    html_url = f"https://github.com/{full_name}/blob/{sha}/{quote(path)}"
    result = {
        "path": path,
        "sha": entry["sha"],
        "size": entry["size"],
        "language": language_for(path),
        "html_url": html_url,
        "binary": False,
        "too_large": entry["size"] > settings.code_max_file_bytes,
        "content": None,
    }
    if result["too_large"] or entry.get("submodule"):
        return result

    raw = await blob(token, full_name, entry["sha"])
    if looks_binary(raw):
        result["binary"] = True
        return result
    result["content"] = raw.decode("utf-8", errors="replace")
    return result


async def readme(token: str, full_name: str, sha: str, directory: str) -> dict[str, Any] | None:
    """The README GitHub would render for `directory`, if it has one."""
    listing = await tree(token, full_name, sha)
    prefix = f"{directory.strip('/')}/" if directory.strip("/") else ""
    present = {e["path"]: e for e in listing["entries"] if e["type"] == "file"}
    for name in README_NAMES:
        path = f"{prefix}{name}"
        if path in present:
            shown = await file(token, full_name, sha, path)
            return {"path": path, "name": name, "content": shown.get("content") or ""}
    return None


def _commit_summary(item: dict) -> dict[str, Any]:
    commit = item.get("commit") or {}
    author = commit.get("author") or {}
    gh_author = item.get("author") or {}
    message = commit.get("message") or ""
    return {
        "sha": item.get("sha"),
        "message": message.split("\n", 1)[0],
        "body": message.split("\n", 1)[1].strip() if "\n" in message else "",
        "author": gh_author.get("login") or author.get("name"),
        "avatar_url": gh_author.get("avatar_url"),
        "date": author.get("date"),
        "html_url": item.get("html_url"),
    }


async def commits(
    token: str, full_name: str, ref: str, *, path: str | None = None, page: int = 1, per_page: int = 30
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"sha": ref, "per_page": per_page, "page": page}
    if path:
        params["path"] = path

    async def load():
        body = await _get(token, f"{_repo_path(full_name)}/commits", **params)
        return [_commit_summary(c) for c in body if isinstance(c, dict)] if isinstance(body, list) else []

    cache_key = key("gh", "commits", full_name, ref, path or "", page, per_page)
    return await cached(cache_key, LIST_TTL, load)


async def branches(token: str, full_name: str) -> list[dict[str, Any]]:
    async def load():
        body = await _get(token, f"{_repo_path(full_name)}/branches", per_page=100)
        return [
            {"name": b.get("name"), "sha": (b.get("commit") or {}).get("sha"), "protected": b.get("protected", False)}
            for b in body if isinstance(b, dict)
        ] if isinstance(body, list) else []

    return await cached(key("gh", "branches", full_name), LIST_TTL, load)


async def languages(token: str, full_name: str) -> dict[str, int]:
    """Bytes of code per language, as GitHub's language bar shows."""
    async def load():
        body = await _get(token, f"{_repo_path(full_name)}/languages")
        return {k: int(v) for k, v in body.items()} if isinstance(body, dict) else {}

    return await cached(key("gh", "langs", full_name), LIST_TTL * 10, load)


async def repository(token: str, full_name: str) -> dict[str, Any]:
    async def load():
        body = await _get(token, _repo_path(full_name))
        if not isinstance(body, dict):
            raise GitHubApiError("Unexpected response from GitHub for the repository.")
        return {
            "full_name": body.get("full_name"),
            "description": body.get("description"),
            "default_branch": body.get("default_branch"),
            "private": body.get("private", False),
            "html_url": body.get("html_url"),
            "stars": body.get("stargazers_count", 0),
            "forks": body.get("forks_count", 0),
            "open_issues": body.get("open_issues_count", 0),
            "size_kb": body.get("size", 0),
            "language": body.get("language"),
            "topics": body.get("topics") or [],
            "license": (body.get("license") or {}).get("spdx_id"),
            "pushed_at": body.get("pushed_at"),
        }

    return await cached(key("gh", "repo", full_name), LIST_TTL, load)


async def compare(token: str, full_name: str, base: str, head: str) -> dict[str, Any]:
    """
    What changed between two commits — the commits and every file touched,
    with patches. Both ends are SHAs, so the answer is cached as immutable.
    """
    async def load():
        body = await _get(token, f"{_repo_path(full_name)}/compare/{base}...{head}")
        if not isinstance(body, dict):
            raise GitHubApiError("Unexpected response from GitHub for a comparison.")
        files = [
            {
                "filename": f.get("filename"),
                "status": f.get("status"),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                # Patches for huge files are omitted by GitHub; cap the rest.
                "patch": (f.get("patch") or "")[:20_000] or None,
            }
            for f in body.get("files") or [] if isinstance(f, dict)
        ]
        return {
            "status": body.get("status"),
            "ahead_by": body.get("ahead_by", 0),
            "behind_by": body.get("behind_by", 0),
            "total_commits": body.get("total_commits", 0),
            "commits": [_commit_summary(c) for c in body.get("commits") or [] if isinstance(c, dict)][-50:],
            "files": files[:300],
            "additions": sum(f["additions"] for f in files),
            "deletions": sum(f["deletions"] for f in files),
        }

    return await cached(key("gh", "compare", full_name, base, head), IMMUTABLE_TTL, load)
