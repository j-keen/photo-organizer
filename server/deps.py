"""FastAPI dependencies shared by the route modules."""
from __future__ import annotations

from fastapi import Query, Request

from .jobs import JobManager
from .workspaces import Workspace, WorkspaceRegistry


def registry(request: Request) -> WorkspaceRegistry:
    return request.app.state.registry


def jobs(request: Request) -> JobManager:
    return request.app.state.jobs


def external(request: Request):
    """Allowed external roots for dupes v2 (server/external.py)."""
    return request.app.state.external


def workspace(request: Request, ws: str | None = Query(None, description='workspace token from /api/workspace/open')) -> Workspace:
    """The workspace a request targets: ?ws=<token> (or X-FI-Workspace header), else the current one."""
    token = ws or request.headers.get('x-fi-workspace') or None
    return request.app.state.registry.get(token)
