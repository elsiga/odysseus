import uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import core.database as db
from src.sync.models import SyncChangeLog, create_sync_tables
from src.sync.listeners import register_note_listeners


def _session(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    create_sync_tables(eng)
    register_note_listeners()
    return sessionmaker(bind=eng)()


def test_insert_update_delete_log_rows(tmp_path):
    s = _session(tmp_path)
    nid = str(uuid.uuid4())
    n = db.Note(id=nid, owner="alice", title="hi", rev=1)
    s.add(n); s.commit()
    n.title = "bye"; n.rev = 2; s.commit()
    s.delete(n); s.commit()
    rows = s.query(SyncChangeLog).order_by(SyncChangeLog.seq).all()
    ops = [(r.entity, r.entity_id, r.op, r.rev) for r in rows]
    assert ops == [("note", nid, "upsert", 1), ("note", nid, "upsert", 2), ("note", nid, "delete", 2)]
