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
