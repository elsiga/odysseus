"""Sync-infra tables over odysseus's native domains (not a domain table).
Generic append-only change log: records WHAT changed, per owner, for the pull cursor."""
import logging

from sqlalchemy import Column, String, Integer, DateTime, inspect, text

from core.database import Base, utcnow_naive

logger = logging.getLogger(__name__)


class SyncChangeLog(Base):
    __tablename__ = "sync_change_log"
    seq = Column(Integer, primary_key=True, autoincrement=True)
    owner = Column(String, index=True, nullable=False)
    entity = Column(String, nullable=False)              # e.g. "note"
    entity_id = Column(String, index=True, nullable=False)
    op = Column(String, nullable=False)                  # "upsert" | "delete"
    rev = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)


def _rename_stale_change_log(engine):
    """Preserve+drop a pre-Slice-A change log so create_all can rebuild it.

    The Slice-1 log used columns (entityId, fields, deviceId, createdAt); the
    per-record-LWW engine needs (entity_id, op, rev). Base.metadata.create_all
    skips tables that already exist, so a DB carried over from Slice 1 keeps the
    stale table and every push / incremental pull dies with
    'no such column: sync_change_log.entity_id'. Rename the old table to
    *_slice1_bak (rows preserved, not deleted) and return its max seq so the
    caller can seed the rebuilt table's sequence past it, keeping existing
    client pull cursors valid. Idempotent: returns None once entity_id exists.
    """
    insp = inspect(engine)
    if not insp.has_table("sync_change_log"):
        return None  # fresh DB — create_all will make the correct schema
    cols = [c["name"] for c in insp.get_columns("sync_change_log")]
    if "entity_id" in cols:
        return None  # already on the per-record-LWW schema
    with engine.begin() as conn:
        old_max = conn.execute(
            text("SELECT COALESCE(MAX(seq), 0) FROM sync_change_log")
        ).scalar() or 0
        conn.execute(text("DROP TABLE IF EXISTS sync_change_log_slice1_bak"))
        conn.execute(text("ALTER TABLE sync_change_log RENAME TO sync_change_log_slice1_bak"))
    logger.warning(
        "Migrated stale Slice-1 sync_change_log (rows preserved as "
        "sync_change_log_slice1_bak); rebuilding per-record-LWW schema, "
        "seeding seq past %s so live pull cursors stay valid",
        old_max,
    )
    return int(old_max)


def _seed_change_log_sequence(engine, old_max):
    """Insert one non-pullable system row so the rebuilt table's autoincrement
    continues past the old max seq. pull_changes skips rows whose entity is not
    in REGISTRY, so this seed never surfaces to a client."""
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO sync_change_log"
                "(seq, owner, entity, entity_id, op, rev, created_at) "
                "VALUES (:seq, '__system__', '__seed__', '__seed__', 'delete', 0, :ts)"
            ),
            {"seq": old_max, "ts": utcnow_naive()},
        )


def create_sync_tables(engine):
    old_max = _rename_stale_change_log(engine)
    Base.metadata.create_all(engine, tables=[SyncChangeLog.__table__])
    if old_max is not None:
        _seed_change_log_sequence(engine, old_max)
