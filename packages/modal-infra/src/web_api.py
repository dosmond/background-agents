"""
Web API endpoints for Open-Inspect Modal functions.

These endpoints expose Modal functions as HTTP APIs that can be called
from the control plane (Cloudflare Workers).

Note: These endpoints call the underlying Python logic directly rather than
using .remote() to avoid nested Modal function calls.

SECURITY: All sensitive endpoints require authentication via HMAC-signed tokens.
The control plane must include an Authorization header with a valid token.
"""

import os
import re
import time

from fastapi import Header, HTTPException
from modal import fastapi_endpoint

from .app import (
    app,
    function_image,
    github_app_secrets,
    inspect_volume,
    internal_api_secret,
    validate_control_plane_url,
)
from .auth import AuthConfigurationError, verify_internal_token
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("web_api")


def require_auth(authorization: str | None) -> None:
    """
    Verify authentication, raising HTTPException on failure.

    Args:
        authorization: The Authorization header value

    Raises:
        HTTPException: 401 if authentication fails, 503 if auth is misconfigured
    """
    try:
        if not verify_internal_token(authorization):
            raise HTTPException(
                status_code=401,
                detail="Unauthorized: Invalid or missing authentication token",
            )
    except AuthConfigurationError as e:
        # Auth system is misconfigured - this is a server error, not client error
        raise HTTPException(
            status_code=503,
            detail=f"Service unavailable: Authentication not configured. {e}",
        )


def require_valid_control_plane_url(url: str | None) -> None:
    """
    Validate control_plane_url, raising HTTPException on failure.

    Args:
        url: The control plane URL to validate

    Raises:
        HTTPException: 400 if URL is invalid
    """
    if url and not validate_control_plane_url(url):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid control_plane_url: {url}. URL must match allowed patterns.",
        )


_PORCELAIN_RE = re.compile(r"^(?P<xy>.{2}) (?P<path>.+)$")
_NUMSTAT_RE = re.compile(r"^(?P<add>\d+|-)\t(?P<del>\d+|-)\t(?P<path>.+)$")


def _normalize_path(raw_path: str) -> tuple[str, str | None]:
    """Normalize git porcelain paths, including rename syntax."""
    if " -> " not in raw_path:
        return raw_path, None
    old_path, new_path = raw_path.split(" -> ", 1)
    return new_path, old_path


def parse_git_status_porcelain(output: str) -> list[dict]:
    """Parse `git status --porcelain=v1` output into structured rows."""
    rows: list[dict] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        match = _PORCELAIN_RE.match(line)
        if not match:
            continue

        xy = match.group("xy")
        raw_path = match.group("path")
        path, old_path = _normalize_path(raw_path)

        status_code = "modified"
        if xy == "??":
            status_code = "untracked"
        elif "R" in xy:
            status_code = "renamed"
        elif "A" in xy:
            status_code = "added"
        elif "D" in xy:
            status_code = "deleted"

        rows.append(
            {
                "filename": path,
                "old_filename": old_path,
                "status": status_code,
            }
        )

    return rows


def parse_git_numstat(output: str) -> dict[str, dict[str, int]]:
    """Parse `git diff --numstat` output into per-file additions/deletions."""
    stats: dict[str, dict[str, int]] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        match = _NUMSTAT_RE.match(line)
        if not match:
            continue
        add_raw = match.group("add")
        del_raw = match.group("del")
        path = match.group("path")
        stats[path] = {
            "additions": 0 if add_raw == "-" else int(add_raw),
            "deletions": 0 if del_raw == "-" else int(del_raw),
        }
    return stats


def _repo_command(cmd: str) -> str:
    """
    Build a command that resolves repo root under /workspace before running git.
    """
    return (
        "set -euo pipefail; "
        "repo_dir=$(python - <<'PY'\n"
        "from pathlib import Path\n"
        "repo_dirs = list(Path('/workspace').glob('*/.git'))\n"
        "print(repo_dirs[0].parent if repo_dirs else '')\n"
        "PY\n"
        "); "
        "if [ -z \"$repo_dir\" ]; then echo 'REPO_NOT_FOUND' >&2; exit 2; fi; "
        'cd "$repo_dir"; '
        f"{cmd}"
    )


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[github_app_secrets, internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_create_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    HTTP endpoint to create a sandbox.

    Requires authentication via Authorization header.

    POST body:
    {
        "session_id": "...",
        "sandbox_id": "...",  // Optional: expected sandbox ID from control plane
        "repo_owner": "...",
        "repo_name": "...",
        "control_plane_url": "...",
        "sandbox_auth_token": "...",
        "snapshot_id": null,
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = request.get("control_plane_url")
    require_valid_control_plane_url(control_plane_url)

    try:
        # Import types and manager directly
        from .auth import generate_installation_token
        from .sandbox import SessionConfig
        from .sandbox.manager import SandboxConfig, SandboxManager

        manager = SandboxManager()

        # Generate GitHub App token for git operations
        github_app_token = None
        try:
            app_id = os.environ.get("GITHUB_APP_ID")
            private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
            installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

            if app_id and private_key and installation_id:
                github_app_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                )
        except Exception as e:
            log.warn("github.token_error", exc=e)

        session_config = SessionConfig(
            session_id=request.get("session_id"),
            repo_owner=request.get("repo_owner"),
            repo_name=request.get("repo_name"),
            branch=request.get("branch"),
            opencode_session_id=request.get("opencode_session_id"),
            provider=request.get("provider", "anthropic"),
            model=request.get("model", "claude-sonnet-4-6"),
        )

        config = SandboxConfig(
            repo_owner=request.get("repo_owner"),
            repo_name=request.get("repo_name"),
            sandbox_id=request.get("sandbox_id"),  # Use control-plane-provided ID for auth
            snapshot_id=request.get("snapshot_id"),
            session_config=session_config,
            control_plane_url=control_plane_url,
            sandbox_auth_token=request.get("sandbox_auth_token"),
            clone_token=github_app_token,
            user_env_vars=request.get("user_env_vars") or None,
            mcp_config=request.get("mcp_config") or None,
            repo_image_id=request.get("repo_image_id") or None,
            repo_image_sha=request.get("repo_image_sha") or None,
            code_server_enabled=bool(request.get("code_server_enabled", False)),
        )

        handle = await manager.create_sandbox(config)

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,  # Modal's internal ID for snapshot API
                "status": handle.status.value,
                "created_at": handle.created_at,
                "code_server_url": handle.code_server_url,
                "code_server_password": handle.code_server_password,
            },
        }
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_create_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_create_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_create_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_warm_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    HTTP endpoint to warm a sandbox.

    Requires authentication via Authorization header.

    POST body:
    {
        "repo_owner": "...",
        "repo_name": "...",
        "control_plane_url": "..."
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = request.get("control_plane_url", "")
    require_valid_control_plane_url(control_plane_url)

    try:
        from .sandbox.manager import SandboxManager

        manager = SandboxManager()
        handle = await manager.warm_sandbox(
            repo_owner=request.get("repo_owner"),
            repo_name=request.get("repo_name"),
            control_plane_url=control_plane_url,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "status": handle.status.value,
            },
        }
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_warm_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_warm_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_warm_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(image=function_image)
@fastapi_endpoint(method="GET")
def api_health() -> dict:
    """Health check endpoint. Does not require authentication."""
    return {"success": True, "data": {"status": "healthy", "service": "open-inspect-modal"}}


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="GET")
def api_snapshot(
    repo_owner: str,
    repo_name: str,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Get latest snapshot for a repository.

    Requires authentication via Authorization header.

    Query params: ?repo_owner=...&repo_name=...
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    try:
        from .registry.store import SnapshotStore

        store = SnapshotStore()
        snapshot = store.get_latest_snapshot(repo_owner, repo_name)

        if snapshot:
            return {"success": True, "data": snapshot.model_dump()}
        return {"success": True, "data": None}
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="GET",
            http_path="/api_snapshot",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_snapshot",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_snapshot_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Take a filesystem snapshot of a running sandbox using Modal's native API.

    Requires authentication via Authorization header.

    This creates a point-in-time copy of the sandbox's filesystem that can be
    used to restore the sandbox later. The snapshot is stored as a Modal Image
    and persists indefinitely.

    POST body:
    {
        "sandbox_id": "...",
        "session_id": "...",
        "reason": "execution_complete" | "pre_timeout" | "heartbeat_timeout"
    }

    Returns:
    {
        "success": true,
        "data": {
            "image_id": "...",
            "sandbox_id": "...",
            "session_id": "...",
            "reason": "..."
        }
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    sandbox_id = request.get("sandbox_id")
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id is required")

    try:
        from .sandbox.manager import SandboxManager

        session_id = request.get("session_id")
        reason = request.get("reason", "manual")

        manager = SandboxManager()

        # Get the sandbox handle by ID
        handle = await manager.get_sandbox_by_id(sandbox_id)
        if not handle:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")

        # Take filesystem snapshot using Modal's native API (sync method)
        image_id = manager.take_snapshot(handle)

        return {
            "success": True,
            "data": {
                "image_id": image_id,
                "sandbox_id": sandbox_id,
                "session_id": session_id,
                "reason": reason,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_snapshot_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_snapshot_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id or sandbox_id,
        )


@app.function(image=function_image, secrets=[github_app_secrets, internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_restore_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Create a new sandbox from a filesystem snapshot.

    Requires authentication via Authorization header.

    This restores a sandbox from a previously taken snapshot Image,
    allowing the session to resume with full workspace state intact.
    Git clone is skipped since the workspace already contains all changes.

    POST body:
    {
        "snapshot_image_id": "...",
        "session_config": {
            "session_id": "...",
            "repo_owner": "...",
            "repo_name": "...",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6"
        },
        "sandbox_id": "...",
        "control_plane_url": "...",
        "sandbox_auth_token": "..."
    }

    Returns:
    {
        "success": true,
        "data": {
            "sandbox_id": "...",
            "status": "warming"
        }
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = request.get("control_plane_url", "")
    require_valid_control_plane_url(control_plane_url)

    snapshot_image_id = request.get("snapshot_image_id")
    if not snapshot_image_id:
        raise HTTPException(status_code=400, detail="snapshot_image_id is required")

    try:
        from .auth import generate_installation_token
        from .sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS, SandboxManager

        session_config = request.get("session_config", {})
        sandbox_id = request.get("sandbox_id")
        sandbox_auth_token = request.get("sandbox_auth_token", "")
        user_env_vars = request.get("user_env_vars") or None
        mcp_config = request.get("mcp_config") or None
        timeout_seconds = int(request.get("timeout_seconds", DEFAULT_SANDBOX_TIMEOUT_SECONDS))

        manager = SandboxManager()

        github_app_token = None
        try:
            app_id = os.environ.get("GITHUB_APP_ID")
            private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
            installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

            if app_id and private_key and installation_id:
                github_app_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                )
        except Exception as e:
            log.warn("github.token_error", exc=e)

        code_server_enabled = bool(request.get("code_server_enabled", False))

        # Restore sandbox from snapshot
        handle = await manager.restore_from_snapshot(
            snapshot_image_id=snapshot_image_id,
            session_config=session_config,
            sandbox_id=sandbox_id,
            control_plane_url=control_plane_url,
            sandbox_auth_token=sandbox_auth_token,
            clone_token=github_app_token,
            user_env_vars=user_env_vars,
            mcp_config=mcp_config,
            timeout_seconds=timeout_seconds,
            code_server_enabled=code_server_enabled,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,
                "status": handle.status.value,
                "code_server_url": handle.code_server_url,
                "code_server_password": handle.code_server_password,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_restore_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_restore_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_restore_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="GET")
async def api_git_changes(
    sandbox_id: str,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Return working-tree git file changes and per-file diffs for a running sandbox.

    Query params: ?sandbox_id=...
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    try:
        from .sandbox.manager import SandboxManager

        manager = SandboxManager()
        handle = await manager.get_sandbox_by_id(sandbox_id)
        if not handle:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")

        status_proc = handle.modal_sandbox.exec(
            "bash",
            "-lc",
            _repo_command("git status --porcelain=v1 --untracked-files=all"),
            timeout=10,
        )
        status_proc.wait()
        status_output = status_proc.stdout.read()
        status_error = status_proc.stderr.read()
        if status_proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"git status failed: {(status_error or '').strip()}",
            )

        changes = parse_git_status_porcelain(status_output)
        if not changes:
            return {
                "success": True,
                "data": {
                    "files": [],
                    "diffs_by_file": {},
                    "summary": {"total_files": 0, "total_additions": 0, "total_deletions": 0},
                },
            }

        numstat_proc = handle.modal_sandbox.exec(
            "bash",
            "-lc",
            _repo_command("git diff --numstat"),
            timeout=10,
        )
        numstat_proc.wait()
        numstat_output = numstat_proc.stdout.read()
        numstat_stats = parse_git_numstat(numstat_output)

        total_additions = 0
        total_deletions = 0
        files: list[dict] = []
        diffs_by_file: dict[str, str] = {}

        max_files = 100
        max_diff_bytes = 50000
        max_total_diff_bytes = 500000
        total_diff_bytes = 0

        for change in changes[:max_files]:
            filename = change["filename"]
            status = change["status"]
            old_filename = change.get("old_filename")
            stats = numstat_stats.get(filename, {"additions": 0, "deletions": 0})
            additions = stats["additions"]
            deletions = stats["deletions"]

            if status == "untracked":
                wc_proc = handle.modal_sandbox.exec(
                    "bash",
                    "-lc",
                    _repo_command(f"wc -l {filename!r}"),
                    timeout=5,
                )
                wc_proc.wait()
                wc_output = wc_proc.stdout.read().strip()
                if wc_proc.returncode == 0 and wc_output:
                    try:
                        additions = int(wc_output.split()[0])
                    except (ValueError, IndexError):
                        additions = 0
                deletions = 0

            files.append(
                {
                    "filename": filename,
                    "status": status,
                    "old_filename": old_filename,
                    "additions": additions,
                    "deletions": deletions,
                }
            )
            total_additions += additions
            total_deletions += deletions

            if status == "untracked":
                diff_proc = handle.modal_sandbox.exec(
                    "bash",
                    "-lc",
                    _repo_command(f"git diff --no-index -- /dev/null {filename!r}"),
                    timeout=10,
                )
            else:
                diff_proc = handle.modal_sandbox.exec(
                    "bash",
                    "-lc",
                    _repo_command(f"git diff -- {filename!r}"),
                    timeout=10,
                )
            diff_proc.wait()
            diff_text = diff_proc.stdout.read()
            if not diff_text:
                continue

            encoded_len = len(diff_text.encode("utf-8", errors="ignore"))
            if total_diff_bytes >= max_total_diff_bytes:
                diffs_by_file[filename] = "# Diff omitted: payload budget exceeded."
                continue
            if encoded_len > max_diff_bytes:
                diff_text = diff_text[:max_diff_bytes] + "\n# Diff truncated.\n"
                encoded_len = len(diff_text.encode("utf-8", errors="ignore"))
            total_diff_bytes += encoded_len
            diffs_by_file[filename] = diff_text

        return {
            "success": True,
            "data": {
                "files": files,
                "diffs_by_file": diffs_by_file,
                "summary": {
                    "total_files": len(files),
                    "total_additions": total_additions,
                    "total_deletions": total_deletions,
                },
            },
        }
    except HTTPException:
        outcome = "error"
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_git_changes")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="GET",
            http_path="/api_git_changes",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_git_changes",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id or sandbox_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret, github_app_secrets],
)
@fastapi_endpoint(method="POST")
async def api_build_repo_image(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Kick off an async image build. Returns immediately.
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    try:
        from .scheduler.image_builder import build_repo_image

        repo_owner = request.get("repo_owner")
        repo_name = request.get("repo_name")
        default_branch = request.get("default_branch", "main")
        build_id = request.get("build_id", "")
        callback_url = request.get("callback_url", "")
        user_env_vars = request.get("user_env_vars") or None

        if not repo_owner or not repo_name:
            raise HTTPException(status_code=400, detail="repo_owner and repo_name are required")

        if not build_id:
            raise HTTPException(status_code=400, detail="build_id is required")

        await build_repo_image.spawn.aio(
            repo_owner=repo_owner,
            repo_name=repo_name,
            default_branch=default_branch,
            callback_url=callback_url,
            build_id=build_id,
            user_env_vars=user_env_vars,
        )

        return {
            "success": True,
            "data": {
                "build_id": build_id,
                "status": "building",
            },
        }
    except HTTPException:
        outcome = "error"
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_build_repo_image")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_build_repo_image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_build_repo_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_delete_provider_image(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Delete a single provider image (best-effort).
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    provider_image_id = request.get("provider_image_id")
    if not provider_image_id:
        raise HTTPException(status_code=400, detail="provider_image_id is required")

    try:
        log.info("image.delete_requested", provider_image_id=provider_image_id)
        return {
            "success": True,
            "data": {
                "provider_image_id": provider_image_id,
                "deleted": True,
            },
        }
    except HTTPException:
        outcome = "error"
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_delete_provider_image")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_delete_provider_image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_delete_provider_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )
