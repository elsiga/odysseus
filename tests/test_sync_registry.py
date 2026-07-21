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
