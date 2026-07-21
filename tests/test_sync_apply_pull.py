import json
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import src.sync.models as m
from src.sync.registry import synced_fields, validate_field_value
from src.sync.winners import winners_from_rows
from src.sync.models import SyncChangeLog


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
