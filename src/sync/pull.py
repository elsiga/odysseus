import json
from src.sync.registry import REGISTRY, synced_fields
from src.sync.winners import winners_from_rows
from src.sync.models import SyncChangeLog


def _max_seq(db, owner: str) -> int:
    row = (db.query(SyncChangeLog.seq).filter(SyncChangeLog.owner == owner)
             .order_by(SyncChangeLog.seq.desc()).first())
    return row[0] if row else 0


def pull_changes(db, owner: str, cursor: int, limit: int) -> dict:
    if cursor <= 0:
        changes = []
        for entity, spec in REGISTRY.items():
            model = spec["model"]
            for row in db.query(model).filter(model.owner == owner).all():
                prior = (db.query(SyncChangeLog)
                           .filter(SyncChangeLog.owner == owner,
                                   SyncChangeLog.entity == entity,
                                   SyncChangeLog.entityId == row.id).all())
                winners = winners_from_rows(prior)
                fallback_ts = (row.updatedAt.isoformat() + "Z-000000") if row.updatedAt else "1970-01-01T00:00:00.000Z-000000"
                fields = {}
                for f in synced_fields(entity):
                    v = getattr(row, f)
                    ts = winners[f][0] if f in winners else fallback_ts
                    fields[f] = {"v": v, "ts": ts}
                changes.append({"seq": 0, "entity": entity, "entityId": row.id, "fields": fields})
        return {"changes": changes, "cursor": _max_seq(db, owner), "hasMore": False}

    rows = (db.query(SyncChangeLog)
              .filter(SyncChangeLog.owner == owner, SyncChangeLog.seq > cursor)
              .order_by(SyncChangeLog.seq.asc()).limit(limit).all())
    changes = [{"seq": r.seq, "entity": r.entity, "entityId": r.entityId,
                "fields": json.loads(r.fields)} for r in rows]
    out_cursor = rows[-1].seq if rows else cursor
    has_more = len(rows) == limit and out_cursor < _max_seq(db, owner)
    return {"changes": changes, "cursor": out_cursor, "hasMore": has_more}
