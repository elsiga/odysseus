from src.sync.hlc import compare_hlc


def test_ts_dominates():
    assert compare_hlc("2026-07-21T00:00:00.000Z-000002", "d1",
                       "2026-07-21T00:00:00.000Z-000001", "d9") == 1

def test_device_tiebreak():
    ts = "2026-07-21T00:00:00.000Z-000001"
    assert compare_hlc(ts, "d1", ts, "d2") == -1
    assert compare_hlc(ts, "d2", ts, "d2") == 0
