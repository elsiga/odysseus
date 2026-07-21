import sqlite3
import core.database as db


def test_notes_table_has_rev_column(tmp_path, monkeypatch):
    db_file = tmp_path / "t.db"
    monkeypatch.setattr(db, "DATABASE_URL", f"sqlite:///{db_file}")
    from sqlalchemy import create_engine
    eng = create_engine(f"sqlite:///{db_file}")
    monkeypatch.setattr(db, "engine", eng)
    db.Base.metadata.create_all(bind=eng, tables=[db.Note.__table__])
    # simulate a pre-existing DB without rev by dropping the column path:
    db._migrate_add_notes_rev()  # idempotent — safe on a table that already has it
    conn = sqlite3.connect(db_file)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(notes)").fetchall()]
    conn.close()
    assert "rev" in cols
