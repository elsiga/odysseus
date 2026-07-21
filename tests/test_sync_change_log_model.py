# tests/test_sync_change_log_model.py
from sqlalchemy import create_engine, inspect
import src.sync.models as m


def test_sync_change_log_schema(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}")
    m.create_sync_tables(eng)
    cols = {c["name"] for c in inspect(eng).get_columns("sync_change_log")}
    assert cols == {"seq", "owner", "entity", "entity_id", "op", "rev", "created_at"}
    assert not hasattr(m, "SyncTask")
