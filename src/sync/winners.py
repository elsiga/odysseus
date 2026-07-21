import json
from src.sync.hlc import compare_hlc


def winners_from_rows(rows) -> dict:
    winners: dict[str, tuple[str, str]] = {}
    for row in rows:
        dev = row.deviceId
        for field, fp in json.loads(row.fields).items():
            ts = fp["ts"]
            cur = winners.get(field)
            if cur is None or compare_hlc(cur[0], cur[1], ts, dev) < 0:
                winners[field] = (ts, dev)
    return winners
