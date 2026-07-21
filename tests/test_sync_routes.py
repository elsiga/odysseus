import asyncio
import httpx
from types import SimpleNamespace
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import src.sync.models as m

TS1 = "2026-07-21T00:00:00.000Z-000001"


class _Identity:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            hdrs = dict(scope.get("headers") or [])
            u = hdrs.get(b"x-test-user")
            scope.setdefault("state", {})
            scope["state"]["current_user"] = u.decode() if u else None
        await self.app(scope, receive, send)


def _app(tmp_path, monkeypatch, is_configured=True):
    engine = create_engine(f"sqlite:///{tmp_path/'s.db'}",
        connect_args={"check_same_thread": False}, poolclass=NullPool)
    Session = sessionmaker(bind=engine)
    import routes.sync_routes as sr
    monkeypatch.setattr(sr, "SessionLocal", Session)
    monkeypatch.setattr(sr, "engine", engine)
    app = FastAPI()
    app.state.auth_manager = SimpleNamespace(is_configured=is_configured)
    app.include_router(sr.setup_sync_routes())
    return _Identity(app)


def _c(app):
    t = httpx.ASGITransport(app=app, client=("203.0.113.7", 54321))
    return httpx.AsyncClient(transport=t, base_url="http://sync.test")


def _c_loopback(app):
    t = httpx.ASGITransport(app=app, client=("127.0.0.1", 12345))
    return httpx.AsyncClient(transport=t, base_url="http://sync.test")


def test_push_then_pull(tmp_path, monkeypatch):
    async def _run():
        app = _app(tmp_path, monkeypatch)
        alice = {"x-test-user": "alice"}
        async with _c(app) as c:
            body = {"deviceId": "dev1", "patches": [
                {"entity": "task", "entityId": "t1", "fields": {"title": {"v": "Buy milk", "ts": TS1}}}]}
            r = await c.post("/api/sync/push", json=body, headers=alice)
            assert r.status_code == 200 and r.json()["applied"] == 1
            pulled = (await c.get("/api/sync/pull?cursor=0", headers=alice)).json()
            assert pulled["changes"][0]["fields"]["title"]["v"] == "Buy milk"
    asyncio.run(_run())


def test_pull_requires_auth(tmp_path, monkeypatch):
    async def _run():
        app = _app(tmp_path, monkeypatch)
        async with _c(app) as c:
            r = await c.get("/api/sync/pull?cursor=0")
            assert r.status_code in (401, 403)
    asyncio.run(_run())


def test_ping_falls_back_to_owner_in_single_user_mode(tmp_path, monkeypatch):
    # require_user returns "" (not a 401) when auth is unconfigured and the
    # caller is on loopback (pre-setup / single-user access). _owner should
    # fall back to FALLBACK_OWNER rather than 401-ing.
    async def _run():
        app = _app(tmp_path, monkeypatch, is_configured=False)
        async with _c_loopback(app) as c:
            r = await c.get("/api/sync/ping")
            assert r.status_code == 200
            assert r.json() == {"ok": True, "user": "owner@localhost"}
    asyncio.run(_run())


def test_push_invalid_field_returns_error_body(tmp_path, monkeypatch):
    async def _run():
        app = _app(tmp_path, monkeypatch)
        alice = {"x-test-user": "alice"}
        async with _c(app) as c:
            body = {"deviceId": "dev1", "patches": [
                {"entity": "task", "entityId": "t1",
                 "fields": {"not_a_real_field": {"v": "x", "ts": TS1}}}]}
            r = await c.post("/api/sync/push", json=body, headers=alice)
            assert r.status_code == 400
            assert r.json() == {"error": "INVALID_FIELD"}
    asyncio.run(_run())
