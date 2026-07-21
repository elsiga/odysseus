"""Per-field local-first sync endpoints (browser cookie auth for Slice 1)."""
from fastapi import APIRouter, Request, HTTPException
from core.database import SessionLocal, engine
from src.auth_helpers import require_user
from src.sync.models import create_sync_tables
from src.sync.apply import apply_push
from src.sync.pull import pull_changes


def setup_sync_routes() -> APIRouter:
    create_sync_tables(engine)
    router = APIRouter(prefix="/api/sync", tags=["sync"])

    def _owner(request: Request) -> str:
        user = require_user(request)
        if not user:
            raise HTTPException(401, "Authentication required")
        return user

    @router.get("/ping")
    async def ping(request: Request):
        return {"ok": True, "user": _owner(request)}

    @router.post("/push")
    async def push(request: Request):
        owner = _owner(request)
        body = await request.json()
        device_id = (body.get("deviceId") or "").strip()
        patches = body.get("patches") or []
        if not device_id or len(patches) > 200:
            raise HTTPException(400, "INVALID_BODY")
        db = SessionLocal()
        try:
            return apply_push(db, owner, device_id, patches)
        except PermissionError:
            db.rollback()
            raise HTTPException(403, "FORBIDDEN")
        except ValueError as e:
            db.rollback()
            raise HTTPException(400, str(e))
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
