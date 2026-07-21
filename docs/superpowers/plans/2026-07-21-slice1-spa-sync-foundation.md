# Slice 1 — Local-First SPA + Sync Foundation (Tasks/Notes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the thinnest end-to-end vertical of the offline-first productivity layer: a new React/Vite SPA, served by odysseus at `/app`, that lists/creates/edits/deletes the user's notes offline (IndexedDB) and syncs them to odysseus's existing `notes` table when online.

**Architecture:** A local-first SPA owns a Dexie (IndexedDB) store + outbox, adapted from ember's sync substrate. Two new odysseus endpoints (`GET /api/sync/pull`, `POST /api/sync/push`) reconcile that store with the existing `notes` table using **per-record last-write-wins keyed on `Note.updated_at`** — client edits are authoritative on push; pull brings down anything changed since the client's cursor and applies it to non-dirty local rows. Browser is same-origin, so auth is the normal cookie/TOTP session via `require_user`. The SPA is served from an isolated `/app` prefix so it cannot shadow or be shadowed by odysseus's existing routes.

**Tech Stack:** Backend — Python 3, FastAPI, SQLAlchemy, pytest (httpx `AsyncClient` + `ASGITransport`). Frontend — TypeScript, React 18, Vite, Dexie 4, Vitest + `fake-indexeddb`, `vite-plugin-pwa`.

## Global Constraints

- **Single backend only: odysseus.** No second server, no ember-server. (verbatim from spec §1)
- **Minimize edits to odysseus hot files; put logic in new files.** Only one-line hooks allowed in `app.py` and `core/database.py`. (spec §5)
- **Additive DB migrations only**, via the existing `_migrate_add_*` pattern in `core/database.py`. No Alembic. (spec §7)
- **Sync writes must go through the ORM** so `Note.updated_at`'s `onupdate=utcnow_naive` fires (bulk/raw `UPDATE` bypasses it). (backend recon)
- **Timestamps are naive UTC**, serialized with `.isoformat()` and **no `Z` suffix**, matching odysseus's `_note_to_dict`. (backend recon)
- **New SPA lives in its own subtree `webapp/`**; `webapp/node_modules` and `webapp/dist` are gitignored. (spec §5)
- **Per-record LWW, client-authoritative on push, dirty-aware on pull.** No HLC / change_log in this slice. (design decision, this plan)

---

## File Structure

**Backend (new files):**
- `src/sync/__init__.py` — package marker.
- `src/sync/note_sync.py` — pure sync logic: `note_to_sync_dict(note)`, `apply_push_row(db, owner, row)`, `pull_notes(db, owner, cursor, limit)`, cursor encode/decode. No FastAPI imports — unit-testable in isolation.
- `routes/sync_routes.py` — `setup_sync_routes()` factory returning an `APIRouter(prefix="/api/sync")` with `GET /pull`, `POST /push`, `GET /ping`.

**Backend (one-line hooks in hot files):**
- `core/database.py` — add `deleted_at` column to `Note` + a `_migrate_add_note_deleted_at()` call.
- `app.py` — `include_router(setup_sync_routes())`; mount `/app-assets`; add `/app` + `/app/{path:path}` routes.

**Backend tests (new):**
- `tests/test_sync_notes_pull_push.py` — pull filtering, cursor paging, push upsert/LWW, owner isolation.

**Frontend (new subtree `webapp/`):**
- `webapp/package.json`, `webapp/vite.config.ts`, `webapp/tsconfig.json`, `webapp/index.html`, `webapp/src/main.tsx`, `webapp/src/App.tsx`.
- `webapp/src/db/db.ts` — Dexie schema (`notes`, `outbox`, `syncMeta`) + row types.
- `webapp/src/db/repo.ts` — `syncedPut`, `createNote`, `updateNote`, `deleteNote`, `liveNotes`.
- `webapp/src/sync/engine.ts` — `createSyncClient({apiBase, fetchFn})`: `pullOnce`, `pushOnce`, `syncOnce`, `start`, `stop`, cursor persistence, status.
- `webapp/src/sync/status.ts` — status store + `useSyncStatus` hook.
- `webapp/src/ui/TasksScreen.tsx` — minimal list/add/edit/delete UI + sync indicator.
- `webapp/src/db/db.test.ts`, `webapp/src/sync/engine.test.ts` — Vitest.
- `webapp/vitest.config.ts`, `webapp/src/test-setup.ts` (`fake-indexeddb/auto`).

**Design reference (read-only):** `design/Tasks + Calendar Prototype.dc.html` — adapt visual language in Task 12; Slice 1 keeps the UI minimal, full day/week/calendar views are Slice 2.

---

### Task 1: Add `deleted_at` tombstone column to `Note` (additive migration)

Sync needs a soft-delete tombstone so deletes propagate; `archived` already has UI meaning, so add a dedicated column.

**Files:**
- Modify: `core/database.py` (Note model + a `_migrate_add_*` function + its call site)
- Test: `tests/test_sync_notes_pull_push.py` (created here, expanded later)

**Interfaces:**
- Produces: `Note.deleted_at` (`DateTime`, nullable). A non-null value means the note is deleted.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_notes_pull_push.py
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import core.database as cdb


def _temp_db(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'sync.db'}",
        connect_args={"check_same_thread": False}, poolclass=NullPool,
    )
    cdb.Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


def test_note_has_deleted_at_column(tmp_path):
    engine, _ = _temp_db(tmp_path)
    cols = {c["name"] for c in inspect(engine).get_columns("notes")}
    assert "deleted_at" in cols
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_notes_pull_push.py::test_note_has_deleted_at_column -v`
Expected: FAIL — `assert 'deleted_at' in cols` is False.

- [ ] **Step 3: Add the column and migration**

In `core/database.py`, inside `class Note(TimestampMixin, Base):` add after the `agent_session_id` column:

```python
    deleted_at = Column(DateTime, nullable=True)  # soft-delete tombstone for sync
```

Then add a migration function alongside the other `_migrate_add_*` helpers:

```python
def _migrate_add_note_deleted_at(engine):
    """Add notes.deleted_at if missing (additive, backward-compatible)."""
    insp = inspect(engine)
    if "notes" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("notes")}
    if "deleted_at" not in cols:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE notes ADD COLUMN deleted_at DATETIME"))
```

Find where the other `_migrate_add_*` functions are invoked inside `init_db()` and add one line next to them:

```python
    _migrate_add_note_deleted_at(engine)
```

(If `inspect`/`text` aren't already imported at that scope, they are imported at the top of `core/database.py`; reuse the existing imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_notes_pull_push.py::test_note_has_deleted_at_column -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/database.py tests/test_sync_notes_pull_push.py
git commit -m "feat(sync): add notes.deleted_at tombstone column"
```

---

### Task 2: Pure sync serialization + cursor helpers

**Files:**
- Create: `src/sync/__init__.py`, `src/sync/note_sync.py`
- Test: `tests/test_sync_notes_pull_push.py`

**Interfaces:**
- Produces:
  - `note_to_sync_dict(note) -> dict` — keys: `id, title, content, items, note_type, color, label, pinned, archived, due_date, sort_order, repeat, deleted, updated_at` (`deleted` is `bool(note.deleted_at)`; `updated_at` is `.isoformat()` no `Z`).
  - `encode_cursor(updated_at: datetime, note_id: str) -> str` → `"<iso>|<id>"`.
  - `decode_cursor(cursor: str | None) -> tuple[datetime | None, str]` → `(dt, id)`; `None`/`""` → `(None, "")`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_sync_notes_pull_push.py
from datetime import datetime
from src.sync.note_sync import note_to_sync_dict, encode_cursor, decode_cursor


def test_encode_decode_cursor_roundtrip():
    dt = datetime(2026, 7, 21, 10, 30, 0)
    c = encode_cursor(dt, "abc")
    back_dt, back_id = decode_cursor(c)
    assert back_dt == dt and back_id == "abc"


def test_decode_cursor_empty():
    assert decode_cursor(None) == (None, "")
    assert decode_cursor("") == (None, "")


def test_note_to_sync_dict_marks_deleted(tmp_path):
    _, Session = _temp_db(tmp_path)
    db = Session()
    n = cdb.Note(id="n1", owner="alice", title="hi", deleted_at=datetime(2026, 7, 21))
    db.add(n); db.commit()
    d = note_to_sync_dict(n)
    assert d["id"] == "n1" and d["deleted"] is True and d["title"] == "hi"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -k "cursor or sync_dict" -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.sync'`.

- [ ] **Step 3: Implement**

```python
# src/sync/__init__.py
```

```python
# src/sync/note_sync.py
"""Pure (no-FastAPI) sync helpers for the notes domain."""
from __future__ import annotations
from datetime import datetime

_FIELDS = (
    "title", "content", "items", "note_type", "color", "label",
    "pinned", "archived", "due_date", "sort_order", "repeat",
)


def note_to_sync_dict(note) -> dict:
    d = {f: getattr(note, f) for f in _FIELDS}
    d["id"] = note.id
    d["deleted"] = bool(note.deleted_at)
    d["updated_at"] = note.updated_at.isoformat() if note.updated_at else None
    return d


def encode_cursor(updated_at: datetime, note_id: str) -> str:
    return f"{updated_at.isoformat()}|{note_id}"


def decode_cursor(cursor: str | None):
    if not cursor:
        return (None, "")
    iso, _, note_id = cursor.partition("|")
    return (datetime.fromisoformat(iso), note_id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -k "cursor or sync_dict" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/__init__.py src/sync/note_sync.py tests/test_sync_notes_pull_push.py
git commit -m "feat(sync): pure note serialization + cursor helpers"
```

---

### Task 3: `pull_notes` — changed-since query with cursor paging

**Files:**
- Modify: `src/sync/note_sync.py`
- Test: `tests/test_sync_notes_pull_push.py`

**Interfaces:**
- Produces: `pull_notes(db, owner: str, cursor: str | None, limit: int) -> dict` returning
  `{"changes": [note_to_sync_dict...], "cursor": "<iso>|<id>" | cursor_in, "hasMore": bool}`.
  Ordered by `(updated_at, id)` ascending; strictly after the decoded cursor; owner-scoped; includes tombstoned (deleted) rows.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_sync_notes_pull_push.py
from datetime import timedelta
from src.sync.note_sync import pull_notes


def _mk(db, id, owner, updated):
    n = cdb.Note(id=id, owner=owner, title=id)
    db.add(n); db.commit()
    n.updated_at = updated          # override auto stamp for deterministic ordering
    db.commit()
    return n


def test_pull_filters_by_cursor_and_owner(tmp_path):
    _, Session = _temp_db(tmp_path)
    db = Session()
    base = datetime(2026, 7, 21, 9, 0, 0)
    _mk(db, "a", "alice", base)
    _mk(db, "b", "alice", base + timedelta(minutes=1))
    _mk(db, "z", "bob",   base + timedelta(minutes=2))

    first = pull_notes(db, "alice", None, limit=1)
    assert [c["id"] for c in first["changes"]] == ["a"]
    assert first["hasMore"] is True

    second = pull_notes(db, "alice", first["cursor"], limit=10)
    assert [c["id"] for c in second["changes"]] == ["b"]
    assert second["hasMore"] is False
    # bob's note never appears for alice
    assert all(c["id"] != "z" for c in first["changes"] + second["changes"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_notes_pull_push.py::test_pull_filters_by_cursor_and_owner -v`
Expected: FAIL — `ImportError: cannot import name 'pull_notes'`.

- [ ] **Step 3: Implement**

Add to `src/sync/note_sync.py`:

```python
from sqlalchemy import and_, or_, tuple_


def pull_notes(db, owner: str, cursor: str | None, limit: int) -> dict:
    from core.database import Note
    since_dt, since_id = decode_cursor(cursor)
    q = db.query(Note).filter(Note.owner == owner)
    if since_dt is not None:
        q = q.filter(
            or_(
                Note.updated_at > since_dt,
                and_(Note.updated_at == since_dt, Note.id > since_id),
            )
        )
    rows = q.order_by(Note.updated_at.asc(), Note.id.asc()).limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    out_cursor = (
        encode_cursor(rows[-1].updated_at, rows[-1].id) if rows else (cursor or "")
    )
    return {
        "changes": [note_to_sync_dict(r) for r in rows],
        "cursor": out_cursor,
        "hasMore": has_more,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_notes_pull_push.py::test_pull_filters_by_cursor_and_owner -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/note_sync.py tests/test_sync_notes_pull_push.py
git commit -m "feat(sync): pull_notes changed-since query with cursor paging"
```

---

### Task 4: `apply_push_row` — client-authoritative upsert (owner-scoped)

**Files:**
- Modify: `src/sync/note_sync.py`
- Test: `tests/test_sync_notes_pull_push.py`

**Interfaces:**
- Produces: `apply_push_row(db, owner: str, row: dict) -> dict` — upserts a note the caller owns.
  Creates it if absent (owner set to caller), updates writable fields if present, sets/clears
  `deleted_at` from `row["deleted"]`, commits through the ORM (so `updated_at` re-stamps), and
  returns `note_to_sync_dict(note)`. Raises `PermissionError` if an existing `id` belongs to another owner.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_sync_notes_pull_push.py
import pytest
from src.sync.note_sync import apply_push_row


def test_push_inserts_then_updates_and_deletes(tmp_path):
    _, Session = _temp_db(tmp_path)
    db = Session()
    r = apply_push_row(db, "alice", {"id": "t1", "title": "Draft", "deleted": False})
    assert r["title"] == "Draft" and r["deleted"] is False

    r2 = apply_push_row(db, "alice", {"id": "t1", "title": "Draft v2", "deleted": False})
    assert r2["title"] == "Draft v2"

    r3 = apply_push_row(db, "alice", {"id": "t1", "deleted": True})
    assert r3["deleted"] is True


def test_push_rejects_other_owner(tmp_path):
    _, Session = _temp_db(tmp_path)
    db = Session()
    apply_push_row(db, "alice", {"id": "x", "title": "mine", "deleted": False})
    with pytest.raises(PermissionError):
        apply_push_row(db, "bob", {"id": "x", "title": "steal", "deleted": False})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -k push -v`
Expected: FAIL — `ImportError: cannot import name 'apply_push_row'`.

- [ ] **Step 3: Implement**

Add to `src/sync/note_sync.py`:

```python
_WRITABLE = (
    "title", "content", "items", "note_type", "color", "label",
    "pinned", "archived", "due_date", "sort_order", "repeat",
)


def apply_push_row(db, owner: str, row: dict) -> dict:
    from core.database import Note
    from core.database import utcnow_naive
    note = db.query(Note).filter(Note.id == row["id"]).first()
    if note is None:
        note = Note(id=row["id"], owner=owner)
        db.add(note)
    elif note.owner != owner:
        raise PermissionError("note belongs to another owner")

    for f in _WRITABLE:
        if f in row and row[f] is not None:
            setattr(note, f, row[f])

    if row.get("deleted"):
        note.deleted_at = utcnow_naive()
    elif "deleted" in row:
        note.deleted_at = None

    db.commit()
    db.refresh(note)
    return note_to_sync_dict(note)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -k push -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/note_sync.py tests/test_sync_notes_pull_push.py
git commit -m "feat(sync): apply_push_row client-authoritative upsert"
```

---

### Task 5: Sync router (`/api/sync/ping|pull|push`) + app.py wiring

**Files:**
- Create: `routes/sync_routes.py`
- Modify: `app.py` (one import + one `include_router` line in the router-registration block near the notes registration ~line 832)
- Test: `tests/test_sync_notes_pull_push.py`

**Interfaces:**
- Consumes: `pull_notes`, `apply_push_row` (Task 3/4); odysseus `require_user`, `SessionLocal`.
- Produces: `setup_sync_routes() -> APIRouter` with:
  - `GET /api/sync/ping` → `{"ok": True, "user": <owner>}`
  - `GET /api/sync/pull?cursor=&limit=` → `pull_notes(...)`
  - `POST /api/sync/push` body `{"rows": [ {id,...,deleted}, ... ]}` → `{"results": [sync_dict...]}`

- [ ] **Step 1: Write the failing test** (uses odysseus's ASGITransport + `x-test-user` pattern)

```python
# append to tests/test_sync_notes_pull_push.py
import httpx
from types import SimpleNamespace
from fastapi import FastAPI


class _Identity:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            hdrs = dict(scope.get("headers") or [])
            user = hdrs.get(b"x-test-user")
            scope.setdefault("state", {})
            scope["state"]["current_user"] = user.decode() if user else None
        await self.app(scope, receive, send)


def _sync_app(Session, monkeypatch):
    import routes.sync_routes as sr
    monkeypatch.setattr(sr, "SessionLocal", Session)
    app = FastAPI()
    app.state.auth_manager = SimpleNamespace(is_configured=True)
    app.include_router(sr.setup_sync_routes())
    return _Identity(app)


def _client(app):
    t = httpx.ASGITransport(app=app, client=("203.0.113.7", 54321))
    return httpx.AsyncClient(transport=t, base_url="http://sync.test")


async def test_push_then_pull_roundtrip(tmp_path, monkeypatch):
    _, Session = _temp_db(tmp_path)
    app = _sync_app(Session, monkeypatch)
    alice = {"x-test-user": "alice"}
    async with _client(app) as c:
        r = await c.post("/api/sync/push",
                         json={"rows": [{"id": "t1", "title": "Buy milk", "deleted": False}]},
                         headers=alice)
        assert r.status_code == 200
        pulled = (await c.get("/api/sync/pull", headers=alice)).json()
        assert [ch["title"] for ch in pulled["changes"]] == ["Buy milk"]


async def test_pull_requires_auth(tmp_path, monkeypatch):
    _, Session = _temp_db(tmp_path)
    app = _sync_app(Session, monkeypatch)
    async with _client(app) as c:
        r = await c.get("/api/sync/pull")   # no x-test-user
        assert r.status_code in (401, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -k "roundtrip or requires_auth" -v`
Expected: FAIL — `No module named 'routes.sync_routes'`.

- [ ] **Step 3: Implement the router**

```python
# routes/sync_routes.py
"""Local-first sync endpoints for the notes domain (browser cookie auth)."""
from fastapi import APIRouter, Request, HTTPException
from core.database import SessionLocal
from src.auth_helpers import require_user
from src.sync.note_sync import pull_notes, apply_push_row


def setup_sync_routes() -> APIRouter:
    router = APIRouter(prefix="/api/sync", tags=["sync"])

    def _owner(request: Request) -> str:
        user = require_user(request)
        if not user:
            raise HTTPException(401, "Authentication required")
        return user

    @router.get("/ping")
    async def ping(request: Request):
        return {"ok": True, "user": _owner(request)}

    @router.get("/pull")
    async def pull(request: Request, cursor: str | None = None, limit: int = 500):
        owner = _owner(request)
        limit = max(1, min(limit, 500))
        db = SessionLocal()
        try:
            return pull_notes(db, owner, cursor, limit)
        finally:
            db.close()

    @router.post("/push")
    async def push(request: Request):
        owner = _owner(request)
        body = await request.json()
        rows = body.get("rows") or []
        if len(rows) > 200:
            raise HTTPException(400, "too many rows (max 200)")
        db = SessionLocal()
        try:
            results = []
            for row in rows:
                try:
                    results.append(apply_push_row(db, owner, row))
                except PermissionError:
                    raise HTTPException(403, "forbidden")
            return {"results": results}
        finally:
            db.close()

    return router
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -k "roundtrip or requires_auth" -v`
Expected: PASS.

- [ ] **Step 5: Wire into app.py**

In `app.py`, in the router-registration block near the notes registration (~line 832), add:

```python
# Local-first sync (SPA at /app)
from routes.sync_routes import setup_sync_routes
app.include_router(setup_sync_routes())
```

- [ ] **Step 6: Full backend test run + commit**

Run: `python -m pytest tests/test_sync_notes_pull_push.py -v`
Expected: all PASS.

```bash
git add routes/sync_routes.py app.py tests/test_sync_notes_pull_push.py
git commit -m "feat(sync): /api/sync ping/pull/push router + app wiring"
```

---

### Task 6: Scaffold the `webapp/` Vite + React SPA

**Files:**
- Create: `webapp/package.json`, `webapp/vite.config.ts`, `webapp/tsconfig.json`, `webapp/index.html`, `webapp/src/main.tsx`, `webapp/src/App.tsx`
- Modify: `.gitignore`

**Interfaces:**
- Produces: a dev server (`npm run dev`) and a production build to `webapp/dist` whose assets are served under `/app-assets/` (`base` config), so paths resolve when odysseus serves it at `/app`.

- [ ] **Step 1: Add gitignore entries**

Append to `/home/elsiga/labspace/odysseus/.gitignore`:

```
# New SPA (webapp/) build + deps
webapp/node_modules/
webapp/dist/
```

- [ ] **Step 2: Create the SPA scaffold**

```json
// webapp/package.json
{
  "name": "odysseus-webapp",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": { "dexie": "^4.0.8", "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": {
    "@types/react": "^18.3.3", "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1", "fake-indexeddb": "^6.0.0",
    "typescript": "^5.5.4", "vite": "^5.4.0", "vite-plugin-pwa": "^0.20.5",
    "vitest": "^2.0.5"
  }
}
```

```ts
// webapp/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/app-assets/",
  plugins: [react(), VitePWA({ registerType: "autoUpdate" })],
  server: { proxy: { "/api": "http://localhost:7000" } },
  build: { outDir: "dist" },
});
```

```json
// webapp/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020", "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"], "module": "ESNext",
    "skipLibCheck": true, "moduleResolution": "bundler",
    "resolveJsonModule": true, "isolatedModules": true, "noEmit": true,
    "jsx": "react-jsx", "strict": true
  },
  "include": ["src"]
}
```

```html
<!-- webapp/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Odysseus Tasks</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```tsx
// webapp/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

```tsx
// webapp/src/App.tsx
export function App() {
  return <h1>Odysseus Tasks</h1>;
}
```

- [ ] **Step 3: Install and verify the build**

Run (on your Mac or wherever Node is available):
```bash
cd webapp && npm install && npm run build
```
Expected: `webapp/dist/index.html` and `webapp/dist/assets/*` produced, exit 0.

- [ ] **Step 4: Commit**

```bash
git add webapp/package.json webapp/vite.config.ts webapp/tsconfig.json webapp/index.html webapp/src/main.tsx webapp/src/App.tsx webapp/package-lock.json .gitignore
git commit -m "feat(webapp): scaffold Vite + React SPA"
```

---

### Task 7: Dexie local store + note repo (with outbox)

**Files:**
- Create: `webapp/src/db/db.ts`, `webapp/src/db/repo.ts`, `webapp/src/test-setup.ts`, `webapp/vitest.config.ts`
- Test: `webapp/src/db/db.test.ts`

**Interfaces:**
- Produces:
  - `NoteRow = { id; title; content; items; note_type; color; label; pinned; archived; due_date; sort_order; repeat; deleted; updated_at; _dirty: 0|1 }`
  - `OutboxRow = { seq?: number; id: string }`
  - `db` (Dexie) with tables `notes` (`id, updated_at, _dirty`), `outbox` (`++seq, id`), `syncMeta` (`key`).
  - Repo: `syncedPut(row)`, `createNote({title})`, `updateNote(id, patch)`, `deleteNote(id)`, `liveNotes(): Promise<NoteRow[]>` (excludes `deleted`, ordered by `sort_order` then `updated_at`).

- [ ] **Step 1: Write the failing test**

```ts
// webapp/src/db/db.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./db";
import { createNote, updateNote, deleteNote, liveNotes } from "./repo";

beforeEach(async () => { await db.delete(); await db.open(); });

describe("note repo", () => {
  it("create writes a dirty row and an outbox entry", async () => {
    const n = await createNote({ title: "Buy milk" });
    expect((await db.notes.get(n.id))!._dirty).toBe(1);
    expect(await db.outbox.count()).toBe(1);
  });

  it("update mutates fields and re-queues outbox", async () => {
    const n = await createNote({ title: "A" });
    await updateNote(n.id, { title: "B" });
    expect((await db.notes.get(n.id))!.title).toBe("B");
  });

  it("delete tombstones and hides from liveNotes", async () => {
    const n = await createNote({ title: "X" });
    await deleteNote(n.id);
    expect((await db.notes.get(n.id))!.deleted).toBe(true);
    expect(await liveNotes()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webapp && npx vitest run src/db/db.test.ts`
Expected: FAIL — cannot resolve `./db`.

- [ ] **Step 3: Implement**

```ts
// webapp/src/test-setup.ts
import "fake-indexeddb/auto";
```

```ts
// webapp/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["src/test-setup.ts"] },
});
```

```ts
// webapp/src/db/db.ts
import Dexie, { type Table } from "dexie";

export interface NoteRow {
  id: string; title: string; content: string | null; items: string | null;
  note_type: string; color: string | null; label: string | null;
  pinned: boolean; archived: boolean; due_date: string | null;
  sort_order: number; repeat: string; deleted: boolean;
  updated_at: string | null; _dirty: 0 | 1;
}
export interface OutboxRow { seq?: number; id: string; }
export interface KV { key: string; value: unknown; }

class AppDB extends Dexie {
  notes!: Table<NoteRow, string>;
  outbox!: Table<OutboxRow, number>;
  syncMeta!: Table<KV, string>;
  constructor() {
    super("odysseus-app");
    this.version(1).stores({
      notes: "id, updated_at, _dirty",
      outbox: "++seq, id",
      syncMeta: "key",
    });
  }
}
export const db = new AppDB();
```

```ts
// webapp/src/db/repo.ts
import { db, type NoteRow } from "./db";

let notifyLocalWrite: () => void = () => {};
export function setLocalWriteListener(fn: () => void) { notifyLocalWrite = fn; }

function newId(): string {
  return (crypto as any).randomUUID?.() ?? `id-${Date.now()}-${Math.floor(Math.random()*1e9)}`;
}

export async function syncedPut(row: NoteRow): Promise<void> {
  await db.transaction("rw", db.notes, db.outbox, async () => {
    await db.notes.put({ ...row, _dirty: 1 });
    await db.outbox.add({ id: row.id });
  });
  notifyLocalWrite();
}

export async function createNote({ title }: { title: string }): Promise<NoteRow> {
  const row: NoteRow = {
    id: newId(), title, content: null, items: null, note_type: "note",
    color: null, label: null, pinned: false, archived: false, due_date: null,
    sort_order: 0, repeat: "none", deleted: false, updated_at: null, _dirty: 1,
  };
  await syncedPut(row);
  return row;
}

export async function updateNote(id: string, patch: Partial<NoteRow>): Promise<void> {
  const existing = await db.notes.get(id);
  if (!existing) return;
  await syncedPut({ ...existing, ...patch, id });
}

export async function deleteNote(id: string): Promise<void> {
  const existing = await db.notes.get(id);
  if (!existing) return;
  await syncedPut({ ...existing, deleted: true });
}

export async function liveNotes(): Promise<NoteRow[]> {
  const all = await db.notes.toArray();
  return all
    .filter((n) => !n.deleted)
    .sort((a, b) => a.sort_order - b.sort_order || (a.updated_at ?? "").localeCompare(b.updated_at ?? ""));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webapp && npx vitest run src/db/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/db webapp/src/test-setup.ts webapp/vitest.config.ts
git commit -m "feat(webapp): Dexie store + note repo with outbox"
```

---

### Task 8: Sync client engine (push + pull + apply, dirty-aware)

**Files:**
- Create: `webapp/src/sync/engine.ts`, `webapp/src/sync/status.ts`
- Test: `webapp/src/sync/engine.test.ts`

**Interfaces:**
- Consumes: `db`, `NoteRow` (Task 7).
- Produces: `createSyncClient({ apiBase, fetchFn }) -> { syncOnce(): Promise<void>; start(): void; stop(): void }`.
  - `pushOnce`: reads distinct outbox ids, POSTs `{rows:[NoteRow-without-meta...]}` to `${apiBase}/push`; on 2xx clears those outbox rows and marks pushed notes `_dirty:0`.
  - `pullOnce`: GET `${apiBase}/pull?cursor=<c>`, applies each change to `notes` **only when the local row is not `_dirty`** (never clobber unsynced edits), persists `syncMeta['cursor']`, loops while `hasMore`.

- [ ] **Step 1: Write the failing test** (mocked `fetch`)

```ts
// webapp/src/sync/engine.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db";
import { createNote, liveNotes } from "../db/repo";
import { createSyncClient } from "./engine";

beforeEach(async () => { await db.delete(); await db.open(); });

function fakeFetch(handlers: Record<string, (url: URL, init?: RequestInit) => any>) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://t");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = handlers[key](url, init);
    return { ok: true, status: 200, json: async () => body } as Response;
  };
}

describe("sync engine", () => {
  it("push sends dirty rows then clears the outbox", async () => {
    const n = await createNote({ title: "Buy milk" });
    let pushed: any = null;
    const fetchFn = fakeFetch({
      "POST /api/sync/push": (_u, init) => { pushed = JSON.parse(init!.body as string); return { results: [] }; },
      "GET /api/sync/pull": () => ({ changes: [], cursor: "", hasMore: false }),
    });
    const client = createSyncClient({ apiBase: "/api/sync", fetchFn });
    await client.syncOnce();
    expect(pushed.rows[0].id).toBe(n.id);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.notes.get(n.id))!._dirty).toBe(0);
  });

  it("pull inserts a server row but does not clobber a dirty local row", async () => {
    const dirty = await createNote({ title: "local edit" });
    const fetchFn = fakeFetch({
      "POST /api/sync/push": () => ({ results: [] }),
      "GET /api/sync/pull": (url) => url.searchParams.get("cursor")
        ? { changes: [], cursor: url.searchParams.get("cursor"), hasMore: false }
        : { changes: [
              { id: "srv1", title: "from server", deleted: false, updated_at: "2026-07-21T10:00:00", sort_order: 0, note_type: "note", repeat: "none", pinned: false, archived: false, content: null, items: null, color: null, label: null, due_date: null },
              { id: dirty.id, title: "SERVER WINS?", deleted: false, updated_at: "2026-07-21T10:00:00", sort_order: 0, note_type: "note", repeat: "none", pinned: false, archived: false, content: null, items: null, color: null, label: null, due_date: null },
            ], cursor: "2026-07-21T10:00:00|srv1", hasMore: false },
    });
    const client = createSyncClient({ apiBase: "/api/sync", fetchFn });
    await client.syncOnce();
    const titles = (await liveNotes()).map((n) => n.title).sort();
    expect(titles).toContain("from server");
    expect((await db.notes.get(dirty.id))!.title).toBe("local edit"); // not clobbered
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webapp && npx vitest run src/sync/engine.test.ts`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Implement**

```ts
// webapp/src/sync/status.ts
export type SyncStatus = "idle" | "syncing" | "offline" | "error";
let status: SyncStatus = "idle";
const subs = new Set<() => void>();
export function getSyncStatus() { return status; }
export function setSyncStatus(s: SyncStatus) { status = s; subs.forEach((f) => f()); }
export function subscribeSyncStatus(fn: () => void) { subs.add(fn); return () => subs.delete(fn); }
```

```ts
// webapp/src/sync/engine.ts
import { db, type NoteRow } from "../db/db";
import { setLocalWriteListener } from "../db/repo";
import { setSyncStatus } from "./status";

const META_FIELDS = new Set(["_dirty"]);
const CURSOR_KEY = "cursor";

export interface SyncClient { syncOnce(): Promise<void>; start(): void; stop(): void; }
interface Opts { apiBase: string; fetchFn?: typeof fetch; }

function stripMeta(row: NoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!META_FIELDS.has(k)) out[k] = v;
  return out;
}

export function createSyncClient(opts: Opts): SyncClient {
  const f = opts.fetchFn ?? fetch;
  let timer: number | undefined;
  let running = false;

  async function pushOnce(): Promise<void> {
    const outbox = await db.outbox.toArray();
    if (outbox.length === 0) return;
    const ids = [...new Set(outbox.map((o) => o.id))];
    const rows = (await db.notes.bulkGet(ids)).filter(Boolean) as NoteRow[];
    const res = await f(`${opts.apiBase}/push`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: rows.map(stripMeta) }),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
    await db.transaction("rw", db.notes, db.outbox, async () => {
      await db.outbox.bulkDelete(outbox.map((o) => o.seq!) as number[]);
      for (const r of rows) {
        const cur = await db.notes.get(r.id);
        if (cur && cur._dirty === 1) await db.notes.put({ ...cur, _dirty: 0 });
      }
    });
  }

  async function pullOnce(): Promise<void> {
    for (;;) {
      const meta = await db.syncMeta.get(CURSOR_KEY);
      const cursor = (meta?.value as string) ?? "";
      const url = `${opts.apiBase}/pull?cursor=${encodeURIComponent(cursor)}&limit=500`;
      const res = await f(url);
      if (!res.ok) throw new Error(`pull ${res.status}`);
      const page = await res.json();
      await db.transaction("rw", db.notes, db.syncMeta, async () => {
        for (const ch of page.changes as any[]) {
          const local = await db.notes.get(ch.id);
          if (local && local._dirty === 1) continue; // never clobber unsynced edits
          await db.notes.put({ ...(ch as NoteRow), _dirty: 0 });
        }
        await db.syncMeta.put({ key: CURSOR_KEY, value: page.cursor });
      });
      if (!page.hasMore) break;
    }
  }

  async function syncOnce(): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSyncStatus("offline"); return;
    }
    setSyncStatus("syncing");
    try { await pushOnce(); await pullOnce(); setSyncStatus("idle"); }
    catch { setSyncStatus("error"); }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void syncOnce(); }, 1500) as unknown as number;
  }

  return {
    syncOnce,
    start() {
      if (running) return;
      running = true;
      setLocalWriteListener(schedule);
      if (typeof window !== "undefined") window.addEventListener("online", () => void syncOnce());
      void syncOnce();
    },
    stop() { running = false; if (timer) clearTimeout(timer); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webapp && npx vitest run src/sync/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/sync
git commit -m "feat(webapp): sync engine push/pull with dirty-aware apply"
```

---

### Task 9: Wire the SPA together — Tasks screen + live sync

**Files:**
- Create: `webapp/src/ui/TasksScreen.tsx`
- Modify: `webapp/src/App.tsx`

**Interfaces:**
- Consumes: repo (`createNote`, `updateNote`, `deleteNote`, `liveNotes`), `createSyncClient`, `subscribeSyncStatus`/`getSyncStatus`.
- Produces: a working screen (add via input, toggle title edit, delete) that reflects Dexie state and shows sync status; a module-level sync client `start()`ed once.

- [ ] **Step 1: Implement the screen and app**

```tsx
// webapp/src/ui/TasksScreen.tsx
import { useEffect, useState, useSyncExternalStore } from "react";
import { createNote, deleteNote, liveNotes, type } from "../db/repo";
import type { NoteRow } from "../db/db";
import { getSyncStatus, subscribeSyncStatus } from "../sync/status";

export function TasksScreen() {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [title, setTitle] = useState("");
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus);

  async function refresh() { setNotes(await liveNotes()); }
  useEffect(() => { void refresh(); const i = setInterval(refresh, 1000); return () => clearInterval(i); }, []);

  async function add() {
    if (!title.trim()) return;
    await createNote({ title: title.trim() });
    setTitle(""); void refresh();
  }

  return (
    <div style={{ maxWidth: 520, margin: "2rem auto", fontFamily: "system-ui" }}>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Tasks</h1><small>sync: {status}</small>
      </header>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a task…" style={{ flex: 1 }} />
        <button onClick={add}>Add</button>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.id} style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{n.title}</span>
            <button onClick={async () => { await deleteNote(n.id); void refresh(); }}>✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Note: remove the stray `type` import above — import only what exists:
```tsx
import { createNote, deleteNote, liveNotes } from "../db/repo";
```

```tsx
// webapp/src/App.tsx
import { useEffect } from "react";
import { TasksScreen } from "./ui/TasksScreen";
import { createSyncClient } from "./sync/engine";

const sync = createSyncClient({ apiBase: "/api/sync" });

export function App() {
  useEffect(() => { sync.start(); return () => sync.stop(); }, []);
  return <TasksScreen />;
}
```

- [ ] **Step 2: Typecheck + build**

Run: `cd webapp && npm run build`
Expected: exit 0, `webapp/dist` produced.

- [ ] **Step 3: Commit**

```bash
git add webapp/src/ui webapp/src/App.tsx
git commit -m "feat(webapp): Tasks screen wired to repo + live sync"
```

---

### Task 10: Serve the SPA from odysseus at `/app`

**Files:**
- Modify: `app.py` (StaticFiles mount + two routes, in the static-serving area near line 480–496 and the page-route block near line 867+)

**Interfaces:**
- Consumes: the built `webapp/dist`.
- Produces: `GET /app` and `GET /app/{path:path}` serve `webapp/dist/index.html`; `/app-assets/*` serves hashed build assets. Isolated prefix — no existing route is affected.

- [ ] **Step 1: Add the mount + routes**

Near the existing `app.mount("/static", ...)` in `app.py`, add:

```python
WEBAPP_DIST = abs_join(BASE_DIR, "webapp/dist")
if os.path.isdir(WEBAPP_DIST):
    app.mount("/app-assets", StaticFiles(directory=abs_join(WEBAPP_DIST, "assets")), name="app-assets")
```

Near the explicit page routes (e.g. after `serve_index`), add:

```python
@app.get("/app")
@app.get("/app/{path:path}")
async def serve_webapp(request: Request, path: str = ""):
    index = abs_join(WEBAPP_DIST, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    raise HTTPException(404, "webapp not built (run: cd webapp && npm run build)")
```

(`FileResponse` is imported in `app.py`; if not, add `from fastapi.responses import FileResponse` at the top with the other response imports.)

- [ ] **Step 2: Manual verification (documented, run locally)**

```bash
cd webapp && npm run build && cd ..
docker compose up -d --build     # or restart the running app so it picks up webapp/dist
```
Then in a browser logged into odysseus:
1. Open `https://chat.elsiga.ch/app` (or `http://localhost:7000/app`) → the Tasks screen loads, `sync: idle`.
2. Add "Buy milk" → it appears; within ~2s `sync` flips `syncing`→`idle`.
3. Open odysseus's existing Notes view → "Buy milk" is present (proves push hit the real `notes` table).
4. In DevTools, go offline, add "Offline task", reload `/app` → it's still listed (IndexedDB), `sync: offline`.
5. Go back online → it syncs and appears in Notes.

- [ ] **Step 3: Commit**

```bash
git add app.py
git commit -m "feat(sync): serve local-first SPA at /app"
```

---

### Task 11: PWA offline-shell verification

**Files:**
- Modify: `webapp/vite.config.ts` (PWA manifest/caching already added in Task 6; confirm it precaches the shell)

**Interfaces:**
- Produces: a service worker that precaches the app shell so `/app` cold-loads offline.

- [ ] **Step 1: Confirm PWA config precaches the shell**

Ensure `webapp/vite.config.ts` `VitePWA` includes:
```ts
VitePWA({
  registerType: "autoUpdate",
  manifest: { name: "Odysseus Tasks", short_name: "Tasks", start_url: "/app", display: "standalone" },
  workbox: { navigateFallback: "/app-assets/index.html", globPatterns: ["**/*.{js,css,html}"] },
})
```

- [ ] **Step 2: Manual verification**

```bash
cd webapp && npm run build && cd .. && docker compose up -d
```
In the browser: load `/app` once (registers SW), then DevTools → Application → Service Workers → check "Offline", reload → the shell still renders (from SW cache) and shows cached notes. Re-online → sync resumes.

- [ ] **Step 3: Commit**

```bash
git add webapp/vite.config.ts
git commit -m "feat(webapp): PWA offline app shell"
```

---

### Task 12: Adapt visual language to the odysseus prototype

**Files:**
- Modify: `webapp/src/ui/TasksScreen.tsx` (+ a small `webapp/src/ui/theme.css` if useful)
- Reference (read-only): `design/Tasks + Calendar Prototype.dc.html`, `design/Screens.dc.html`

**Interfaces:** no API change — visual only.

- [ ] **Step 1: Extract the design tokens**

Open `design/Tasks + Calendar Prototype.dc.html` and record: the font stack, the color variables (background, surface, text, accent), border-radius, and the task-row layout. Cross-check against odysseus's existing tokens in `static/` (e.g. CSS custom properties in `static/index.html`/`static/css`) so the SPA reads as part of odysseus.

- [ ] **Step 2: Apply tokens to the Tasks screen**

Replace the inline styles in `TasksScreen.tsx` with the prototype's tokens (font, colors, radius, spacing). Keep it a single screen — day/week/calendar views are Slice 2. Verify light/dark parity with odysseus if it themes.

- [ ] **Step 3: Rebuild + eyeball against the prototype**

```bash
cd webapp && npm run build
```
Load `/app`, compare side-by-side with the prototype screenshot; adjust until it reads as native odysseus.

- [ ] **Step 4: Commit**

```bash
git add webapp/src/ui
git commit -m "style(webapp): match odysseus design language from prototype"
```

---

## Self-Review

**Spec coverage (against the program design doc §6 Slice 1 = "SPA + sync foundation + tasks offline, served by odysseus as a browser PWA, thinnest vertical proving the local-first ↔ odysseus loop"):**
- SPA scaffold → Task 6. Local store → Task 7. Sync engine → Task 8. Tasks UI → Task 9. Served by odysseus → Task 10. Offline PWA → Task 11. odysseus sync endpoints over the `Note` domain → Tasks 1–5. Design integration → Task 12. ✅ All Slice 1 spec points map to a task.
- Deferred by design (not gaps): `ody_` token auth (Android slice), calendar/Pomodoro (Slice 2), per-field/HLC sync (only if multi-device ever needs it).

**Placeholder scan:** No "TBD/TODO/handle edge cases"; every code step carries real code and a real command. One deliberate correction is called out inline in Task 9 (remove the stray `type` import) — kept visible rather than hidden so the implementer doesn't copy the wrong line.

**Type consistency:** `NoteRow`/`OutboxRow` defined in `db.ts` (Task 7) and consumed unchanged in `repo.ts`, `engine.ts` (Task 8), `TasksScreen.tsx` (Task 9). Backend `note_to_sync_dict` keys (Task 2) match the `NoteRow` fields the client applies (Task 8) — `id,title,content,items,note_type,color,label,pinned,archived,due_date,sort_order,repeat,deleted,updated_at`. `createSyncClient({apiBase, fetchFn})` signature is identical in engine and its tests and App.tsx.

**Known risk carried forward (documented, not a Slice 1 blocker):** the LWW model is client-authoritative on push + dirty-aware on pull — correct for single-user. Cross-device same-record concurrent edits resolve last-sync-wins; revisit only if multi-device per-field merge is ever needed (would adopt ember's HLC/change_log then).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-slice1-spa-sync-foundation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
