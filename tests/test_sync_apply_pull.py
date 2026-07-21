from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
import src.sync.models as m


def _db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path/'s.db'}",
        connect_args={"check_same_thread": False}, poolclass=NullPool)
    m.create_sync_tables(engine)
    return engine, sessionmaker(bind=engine)


def test_sync_tables_exist(tmp_path):
    engine, _ = _db(tmp_path)
    names = set(inspect(engine).get_table_names())
    assert {"sync_task", "sync_change_log"} <= names
    cols = {c["name"] for c in inspect(engine).get_columns("sync_task")}
    assert {"id", "owner", "title", "sortOrder", "deletedAt", "updatedAt"} <= cols
