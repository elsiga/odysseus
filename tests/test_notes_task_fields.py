import core.database as db
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from routes.note.note_service import (
    create_note_record, update_note_record, note_to_wire, note_from_wire,
)


def _s(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    return sessionmaker(bind=eng)()


def test_task_fields_default_and_roundtrip(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T"})
    # defaults
    assert n.bucket == "today" and n.urgency == 0 and n.project is None and n.done is False
    wire = note_to_wire(n)
    assert wire["bucket"] == "today" and wire["urgency"] == 0
    assert wire["project"] is None and wire["done"] is False


def test_task_fields_create_and_update(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {
        "title": "T", "bucket": "soon", "urgency": 2, "project": "flat", "done": False,
    })
    assert n.bucket == "soon" and n.urgency == 2 and n.project == "flat"
    n2 = update_note_record(s, "alice", n.id, {"done": True, "bucket": "someday"})
    assert n2.done is True and n2.bucket == "someday"


def test_task_fields_wire_in_filters(tmp_path):
    data = note_from_wire({"title": "T", "bucket": "soon", "project": "x",
                           "urgency": 1, "done": True, "not_a_field": 9})
    assert data["bucket"] == "soon" and data["done"] is True and "not_a_field" not in data


def test_duration_min_default_null_and_roundtrip(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T"})
    assert n.duration_min is None
    assert note_to_wire(n)["duration_min"] is None


def test_duration_min_create_and_update(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T", "duration_min": 25})
    assert n.duration_min == 25
    assert note_to_wire(n)["duration_min"] == 25
    n2 = update_note_record(s, "alice", n.id, {"duration_min": 45})
    assert n2.duration_min == 45
    # Clearing uses 0 (update skips None), meaning "no explicit duration"
    n3 = update_note_record(s, "alice", n.id, {"duration_min": 0})
    assert n3.duration_min == 0


def test_duration_min_wire_in_filters(tmp_path):
    data = note_from_wire({"title": "T", "duration_min": 60, "not_a_field": 9})
    assert data["duration_min"] == 60 and "not_a_field" not in data
