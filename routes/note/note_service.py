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
