import json
from src.sync.registry import REGISTRY, synced_fields, validate_field_value
from src.sync.winners import winners_from_rows
from src.sync.hlc import compare_hlc
from src.sync.models import SyncChangeLog


def apply_push(db, owner: str, device_id: str, patches: list) -> dict:
    applied = 0
    for patch in patches:
        entity = patch["entity"]
        if entity not in REGISTRY:
            raise ValueError("INVALID_FIELD")
        model = REGISTRY[entity]["model"]
        entity_id = patch["entityId"]
        incoming = patch["fields"]

        for field, fp in incoming.items():
            if field not in synced_fields(entity):
                raise ValueError("INVALID_FIELD")
            if not validate_field_value(entity, field, fp["v"]):
                raise ValueError("INVALID_VALUE")

        row = db.query(model).get(entity_id)
        if row is not None and row.owner != owner:
            raise PermissionError("FORBIDDEN")

        prior = (db.query(SyncChangeLog)
                   .filter(SyncChangeLog.owner == owner,
                           SyncChangeLog.entity == entity,
                           SyncChangeLog.entityId == entity_id).all())
        current = winners_from_rows(prior)

        winning = {}
        for field, fp in incoming.items():
            cur = current.get(field)
            if cur is None or compare_hlc(cur[0], cur[1], fp["ts"], device_id) < 0:
                winning[field] = fp

        if not winning:
            continue

        if row is None:
            row = model(id=entity_id, owner=owner)
            db.add(row)
        for field, fp in winning.items():
            setattr(row, field, fp["v"])

        db.add(SyncChangeLog(owner=owner, entity=entity, entityId=entity_id,
                             deviceId=device_id, fields=json.dumps(winning)))
        applied += 1

    db.commit()
    max_seq = (db.query(SyncChangeLog.seq)
                 .filter(SyncChangeLog.owner == owner)
                 .order_by(SyncChangeLog.seq.desc()).first())
    return {"applied": applied, "serverSeq": max_seq[0] if max_seq else 0}
