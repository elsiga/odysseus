"""Sync-infra tables over odysseus's native domains (not a domain table).
Generic append-only change log: records WHAT changed, per owner, for the pull cursor."""
from sqlalchemy import Column, String, Integer, DateTime
from core.database import Base, utcnow_naive


class SyncChangeLog(Base):
    __tablename__ = "sync_change_log"
    seq = Column(Integer, primary_key=True, autoincrement=True)
    owner = Column(String, index=True, nullable=False)
    entity = Column(String, nullable=False)              # e.g. "note"
    entity_id = Column(String, index=True, nullable=False)
    op = Column(String, nullable=False)                  # "upsert" | "delete"
    rev = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=utcnow_naive, nullable=False)


def create_sync_tables(engine):
    Base.metadata.create_all(engine, tables=[SyncChangeLog.__table__])
