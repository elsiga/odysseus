"""Per-field local-first sync endpoints (browser cookie auth for Slice 1)."""
import os
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from core.database import SessionLocal, engine
from src.auth_helpers import require_user
from src.sync.models import create_sync_tables
from src.sync.apply import apply_push
from src.sync.pull import pull_changes

# Single-user fallback identity, used only when require_user returns "" (auth
# disabled / unconfigured single-user first-run+loopback / LOCALHOST_BYPASS).
# Mirrors routes/calendar_routes.py's FALLBACK_OWNER convention.
FALLBACK_OWNER = os.environ.get("ODYSSEUS_FALLBACK_OWNER", "owner@localhost")


def setup_sync_routes() -> APIRouter:
    create_sync_tables(engine)
    router = APIRouter(prefix="/api/sync", tags=["sync"])

    def _owner(request: Request) -> str:
        # require_user raises 401 itself when auth is configured and the
        # caller is unauthenticated; it returns "" for single-user / auth
        # disabled modes, in which case we fall back to FALLBACK_OWNER.
        user = require_user(request)
        return user if user else FALLBACK_OWNER

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
