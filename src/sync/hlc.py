def compare_hlc(a_ts: str, a_dev: str, b_ts: str, b_dev: str) -> int:
    if a_ts != b_ts:
        return -1 if a_ts < b_ts else 1
    if a_dev != b_dev:
        return -1 if a_dev < b_dev else 1
    return 0
