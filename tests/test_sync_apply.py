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


def test_delete_wins_over_later_upsert_no_resurrection(tmp_path):
    s = _s(tmp_path)
    nid = str(uuid.uuid4())
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:00:00", "record": {"title": "x"}}])
    apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "delete",
        "editedAt": "2026-07-21T10:01:00"}])
    # A stale offline device pushes an upsert (even with a LATER editedAt) to the
    # deleted id — spec §4: delete wins, must NOT resurrect.
    r = apply_push(s, "alice", [{"entity": "note", "id": nid, "op": "upsert",
        "editedAt": "2026-07-21T10:02:00", "record": {"title": "resurrected"}}])
    assert r["results"][0]["op"] == "delete"
    assert s.query(db.Note).filter(db.Note.id == nid).first() is None
