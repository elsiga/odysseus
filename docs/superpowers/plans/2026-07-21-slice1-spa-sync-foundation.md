# Slice 1 — Local-First SPA + Per-Field Sync Foundation (Tasks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the thinnest end-to-end vertical of the offline-first productivity layer: a new React/Vite SPA, served by odysseus at `/app`, that lists/creates/edits/deletes **tasks** offline (IndexedDB) and syncs them to odysseus with **per-field last-write-wins** (ember-faithful), proving the full local-first ↔ odysseus loop.

**Architecture:** Ember's local-first sync engine is lifted near-verbatim onto the client (Dexie store + outbox + per-field HLC stamps). odysseus's Python backend gains a faithful reimplementation of ember's sync server: two new **sync-owned tables** (`sync_task` live rows + an append-only `sync_change_log`) and two endpoints (`POST /api/sync/push`, `GET /api/sync/pull`) that resolve conflicts **per field** via hybrid-logical-clock comparison. New tasks are a store separate from odysseus's legacy `Note`; agent access is a later, additive slice. Browser is same-origin → cookie/TOTP auth via `require_user`.

**Tech Stack:** Backend — Python 3, FastAPI, SQLAlchemy, pytest (httpx `AsyncClient` + `ASGITransport`). Frontend — TypeScript, React 18, Vite, Dexie 4, zod, Vitest + `fake-indexeddb`, `vite-plugin-pwa`.

**Reference implementation (read-only, port from here):** ember at `/home/elsiga/labspace/ember`. Shared core `packages/shared/src/{hlc,sync,entities}.ts` + `domain/*`; client `apps/web/src/sync/*`, `apps/web/src/db/*`; server semantics to mirror `apps/server/src/sync/{apply,pull,winners,registry}.ts`.

## Global Constraints

- **Single backend only: odysseus.** No ember-server. (spec §1)
- **Per-field LWW via HLC + append-only change_log**, mirroring ember's wire format and semantics exactly. (design decision)
- **Sync-owned tables only** (`sync_task`, `sync_change_log`); do **not** touch odysseus's `notes`/`Note` or its write paths. (design decision — keeps upstream merges clean)
- **All logic in NEW files.** Only one-line hooks allowed in `app.py` (router include + `/app` serving). No edits to `core/database.py` or any actively-developed upstream file. (spec §5)
- **New tables created via the sync package**, not via `init_db()` edits: register models on `Base.metadata` (imported through `routes/sync_routes.py`) and `create_all(tables=[...])` at router setup. (this plan)
- **Wire field names are ember's camelCase** (`projectId`, `scheduledAt`, `sortOrder`, `completedAt`, `createdAt`, `deletedAt`) so the ported client speaks them unchanged; `sync_task` columns are named identically. (this plan)
- **HLC compare:** lexicographic on `ts`, tiebreak `deviceId`, **strict `<`** (own echoes at equal ts are no-ops). Field values are **JSON scalars only**. (ember invariant)
- **`updatedAt` is server-owned**, never accepted in a patch, never LWW'd; server stamps apply-time. (ember invariant)
- New SPA lives in `webapp/`; `webapp/node_modules` and `webapp/dist` are gitignored.

---

## File Structure

**Backend (all new files):**
- `src/sync/__init__.py`
- `src/sync/models.py` — `SyncTask` (live), `SyncChangeLog` (append-only) on `Base`.
- `src/sync/hlc.py` — `compare_hlc(a_ts, a_dev, b_ts, b_dev) -> int`.
- `src/sync/winners.py` — `winners_from_rows(rows) -> dict[field -> (ts, deviceId)]`.
- `src/sync/registry.py` — `REGISTRY[kind] = {model, fields}`; `synced_fields(kind)`, `validate_field_value(kind, field, value)`.
- `src/sync/apply.py` — `apply_push(db, owner, device_id, patches) -> dict`.
- `src/sync/pull.py` — `pull_changes(db, owner, cursor, limit) -> dict`.
- `routes/sync_routes.py` — `setup_sync_routes()` → `APIRouter(prefix="/api/sync")` with `POST /push`, `GET /pull`, `GET /ping`; creates the sync tables on setup.

**Backend (one-line hooks only):**
- `app.py` — `include_router(setup_sync_routes())`; `/app-assets` mount + `/app` routes.

**Backend tests (new):**
- `tests/test_sync_hlc.py`, `tests/test_sync_apply_pull.py`, `tests/test_sync_routes.py`

**Frontend (new subtree `webapp/`):** scaffold; `src/shared/` (ported ember shared core); `src/sync/` (ported ember client engine, task-only); `src/db/` (Dexie + task repo); `src/ui/TasksScreen.tsx`; Vitest specs.

**Design reference (read-only):** `design/Tasks + Calendar Prototype.dc.html` — Task 14.

---

### Task 1: Sync-owned tables (`sync_task`, `sync_change_log`)

**Files:**
- Create: `src/sync/__init__.py`, `src/sync/models.py`
- Test: `tests/test_sync_apply_pull.py`

**Interfaces:**
- Produces:
  - `SyncTask` — columns (camelCase to match wire): `id` (PK str), `owner` (str, index), `projectId`, `title`, `notes`, `bucket`, `scheduledAt`, `scheduledDurationMin`, `sortOrder` (Float), `completedAt`, `createdAt`, `deletedAt`, plus server-owned `updatedAt` (DateTime, `onupdate`).
  - `SyncChangeLog` — `seq` (Integer PK autoincrement), `owner` (str, index), `entity` (str), `entityId` (str, index), `fields` (Text = JSON of `{field: {v, ts}}`), `deviceId` (str), `createdAt` (DateTime).
  - `create_sync_tables(engine)` — `Base.metadata.create_all(engine, tables=[SyncTask.__table__, SyncChangeLog.__table__])`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_apply_pull.py
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import src.sync.models as m


def _db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path/'s.db'}",
        connect_args={"check_same_thread": False}, poolclass=NullPool)
    m.create_sync_tables(engine)
    return engine, sessionmaker(bind=engine)


def test_sync_tables_exist(tmp_path):
    engine, _ = _db(tmp_path)
    names = set(inspect(engine).get_table_names())
    assert {"sync_task", "sync_change_log"} <= names
    cols = {c["name"] for c in inspect(engine).get_columns("sync_task")}
    assert {"id", "owner", "title", "sortOrder", "deletedAt", "updatedAt"} <= cols
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_apply_pull.py::test_sync_tables_exist -v`
Expected: FAIL — `No module named 'src.sync.models'`.

- [ ] **Step 3: Implement the models**

```python
# src/sync/__init__.py
```

```python
# src/sync/models.py
"""Sync-owned tables (separate from odysseus Notes). Column names are camelCase
to match ember's wire field names so the ported client speaks them unchanged."""
from sqlalchemy import Column, String, Text, Float, Integer, DateTime
from core.database import Base, utcnow_naive


class SyncTask(Base):
    __tablename__ = "sync_task"
    id = Column(String, primary_key=True)
    owner = Column(String, index=True, nullable=False)
    projectId = Column(String, nullable=True)
    title = Column(String, default="")
    notes = Column(Text, default="")
    bucket = Column(String, default="today")            # today|soon|someday
    scheduledAt = Column(String, nullable=True)          # ISO or null
    scheduledDurationMin = Column(Integer, nullable=True)
    sortOrder = Column(Float, default=0.0)
    completedAt = Column(String, nullable=True)
    createdAt = Column(String, nullable=True)            # client-set ISO
    deletedAt = Column(String, nullable=True)            # tombstone (client-set ISO)
    updatedAt = Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False)


class SyncChangeLog(Base):
    __tablename__ = "sync_change_log"
    seq = Column(Integer, primary_key=True, autoincrement=True)
    owner = Column(String, index=True, nullable=False)
    entity = Column(String, nullable=False)
    entityId = Column(String, index=True, nullable=False)
    fields = Column(Text, nullable=False)                # JSON: {field: {v, ts}}
    deviceId = Column(String, nullable=False)
    createdAt = Column(DateTime, default=utcnow_naive, nullable=False)


def create_sync_tables(engine):
    Base.metadata.create_all(engine, tables=[SyncTask.__table__, SyncChangeLog.__table__])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_apply_pull.py::test_sync_tables_exist -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/__init__.py src/sync/models.py tests/test_sync_apply_pull.py
git commit -m "feat(sync): sync-owned task + change_log tables"
```

---

### Task 2: HLC comparison

**Files:**
- Create: `src/sync/hlc.py`
- Test: `tests/test_sync_hlc.py`

**Interfaces:**
- Produces: `compare_hlc(a_ts: str, a_dev: str, b_ts: str, b_dev: str) -> int` → `-1|0|1`. Ports ember `compareHlc`: compare `ts` lexicographically; if equal, compare `deviceId`; else 0.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sync_hlc.py
from src.sync.hlc import compare_hlc


def test_ts_dominates():
    assert compare_hlc("2026-07-21T00:00:00.000Z-000002", "d1",
                       "2026-07-21T00:00:00.000Z-000001", "d9") == 1

def test_device_tiebreak():
    ts = "2026-07-21T00:00:00.000Z-000001"
    assert compare_hlc(ts, "d1", ts, "d2") == -1
    assert compare_hlc(ts, "d2", ts, "d2") == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_hlc.py -v`
Expected: FAIL — `No module named 'src.sync.hlc'`.

- [ ] **Step 3: Implement**

```python
# src/sync/hlc.py
def compare_hlc(a_ts: str, a_dev: str, b_ts: str, b_dev: str) -> int:
    if a_ts != b_ts:
        return -1 if a_ts < b_ts else 1
    if a_dev != b_dev:
        return -1 if a_dev < b_dev else 1
    return 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_hlc.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/hlc.py tests/test_sync_hlc.py
git commit -m "feat(sync): HLC comparison (ember-faithful)"
```

---

### Task 3: Field registry + winners reducer

**Files:**
- Create: `src/sync/registry.py`, `src/sync/winners.py`
- Test: `tests/test_sync_apply_pull.py`

**Interfaces:**
- Produces:
  - `REGISTRY: dict[str, dict]` with `"task" -> {"model": SyncTask, "fields": [...]}`; fields = the SyncTask columns minus `id`, `owner`, `updatedAt`.
  - `synced_fields(kind) -> list[str]`; `validate_field_value(kind, field, value) -> bool` (scalar-only: `str|int|float|bool|None`).
  - `winners_from_rows(rows: list[SyncChangeLog]) -> dict[str, tuple[str, str]]` — highest-HLC `(ts, deviceId)` per field, using `compare_hlc`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_sync_apply_pull.py
import json
from src.sync.registry import synced_fields, validate_field_value
from src.sync.winners import winners_from_rows
from src.sync.models import SyncChangeLog


def test_synced_fields_and_validation():
    f = synced_fields("task")
    assert "title" in f and "id" not in f and "updatedAt" not in f
    assert validate_field_value("task", "title", "hi") is True
    assert validate_field_value("task", "title", {"nested": 1}) is False


def test_winners_pick_highest_hlc():
    rows = [
        SyncChangeLog(owner="a", entity="task", entityId="t1", deviceId="d1",
                      fields=json.dumps({"title": {"v": "old", "ts": "2026-01-01T00:00:00.000Z-000001"}})),
        SyncChangeLog(owner="a", entity="task", entityId="t1", deviceId="d2",
                      fields=json.dumps({"title": {"v": "new", "ts": "2026-01-01T00:00:00.000Z-000002"}})),
    ]
    w = winners_from_rows(rows)
    assert w["title"] == ("2026-01-01T00:00:00.000Z-000002", "d2")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_apply_pull.py -k "synced_fields or winners" -v`
Expected: FAIL — import errors.

- [ ] **Step 3: Implement**

```python
# src/sync/registry.py
from src.sync.models import SyncTask

_EXCLUDED = {"id", "owner", "updatedAt"}


def _columns(model) -> list[str]:
    return [c.name for c in model.__table__.columns if c.name not in _EXCLUDED]


REGISTRY = {
    "task": {"model": SyncTask, "fields": _columns(SyncTask)},
}


def synced_fields(kind: str) -> list[str]:
    return REGISTRY[kind]["fields"]


def validate_field_value(kind: str, field: str, value) -> bool:
    if field not in synced_fields(kind):
        return False
    return isinstance(value, (str, int, float, bool)) or value is None
```

```python
# src/sync/winners.py
import json
from src.sync.hlc import compare_hlc


def winners_from_rows(rows) -> dict:
    winners: dict[str, tuple[str, str]] = {}
    for row in rows:
        dev = row.deviceId
        for field, fp in json.loads(row.fields).items():
            ts = fp["ts"]
            cur = winners.get(field)
            if cur is None or compare_hlc(cur[0], cur[1], ts, dev) < 0:
                winners[field] = (ts, dev)
    return winners
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_apply_pull.py -k "synced_fields or winners" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/registry.py src/sync/winners.py tests/test_sync_apply_pull.py
git commit -m "feat(sync): field registry + HLC winners reducer"
```

---

### Task 4: `apply_push` — per-field LWW upsert + change_log append

**Files:**
- Create: `src/sync/apply.py`
- Test: `tests/test_sync_apply_pull.py`

**Interfaces:**
- Consumes: `REGISTRY`, `synced_fields`, `validate_field_value`, `winners_from_rows`, `compare_hlc`, models.
- Produces: `apply_push(db, owner, device_id, patches) -> {"applied": int, "serverSeq": int}`.
  For each patch `{entity, entityId, fields:{f:{v,ts}}}`: reject unknown/invalid fields (`ValueError("INVALID_FIELD"/"INVALID_VALUE")`); load or create the live row (owner check → `PermissionError`); compute current winners from that entity's change_log rows; keep only fields whose incoming `(ts, device_id)` beats the current winner (**strict `>`**); write winning values to the live row via ORM; append **one** `SyncChangeLog` row with the winning fields; commit. Returns count applied + max seq for owner.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_sync_apply_pull.py
import pytest
from src.sync.apply import apply_push


def _patch(entity_id, **fields_ts):
    return {"entity": "task", "entityId": entity_id,
            "fields": {f: {"v": v, "ts": ts} for f, (v, ts) in fields_ts.items()}}


TS1 = "2026-07-21T00:00:00.000Z-000001"
TS2 = "2026-07-21T00:00:00.000Z-000002"


def test_apply_creates_then_field_lww(tmp_path):
    _, Session = _db(tmp_path)
    db = Session()
    r = apply_push(db, "alice", "dev1", [_patch("t1", title=("A", TS1), bucket=("today", TS1))])
    assert r["applied"] == 1
    row = db.query(m.SyncTask).get("t1")
    assert row.title == "A" and row.owner == "alice"

    # older ts loses, newer ts wins — per field
    apply_push(db, "alice", "dev1", [_patch("t1", title=("STALE", TS1))])   # equal/old -> skipped
    assert db.query(m.SyncTask).get("t1").title == "A"
    apply_push(db, "alice", "dev1", [_patch("t1", title=("B", TS2))])       # newer -> wins
    assert db.query(m.SyncTask).get("t1").title == "B"


def test_apply_rejects_unknown_field(tmp_path):
    _, Session = _db(tmp_path)
    db = Session()
    with pytest.raises(ValueError):
        apply_push(db, "alice", "dev1",
                   [{"entity": "task", "entityId": "t1", "fields": {"nope": {"v": 1, "ts": TS1}}}])


def test_apply_owner_gate(tmp_path):
    _, Session = _db(tmp_path)
    db = Session()
    apply_push(db, "alice", "dev1", [_patch("t1", title=("mine", TS1))])
    with pytest.raises(PermissionError):
        apply_push(db, "bob", "dev1", [_patch("t1", title=("steal", TS2))])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_apply_pull.py -k apply -v`
Expected: FAIL — `No module named 'src.sync.apply'`.

- [ ] **Step 3: Implement**

```python
# src/sync/apply.py
import json
from src.sync.registry import REGISTRY, synced_fields, validate_field_value
from src.sync.winners import winners_from_rows
from src.sync.hlc import compare_hlc
from src.sync.models import SyncChangeLog


def apply_push(db, owner: str, device_id: str, patches: list) -> dict:
    applied = 0
    for patch in patches:
        entity = patch["entity"]
        if entity not in REGISTRY:
            raise ValueError("INVALID_FIELD")
        model = REGISTRY[entity]["model"]
        entity_id = patch["entityId"]
        incoming = patch["fields"]

        for field, fp in incoming.items():
            if field not in synced_fields(entity):
                raise ValueError("INVALID_FIELD")
            if not validate_field_value(entity, field, fp["v"]):
                raise ValueError("INVALID_VALUE")

        row = db.query(model).get(entity_id)
        if row is not None and row.owner != owner:
            raise PermissionError("FORBIDDEN")

        prior = (db.query(SyncChangeLog)
                   .filter(SyncChangeLog.owner == owner,
                           SyncChangeLog.entity == entity,
                           SyncChangeLog.entityId == entity_id).all())
        current = winners_from_rows(prior)

        winning = {}
        for field, fp in incoming.items():
            cur = current.get(field)
            if cur is None or compare_hlc(cur[0], cur[1], fp["ts"], device_id) < 0:
                winning[field] = fp

        if not winning:
            continue

        if row is None:
            row = model(id=entity_id, owner=owner)
            db.add(row)
        for field, fp in winning.items():
            setattr(row, field, fp["v"])

        db.add(SyncChangeLog(owner=owner, entity=entity, entityId=entity_id,
                             deviceId=device_id, fields=json.dumps(winning)))
        applied += 1

    db.commit()
    max_seq = (db.query(SyncChangeLog.seq)
                 .filter(SyncChangeLog.owner == owner)
                 .order_by(SyncChangeLog.seq.desc()).first())
    return {"applied": applied, "serverSeq": max_seq[0] if max_seq else 0}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_apply_pull.py -k apply -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/apply.py tests/test_sync_apply_pull.py
git commit -m "feat(sync): apply_push per-field LWW + change_log append"
```

---

### Task 5: `pull_changes` — incremental + cursor-0 snapshot

**Files:**
- Create: `src/sync/pull.py`
- Test: `tests/test_sync_apply_pull.py`

**Interfaces:**
- Produces: `pull_changes(db, owner, cursor: int, limit: int) -> {"changes": [...], "cursor": int, "hasMore": bool}`.
  - `cursor == 0`: synthesize one full-row change per live `sync_task` row owned by `owner` (including tombstoned), each field's `ts` = its winning ts from change_log (fallback `updatedAt.isoformat()+"Z-000000"`); `cursor` = current max change_log seq for owner; `hasMore` = False.
  - `cursor > 0`: `SyncChangeLog` rows where `owner` and `seq > cursor`, ordered by `seq`, limit `limit`; map to `{seq, entity, entityId, fields}`; `cursor` = last seq; `hasMore = (len == limit and last < max_seq)`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_sync_apply_pull.py
from src.sync.pull import pull_changes


def test_pull_bootstrap_then_incremental(tmp_path):
    _, Session = _db(tmp_path)
    db = Session()
    apply_push(db, "alice", "dev1", [_patch("t1", title=("A", TS1))])

    boot = pull_changes(db, "alice", 0, 500)
    assert len(boot["changes"]) == 1
    assert boot["changes"][0]["entityId"] == "t1"
    assert boot["changes"][0]["fields"]["title"]["v"] == "A"
    assert boot["hasMore"] is False
    cursor = boot["cursor"]

    apply_push(db, "alice", "dev1", [_patch("t1", title=("B", TS2))])
    inc = pull_changes(db, "alice", cursor, 500)
    assert [c["fields"]["title"]["v"] for c in inc["changes"]] == ["B"]
    assert inc["cursor"] > cursor
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_apply_pull.py -k pull -v`
Expected: FAIL — `No module named 'src.sync.pull'`.

- [ ] **Step 3: Implement**

```python
# src/sync/pull.py
import json
from src.sync.registry import REGISTRY, synced_fields
from src.sync.winners import winners_from_rows
from src.sync.models import SyncChangeLog


def _max_seq(db, owner: str) -> int:
    row = (db.query(SyncChangeLog.seq).filter(SyncChangeLog.owner == owner)
             .order_by(SyncChangeLog.seq.desc()).first())
    return row[0] if row else 0


def pull_changes(db, owner: str, cursor: int, limit: int) -> dict:
    if cursor <= 0:
        changes = []
        for entity, spec in REGISTRY.items():
            model = spec["model"]
            for row in db.query(model).filter(model.owner == owner).all():
                prior = (db.query(SyncChangeLog)
                           .filter(SyncChangeLog.owner == owner,
                                   SyncChangeLog.entity == entity,
                                   SyncChangeLog.entityId == row.id).all())
                winners = winners_from_rows(prior)
                fallback_ts = (row.updatedAt.isoformat() + "Z-000000") if row.updatedAt else "1970-01-01T00:00:00.000Z-000000"
                fields = {}
                for f in synced_fields(entity):
                    v = getattr(row, f)
                    ts = winners[f][0] if f in winners else fallback_ts
                    fields[f] = {"v": v, "ts": ts}
                changes.append({"seq": 0, "entity": entity, "entityId": row.id, "fields": fields})
        return {"changes": changes, "cursor": _max_seq(db, owner), "hasMore": False}

    rows = (db.query(SyncChangeLog)
              .filter(SyncChangeLog.owner == owner, SyncChangeLog.seq > cursor)
              .order_by(SyncChangeLog.seq.asc()).limit(limit).all())
    changes = [{"seq": r.seq, "entity": r.entity, "entityId": r.entityId,
                "fields": json.loads(r.fields)} for r in rows]
    out_cursor = rows[-1].seq if rows else cursor
    has_more = len(rows) == limit and out_cursor < _max_seq(db, owner)
    return {"changes": changes, "cursor": out_cursor, "hasMore": has_more}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_apply_pull.py -k pull -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/pull.py tests/test_sync_apply_pull.py
git commit -m "feat(sync): pull_changes incremental + cursor-0 snapshot"
```

---

### Task 6: Sync router + app.py wiring

**Files:**
- Create: `routes/sync_routes.py`
- Modify: `app.py` (one import + one `include_router` near the notes registration ~line 832)
- Test: `tests/test_sync_routes.py`

**Interfaces:**
- Produces: `setup_sync_routes() -> APIRouter` (`/api/sync`), creating the sync tables on setup, with:
  - `GET /ping` → `{"ok": True, "user": owner}`
  - `POST /push` body `{deviceId, patches}` → `apply_push(...)`; maps `ValueError`→400 `{error:<code>}`, `PermissionError`→403 `{error:"FORBIDDEN"}`.
  - `GET /pull?cursor=&limit=` → `pull_changes(...)` (cursor default 0, limit clamped 1..500).

- [ ] **Step 1: Write the failing test** (odysseus ASGITransport + `x-test-user` shim)

```python
# tests/test_sync_routes.py
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


def _app(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path/'s.db'}",
        connect_args={"check_same_thread": False}, poolclass=NullPool)
    Session = sessionmaker(bind=engine)
    import routes.sync_routes as sr
    monkeypatch.setattr(sr, "SessionLocal", Session)
    monkeypatch.setattr(sr, "engine", engine)
    app = FastAPI()
    app.state.auth_manager = SimpleNamespace(is_configured=True)
    app.include_router(sr.setup_sync_routes())
    return _Identity(app)


def _c(app):
    t = httpx.ASGITransport(app=app, client=("203.0.113.7", 54321))
    return httpx.AsyncClient(transport=t, base_url="http://sync.test")


async def test_push_then_pull(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    alice = {"x-test-user": "alice"}
    async with _c(app) as c:
        body = {"deviceId": "dev1", "patches": [
            {"entity": "task", "entityId": "t1", "fields": {"title": {"v": "Buy milk", "ts": TS1}}}]}
        r = await c.post("/api/sync/push", json=body, headers=alice)
        assert r.status_code == 200 and r.json()["applied"] == 1
        pulled = (await c.get("/api/sync/pull?cursor=0", headers=alice)).json()
        assert pulled["changes"][0]["fields"]["title"]["v"] == "Buy milk"


async def test_pull_requires_auth(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    async with _c(app) as c:
        r = await c.get("/api/sync/pull?cursor=0")
        assert r.status_code in (401, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_sync_routes.py -v`
Expected: FAIL — `No module named 'routes.sync_routes'`.

- [ ] **Step 3: Implement the router**

```python
# routes/sync_routes.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_sync_routes.py -v`
Expected: PASS.

- [ ] **Step 5: Wire into app.py + full backend run**

In `app.py`, near the notes registration (~line 832):

```python
# Local-first per-field sync (SPA at /app)
from routes.sync_routes import setup_sync_routes
app.include_router(setup_sync_routes())
```

Run: `python -m pytest tests/test_sync_hlc.py tests/test_sync_apply_pull.py tests/test_sync_routes.py -v`
Expected: all PASS.

```bash
git add routes/sync_routes.py app.py tests/test_sync_routes.py
git commit -m "feat(sync): /api/sync push/pull router + app wiring"
```

---

### Task 7: Scaffold the `webapp/` SPA

Identical to a standard Vite+React+PWA scaffold. **Files:** `webapp/{package.json,vite.config.ts,tsconfig.json,index.html}`, `webapp/src/{main.tsx,App.tsx}`, `.gitignore` entries; add `zod` to dependencies (client reuses ember's zod wire schemas).

- [ ] **Step 1: gitignore** — append to `.gitignore`:
```
# New SPA (webapp/) build + deps
webapp/node_modules/
webapp/dist/
```

- [ ] **Step 2: Scaffold** — create `webapp/package.json` (deps: `dexie@^4`, `react@^18`, `react-dom@^18`, `zod@^3`; devDeps: `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `fake-indexeddb`, `typescript@^5`, `vite@^5`, `vite-plugin-pwa`, `vitest@^2`, `jsdom`), `vite.config.ts` (`base:"/app-assets/"`, react + VitePWA plugins, dev `server.proxy` `/api → http://localhost:7000`), `tsconfig.json` (strict, `jsx:"react-jsx"`), `index.html`, `src/main.tsx`, `src/App.tsx` (placeholder `<h1>Odysseus Tasks</h1>`), `vitest.config.ts` (`environment:"jsdom"`, `setupFiles:["src/test-setup.ts"]`), `src/test-setup.ts` (`import "fake-indexeddb/auto"`).

- [ ] **Step 3: Verify** — Run: `cd webapp && npm install && npm run build` → exit 0, `webapp/dist` produced.

- [ ] **Step 4: Commit**
```bash
git add webapp .gitignore && git commit -m "feat(webapp): scaffold Vite + React SPA"
```

---

### Task 8: Port ember's shared sync core

**Files:**
- Create by copying from ember (read `/home/elsiga/labspace/ember/packages/shared/src/*` and reproduce): `webapp/src/shared/hlc.ts`, `webapp/src/shared/sync.ts`, `webapp/src/shared/entities.ts`, `webapp/src/shared/domain/tasks.ts`, `webapp/src/shared/domain/sortOrder.ts`, `webapp/src/shared/index.ts` (barrel).
- Test: `webapp/src/shared/hlc.test.ts`

**Interfaces (as ported, verbatim from ember):**
- `hlc.ts`: `HlcStamp`, `hlcTimestamp(wallIso, counter)`, `compareHlc(a, b)`.
- `sync.ts`: zod `entityKindSchema/EntityKind`, `fieldPatchSchema/FieldPatch`, `entityPatchSchema/EntityPatch`, `pushRequestSchema/PushRequest`, `pushResponseSchema/PushResponse`, `pullChangeSchema/PullChange`, `pullResponseSchema/PullResponse`.
- `entities.ts`: `taskSchema/Task`, `bucketSchema` (Slice-1 subset — task only; other entities may be dropped from the enum in `sync.ts` to `['task']`).
- `domain/tasks.ts`, `domain/sortOrder.ts`: pure field-builders.

- [ ] **Step 1: Copy the files** — read each ember source and write the identical content to the `webapp/src/shared/...` path. In `sync.ts`, reduce `entityKindSchema` to `z.enum(['task'])` for Slice 1. `index.ts` re-exports from `./hlc`, `./sync`, `./entities`, `./domain/tasks`, `./domain/sortOrder`.

- [ ] **Step 2: Write the port-verification test**

```ts
// webapp/src/shared/hlc.test.ts
import { describe, it, expect } from "vitest";
import { compareHlc, hlcTimestamp } from "./hlc";

describe("hlc", () => {
  it("orders by ts then deviceId, strict", () => {
    const a = { ts: hlcTimestamp("2026-07-21T00:00:00.000Z", 2), deviceId: "d1" };
    const b = { ts: hlcTimestamp("2026-07-21T00:00:00.000Z", 1), deviceId: "d9" };
    expect(compareHlc(a, b)).toBe(1);
    expect(compareHlc(a, a)).toBe(0);
  });
});
```

- [ ] **Step 3: Run** — `cd webapp && npx vitest run src/shared/hlc.test.ts` → PASS.

- [ ] **Step 4: Commit**
```bash
git add webapp/src/shared && git commit -m "feat(webapp): port ember shared sync core (task-only)"
```

---

### Task 9: Port ember client store + synced writes (task-only)

**Files:**
- Create by porting from ember `apps/web/src/db/db.ts`, `apps/web/src/sync/hlc.ts`, `apps/web/src/sync/localWrite.ts`, `apps/web/src/db/repo/tasks.ts`:
  `webapp/src/db/db.ts` (Dexie — keep only `tasks`, `outbox`, `syncMeta`, `settings`, `activeTimer`; drop subtasks/projects/sessions/memoryEntries for Slice 1), `webapp/src/sync/hlc.ts` (`getDeviceId`, `nextHlc`), `webapp/src/sync/localWrite.ts` (`syncedCreate`, `syncedUpdate`, `setLocalWriteListener`, `notifySyncOfLocalWrite`), `webapp/src/db/repo/tasks.ts`.
- Test: `webapp/src/db/tasks.test.ts`

**Interfaces (ported):** `db` (Dexie, name `"odysseus-app"`); `TaskRow = Task & {_dirty:0|1; _fieldTs?:Record<string,string>}`; `OutboxRow`; repo `createTask`, `updateTask`, `completeTask`, `deleteTask`, `liveTasksByBucket`, `liveTodayTasks`, `setTaskSortOrder`.

- [ ] **Step 1: Port the files** — reproduce ember's content with the reduced table set; imports point at `../shared` instead of `@ember/shared`.

- [ ] **Step 2: Write the test**

```ts
// webapp/src/db/tasks.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./db";
import { createTask, updateTask, deleteTask, liveTodayTasks } from "./repo/tasks";

beforeEach(async () => { await db.delete(); await db.open(); });

describe("task repo", () => {
  it("create journals to outbox with a dirty row + field ts", async () => {
    const t = await createTask({ title: "Buy milk", bucket: "today" });
    const row = await db.tasks.get(t.id);
    expect(row!._dirty).toBe(1);
    expect(row!._fieldTs?.title).toBeDefined();
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });

  it("delete tombstones and drops from live list", async () => {
    const t = await createTask({ title: "X", bucket: "today" });
    await deleteTask(t.id);
    const live = await liveTodayTasks();
    expect(live.find((r) => r.id === t.id)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run** — `cd webapp && npx vitest run src/db/tasks.test.ts` → PASS.

- [ ] **Step 4: Commit**
```bash
git add webapp/src/db webapp/src/sync/hlc.ts webapp/src/sync/localWrite.ts
git commit -m "feat(webapp): port ember Dexie store + synced task writes"
```

---

### Task 10: Port ember sync engine + status (task-only)

**Files:**
- Create by porting `apps/web/src/sync/engine.ts`, `apps/web/src/sync/status.ts`, `apps/web/src/sync/client.ts`:
  `webapp/src/sync/engine.ts` (`createSyncClient`), `webapp/src/sync/status.ts`, `webapp/src/sync/client.ts`.
- Test: `webapp/src/sync/engine.test.ts`

**Interfaces (ported):** `createSyncClient({db?, apiBase, getToken, fetchFn?}) -> {syncOnce, start, stop}`. Adaptations: `apiBase` default `"/api/sync"`; `getToken` returns `null` (browser cookie auth — no bearer in Slice 1); `TABLES` maps only `task -> db.tasks`; endpoints `POST ${apiBase}/push`, `GET ${apiBase}/pull?cursor=`.

- [ ] **Step 1: Port** — reproduce ember's engine with `TABLES = { task: db.tasks }`, the entity enum reduced, and `api()` omitting the `Authorization` header when `getToken()` is null.

- [ ] **Step 2: Write the round-trip test** (mocked fetch, per-field apply)

```ts
// webapp/src/sync/engine.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db";
import { createTask } from "../db/repo/tasks";
import { createSyncClient } from "./engine";

beforeEach(async () => { await db.delete(); await db.open(); });

function fake(handlers: Record<string, (u: URL, i?: RequestInit) => any>) {
  return async (input: string, init?: RequestInit) => {
    const u = new URL(input, "http://t");
    const body = handlers[`${init?.method ?? "GET"} ${u.pathname}`](u, init);
    return { ok: true, status: 200, json: async () => body } as Response;
  };
}

describe("sync engine", () => {
  it("pushes dirty rows then clears outbox", async () => {
    const t = await createTask({ title: "Buy milk", bucket: "today" });
    let pushed: any = null;
    const fetchFn = fake({
      "POST /api/sync/push": (_u, i) => { pushed = JSON.parse(i!.body as string); return { applied: 1, serverSeq: 1 }; },
      "GET /api/sync/pull": () => ({ changes: [], cursor: 0, hasMore: false }),
    });
    const client = createSyncClient({ apiBase: "/api/sync", getToken: async () => null, fetchFn });
    await client.syncOnce();
    expect(pushed.patches[0].entityId).toBe(t.id);
    expect(pushed.patches[0].fields.title.v).toBe("Buy milk");
    expect(await db.outbox.count()).toBe(0);
  });

  it("applies a remote field only when its ts is newer (strict LWW)", async () => {
    const t = await createTask({ title: "local", bucket: "today" });
    // make the local row clean so pull may apply
    const row = await db.tasks.get(t.id); await db.tasks.put({ ...row!, _dirty: 0 });
    const newTs = "2999-01-01T00:00:00.000Z-000001";
    const fetchFn = fake({
      "POST /api/sync/push": () => ({ applied: 0, serverSeq: 0 }),
      "GET /api/sync/pull": (u) => Number(u.searchParams.get("cursor")) > 0
        ? { changes: [], cursor: 1, hasMore: false }
        : { changes: [{ seq: 1, entity: "task", entityId: t.id, fields: { title: { v: "remote wins", ts: newTs } } }], cursor: 1, hasMore: false },
    });
    const client = createSyncClient({ apiBase: "/api/sync", getToken: async () => null, fetchFn });
    await client.syncOnce();
    expect((await db.tasks.get(t.id))!.title).toBe("remote wins");
  });
});
```

- [ ] **Step 3: Run** — `cd webapp && npx vitest run src/sync/engine.test.ts` → PASS.

- [ ] **Step 4: Commit**
```bash
git add webapp/src/sync/engine.ts webapp/src/sync/status.ts webapp/src/sync/client.ts
git commit -m "feat(webapp): port ember sync engine (task-only, cookie auth)"
```

---

### Task 11: Tasks screen + wire the sync client

**Files:**
- Create: `webapp/src/ui/TasksScreen.tsx`
- Modify: `webapp/src/App.tsx`

**Interfaces:** consumes the task repo + `createSyncClient` + `useSyncStatus`. Minimal single screen: add via input, list today's tasks, complete, delete; sync-status text.

- [ ] **Step 1: Implement** `TasksScreen.tsx` (input→`createTask`, list from `liveTodayTasks` on a 1s poll, `completeTask`/`deleteTask` buttons, `useSyncStatus()` badge) and `App.tsx` (create a module-level `createSyncClient({apiBase:"/api/sync", getToken: async()=>null})`, `start()` in a `useEffect`, render `<TasksScreen/>`).

- [ ] **Step 2: Build** — `cd webapp && npm run build` → exit 0.

- [ ] **Step 3: Commit**
```bash
git add webapp/src/ui webapp/src/App.tsx && git commit -m "feat(webapp): Tasks screen wired to per-field sync"
```

---

### Task 12: Serve the SPA from odysseus at `/app`

**Files:** Modify `app.py` (mount `/app-assets` → `webapp/dist/assets`; `@app.get("/app")` + `@app.get("/app/{path:path}")` → `FileResponse(webapp/dist/index.html)`, guarded by `os.path.isdir`). Isolated prefix; no existing route affected.

- [ ] **Step 1: Add mount + routes** (as in the file-structure notes; `from fastapi.responses import FileResponse` if not already imported).

- [ ] **Step 2: Manual end-to-end verification** — `cd webapp && npm run build && cd .. && docker compose up -d`. Logged into odysseus, open `/app`: add "Buy milk" → within ~2s status flips `syncing`→`idle`. Confirm the round trip two ways: (a) open `/app` in a second browser/profile → "Buy milk" appears after its initial pull; (b) DevTools → offline → add "Offline task" → reload `/app` (still listed from IndexedDB, status `offline`) → back online → it syncs. Verify per-field: in browser A change the title, in browser B (before it syncs) change the bucket → after both sync, both changes survive.

- [ ] **Step 3: Commit**
```bash
git add app.py && git commit -m "feat(sync): serve local-first SPA at /app"
```

---

### Task 13: PWA offline shell

**Files:** Modify `webapp/vite.config.ts` — `VitePWA({ registerType:"autoUpdate", manifest:{name:"Odysseus Tasks", short_name:"Tasks", start_url:"/app", display:"standalone"}, workbox:{ navigateFallback:"/app-assets/index.html", globPatterns:["**/*.{js,css,html}"] } })`.

- [ ] **Step 1: Configure PWA** (above). **Step 2:** build + verify offline cold-load (DevTools → Application → Service Workers → Offline → reload `/app` renders from cache). **Step 3:** commit `style/feat(webapp): PWA offline app shell`.

---

### Task 14: Adapt visual language to the odysseus prototype

**Files:** Modify `webapp/src/ui/TasksScreen.tsx` (+ optional `webapp/src/ui/theme.css`). Reference (read-only): `design/Tasks + Calendar Prototype.dc.html`, `design/Screens.dc.html`.

- [ ] **Step 1:** Extract design tokens (font, color vars, radius, task-row layout) from the prototype; cross-check odysseus's `static/` CSS custom properties so the SPA reads as native. **Step 2:** Apply tokens (keep a single screen; day/week/calendar are Slice 2); verify light/dark parity. **Step 3:** build + eyeball vs. prototype. **Step 4:** commit `style(webapp): match odysseus design language`.

---

## Self-Review

**Spec coverage** (program doc §6 Slice 1 = "SPA + sync foundation + tasks offline, per-field, served by odysseus"): sync-owned tables → T1; HLC/winners/registry/apply/pull (ember-faithful per-field) → T2–T5; endpoints → T6; SPA scaffold → T7; ported shared core → T8; ported store+writes → T9; ported engine → T10; Tasks UI → T11; served at `/app` → T12; PWA offline → T13; design → T14. ✅ All Slice 1 points covered. Deferred by design: `ody_` token auth (Android slice), subtask/session/project entities + Pomodoro (Slice 2), agent access to `sync_task` (later additive tool).

**Placeholder scan:** Backend steps carry complete Python + real pytest commands. Client "port" tasks name exact ember source paths + the precise reductions (task-only entity set, cookie auth, `/api/sync` base) and include verification tests — actionable, not vague. No "TBD/handle edge cases".

**Type/contract consistency:** wire shapes match ember exactly on both sides — push `{deviceId, patches:[{entity,entityId,fields:{f:{v,ts}}}]}` (client `engine.ts` ↔ server `apply_push`), pull `{changes:[{seq,entity,entityId,fields}], cursor, hasMore}` (server `pull_changes` ↔ client apply). Field names are ember camelCase throughout, mirrored by `sync_task` columns and `synced_fields`. `compare_hlc`/`compareHlc` use identical strict-`<` semantics on both sides. `createSyncClient` signature identical in engine, tests, and `App.tsx`.

**Carried risk:** cursor-0 snapshot stamps agent-free rows via `updatedAt` fallback ts — correct here because `sync_task` has no non-sync writers (the whole point of sync-owned tables). If a future slice lets the agent write `sync_task` directly, it must go through `apply_push` (or journal to `sync_change_log`) to preserve per-field semantics — noted for that slice.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-slice1-spa-sync-foundation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks.
2. **Inline Execution** — tasks executed in this session in batches with checkpoints.

Which approach?
