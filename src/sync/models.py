"""Sync-owned tables (separate from odysseus Notes). Column names are camelCase
to match ember's wire field names so the ported client speaks them unchanged."""
from sqlalchemy import Column, String, Text, Float, Integer, DateTime
from core.database import Base, utcnow_naive


class SyncTask(Base):
    __tablename__ = "sync_task"
    id = Column(String, primary_key=True)
    owner = Column(String, index=True, nullable=False)
    projectId = Column(String, nullable=True)
    title = Column(String, default="")
    notes = Column(Text, default="")
    bucket = Column(String, default="today")            # today|soon|someday
    scheduledAt = Column(String, nullable=True)          # ISO or null
    scheduledDurationMin = Column(Integer, nullable=True)
    sortOrder = Column(Float, default=0.0)
    completedAt = Column(String, nullable=True)
    createdAt = Column(String, nullable=True)            # client-set ISO
    deletedAt = Column(String, nullable=True)            # tombstone (client-set ISO)
    updatedAt = Column(DateTime, default=utcnow_naive, onupdate=utcnow_naive, nullable=False)


class SyncChangeLog(Base):
    __tablename__ = "sync_change_log"
    seq = Column(Integer, primary_key=True, autoincrement=True)
    owner = Column(String, index=True, nullable=False)
    entity = Column(String, nullable=False)
    entityId = Column(String, index=True, nullable=False)
    fields = Column(Text, nullable=False)                # JSON: {field: {v, ts}}
    deviceId = Column(String, nullable=False)
    createdAt = Column(DateTime, default=utcnow_naive, nullable=False)


def create_sync_tables(engine):
    Base.metadata.create_all(engine, tables=[SyncTask.__table__, SyncChangeLog.__table__])
