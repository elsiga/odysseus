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
