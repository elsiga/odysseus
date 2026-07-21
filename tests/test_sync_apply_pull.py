import json
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import pytest
import src.sync.models as m
from src.sync.registry import synced_fields, validate_field_value
from src.sync.winners import winners_from_rows
from src.sync.models import SyncChangeLog
from src.sync.apply import apply_push


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
