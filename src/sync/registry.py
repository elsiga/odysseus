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
