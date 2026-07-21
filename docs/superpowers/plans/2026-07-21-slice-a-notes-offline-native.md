# Slice A — Notes/Todos Offline, Native — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make odysseus's own Notes/todos domain work offline on mobile — edits happen in a local store and sync back to odysseus's real `notes` table on reconnect — while the web behaves as a normal always-online screen, all through one local-first data path.

**Architecture:** Retire the Slice-1 standalone-SPA spike. On the backend, add a generic append-only `sync_change_log` fed by SQLAlchemy mapper listeners on `Note`, a `rev` column for optimistic concurrency, and `/api/sync/pull|push` endpoints that reconcile with **per-record last-write-wins tie-broken by a client `editedAt` timestamp**, routing writes through **extracted note-CRUD service functions** (one source of truth). On the client, re-home the ported Dexie sync engine into a committed, dev-time-built ES module under `static/js/productivity/`, exposing a `notesRepo`. Refactor the existing `static/js/notes.js` data access onto `notesRepo` without touching its UI.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy (SQLite) backend; vanilla-JS ES modules (no runtime build step) frontend; TypeScript sync engine bundled with esbuild → committed JS; Dexie (IndexedDB) local store; pytest (house `asyncio.run` pattern, **no pytest-asyncio**) + vitest.

## Global Constraints

- **No runtime build step in odysseus.** The `static/js/productivity/` bundle is a *committed* build artifact; only the TS engine source triggers a rebuild, run on the Node box. `static/index.html` loads it as a plain `<script type="module">`. — spec §3.2, §8.
- **Per-record LWW only.** No per-field HLC, no CRDT/OT. Tie-break by client-stamped `editedAt`; `updated_at = max(current, editedAt)` (monotonic, never rewinds). — spec §4.
- **One source of truth for domain writes.** The sync push must call the *same* extracted note-CRUD functions the HTTP routes call — never a re-implemented row mutation. — spec §3.1.
- **Owner-scoped throughout.** `require_user(request)` with single-user `FALLBACK_OWNER = os.environ.get("ODYSSEUS_FALLBACK_OWNER", "owner@localhost")` fallback (mirrors `routes/sync_routes.py` / `calendar_routes`). Ownership gate: `if user is not None and row.owner != user: 404`. — `note_routes.py`, `sync_routes.py`.
- **Note PK is an app-side `str(uuid.uuid4())` string UUID.** Offline creates mint their own UUID and push it verbatim — **no temp-ID→server-ID remapping**. — spec §2.
- **Backend tests use the house pattern:** each `def test_*` wraps an inner `async def _run()` and ends with `asyncio.run(_run())`; per-test temp SQLite (`tmp_path`, `NullPool`, `check_same_thread=False`); `SessionLocal`/`engine` monkeypatched onto the route module; auth injected via an `_Identity` ASGI shim setting `scope["state"]["current_user"]`. — `tests/test_sync_routes.py`.
- **`items` is a JSON string** column on `notes` (`[{text, done}]`); mutating it in place requires `flag_modified(note, "items")`. — `note_routes.py`.
- **Additive migrations only**, via the `_migrate_add_*` SQLite `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` pattern, wired into `init_db()` in `core/database.py`. — spec §7.

---

## Phase 1 — Cleanup (retire the Slice-1 spike)

Pure deletion; each task leaves the backend test suite green. Do this first to clear the field (spec §7 ordering).

### Task 1: Remove the `/app` SPA serving

**Files:**
- Modify: `app.py:519-536` (remove `_SpaStatic` class + `WEBAPP_DIST` + the `/app` mount)
- Delete: `tests/test_app_spa.py`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (removal only). No other module imports `_SpaStatic` or `WEBAPP_DIST`.

- [ ] **Step 1: Confirm nothing else references the removed symbols**

Run: `grep -rn "_SpaStatic\|WEBAPP_DIST\|/app\"" app.py routes/ src/ tests/`
Expected: matches only in `app.py:519-536` and `tests/test_app_spa.py`. If `_StarletteHTTPException` / `StaticFiles` are used elsewhere in `app.py`, leave their imports; otherwise remove the now-unused imports too.

- [ ] **Step 2: Delete the SPA-serving block in `app.py`**

Remove lines 519–536 (the `_SpaStatic` class, the `WEBAPP_DIST = ...` line, and the `if os.path.isdir(WEBAPP_DIST): app.mount("/app", ...)` block). If `StaticFiles` and `_StarletteHTTPException` are imported solely for this block (verify via grep in Step 1), remove those imports as well.

- [ ] **Step 3: Delete the SPA test**

Run: `git rm tests/test_app_spa.py`

- [ ] **Step 4: Verify the app imports and the suite is green**

Run: `python -c "import app"` then `python -m pytest tests/ -q`
Expected: `import app` succeeds with no error; pytest passes (the sync tests still exist at this point and pass; `test_app_spa.py` is gone).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(cleanup): remove /app SPA serving (retire Slice-1 spike)"
```

### Task 2: Delete the `webapp/` React SPA

**Files:**
- Delete: `webapp/` (entire directory — React/Vite SPA source; `webapp/dist` is gitignored)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. The Python backend has zero import dependency on `webapp/` after Task 1.

- [ ] **Step 1: Confirm no backend reference remains**

Run: `grep -rn "webapp" app.py routes/ src/ core/ tests/ --include=*.py`
Expected: no matches (Task 1 removed the only reference, `WEBAPP_DIST`).

- [ ] **Step 2: Remove the directory**

Run: `git rm -r webapp`

- [ ] **Step 3: Verify boot + suite**

Run: `python -c "import app"` then `python -m pytest tests/ -q`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(cleanup): delete webapp/ React SPA (superseded by native offline layer)"
```

---

## Phase 2 — Backend: per-record LWW sync over the native `notes` table

Each task ends green. The dependency order is: `rev` column → generic `sync_change_log` → `Note` listeners → extracted note-CRUD service → per-record apply/pull → route + wire. The per-field HLC modules (`hlc.py`, `winners.py`) and their tests are removed in the task that rewrites their only consumers (apply/pull), so no task leaves a broken import.

### Task 3: Add the `rev` column to `Note`

**Files:**
- Modify: `core/database.py` (the `class Note` definition ~L1704; add a `_migrate_add_notes_rev()` fn near the other `_migrate_add_*`; call it in `init_db()` in the L1929–1969 block)
- Test: `tests/test_note_rev_migration.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `Note.rev` — `Column(Integer, nullable=False, default=1, server_default="1")`. New notes start at `rev=1`. Later tasks bump it on every write.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_note_rev_migration.py
import sqlite3
import core.database as db


def test_notes_table_has_rev_column(tmp_path, monkeypatch):
    db_file = tmp_path / "t.db"
    monkeypatch.setattr(db, "DATABASE_URL", f"sqlite:///{db_file}")
    from sqlalchemy import create_engine
    eng = create_engine(f"sqlite:///{db_file}")
    monkeypatch.setattr(db, "engine", eng)
    db.Base.metadata.create_all(bind=eng, tables=[db.Note.__table__])
    # simulate a pre-existing DB without rev by dropping the column path:
    db._migrate_add_notes_rev()  # idempotent — safe on a table that already has it
    conn = sqlite3.connect(db_file)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(notes)").fetchall()]
    conn.close()
    assert "rev" in cols
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_note_rev_migration.py -q`
Expected: FAIL — `AttributeError: module 'core.database' has no attribute '_migrate_add_notes_rev'` (and/or `Note` has no `rev`).

- [ ] **Step 3: Add the model column and the migration**

In `core/database.py`, add to `class Note` (alongside the other columns):

```python
    rev = Column(Integer, nullable=False, default=1, server_default="1")
```

Add the migration function next to the other `_migrate_add_*` definitions:

```python
def _migrate_add_notes_rev():
    """Add the monotonic `rev` column to notes if it doesn't exist (per-record LWW)."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(notes)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "rev" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 1")
        conn.commit()
    except Exception as e:
        logging.getLogger(__name__).warning(f"notes rev migration failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
```

Wire the call into `init_db()` in the `_migrate_add_*` block (near L1932, next to `_migrate_add_notes_sort_order()`):

```python
    _migrate_add_notes_rev()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_note_rev_migration.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/database.py tests/test_note_rev_migration.py
git commit -m "feat(sync): add monotonic rev column to notes (per-record LWW)"
```

### Task 4: Replace the sync tables with a generic `sync_change_log`

**Files:**
- Modify: `src/sync/models.py` (drop `SyncTask`; redesign `SyncChangeLog`; keep `create_sync_tables`)
- Test: `tests/test_sync_change_log_model.py` (create)

**Interfaces:**
- Consumes: `core.database.Base`, `utcnow_naive`.
- Produces:
  - `class SyncChangeLog(Base)` with columns: `seq` (Integer PK, autoincrement), `owner` (String, indexed, not null), `entity` (String, not null), `entity_id` (String, indexed, not null), `op` (String, not null — one of `"upsert"`/`"delete"`), `rev` (Integer, not null), `created_at` (DateTime, default `utcnow_naive`).
  - `create_sync_tables(engine)` — creates `SyncChangeLog.__table__` only.
  - `SyncTask` is **removed**.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_change_log_model.py
from sqlalchemy import create_engine, inspect
import src.sync.models as m


def test_sync_change_log_schema(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}")
    m.create_sync_tables(eng)
    cols = {c["name"] for c in inspect(eng).get_columns("sync_change_log")}
    assert cols == {"seq", "owner", "entity", "entity_id", "op", "rev", "created_at"}
    assert not hasattr(m, "SyncTask")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_change_log_model.py -q`
Expected: FAIL — current `sync_change_log` has `fields/deviceId/entityId` (camelCase) and `SyncTask` still exists.

- [ ] **Step 3: Rewrite `src/sync/models.py`**

```python
"""Sync-infra tables over odysseus's native domains (not a domain table).
Generic append-only change log: records WHAT changed, per owner, for the pull cursor."""
from sqlalchemy import Column, String, Integer, DateTime
from core.database import Base, utcnow_naive


class SyncChangeLog(Base):
    __tablename__ = "sync_change_log"
    seq = Column(Integer, primary_key=True, autoincrement=True)
    owner = Column(String, index=True, nullable=False)
    entity = Column(String, nullable=False)              # e.g. "note"
    entity_id = Column(String, index=True, nullable=False)
    op = Column(String, nullable=False)                  # "upsert" | "delete"
    rev = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)


def create_sync_tables(engine):
    Base.metadata.create_all(engine, tables=[SyncChangeLog.__table__])
```

Note: the old `sync_task` table is abandoned in the DB; it is harmless (unused) and needs no destructive migration for a single self-hosted user. Do not add a drop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_sync_change_log_model.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/models.py tests/test_sync_change_log_model.py
git commit -m "feat(sync): generic sync_change_log schema (seq/owner/entity/op/rev); drop sync_task"
```

### Task 5: `Note` mapper listeners → append change-log rows

**Files:**
- Create: `src/sync/listeners.py`
- Test: `tests/test_sync_listeners.py` (create)

**Interfaces:**
- Consumes: `Note` (from `core.database`), `SyncChangeLog` (from `src.sync.models`), SQLAlchemy `event`.
- Produces:
  - `register_note_listeners()` — idempotent; attaches `after_insert`/`after_update`/`after_delete` on `Note`. Each listener inserts a `SyncChangeLog` row into the same session/connection: `op="upsert"` for insert/update, `op="delete"` for delete, copying `owner`, `entity="note"`, `entity_id=note.id`, `rev=note.rev`.
  - Listeners bump `rev` on write: the `after_update`/`after_insert` path must ensure the log's `rev` equals the note's post-write `rev`. (The service layer in Task 6 is responsible for incrementing `note.rev`; the listener only records it.)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_listeners.py
import uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import core.database as db
from src.sync.models import SyncChangeLog, create_sync_tables
from src.sync.listeners import register_note_listeners


def _session(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    create_sync_tables(eng)
    register_note_listeners()
    return sessionmaker(bind=eng)()


def test_insert_update_delete_log_rows(tmp_path):
    s = _session(tmp_path)
    nid = str(uuid.uuid4())
    n = db.Note(id=nid, owner="alice", title="hi", rev=1)
    s.add(n); s.commit()
    n.title = "bye"; n.rev = 2; s.commit()
    s.delete(n); s.commit()
    rows = s.query(SyncChangeLog).order_by(SyncChangeLog.seq).all()
    ops = [(r.entity, r.entity_id, r.op, r.rev) for r in rows]
    assert ops == [("note", nid, "upsert", 1), ("note", nid, "upsert", 2), ("note", nid, "delete", 2)]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_listeners.py -q`
Expected: FAIL — `ModuleNotFoundError: src.sync.listeners`.

- [ ] **Step 3: Write `src/sync/listeners.py`**

```python
"""Net-new SQLAlchemy mapper listeners on Note → append rows to sync_change_log.
Catches every write path (web UI, agents, and the sync push itself)."""
import logging
from sqlalchemy import event, insert
from sqlalchemy.exc import OperationalError
from core.database import Note
from src.sync.models import SyncChangeLog

_REGISTERED = False


def _log(connection, note, op):
    # Listeners are registered globally on the Note mapper. If a caller's DB has
    # no sync_change_log (isolated unit tests, or sync infra not yet initialized),
    # skip logging rather than crash the domain write.
    try:
        connection.execute(
            insert(SyncChangeLog.__table__).values(
                owner=note.owner, entity="note", entity_id=note.id, op=op, rev=note.rev,
            )
        )
    except OperationalError as e:
        if "no such table" in str(e).lower():
            return
        logging.getLogger(__name__).warning(f"sync_change_log append failed: {e}")


def register_note_listeners():
    global _REGISTERED
    if _REGISTERED:
        return
    event.listen(Note, "after_insert", lambda m, c, t: _log(c, t, "upsert"))
    event.listen(Note, "after_update", lambda m, c, t: _log(c, t, "upsert"))
    event.listen(Note, "after_delete", lambda m, c, t: _log(c, t, "delete"))
    _REGISTERED = True
```

Note: listeners use the mapper-provided `connection` (not a new Session) so the log row commits atomically with the domain write. `insert(...).values(...)` is used instead of ORM `Session.add` because we're inside a flush.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_sync_listeners.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/listeners.py tests/test_sync_listeners.py
git commit -m "feat(sync): Note after_insert/update/delete listeners append to sync_change_log"
```

### Task 6: Extract note CRUD into callable service functions

**Files:**
- Create: `routes/note/note_service.py`
- Modify: `routes/note/note_routes.py` (rewire `create_note`/`update_note`/`delete_note`/`toggle_item` handlers onto the service; keep `_owner`/`_reserve_note_uploads` in the route)
- Test: `tests/test_note_service.py` (create)

**Interfaces:**
- Consumes: `Note` (`core.database`), `flag_modified` (`sqlalchemy.orm.attributes`), the `NoteCreate`/`NoteUpdate` field set.
- Produces (all take an open `db` Session + `owner`, mutate + `commit` + `refresh`, and **bump `rev`** on write so the listener records the new version; ownership gate raises `LookupError` for not-found/forbidden so the caller maps it to 404):
  - `create_note_record(db, owner, data: dict) -> Note` — mints `id=str(uuid.uuid4())`, `rev=1`, sets `updated_at` if `data` carries `edited_at`.
  - `update_note_record(db, owner, note_id: str, data: dict) -> Note` — field-by-field `if k in data` mutation (mirrors the handler's `if body.x is not None`), `flag_modified(note, "items")` when `items` present, `note.rev += 1`, `note.updated_at = max(note.updated_at, edited_at)` when `edited_at` in `data`.
  - `delete_note_record(db, owner, note_id: str) -> None`.
  - `toggle_item_record(db, owner, note_id: str, index: int) -> list` — returns the mutated items list.
- **Side-effect note:** none of these fire reminders/AI/scheduler (verified — those live only in the separate `fire_reminder` route). Upload-reservation stays in the *route* wrapper (`_reserve_note_uploads` needs the closure's `upload_handler`); the service is pure row logic.

- [ ] **Step 1: Write the failing test (parity + rev bump)**

```python
# tests/test_note_service.py
import uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import core.database as db
from routes.note.note_service import (
    create_note_record, update_note_record, delete_note_record, toggle_item_record,
)


def _s(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    return sessionmaker(bind=eng)()


def test_create_then_update_bumps_rev_and_items(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T", "items": [{"text": "a", "done": False}]})
    assert n.rev == 1 and n.owner == "alice"
    nid = n.id
    n2 = update_note_record(s, "alice", nid, {"items": [{"text": "a", "done": True}]})
    assert n2.rev == 2
    import json
    assert json.loads(n2.items)[0]["done"] is True


def test_delete_and_toggle(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T", "items": [{"text": "a", "done": False}]})
    items = toggle_item_record(s, "alice", n.id, 0)
    assert items[0]["done"] is True
    delete_note_record(s, "alice", n.id)
    assert s.query(db.Note).filter(db.Note.id == n.id).first() is None


def test_ownership_gate(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T"})
    try:
        update_note_record(s, "bob", n.id, {"title": "X"})
        assert False, "expected LookupError"
    except LookupError:
        pass
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_note_service.py -q`
Expected: FAIL — `ModuleNotFoundError: routes.note.note_service`.

- [ ] **Step 3: Write `routes/note/note_service.py`**

```python
"""Callable note CRUD — the single source of truth for note writes, shared by the
HTTP routes and the sync push. Pure row logic (no upload reservation, no reminders)."""
import json
import uuid
from sqlalchemy.orm.attributes import flag_modified
from core.database import Note

_CREATE_FIELDS = ("title", "content", "note_type", "color", "label", "pinned",
                  "due_date", "source", "session_id", "image_url", "repeat", "sort_order")
_UPDATE_FIELDS = ("title", "content", "note_type", "color", "label", "pinned",
                  "archived", "due_date", "image_url", "repeat", "sort_order",
                  "agent_session_id")


def _gate(note, owner):
    if note is None:
        raise LookupError("Note not found")
    if owner is not None and note.owner != owner:
        raise LookupError("Note not found")


def _apply_edited_at(note, data):
    edited_at = data.get("edited_at")
    if edited_at is not None:
        note.updated_at = max(note.updated_at, edited_at) if note.updated_at else edited_at


def create_note_record(db, owner, data: dict) -> Note:
    note = Note(
        id=data.get("id") or str(uuid.uuid4()),
        owner=owner,
        rev=1,
        items=json.dumps(data["items"]) if data.get("items") is not None else None,
        note_type=data.get("note_type", "note"),
        repeat=data.get("repeat") or "none",
        sort_order=data.get("sort_order") if data.get("sort_order") is not None else 0,
    )
    for f in _CREATE_FIELDS:
        if f in data and f not in ("note_type", "repeat", "sort_order"):
            setattr(note, f, data[f])
    _apply_edited_at(note, data)
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


def update_note_record(db, owner, note_id: str, data: dict) -> Note:
    note = db.query(Note).filter(Note.id == note_id).first()
    _gate(note, owner)
    for f in _UPDATE_FIELDS:
        if f in data and data[f] is not None:
            setattr(note, f, data[f])
    if data.get("items") is not None:
        note.items = json.dumps(data["items"])
        flag_modified(note, "items")
    note.rev = (note.rev or 1) + 1
    _apply_edited_at(note, data)
    db.commit()
    db.refresh(note)
    return note


def delete_note_record(db, owner, note_id: str) -> None:
    note = db.query(Note).filter(Note.id == note_id).first()
    _gate(note, owner)
    db.delete(note)
    db.commit()


def toggle_item_record(db, owner, note_id: str, index: int) -> list:
    note = db.query(Note).filter(Note.id == note_id).first()
    _gate(note, owner)
    if not note.items:
        raise ValueError("Note has no checklist items")
    items = json.loads(note.items)
    if index < 0 or index >= len(items):
        raise ValueError(f"Item index {index} out of range")
    items[index]["done"] = not items[index].get("done", False)
    note.items = json.dumps(items)
    flag_modified(note, "items")
    note.rev = (note.rev or 1) + 1
    db.commit()
    return items
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `python -m pytest tests/test_note_service.py -q`
Expected: PASS.

- [ ] **Step 5: Rewire the route handlers onto the service (behavior-preserving)**

In `routes/note/note_routes.py`, replace the inline bodies of `create_note`, `update_note`, `delete_note`, and `toggle_item` with calls to the service, keeping the existing `_owner`/`_reserve_note_uploads`/`_note_to_dict` wrappers and the `HTTPException` mapping. Example for `update_note`:

```python
    @router.put("/{note_id}")
    def update_note(request: Request, note_id: str, body: NoteUpdate):
        user = _owner(request)
        _reserve_note_uploads(
            user, body.image_url, body.color, body.content,
            json.dumps(body.items) if body.items is not None else None,
        )
        db = SessionLocal()
        try:
            data = body.model_dump(exclude_unset=True)
            note = update_note_record(db, user, note_id, data)
            return _note_to_dict(note)
        except LookupError:
            raise HTTPException(404, "Note not found")
        finally:
            db.close()
```

Apply the analogous rewrite to `create_note` (use `create_note_record`; keep the `_reserve_note_uploads` call), `delete_note` (map `LookupError`→404, return `{"ok": True}`), and `toggle_item` (map `LookupError`→404 and `ValueError`→400, return `{"ok": True, "items": items}`). Add the import at the top: `from routes.note.note_service import create_note_record, update_note_record, delete_note_record, toggle_item_record`.

- [ ] **Step 6: Verify the existing note-route tests still pass (parity)**

Run: `python -m pytest tests/ -q -k "note"`
Expected: PASS — the HTTP behavior is unchanged. If there is no existing route-level note test, the parity is covered by `tests/test_note_service.py` plus a manual `curl` of `/api/notes` on the running app (create/update/delete/toggle round-trip identical to before).

- [ ] **Step 7: Commit**

```bash
git add routes/note/note_service.py routes/note/note_routes.py tests/test_note_service.py
git commit -m "refactor(notes): extract callable CRUD service; routes delegate (one source of truth)"
```

---

## Wire protocol (per-record) — the contract between Phase 2 (server) and Phase 3 (client)

Both endpoints speak `entity="note"`. `record` is the full note as `_note_to_dict`/`note_to_wire` serializes it (`items` is a **list**, not a JSON string).

**`POST /api/sync/push`** — request:
```json
{ "changes": [
  { "entity": "note", "id": "<uuid>", "op": "upsert", "baseRev": 3, "editedAt": "2026-07-21T10:05:00.000Z", "record": { "id": "<uuid>", "title": "...", "items": [{"text":"a","done":true}], "...": "..." } },
  { "entity": "note", "id": "<uuid>", "op": "delete", "editedAt": "2026-07-21T10:06:00.000Z" }
] }
```
Response:
```json
{ "results": [ { "entity": "note", "id": "<uuid>", "op": "upsert", "rev": 4, "record": { "...": "..." } } ], "cursor": 128 }
```
- **LWW rule:** upsert to a non-existent id → create (`rev=1`). Upsert to an existing row → apply iff `editedAt >= row.updated_at`, else the **server row wins** and is returned unchanged. Delete always wins and is idempotent (delete of an absent id returns an `op:"delete"` tombstone). Each result carries the **winning** record so the client converges.

**`GET /api/sync/pull?cursor=&limit=`** — response:
```json
{ "changes": [ { "entity": "note", "id": "<uuid>", "op": "upsert", "rev": 4, "record": {"...":"..."} },
               { "entity": "note", "id": "<uuid>", "op": "delete", "rev": 5, "record": null } ],
  "cursor": 130, "hasMore": false }
```
- `cursor<=0` → **bootstrap**: every live note for the owner as `op:"upsert"`. `cursor>0` → change-log rows with `seq>cursor` (each resolved to the *current* live record, or a delete tombstone). `hasMore` when the page filled and more remain.
- **Echo:** because push routes through the ORM CRUD, the push's own write logs a change-log row; the originating device pulls it back. The client dedups by `rev` (§Task 15) — an incoming `rev <= local baseRev` on a non-dirty row is a no-op.

### Task 7: Registry + note wire mapping + service hooks

**Files:**
- Modify: `routes/note/note_service.py` (add `note_to_wire` + `note_from_wire`)
- Modify: `src/sync/registry.py` (replace `task` registry with `note`)
- Test: `tests/test_sync_registry.py` (create)

**Interfaces:**
- Consumes: `Note`, the Task-6 service functions.
- Produces:
  - `note_to_wire(note: Note) -> dict` — same keys as `_note_to_dict` (in `note_routes.py`), `items` decoded to a list.
  - `note_from_wire(record: dict) -> dict` — whitelist the writable fields into a service `data` dict (`items` kept as a list).
  - `REGISTRY = {"note": {"model": Note, "to_wire", "from_wire", "create", "update", "delete"}}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_registry.py
from src.sync.registry import REGISTRY
from routes.note.note_service import note_from_wire


def test_registry_note_shape():
    spec = REGISTRY["note"]
    assert set(spec) >= {"model", "to_wire", "from_wire", "create", "update", "delete"}


def test_from_wire_whitelists_and_keeps_items_list():
    data = note_from_wire({"title": "T", "items": [{"text": "a", "done": False}], "owner": "x", "rev": 9})
    assert data["title"] == "T"
    assert data["items"] == [{"text": "a", "done": False}]
    assert "owner" not in data and "rev" not in data  # server-controlled, not client-writable
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_registry.py -q`
Expected: FAIL — `KeyError: 'note'` (registry still has only `task`) / `ImportError: note_from_wire`.

- [ ] **Step 3: Add `note_to_wire`/`note_from_wire` to `routes/note/note_service.py`**

Append to `routes/note/note_service.py`:

```python
_WIRE_IN_FIELDS = ("title", "content", "items", "note_type", "color", "label",
                   "pinned", "archived", "due_date", "image_url", "repeat",
                   "sort_order", "source", "session_id", "agent_session_id")


def note_from_wire(record: dict) -> dict:
    """Client record → service `data` dict (writable fields only; items stays a list)."""
    return {k: record[k] for k in _WIRE_IN_FIELDS if k in record}


def note_to_wire(note: Note) -> dict:
    """Note → wire record (mirrors _note_to_dict; items decoded to a list)."""
    items = None
    if note.items:
        try:
            items = json.loads(note.items)
        except (json.JSONDecodeError, TypeError):
            items = None
    return {
        "id": note.id, "owner": note.owner, "title": note.title, "content": note.content,
        "items": items, "note_type": note.note_type, "color": note.color, "label": note.label,
        "pinned": note.pinned, "archived": note.archived, "due_date": note.due_date,
        "source": note.source, "session_id": note.session_id, "sort_order": note.sort_order or 0,
        "image_url": note.image_url, "repeat": note.repeat or "none",
        "agent_session_id": getattr(note, "agent_session_id", None),
        "rev": note.rev,
        "created_at": note.created_at.isoformat() if note.created_at else None,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
    }
```

- [ ] **Step 4: Rewrite `src/sync/registry.py`**

```python
from core.database import Note
from routes.note.note_service import (
    note_to_wire, note_from_wire,
    create_note_record, update_note_record, delete_note_record,
)

REGISTRY = {
    "note": {
        "model": Note,
        "to_wire": note_to_wire,
        "from_wire": note_from_wire,
        "create": create_note_record,   # (db, owner, data) -> Note
        "update": update_note_record,    # (db, owner, id, data) -> Note
        "delete": delete_note_record,    # (db, owner, id) -> None
    },
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest tests/test_sync_registry.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/note/note_service.py src/sync/registry.py tests/test_sync_registry.py
git commit -m "feat(sync): note registry entry + wire mapping + service hooks"
```

### Task 8: Per-record LWW push (`apply_push`)

**Files:**
- Modify: `src/sync/apply.py` (replace per-field HLC body)
- Delete: `src/sync/hlc.py`, `src/sync/winners.py`, `tests/test_sync_hlc.py`, `tests/test_sync_apply_pull.py` (their only consumers are being rewritten in this + the next task)
- Test: `tests/test_sync_apply.py` (create)

**Interfaces:**
- Consumes: `REGISTRY`, `SyncChangeLog`, the note service hooks.
- Produces: `apply_push(db, owner, changes: list) -> dict` returning `{"results": [...], "cursor": int}` per the wire contract.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_apply.py
import uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import core.database as db
from src.sync.models import create_sync_tables
from src.sync.listeners import register_note_listeners
from src.sync.apply import apply_push


def _s(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    create_sync_tables(eng)
    register_note_listeners()
    return sessionmaker(bind=eng)()


def test_create_then_newer_wins_older_loses(tmp_path):
    s = _s(tmp_path)
    nid = str(uuid.uuid4())
    r1 = apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:00:00", "record": {"title": "v1"}}])
    assert r1["results"][0]["rev"] == 1
    # newer edit wins
    r2 = apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:05:00", "record": {"title": "v2"}}])
    assert r2["results"][0]["record"]["title"] == "v2" and r2["results"][0]["rev"] == 2
    # older edit loses — server row (v2) returned unchanged
    r3 = apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T09:00:00", "record": {"title": "stale"}}])
    assert r3["results"][0]["record"]["title"] == "v2"


def test_delete_wins_and_is_idempotent(tmp_path):
    s = _s(tmp_path)
    nid = str(uuid.uuid4())
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:00:00", "record": {"title": "x"}}])
    r = apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "delete",
        "editedAt": "2026-07-21T10:01:00"}])
    assert r["results"][0]["op"] == "delete"
    assert s.query(db.Note).filter(db.Note.id == nid).first() is None
    # idempotent second delete
    r2 = apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "delete",
        "editedAt": "2026-07-21T10:02:00"}])
    assert r2["results"][0]["op"] == "delete"


def test_foreign_owner_rejected(tmp_path):
    s = _s(tmp_path)
    nid = str(uuid.uuid4())
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:00:00", "record": {"title": "x"}}])
    try:
        apply_push(s, "bob", [{"entity": "note", "id": nid, "op": "upsert",
            "editedAt": "2026-07-21T11:00:00", "record": {"title": "hack"}}])
        assert False, "expected PermissionError"
    except PermissionError:
        pass
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_apply.py -q`
Expected: FAIL — `apply_push` still expects the old `device_id, patches` signature / imports `winners`.

- [ ] **Step 3: Rewrite `src/sync/apply.py`**

```python
"""Per-record last-write-wins push over odysseus's native tables, routed through
the domain CRUD service (one source of truth). Tie-break by client `editedAt`."""
from datetime import datetime
from src.sync.registry import REGISTRY
from src.sync.models import SyncChangeLog


def _parse_ts(value):
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "").replace("+00:00", ""))


def apply_push(db, owner: str, changes: list) -> dict:
    results = []
    for ch in changes:
        entity = ch.get("entity")
        spec = REGISTRY.get(entity)
        if spec is None:
            raise ValueError("INVALID_ENTITY")
        model = spec["model"]
        eid = ch["id"]
        op = ch.get("op", "upsert")
        edited_at = _parse_ts(ch.get("editedAt"))

        row = db.get(model, eid)
        if row is not None and owner is not None and row.owner != owner:
            raise PermissionError("FORBIDDEN")

        if op == "delete":
            if row is not None:
                spec["delete"](db, owner, eid)
            results.append({"entity": entity, "id": eid, "op": "delete", "rev": None, "record": None})
            continue

        data = spec["from_wire"](ch.get("record") or {})
        data["edited_at"] = edited_at
        if row is None:
            data["id"] = eid
            new = spec["create"](db, owner, data)
            results.append({"entity": entity, "id": eid, "op": "upsert",
                            "rev": new.rev, "record": spec["to_wire"](new)})
        elif edited_at is None or row.updated_at is None or edited_at >= row.updated_at:
            updated = spec["update"](db, owner, eid, data)
            results.append({"entity": entity, "id": eid, "op": "upsert",
                            "rev": updated.rev, "record": spec["to_wire"](updated)})
        else:  # server row is newer — it wins
            results.append({"entity": entity, "id": eid, "op": "upsert",
                            "rev": row.rev, "record": spec["to_wire"](row)})

    max_seq = (db.query(SyncChangeLog.seq).filter(SyncChangeLog.owner == owner)
                 .order_by(SyncChangeLog.seq.desc()).first())
    return {"results": results, "cursor": max_seq[0] if max_seq else 0}
```

- [ ] **Step 4: Delete the retired per-field HLC modules + their tests**

Run: `git rm src/sync/hlc.py src/sync/winners.py tests/test_sync_hlc.py tests/test_sync_apply_pull.py`

- [ ] **Step 5: Run the new apply tests + confirm no dangling imports**

Run: `python -m pytest tests/test_sync_apply.py -q` then `grep -rn "hlc\|winners" src/sync/`
Expected: apply tests PASS; grep returns nothing (pull.py still imports them at this point — it is rewritten in Task 9; if `grep` shows `src/sync/pull.py`, that's expected and fixed next task). Do **not** run the whole suite yet — `pull.py` is temporarily broken until Task 9.

- [ ] **Step 6: Commit**

```bash
git add src/sync/apply.py tests/test_sync_apply.py
git rm src/sync/hlc.py src/sync/winners.py tests/test_sync_hlc.py tests/test_sync_apply_pull.py
git commit -m "feat(sync): per-record LWW push via note service; retire per-field HLC apply"
```

### Task 9: Per-record pull (`pull_changes`)

**Files:**
- Modify: `src/sync/pull.py` (replace per-field HLC body)
- Test: `tests/test_sync_pull.py` (create)

**Interfaces:**
- Consumes: `REGISTRY`, `SyncChangeLog`.
- Produces: `pull_changes(db, owner, cursor: int, limit: int) -> dict` → `{"changes": [...], "cursor": int, "hasMore": bool}` per the wire contract.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_pull.py
import uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import core.database as db
from src.sync.models import create_sync_tables
from src.sync.listeners import register_note_listeners
from src.sync.apply import apply_push
from src.sync.pull import pull_changes


def _s(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    create_sync_tables(eng)
    register_note_listeners()
    return sessionmaker(bind=eng)()


def test_bootstrap_then_incremental(tmp_path):
    s = _s(tmp_path)
    nid = str(uuid.uuid4())
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:00:00", "record": {"title": "hello"}}])
    boot = pull_changes(s, "alice", 0, 500)
    assert boot["hasMore"] is False
    assert [c["record"]["title"] for c in boot["changes"]] == ["hello"]
    cur = boot["cursor"]
    # an incremental edit shows up after the cursor
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:05:00", "record": {"title": "world"}}])
    inc = pull_changes(s, "alice", cur, 500)
    assert inc["changes"][-1]["record"]["title"] == "world"
    assert inc["cursor"] > cur


def test_incremental_delete_is_tombstone(tmp_path):
    s = _s(tmp_path)
    nid = str(uuid.uuid4())
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:00:00", "record": {"title": "x"}}])
    cur = pull_changes(s, "alice", 0, 500)["cursor"]
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "delete",
        "editedAt": "2026-07-21T10:01:00"}])
    inc = pull_changes(s, "alice", cur, 500)
    assert inc["changes"][-1]["op"] == "delete" and inc["changes"][-1]["record"] is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_pull.py -q`
Expected: FAIL — `pull.py` still imports `winners`/`synced_fields` and returns the per-field shape.

- [ ] **Step 3: Rewrite `src/sync/pull.py`**

```python
"""Per-record pull: page over sync_change_log, resolving each change to the current
live record (or a delete tombstone). Bootstrap (cursor<=0) ships all live rows."""
from src.sync.registry import REGISTRY
from src.sync.models import SyncChangeLog


def _max_seq(db, owner: str) -> int:
    row = (db.query(SyncChangeLog.seq).filter(SyncChangeLog.owner == owner)
             .order_by(SyncChangeLog.seq.desc()).first())
    return row[0] if row else 0


def pull_changes(db, owner: str, cursor: int, limit: int) -> dict:
    if cursor <= 0:
        changes = []
        for entity, spec in REGISTRY.items():
            for row in db.query(spec["model"]).filter(spec["model"].owner == owner).all():
                changes.append({"entity": entity, "id": row.id, "op": "upsert",
                                "rev": row.rev, "record": spec["to_wire"](row)})
        return {"changes": changes, "cursor": _max_seq(db, owner), "hasMore": False}

    rows = (db.query(SyncChangeLog)
              .filter(SyncChangeLog.owner == owner, SyncChangeLog.seq > cursor)
              .order_by(SyncChangeLog.seq.asc()).limit(limit).all())
    changes = []
    for r in rows:
        spec = REGISTRY.get(r.entity)
        if spec is None:
            continue
        live = db.get(spec["model"], r.entity_id)
        if r.op == "delete" or live is None:
            changes.append({"entity": r.entity, "id": r.entity_id, "op": "delete",
                            "rev": r.rev, "record": None})
        else:
            changes.append({"entity": r.entity, "id": r.entity_id, "op": "upsert",
                            "rev": live.rev, "record": spec["to_wire"](live)})
    out_cursor = rows[-1].seq if rows else cursor
    has_more = len(rows) == limit and out_cursor < _max_seq(db, owner)
    return {"changes": changes, "cursor": out_cursor, "hasMore": has_more}
```

- [ ] **Step 4: Run the pull tests + full sync module**

Run: `python -m pytest tests/test_sync_pull.py tests/test_sync_apply.py tests/test_sync_listeners.py -q`
Expected: all PASS (pull no longer imports the deleted HLC modules).

- [ ] **Step 5: Commit**

```bash
git add src/sync/pull.py tests/test_sync_pull.py
git commit -m "feat(sync): per-record pull (live record / delete tombstone) over change log"
```

### Task 10: Rewire `/api/sync` routes to the per-record protocol

**Files:**
- Modify: `routes/sync_routes.py`
- Test: `tests/test_sync_routes.py` (replace the per-field body with per-record round-trip tests)

**Interfaces:**
- Consumes: `apply_push`, `pull_changes`, `create_sync_tables`, `register_note_listeners`, `require_user`, `FALLBACK_OWNER`.
- Produces: `POST /api/sync/push` (body `{changes:[...]}`), `GET /api/sync/pull?cursor=&limit=`, `GET /api/sync/ping`. Listeners are registered at router setup.

- [ ] **Step 1: Replace `tests/test_sync_routes.py` with per-record tests**

```python
# tests/test_sync_routes.py
import asyncio
import httpx
from types import SimpleNamespace
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import core.database as db


class _Identity:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            hdrs = dict(scope.get("headers") or [])
            u = hdrs.get(b"x-test-user")
            scope.setdefault("state", {})
            scope["state"]["current_user"] = u.decode() if u else None
        await self.app(scope, receive, send)


def _app(tmp_path, monkeypatch):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}",
        connect_args={"check_same_thread": False}, poolclass=NullPool)
    Session = sessionmaker(bind=eng)
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    import routes.sync_routes as sr
    monkeypatch.setattr(sr, "SessionLocal", Session)
    monkeypatch.setattr(sr, "engine", eng)
    app = FastAPI()
    app.state.auth_manager = SimpleNamespace(is_configured=True)
    app.include_router(sr.setup_sync_routes())
    return _Identity(app)


def _c(app):
    t = httpx.ASGITransport(app=app, client=("203.0.113.7", 54321))
    return httpx.AsyncClient(transport=t, base_url="http://sync.test")


def test_push_then_pull_roundtrip(tmp_path, monkeypatch):
    async def _run():
        app = _app(tmp_path, monkeypatch)
        alice = {"x-test-user": "alice"}
        async with _c(app) as c:
            body = {"changes": [{"entity": "note", "id": "n1", "op": "upsert",
                "editedAt": "2026-07-21T10:00:00", "record": {"title": "Buy milk"}}]}
            r = await c.post("/api/sync/push", json=body, headers=alice)
            assert r.status_code == 200 and r.json()["results"][0]["rev"] == 1
            pulled = (await c.get("/api/sync/pull?cursor=0", headers=alice)).json()
            assert pulled["changes"][0]["record"]["title"] == "Buy milk"
    asyncio.run(_run())


def test_pull_requires_auth_when_configured(tmp_path, monkeypatch):
    async def _run():
        app = _app(tmp_path, monkeypatch)
        async with _c(app) as c:  # no x-test-user header, remote IP
            r = await c.get("/api/sync/pull?cursor=0")
            assert r.status_code == 401
    asyncio.run(_run())
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_routes.py -q`
Expected: FAIL — routes still parse `{deviceId, patches}` and call the old `apply_push` signature.

- [ ] **Step 3: Rewrite `routes/sync_routes.py`**

```python
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
```

- [ ] **Step 4: Run the route tests + the whole backend suite**

Run: `python -m pytest tests/test_sync_routes.py -q` then `python -m pytest tests/ -q`
Expected: route tests PASS; the full suite is green (no references to deleted HLC modules remain).

- [ ] **Step 5: Commit**

```bash
git add routes/sync_routes.py tests/test_sync_routes.py
git commit -m "feat(sync): per-record /api/sync push/pull; register Note listeners at setup"
```

---

## Phase 3 — Client: bundled local-first engine + `notesRepo`

The Slice-1 TS engine was per-*field* HLC (`_fieldTs`, `patchFields`, `nextHlc`). Per-record LWW is simpler, so we **reuse the engine scaffolding** — the `syncOnce`/backoff loop, `start/stop` triggers (3s local-write debounce, `window online`, 60s visibility-gated interval), and the cookie-auth `api()` wrapper — and **replace the data plane** (Dexie schema, outbox, apply, wire building). Source lives in a committed TS tree at `sync-engine/`; the build emits the committed ES module `static/js/productivity/sync-core.js`. `webapp/` is already gone (Phase 1), so this is written fresh against the wire contract above.

### Task 11: Scaffold the engine build (esbuild → committed ES module)

**Files:**
- Create: `sync-engine/package.json`, `sync-engine/tsconfig.json`, `sync-engine/build.mjs`, `sync-engine/.gitignore`
- Create: `sync-engine/src/index.ts` (temporary stub, replaced next tasks)
- Create: `static/js/productivity/.gitkeep`

**Interfaces:**
- Produces: `npm --prefix sync-engine run build` → writes `static/js/productivity/sync-core.js` (single ESM file, Dexie bundled in). `npm --prefix sync-engine test` runs vitest.

- [ ] **Step 1: Write `sync-engine/package.json`**

```json
{
  "name": "odysseus-sync-engine",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "dexie": "^4.0.8" },
  "devDependencies": {
    "esbuild": "^0.23.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "fake-indexeddb": "^6.0.0"
  }
}
```

- [ ] **Step 2: Write `sync-engine/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "skipLibCheck": true, "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `sync-engine/build.mjs`**

```js
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: '../static/js/productivity/sync-core.js',
  banner: { js: '// GENERATED by sync-engine/build.mjs — do not edit by hand. Source: sync-engine/src/' },
})
console.log('built static/js/productivity/sync-core.js')
```

- [ ] **Step 4: Write `sync-engine/.gitignore`**

```
node_modules/
```

- [ ] **Step 5: Write the temporary entry stub `sync-engine/src/index.ts`**

```ts
export const SYNC_ENGINE_VERSION = '0.1.0'
```

- [ ] **Step 6: Install, build, and verify the committed artifact exists**

Run: `npm --prefix sync-engine install && npm --prefix sync-engine run build && head -1 static/js/productivity/sync-core.js`
Expected: build prints `built static/js/productivity/sync-core.js`; the file's first line is the GENERATED banner.

- [ ] **Step 7: Commit (including the generated bundle)**

```bash
git add sync-engine/package.json sync-engine/package-lock.json sync-engine/tsconfig.json sync-engine/build.mjs sync-engine/.gitignore sync-engine/src/index.ts static/js/productivity/sync-core.js
git commit -m "build(sync): esbuild engine build → committed static/js/productivity/sync-core.js"
```

### Task 12: Dexie store + outbox (per-record)

**Files:**
- Create: `sync-engine/src/db.ts`
- Test: `sync-engine/src/db.test.ts`

**Interfaces:**
- Produces:
  - `NoteRow = Record<string, unknown> & { id: string; _dirty: 0|1; _baseRev: number; _editedAt: string }`
  - `OutboxRow = { seq?: number; entity: 'note'; id: string; op: 'upsert'|'delete'; editedAt: string }`
  - `db` — Dexie `odysseus-productivity` with stores `notes: 'id, updated_at'`, `outbox: '++seq, id'`, `meta: 'key'`.

- [ ] **Step 1: Write the failing test**

```ts
// sync-engine/src/db.test.ts
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { db } from './db'

describe('db', () => {
  it('stores a note row and an outbox entry', async () => {
    await db.notes.put({ id: 'n1', title: 'x', _dirty: 1, _baseRev: 0, _editedAt: '2026-07-21T10:00:00Z' })
    await db.outbox.add({ entity: 'note', id: 'n1', op: 'upsert', editedAt: '2026-07-21T10:00:00Z' })
    expect((await db.notes.get('n1'))?.title).toBe('x')
    expect((await db.outbox.toArray()).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sync-engine test -- db.test`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 3: Write `sync-engine/src/db.ts`**

```ts
import Dexie, { type Table } from 'dexie'

export type NoteRow = Record<string, unknown> & {
  id: string; _dirty: 0 | 1; _baseRev: number; _editedAt: string
}
export type OutboxRow = {
  seq?: number; entity: 'note'; id: string; op: 'upsert' | 'delete'; editedAt: string
}
export type KV = { key: string; value: unknown }

class ProductivityDB extends Dexie {
  notes!: Table<NoteRow, string>
  outbox!: Table<OutboxRow, number>
  meta!: Table<KV, string>
  constructor() {
    super('odysseus-productivity')
    this.version(1).stores({ notes: 'id, updated_at', outbox: '++seq, id', meta: 'key' })
  }
}

export const db = new ProductivityDB()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix sync-engine test -- db.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sync-engine/src/db.ts sync-engine/src/db.test.ts
git commit -m "feat(sync-client): Dexie store (notes/outbox/meta) for per-record LWW"
```

### Task 13: Local write helpers (optimistic writes + outbox)

**Files:**
- Create: `sync-engine/src/localWrite.ts`
- Test: `sync-engine/src/localWrite.test.ts`

**Interfaces:**
- Consumes: `db`, a `nowIso()` clock.
- Produces (each is one atomic Dexie `rw` transaction that writes the note row **and** appends an outbox entry, then fires the local-write notifier):
  - `syncedUpsert(record: {id: string} & Record<string, unknown>): Promise<void>` — sets `_dirty=1`, `_editedAt=nowIso()`, preserves existing `_baseRev` (or 0).
  - `syncedDelete(id: string): Promise<void>` — deletes the local row, appends an `op:'delete'` outbox entry.
  - `setLocalWriteListener(cb: () => void)` / `notifyLocalWrite()` — the 3s-debounce trigger seam the engine subscribes to.
  - `nowIso(): string` — `new Date().toISOString()` (overridable in tests).

- [ ] **Step 1: Write the failing test**

```ts
// sync-engine/src/localWrite.test.ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { syncedUpsert, syncedDelete } from './localWrite'

beforeEach(async () => { await db.notes.clear(); await db.outbox.clear() })

describe('localWrite', () => {
  it('upsert writes a dirty row + upsert outbox entry', async () => {
    await syncedUpsert({ id: 'n1', title: 'hi' })
    const row = await db.notes.get('n1')
    expect(row?._dirty).toBe(1)
    expect(typeof row?._editedAt).toBe('string')
    const ob = await db.outbox.toArray()
    expect(ob[0]).toMatchObject({ entity: 'note', id: 'n1', op: 'upsert' })
  })

  it('delete removes the row + appends a delete outbox entry', async () => {
    await syncedUpsert({ id: 'n1', title: 'hi' })
    await syncedDelete('n1')
    expect(await db.notes.get('n1')).toBeUndefined()
    const ops = (await db.outbox.toArray()).map((o) => o.op)
    expect(ops).toContain('delete')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sync-engine test -- localWrite.test`
Expected: FAIL — `Cannot find module './localWrite'`.

- [ ] **Step 3: Write `sync-engine/src/localWrite.ts`**

```ts
import { db, type NoteRow } from './db'

export function nowIso(): string { return new Date().toISOString() }

let _listener: (() => void) | null = null
export function setLocalWriteListener(cb: () => void) { _listener = cb }
export function notifyLocalWrite() { if (_listener) _listener() }

export async function syncedUpsert(record: { id: string } & Record<string, unknown>): Promise<void> {
  const editedAt = nowIso()
  await db.transaction('rw', [db.notes, db.outbox], async () => {
    const existing = await db.notes.get(record.id)
    const row: NoteRow = {
      ...record, _dirty: 1, _baseRev: existing?._baseRev ?? 0, _editedAt: editedAt,
    }
    await db.notes.put(row)
    await db.outbox.add({ entity: 'note', id: record.id, op: 'upsert', editedAt })
  })
  notifyLocalWrite()
}

export async function syncedDelete(id: string): Promise<void> {
  const editedAt = nowIso()
  await db.transaction('rw', [db.notes, db.outbox], async () => {
    await db.notes.delete(id)
    await db.outbox.add({ entity: 'note', id, op: 'delete', editedAt })
  })
  notifyLocalWrite()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix sync-engine test -- localWrite.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sync-engine/src/localWrite.ts sync-engine/src/localWrite.test.ts
git commit -m "feat(sync-client): optimistic local writes + outbox (per-record)"
```

### Task 14: Sync engine — push/pull loop with echo-safe apply

**Files:**
- Create: `sync-engine/src/engine.ts`
- Test: `sync-engine/src/engine.test.ts`

**Interfaces:**
- Consumes: `db`, the wire contract, a `fetchFn` (defaults to `globalThis.fetch`).
- Produces:
  - `createSyncClient(opts: { apiBase?: string; fetchFn?: typeof fetch }) => { syncOnce, start, stop }`.
  - `pushOnce()` — drains outbox → for each entry builds `{entity,id,op,baseRev,editedAt,record}` (record = current `db.notes` row minus meta fields, for upserts) → `POST {apiBase}/push` → on each result set `_baseRev=rev, _dirty=0` and overwrite the local row with the winning `record` (LWW-lost convergence) → clear sent outbox rows.
  - `pullOnce()` — pages `GET {apiBase}/pull?cursor=&limit=500`; **echo-safe apply**: for an incoming `upsert`, skip if the local row is `_dirty` (a pending edit will push+resolve) or if `incoming.rev <= local._baseRev` (own echo); else write the record with `_baseRev=rev, _dirty=0`. For `delete`, remove locally unless the local row is `_dirty`. Advance the persisted cursor (`meta` key `cursor`).
  - `apiBase` default `/api/sync`; `fetchFn` uses `credentials: 'same-origin'` (cookie auth).

- [ ] **Step 1: Write the failing test (round-trip against a fake server + echo-safety)**

```ts
// sync-engine/src/engine.test.ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { syncedUpsert } from './localWrite'
import { createSyncClient } from './engine'

beforeEach(async () => { await db.notes.clear(); await db.outbox.clear(); await db.meta.clear() })

function fakeServer() {
  const store = new Map<string, any>()
  let seq = 0
  const log: any[] = []
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://t')
    if (url.pathname.endsWith('/push')) {
      const { changes } = JSON.parse(String(init!.body))
      const results = changes.map((ch: any) => {
        if (ch.op === 'delete') { store.delete(ch.id); log.push({ ...ch, seq: ++seq }); return { entity: 'note', id: ch.id, op: 'delete', rev: null, record: null } }
        const prev = store.get(ch.id)
        const rev = (prev?.rev ?? 0) + 1
        const rec = { ...ch.record, id: ch.id, rev, updated_at: ch.editedAt }
        store.set(ch.id, rec); log.push({ ...ch, seq: ++seq })
        return { entity: 'note', id: ch.id, op: 'upsert', rev, record: rec }
      })
      return new Response(JSON.stringify({ results, cursor: seq }), { status: 200 })
    }
    const cursor = Number(url.searchParams.get('cursor') || 0)
    const changes = cursor <= 0
      ? [...store.values()].map((r) => ({ entity: 'note', id: r.id, op: 'upsert', rev: r.rev, record: r }))
      : log.filter((l) => l.seq > cursor).map((l) => { const r = store.get(l.id); return r ? { entity: 'note', id: r.id, op: 'upsert', rev: r.rev, record: r } : { entity: 'note', id: l.id, op: 'delete', rev: null, record: null } })
    return new Response(JSON.stringify({ changes, cursor: seq, hasMore: false }), { status: 200 })
  }
}

describe('engine', () => {
  it('pushes a local note and reconciles rev without duplicating on echo', async () => {
    const client = createSyncClient({ fetchFn: fakeServer() as any })
    await syncedUpsert({ id: 'n1', title: 'hello' })
    await client.syncOnce()
    let row = await db.notes.get('n1')
    expect(row?._baseRev).toBe(1)
    expect(row?._dirty).toBe(0)
    // second sync pulls our own echo back — must not clobber or duplicate
    await client.syncOnce()
    row = await db.notes.get('n1')
    expect(row?._baseRev).toBe(1)
    expect((await db.notes.toArray()).length).toBe(1)
  })

  it('applies a remote note on pull', async () => {
    const server = fakeServer()
    // seed the server via a first client
    const c1 = createSyncClient({ fetchFn: server as any })
    await syncedUpsert({ id: 'remote1', title: 'from-other-device' })
    await c1.syncOnce()
    // fresh local store, pull it down
    await db.notes.clear(); await db.outbox.clear(); await db.meta.clear()
    const c2 = createSyncClient({ fetchFn: server as any })
    await c2.syncOnce()
    expect((await db.notes.get('remote1'))?.title).toBe('from-other-device')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sync-engine test -- engine.test`
Expected: FAIL — `Cannot find module './engine'`.

- [ ] **Step 3: Write `sync-engine/src/engine.ts`**

```ts
import { db, type NoteRow } from './db'
import { setLocalWriteListener } from './localWrite'

const META = new Set(['_dirty', '_baseRev', '_editedAt'])
const BACKOFF_MIN = 2000, BACKOFF_MAX = 60000

function stripMeta(row: NoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!META.has(k)) out[k] = v
  return out
}

export interface SyncClient { syncOnce(): Promise<void>; start(): void; stop(): void }

export function createSyncClient(opts: { apiBase?: string; fetchFn?: typeof fetch } = {}): SyncClient {
  const apiBase = opts.apiBase ?? '/api/sync'
  const fetchFn = opts.fetchFn ?? ((i: any, init?: any) => fetch(i, init))
  let queue: Promise<void> = Promise.resolve()
  let failures = 0, nextAllowedAt = 0
  let timer: any = null, interval: any = null

  async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetchFn(`${apiBase}${path}`, { credentials: 'same-origin', ...init })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  async function getCursor(): Promise<number> {
    return ((await db.meta.get('cursor'))?.value as number) ?? 0
  }

  async function pushOnce(): Promise<void> {
    const entries = await db.outbox.orderBy('seq').toArray()
    if (!entries.length) return
    const changes = [] as any[]
    for (const e of entries) {
      if (e.op === 'delete') {
        changes.push({ entity: 'note', id: e.id, op: 'delete', editedAt: e.editedAt })
      } else {
        const row = await db.notes.get(e.id)
        if (!row) continue
        changes.push({ entity: 'note', id: e.id, op: 'upsert', baseRev: row._baseRev, editedAt: e.editedAt, record: stripMeta(row) })
      }
    }
    if (!changes.length) {
      await db.outbox.bulkDelete(entries.map((e) => e.seq!))
      return
    }
    const { results } = await api('/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) })
    // Clear exactly what we sent FIRST, so the pending-check below sees only
    // edits that arrived DURING the round-trip.
    await db.outbox.bulkDelete(entries.map((e) => e.seq!))
    for (const r of results as any[]) {
      if (r.op === 'delete') continue
      // A newer local edit arrived mid-sync → leave it dirty; it will push next round.
      if ((await db.outbox.where('id').equals(r.id).count()) > 0) continue
      await db.notes.put({ ...r.record, _dirty: 0, _baseRev: r.rev, _editedAt: r.record.updated_at ?? new Date(0).toISOString() })
    }
  }

  async function applyChange(ch: any): Promise<void> {
    const local = await db.notes.get(ch.id)
    if (ch.op === 'delete') {
      if (!local || local._dirty === 0) await db.notes.delete(ch.id)
      return
    }
    if (local?._dirty === 1) return                 // pending local edit — resolve via push
    if (local && ch.rev <= local._baseRev) return    // own echo / stale
    await db.notes.put({ ...ch.record, _dirty: 0, _baseRev: ch.rev, _editedAt: ch.record.updated_at ?? new Date(0).toISOString() })
  }

  async function pullOnce(): Promise<void> {
    for (;;) {
      const cursor = await getCursor()
      const page = await api(`/pull?cursor=${cursor}&limit=500`)
      for (const ch of page.changes) await applyChange(ch)
      await db.meta.put({ key: 'cursor', value: page.cursor })
      if (!page.hasMore) break
    }
  }

  function syncOnce(): Promise<void> {
    const run = queue.then(async () => {
      if (Date.now() < nextAllowedAt) return
      try {
        await pushOnce(); await pullOnce(); failures = 0; nextAllowedAt = 0
      } catch {
        failures += 1
        nextAllowedAt = Date.now() + Math.min(BACKOFF_MIN * 2 ** (failures - 1), BACKOFF_MAX)
      }
    })
    queue = run.catch(() => {})
    return run
  }

  function start(): void {
    setLocalWriteListener(() => { clearTimeout(timer); timer = setTimeout(() => void syncOnce(), 3000) })
    if (typeof window !== 'undefined') window.addEventListener('online', () => void syncOnce())
    interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void syncOnce()
    }, 60000)
    void syncOnce()
  }

  function stop(): void { clearTimeout(timer); clearInterval(interval) }

  return { syncOnce, start, stop }
}
```

- [ ] **Step 4: Run the engine test to verify it passes**

Run: `npm --prefix sync-engine test -- engine.test`
Expected: PASS (both round-trip and echo-safety).

- [ ] **Step 5: Commit**

```bash
git add sync-engine/src/engine.ts sync-engine/src/engine.test.ts
git commit -m "feat(sync-client): per-record push/pull engine with echo-safe apply"
```

### Task 15: `notesRepo` façade + public bundle entry

**Files:**
- Create: `sync-engine/src/notesRepo.ts`
- Modify: `sync-engine/src/index.ts` (export the public API)
- Test: `sync-engine/src/notesRepo.test.ts`

**Interfaces:**
- Produces `notesRepo` — the surface `static/js/notes.js` calls (mirrors its current fetch functions so the UI stays):
  - `list(): Promise<object[]>` — all local notes (meta fields stripped), for `_notes`.
  - `create(note): Promise<object>` — `syncedUpsert` with a client-minted `id` if absent (`crypto.randomUUID()`), returns the stored record.
  - `update(id, patch): Promise<object>` — merge patch into the local row via `syncedUpsert`, returns it.
  - `remove(id): Promise<void>` — `syncedDelete`.
  - `reorder(ids: string[]): Promise<void>` — set `sort_order` per index via `syncedUpsert`.
  - `subscribe(cb: () => void): () => void` — fires after any pull/push changes local notes (Dexie hook), so the screen re-renders.
- `index.ts` exports `{ notesRepo, createSyncClient }` — this is what `sync-core.js` exposes.

- [ ] **Step 1: Write the failing test**

```ts
// sync-engine/src/notesRepo.test.ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { notesRepo } from './notesRepo'

beforeEach(async () => { await db.notes.clear(); await db.outbox.clear() })

describe('notesRepo', () => {
  it('create mints an id and list returns it without meta fields', async () => {
    const saved = await notesRepo.create({ title: 'hi', items: [{ text: 'a', done: false }] })
    expect(saved.id).toBeTruthy()
    const list = await notesRepo.list()
    expect(list.length).toBe(1)
    expect((list[0] as any)._dirty).toBeUndefined()
    expect((list[0] as any).title).toBe('hi')
  })

  it('update merges a patch; remove deletes', async () => {
    const n = await notesRepo.create({ title: 'a' })
    await notesRepo.update(n.id, { color: 'red' })
    expect((await notesRepo.list())[0]).toMatchObject({ title: 'a', color: 'red' })
    await notesRepo.remove(n.id)
    expect((await notesRepo.list()).length).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sync-engine test -- notesRepo.test`
Expected: FAIL — `Cannot find module './notesRepo'`.

- [ ] **Step 3: Write `sync-engine/src/notesRepo.ts`**

```ts
import { db, type NoteRow } from './db'
import { syncedUpsert, syncedDelete } from './localWrite'

const META = new Set(['_dirty', '_baseRev', '_editedAt'])
function clean(row: NoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!META.has(k)) out[k] = v
  return out
}
function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : 'n_' + Math.random().toString(36).slice(2)
}

export const notesRepo = {
  async list(): Promise<Record<string, unknown>[]> {
    return (await db.notes.toArray()).map(clean)
  },
  async create(note: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = (note.id as string) || newId()
    await syncedUpsert({ ...note, id })
    return clean((await db.notes.get(id))!)
  },
  async update(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await db.notes.get(id)
    await syncedUpsert({ ...(existing ? clean(existing) : {}), ...patch, id })
    return clean((await db.notes.get(id))!)
  },
  async remove(id: string): Promise<void> { await syncedDelete(id) },
  async reorder(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      const row = await db.notes.get(ids[i])
      if (row) await syncedUpsert({ ...clean(row), sort_order: i })
    }
  },
  subscribe(cb: () => void): () => void {
    const h = () => cb()
    db.notes.hook('creating', h); db.notes.hook('updating', h); db.notes.hook('deleting', h)
    return () => { db.notes.hook('creating').unsubscribe(h); db.notes.hook('updating').unsubscribe(h); db.notes.hook('deleting').unsubscribe(h) }
  },
}
```

- [ ] **Step 4: Write the public entry `sync-engine/src/index.ts`**

```ts
export { notesRepo } from './notesRepo'
export { createSyncClient } from './engine'
```

- [ ] **Step 5: Run the repo test + rebuild the bundle**

Run: `npm --prefix sync-engine test -- notesRepo.test && npm --prefix sync-engine run build`
Expected: test PASS; `static/js/productivity/sync-core.js` rebuilt.

- [ ] **Step 6: Commit (source + regenerated bundle)**

```bash
git add sync-engine/src/notesRepo.ts sync-engine/src/index.ts sync-engine/src/notesRepo.test.ts static/js/productivity/sync-core.js
git commit -m "feat(sync-client): notesRepo façade + public bundle entry; rebuild sync-core.js"
```

---

## Phase 4 — Frontend: refactor `notes.js` onto `notesRepo`

Swap the data source only; keep `_notes` (array) + `_renderNotes()` (full re-render) and the optimistic-update UX. First extract the two un-factored fetch call sites (reorder, fire-reminder) into named functions so every network touch lives behind one seam, then repoint the six seams at `notesRepo` and boot the sync client.

### Task 16: Extract the un-factored fetch call sites into named functions

**Files:**
- Modify: `static/js/notes.js` (the 3 inline `reorder` fetches at ~L2692/2786/5290 → `_reorderNotesApi(ids)`; keep `fire-reminder` inline — it is an online-only server-synthesis call and stays a direct `fetch`, out of the offline path)

**Interfaces:**
- Produces: `async function _reorderNotesApi(ids)` — `POST /api/notes/reorder` with `{ids}`, fire-and-forget-safe (throws on non-ok; existing callers already `catch`).

- [ ] **Step 1: Add the named function next to the other API wrappers (~L454, after `_patchNote`)**

```js
async function _reorderNotesApi(ids) {
  const res = await fetch(`${API_BASE}/api/notes/reorder`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error('Failed to reorder notes');
}
```

- [ ] **Step 2: Replace the 3 inline reorder fetches with calls to it**

At each site (dragend ~L2692, touch-end ~L2786, `_commitNoteReorder` ~L5290) replace the inline `fetch(... '/api/notes/reorder' ...)` with `await _reorderNotesApi(ids)` (keep the surrounding `try/catch` and, in `_commitNoteReorder`, the subsequent local `sort_order` write-back).

- [ ] **Step 3: Verify no inline reorder fetch remains**

Run: `grep -n "notes/reorder" static/js/notes.js`
Expected: exactly one match — inside `_reorderNotesApi`.

- [ ] **Step 4: Manual smoke (no automated DOM test for this module)**

Load the app, open Notes, drag to reorder → order persists across reload. (Behavior unchanged; this is a pure extraction.)

- [ ] **Step 5: Commit**

```bash
git add static/js/notes.js
git commit -m "refactor(notes.js): extract _reorderNotesApi (single network seam for reorder)"
```

### Task 17: Repoint the data seams at `notesRepo` + boot the sync client

**Files:**
- Modify: `static/js/notes.js` (import the bundle; rewrite `_fetchNotes`/`_saveNote`/`_patchNote`/`_deleteNoteApi`/`_reorderNotesApi` onto `notesRepo`; subscribe for sync-in; start the client)
- Modify: `static/index.html` (nothing if notes.js is already module-loaded — the import is transitive; verify CSP allows the new module path)

**Interfaces:**
- Consumes: `notesRepo`, `createSyncClient` from `./productivity/sync-core.js`.
- Produces: the Notes screen reads/writes through the local store; edits queue in the outbox and sync when online; remote changes arrive via `notesRepo.subscribe`.

- [ ] **Step 1: Import the bundle at the top of `static/js/notes.js`**

```js
import { notesRepo, createSyncClient } from './productivity/sync-core.js';
```

- [ ] **Step 2: Rewrite the five data seams to delegate to the repo (keep signatures + return shapes)**

```js
async function _fetchNotes() {
  _loading = true;
  try {
    _notes = await notesRepo.list();
  } catch (e) {
    console.error('Failed to load notes:', e);
    _notes = [];
  } finally {
    _loading = false;
  }
}

async function _saveNote(note) {
  return note.id ? await notesRepo.update(note.id, note) : await notesRepo.create(note);
}

async function _patchNote(id, patch) {
  return await notesRepo.update(id, patch);
}

async function _deleteNoteApi(id) {
  await notesRepo.remove(id);
}

async function _reorderNotesApi(ids) {
  await notesRepo.reorder(ids);
}
```

Note: `_saveNote`'s create path now returns a record that **already has** the client-minted `id` (the repo mints it), so the existing `tmp_`-id swap in the submit flow still works — `saved.id` is real. The `?archived=true` server filter that `_fetchNotes` used is now applied client-side in `_renderNotes` (it already filters `_showingArchived`); confirm archived notes are still in `_notes` and filtered at render.

- [ ] **Step 3: Boot the sync client + subscribe for sync-in (replace the `setTimeout(_initReminders, 3000)` tail region ~L5371)**

```js
const _syncClient = createSyncClient({ apiBase: '/api/sync' });
_syncClient.start();
notesRepo.subscribe(() => {
  // a pull (or push convergence) changed the local store — refresh + re-render if open
  _fetchNotes().then(() => { if (_open) _renderNotes(); });
});
```

Keep `_initReminders`/`_startReminderLoop` but change its data source: it should read from `notesRepo.list()` rather than `fetch('/api/notes')` (so reminders work from the local store too):

```js
async function _initReminders() {
  try {
    _notes = await notesRepo.list();
    _startReminderLoop();
  } catch {}
}
```

- [ ] **Step 4: Verify CSP + module resolution**

Run: `grep -n "productivity/sync-core" static/index.html static/js/notes.js` and confirm the app boots with no console CSP/module error.
Expected: `notes.js` imports the bundle; since `index.html` loads `notes.js` as `type="module"`, the transitive import needs no separate `<script>` tag. If a strict `script-src` blocks it, add the module path to the existing allowance (it is same-origin `/static/...`, so the nonce-based CSP already permits it — verify no error in devtools).

- [ ] **Step 5: Manual smoke — online**

Load the app → open Notes → create, edit, check an item, color, delete, reorder → all persist and survive reload (now sourced from the local store, synced to the server). Confirm a note created here appears in the DB (`/api/notes` still returns it, since the sync push wrote through the note service).

- [ ] **Step 6: Commit**

```bash
git add static/js/notes.js static/index.html
git commit -m "feat(notes.js): route data access through notesRepo; boot local-first sync client"
```

---

## Phase 5 — Verification, docs, and the offline proof

### Task 18: Offline proof + regen docs + self-hosted round-trip

**Files:**
- Create: `docs/productivity/sync-engine.md` (regen command + architecture note)
- Modify: `README`/dev docs if a "build steps" section exists (add the engine build)

**Interfaces:** none (verification + documentation).

- [ ] **Step 1: Full backend suite green**

Run: `python -m pytest tests/ -q`
Expected: PASS, including `test_note_service`, `test_sync_apply`, `test_sync_pull`, `test_sync_routes`, `test_sync_listeners`, `test_note_rev_migration`, `test_sync_change_log_model`, `test_sync_registry`. No import of removed HLC modules.

- [ ] **Step 2: Full client suite green + bundle in sync with source**

Run: `npm --prefix sync-engine test && npm --prefix sync-engine run build && git diff --exit-code static/js/productivity/sync-core.js`
Expected: vitest PASS; `git diff --exit-code` returns 0 — the committed bundle equals a fresh build (no drift).

- [ ] **Step 3: Offline proof (the Slice-A acceptance criterion)**

On the running stack (`https://chat.elsiga.ch`, auth configured), in the browser:
1. Open Notes; create a todo → confirm it appears in the DB via `GET /api/notes`.
2. DevTools → Network → **Offline**. Edit the todo (check an item, change title). Confirm the edit renders instantly (optimistic) and an entry sits in the `outbox` (Application → IndexedDB → `odysseus-productivity` → `outbox`).
3. Reload while still offline → the edit persists (served from IndexedDB, not the server).
4. DevTools → **Online**. Within ~3s (local-write debounce) the outbox drains; confirm `GET /api/notes` now returns the edited value and the `outbox` table is empty.

Record the result (pass/fail with notes) in the commit message / PR body. This is manual — there is no automated multi-context offline e2e in Slice A (named gap, consistent with Slice 1).

- [ ] **Step 4: Write `docs/productivity/sync-engine.md`**

```markdown
# Productivity sync engine (Slice A)

**Source:** `sync-engine/src/` (TypeScript). **Committed build output:** `static/js/productivity/sync-core.js` (a single ESM bundle with Dexie inlined). odysseus's runtime has no build step — the bundle is loaded as a plain module by `static/js/notes.js`.

## Regenerate the bundle
```
npm --prefix sync-engine install   # first time
npm --prefix sync-engine test      # engine unit tests (vitest)
npm --prefix sync-engine run build # → static/js/productivity/sync-core.js (commit the result)
```
The build output is committed; CI (or a pre-merge check) runs `npm --prefix sync-engine run build && git diff --exit-code static/js/productivity/sync-core.js` to catch source/artifact drift.

## Architecture
Per-record last-write-wins over odysseus's native `notes` table (tie-break by client `editedAt`). Backend: `sync_change_log` + `Note` mapper listeners + `/api/sync/pull|push` routed through the note CRUD service (`routes/note/note_service.py`). Client: Dexie store + outbox + `notesRepo`; `notes.js` reads/writes the repo. See `docs/superpowers/specs/2026-07-21-odysseus-native-offline-productivity-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/productivity/sync-engine.md
git commit -m "docs(sync): engine regen command + Slice-A architecture note"
```

---

## Known caveats carried into later slices

- **Owner resolution asymmetry in auth-*disabled* dev mode:** `note_routes._owner` falls back to `None`, `sync_routes._owner` to `FALLBACK_OWNER`. In the target deployment (auth configured, TOTP set) both resolve to the real username, so this is consistent; a pure auth-disabled dev box would want `ODYSSEUS_FALLBACK_OWNER` aligned with how notes were created. Documented, not fixed in Slice A.
- **`sync_change_log` grows unbounded** — compaction is a named later enhancement (spec §9).
- **No automated multi-context offline e2e** — the offline proof is manual (Task 18 Step 3); engine convergence is unit-tested deterministically.
- **Checklist item-level merge** is not built — two offline edits to different items of the same note LWW the whole `items` blob (spec §4 accepted weakness).
