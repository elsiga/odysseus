from src.sync.models import SyncTask

_EXCLUDED = {"id", "owner", "updatedAt"}


def _columns(model) -> list[str]:
    return [c.name for c in model.__table__.columns if c.name not in _EXCLUDED]


REGISTRY = {
    "task": {"model": SyncTask, "fields": _columns(SyncTask)},
}


def synced_fields(kind: str) -> list[str]:
    return REGISTRY[kind]["fields"]


def validate_field_value(kind: str, field: str, value) -> bool:
    if field not in synced_fields(kind):
        return False
    return isinstance(value, (str, int, float, bool)) or value is None
