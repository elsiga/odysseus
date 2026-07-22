# tests/test_sync_change_log_model.py
from sqlalchemy import create_engine, inspect, text
import src.sync.models as m


def test_sync_change_log_schema(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}")
    m.create_sync_tables(eng)
    cols = {c["name"] for c in inspect(eng).get_columns("sync_change_log")}
    assert cols == {"seq", "owner", "entity", "entity_id", "op", "rev", "created_at"}
    assert not hasattr(m, "SyncTask")


def test_migrates_stale_slice1_change_log(tmp_path):
    """A DB carried over from Slice 1 has the old change-log schema
    (entityId/fields/deviceId/createdAt). create_sync_tables must rebuild it to
    the per-record-LWW schema, preserve the old rows as a backup, and seed the
    sequence past the old max seq so live client pull cursors stay valid."""
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}")
    with eng.begin() as conn:
        conn.execute(text(
            "CREATE TABLE sync_change_log ("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, entity TEXT, "
            "entityId TEXT, fields TEXT, deviceId TEXT, createdAt TEXT)"
        ))
        for i in (1, 2, 9):
            conn.execute(
                text("INSERT INTO sync_change_log(seq, owner, entity, entityId) "
                     "VALUES (:s, 'elsiga', 'task', 't')"),
                {"s": i},
            )

    m.create_sync_tables(eng)

    insp = inspect(eng)
    # new schema in place
    assert {c["name"] for c in insp.get_columns("sync_change_log")} == {
        "seq", "owner", "entity", "entity_id", "op", "rev", "created_at"}
    # old rows preserved, not deleted
    assert insp.has_table("sync_change_log_slice1_bak")
    with eng.begin() as conn:
        assert conn.execute(
            text("SELECT COUNT(*) FROM sync_change_log_slice1_bak")).scalar() == 3
        # sequence seeded past the old max (9) and the seed is non-pullable
        assert conn.execute(
            text("SELECT MAX(seq) FROM sync_change_log")).scalar() == 9
        assert conn.execute(text(
            "SELECT entity FROM sync_change_log")).scalar() == "__seed__"

    # idempotent: a second call is a no-op (no error, schema unchanged)
    m.create_sync_tables(eng)
    assert {c["name"] for c in inspect(eng).get_columns("sync_change_log")} == {
        "seq", "owner", "entity", "entity_id", "op", "rev", "created_at"}
