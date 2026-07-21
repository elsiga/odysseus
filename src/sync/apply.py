"""Per-record last-write-wins push over odysseus's native tables, routed through
the domain CRUD service (one source of truth). Tie-break by client `editedAt`."""
from datetime import datetime
from src.sync.registry import REGISTRY
from src.sync.models import SyncChangeLog


def _parse_ts(value):
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "").replace("+00:00", ""))


def apply_push(db, owner: str, changes: list) -> dict:
    results = []
    for ch in changes:
        entity = ch.get("entity")
        spec = REGISTRY.get(entity)
        if spec is None:
            raise ValueError("INVALID_ENTITY")
        model = spec["model"]
        eid = ch["id"]
        op = ch.get("op", "upsert")
        edited_at = _parse_ts(ch.get("editedAt"))

        row = db.get(model, eid)
        if row is not None and owner is not None and row.owner != owner:
            raise PermissionError("FORBIDDEN")

        if op == "delete":
            if row is not None:
                spec["delete"](db, owner, eid)
            results.append({"entity": entity, "id": eid, "op": "delete", "rev": None, "record": None})
            continue

        data = spec["from_wire"](ch.get("record") or {})
        data["edited_at"] = edited_at
        if row is None:
            data["id"] = eid
            new = spec["create"](db, owner, data)
            results.append({"entity": entity, "id": eid, "op": "upsert",
                            "rev": new.rev, "record": spec["to_wire"](new)})
        elif edited_at is None or row.updated_at is None or edited_at >= row.updated_at:
            updated = spec["update"](db, owner, eid, data)
            results.append({"entity": entity, "id": eid, "op": "upsert",
                            "rev": updated.rev, "record": spec["to_wire"](updated)})
        else:  # server row is newer — it wins
            results.append({"entity": entity, "id": eid, "op": "upsert",
                            "rev": row.rev, "record": spec["to_wire"](row)})

    max_seq = (db.query(SyncChangeLog.seq).filter(SyncChangeLog.owner == owner)
                 .order_by(SyncChangeLog.seq.desc()).first())
    return {"results": results, "cursor": max_seq[0] if max_seq else 0}
