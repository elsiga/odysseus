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


def setup_sync_routes() -> APIRouter:
    create_sync_tables(engine)
    register_note_listeners()
    router = APIRouter(prefix="/api/sync", tags=["sync"])

    def _owner(request: Request) -> str:
        user = require_user(request)
        return user if user else FALLBACK_OWNER

    @router.get("/ping")
    async def ping(request: Request):
        return {"ok": True, "user": _owner(request)}

    @router.post("/push")
    async def push(request: Request):
        owner = _owner(request)
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
        owner = _owner(request)
        limit = max(1, min(limit, 500))
        db = SessionLocal()
        try:
            return pull_changes(db, owner, cursor, limit)
        finally:
            db.close()

    return router
