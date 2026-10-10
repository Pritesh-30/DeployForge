"""
The workflow file committed into a student's repository, and the build plan
handed to it.

The file is deliberately thin: it says *when* to build (a push to the branch
the app was connected from, or the dashboard's Deploy button) and hands off to
one shared, reusable workflow for *how*. The how changes as DeployForge does;
students' repositories should not have to.

Everything here is pure.
"""

from __future__ import annotations

import re

from app.builder import stack
from app.config import settings
from app.models.repository import Repository
from app.runtime.naming import subdomain_for, url_for

WORKFLOW_DIR = ".github/workflows"

# Docker repository path components: lowercase alphanumerics separated by
# single dots, dashes or underscores.
_NOT_IMAGE = re.compile(r"[^a-z0-9._-]+")
_SEPARATORS = re.compile(r"[._-]{2,}")


def workflow_filename(repository: Repository) -> str:
    """
    One file per connected target.

    A monorepo can have its frontend and backend connected as two apps, and
    each needs its own trigger and its own build.
    """
    return f"deployforge-{repository.id.hex[:8]}.yml"


def workflow_path(repository: Repository) -> str:
    return f"{WORKFLOW_DIR}/{workflow_filename(repository)}"


def _image_component(value: str) -> str:
    cleaned = _NOT_IMAGE.sub("-", value.strip().lower())
    cleaned = _SEPARATORS.sub("-", cleaned).strip("._-")
    return cleaned or "app"


def image_repository(repository: Repository) -> str:
    """
    Where this app's images live: `ghcr.io/<owner>/<repo>/<target>`.

    Under the student's own account, so the images are theirs, count against
    their storage rather than the platform's, and are private when the
    repository is.
    """
    owner, _, name = repository.full_name.partition("/")
    target = repository.deploy_path or ("stack" if repository.is_multi_service else "app")
    return "/".join(
        [
            settings.ci_registry.strip().rstrip("/"),
            _image_component(owner),
            _image_component(name),
            _image_component(target.replace("/", "-")),
        ]
    )


def image_tag(commit_sha: str) -> str:
    return commit_sha[:12]


def _trigger_paths(repository: Repository) -> list[str]:
    """
    Only changes to what this app is built from should redeploy it.

    A monorepo's frontend should not be rebuilt because someone edited the
    backend's README. A root target has no filter: everything is its source.
    """
    if repository.is_multi_service:
        paths = repository.service_paths or []
    elif repository.deploy_path:
        paths = [repository.deploy_path]
    else:
        return []
    if any(not p for p in paths):  # one of the services is the root
        return []
    return [f"{p.strip('/')}/**" for p in paths]


def _quote(value: str) -> str:
    """A YAML double-quoted scalar."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render(repository: Repository) -> str:
    """The workflow file for this target, exactly as committed."""
    url = url_for(
        subdomain_for(
            repository_id=repository.id,
            repository_name=repository.name,
            deploy_path=repository.deploy_path,
        )
    )
    branch = repository.default_branch
    paths = _trigger_paths(repository)
    paths_block = (
        "    paths:\n" + "".join(f"      - {_quote(p)}\n" for p in paths)
        if paths
        else ""
    )

    return (
        f"# Managed by DeployForge: deploys {repository.target_label}\n"
        f"# to {url}\n"
        "#\n"
        "# Every push to the branch below is built here, in GitHub Actions, and\n"
        "# the result is deployed. DeployForge rewrites this file when you deploy\n"
        "# from the dashboard, so edit settings there rather than here. Delete\n"
        "# the file to stop automatic deploys.\n"
        f"name: {_quote('DeployForge: ' + repository.target_label)}\n"
        "\n"
        "on:\n"
        "  push:\n"
        f"    branches: [{_quote(branch)}]\n"
        f"{paths_block}"
        "  workflow_dispatch:\n"
        "    inputs:\n"
        "      deployment:\n"
        "        description: Set by the DeployForge dashboard\n"
        "        required: false\n"
        "        default: \"\"\n"
        "\n"
        "permissions:\n"
        "  contents: read\n"
        "  packages: write\n"
        "  id-token: write\n"
        "\n"
        "# A newer push replaces a build still running for an older one.\n"
        "concurrency:\n"
        f"  group: deployforge-{repository.id.hex[:8]}\n"
        "  cancel-in-progress: true\n"
        "\n"
        "jobs:\n"
        "  deploy:\n"
        f"    uses: {settings.ci_workflow}\n"
        "    with:\n"
        f"      api-url: {_quote(settings.public_api_url.rstrip('/'))}\n"
        f"      target: {_quote(str(repository.id))}\n"
        "      deployment: ${{ inputs.deployment }}\n"
    )


def build_plan(repository: Repository, commit_sha: str) -> dict:
    """
    What the run should build, and what to call the result.

    The run decides *how* each directory is built — compose file, Dockerfile
    or buildpacks — from the files it checked out, by the same rules the
    server uses. The server decides the names, so it can recognise the images
    it is later told about.
    """
    base = image_repository(repository)
    tag = image_tag(commit_sha)

    if repository.is_multi_service:
        services = [
            {
                "name": stack.service_name(path),
                "path": path or ".",
                "image": f"{base}/{_image_component(stack.service_name(path))}:{tag}",
            }
            for path in repository.service_paths or []
        ]
        return {"kind": "stack", "services": services, "tag": tag}

    return {
        "kind": "single",
        "path": repository.deploy_path or ".",
        "image": f"{base}:{tag}",
        # A compose file's services are named in the file, not here.
        "image_prefix": base,
        "tag": tag,
    }


def image_belongs_to(repository: Repository, image_ref: str) -> bool:
    """Whether `image_ref` is one this app's builds are allowed to report."""
    return image_ref.startswith(image_repository(repository) + "/") or (
        image_ref.startswith(image_repository(repository) + ":")
    )

