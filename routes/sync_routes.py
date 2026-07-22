"""Per-record local-first sync endpoints over odysseus's native tables."""
import os
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from core.database import SessionLocal, engine
from src.auth_helpers import require_user
from src.sync.models import create_sync_tables
from src.sync.listeners import register_note_listeners
from src.sync.apply import apply_push
from src.sync.pull import pull_changes

FALLBACK_OWNER = os.environ.get("ODYSSEUS_FALLBACK_OWNER", "owner@localhost")

SYNC_READ_SCOPES = {"sync:read", "sync:write"}
SYNC_WRITE_SCOPES = {"sync:write"}


def bearer_owner(request: Request, required: set[str]) -> str | None:
    """Owner for an API-token (Bearer) request, or None if this isn't one.

    Raises 403 if the token lacks a required scope or has no owner.
    """
    if not getattr(request.state, "api_token", False):
        return None
    scopes = set(getattr(request.state, "api_token_scopes", []) or [])
    if not scopes.intersection(required):
        raise HTTPException(403, f"API token missing required scope: {' or '.join(sorted(required))}")
    owner = getattr(request.state, "api_token_owner", None)
    if not owner:
        raise HTTPException(403, "API token has no owner")
    return owner


def sync_owner(request: Request, required: set[str]) -> str:
    """Resolve the data owner for a sync request (bearer token OR cookie/anon)."""
    bearer = bearer_owner(request, required)
    if bearer is not None:
        return bearer
    user = require_user(request)
    return user if user else FALLBACK_OWNER


def setup_sync_routes() -> APIRouter:
    create_sync_tables(engine)
    register_note_listeners()
    router = APIRouter(prefix="/api/sync", tags=["sync"])

    @router.get("/ping")
    async def ping(request: Request):
        return {"ok": True, "user": sync_owner(request, SYNC_READ_SCOPES)}

    @router.post("/push")
    async def push(request: Request):
        owner = sync_owner(request, SYNC_WRITE_SCOPES)
        body = await request.json()
        changes = body.get("changes") or []
        if len(changes) > 500:
            raise HTTPException(400, "INVALID_BODY")
        db = SessionLocal()
        try:
            return apply_push(db, owner, changes)
        except PermissionError:
            db.rollback()
            return JSONResponse(status_code=403, content={"error": "FORBIDDEN"})
        except ValueError as e:
            db.rollback()
            return JSONResponse(status_code=400, content={"error": str(e)})
        finally:
            db.close()

    @router.get("/pull")
    async def pull(request: Request, cursor: int = 0, limit: int = 500):
        owner = sync_owner(request, SYNC_READ_SCOPES)
        limit = max(1, min(limit, 500))
        db = SessionLocal()
        try:
            return pull_changes(db, owner, cursor, limit)
        finally:
            db.close()

    return router
