"""Per-record pull: page over sync_change_log, resolving each change to the current
live record (or a delete tombstone). Bootstrap (cursor<=0) ships all live rows."""
from src.sync.registry import REGISTRY
from src.sync.models import SyncChangeLog


def _max_seq(db, owner: str) -> int:
    row = (db.query(SyncChangeLog.seq).filter(SyncChangeLog.owner == owner)
             .order_by(SyncChangeLog.seq.desc()).first())
    return row[0] if row else 0


def pull_changes(db, owner: str, cursor: int, limit: int) -> dict:
    if cursor <= 0:
        changes = []
        for entity, spec in REGISTRY.items():
            for row in db.query(spec["model"]).filter(spec["model"].owner == owner).all():
                changes.append({"entity": entity, "id": row.id, "op": "upsert",
                                "rev": row.rev, "record": spec["to_wire"](row)})
        return {"changes": changes, "cursor": _max_seq(db, owner), "hasMore": False}

    rows = (db.query(SyncChangeLog)
              .filter(SyncChangeLog.owner == owner, SyncChangeLog.seq > cursor)
              .order_by(SyncChangeLog.seq.asc()).limit(limit).all())
    changes = []
    for r in rows:
        spec = REGISTRY.get(r.entity)
        if spec is None:
            continue
        live = db.get(spec["model"], r.entity_id)
        if r.op == "delete" or live is None:
            changes.append({"entity": r.entity, "id": r.entity_id, "op": "delete",
                            "rev": r.rev, "record": None})
        else:
            changes.append({"entity": r.entity, "id": r.entity_id, "op": "upsert",
                            "rev": live.rev, "record": spec["to_wire"](live)})
    out_cursor = rows[-1].seq if rows else cursor
    has_more = len(rows) == limit and out_cursor < _max_seq(db, owner)
    return {"changes": changes, "cursor": out_cursor, "hasMore": has_more}
