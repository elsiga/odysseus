"""Net-new SQLAlchemy mapper listeners on Note → append rows to sync_change_log.
Catches every write path (web UI, agents, and the sync push itself)."""
import logging
from sqlalchemy import event, insert
from sqlalchemy.exc import OperationalError
from core.database import Note
from src.sync.models import SyncChangeLog

_REGISTERED = False


def _log(connection, note, op):
    # Listeners are registered globally on the Note mapper. If a caller's DB has
    # no sync_change_log (isolated unit tests, or sync infra not yet initialized),
    # skip logging rather than crash the domain write.
    try:
        connection.execute(
            insert(SyncChangeLog.__table__).values(
                owner=note.owner, entity="note", entity_id=note.id, op=op, rev=note.rev,
            )
        )
    except OperationalError as e:
        if "no such table" in str(e).lower():
            return
        logging.getLogger(__name__).warning(f"sync_change_log append failed: {e}")


def register_note_listeners():
    global _REGISTERED
    if _REGISTERED:
        return
    event.listen(Note, "after_insert", lambda m, c, t: _log(c, t, "upsert"))
    event.listen(Note, "after_update", lambda m, c, t: _log(c, t, "upsert"))
    event.listen(Note, "after_delete", lambda m, c, t: _log(c, t, "delete"))
    _REGISTERED = True
