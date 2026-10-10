"""
A GitHub-style preview of a downloaded repository: its file tree and READMEs.

Built from the copy the scan already downloaded, so showing the student what
they are about to deploy costs no extra request to GitHub. Pure: it reads the
directory and nothing else, and it never follows a symlink out of it.
"""

from __future__ import annotations

import os
from pathlib import Path

# Bounds, so one enormous repository cannot make a scan response huge. The
# preview is for orientation, not a mirror.
MAX_ENTRIES = 4000
MAX_READMES = 40
MAX_README_BYTES = 64 * 1024

# What GitHub itself renders as a directory's README, in its order.
README_NAMES = (
    "README.md",
    "readme.md",
    "Readme.md",
    "README.markdown",
    "README.rst",
    "README.txt",
    "README",
)


def _relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _read_readme(path: Path) -> str | None:
    try:
        with path.open("rb") as handle:
            raw = handle.read(MAX_README_BYTES + 1)
    except OSError:
        return None
    text = raw[:MAX_README_BYTES].decode("utf-8", errors="replace")
    if len(raw) > MAX_README_BYTES:
        text += "\n\n*…README truncated in this preview.*\n"
    return text


def build_preview(root: Path, *, priority_dirs: list[str] | None = None) -> dict:
    """
    Every file and directory under `root`, and the READMEs worth showing.

    Entries are listed breadth-first, so when the cap is reached it is the
    deepest corners of the tree that are left out, not the top level a student
    looks at first. READMEs for `priority_dirs` (the deployable candidates)
    are read before any others.
    """
    entries: list[dict] = []
    readme_paths: dict[str, Path] = {}
    truncated = False

    queue = [root]
    while queue and not truncated:
        directory = queue.pop(0)
        try:
            children = sorted(
                os.scandir(directory),
                key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()),
            )
        except OSError:
            continue

        for child in children:
            if child.is_symlink():
                continue
            path = Path(child.path)
            is_dir = child.is_dir(follow_symlinks=False)
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                break
            try:
                size = 0 if is_dir else child.stat(follow_symlinks=False).st_size
            except OSError:
                size = 0
            entries.append(
                {
                    "path": _relative(root, path),
                    "type": "dir" if is_dir else "file",
                    "size": size,
                }
            )
            if is_dir:
                queue.append(path)

        dir_key = "" if directory == root else _relative(root, directory)
        names = {child.name for child in children if not child.is_symlink()}
        for candidate in README_NAMES:
            if candidate in names:
                readme_paths[dir_key] = directory / candidate
                break

    # The root first, then the deployable directories, then the rest by depth.
    wanted = [""] + [d for d in (priority_dirs or []) if d]
    order = [d for d in wanted if d in readme_paths] + sorted(
        (d for d in readme_paths if d not in wanted),
        key=lambda d: (d.count("/"), d),
    )
    readmes: dict[str, dict] = {}
    for directory in order[:MAX_READMES]:
        path = readme_paths[directory]
        text = _read_readme(path)
        if text is not None:
            readmes[directory] = {"name": path.name, "content": text}

    return {"entries": entries, "readmes": readmes, "truncated": truncated}
