from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from routes.sync_routes import (
    bearer_owner, SYNC_READ_SCOPES, SYNC_WRITE_SCOPES,
)


def _req(**state):
    return SimpleNamespace(state=SimpleNamespace(**state))


def test_bearer_owner_none_when_not_token():
    # Cookie/session request → not a token → helper returns None (caller falls back)
    assert bearer_owner(_req(api_token=False), SYNC_WRITE_SCOPES) is None


def test_bearer_owner_returns_owner_with_matching_scope():
    r = _req(api_token=True, api_token_scopes=["sync:write"], api_token_owner="alice")
    assert bearer_owner(r, SYNC_WRITE_SCOPES) == "alice"


def test_bearer_owner_read_scope_satisfies_read_requirement():
    r = _req(api_token=True, api_token_scopes=["sync:read"], api_token_owner="alice")
    assert bearer_owner(r, SYNC_READ_SCOPES) == "alice"


def test_bearer_owner_403_when_scope_missing():
    r = _req(api_token=True, api_token_scopes=["sync:read"], api_token_owner="alice")
    with pytest.raises(HTTPException) as ei:
        bearer_owner(r, SYNC_WRITE_SCOPES)
    assert ei.value.status_code == 403


def test_bearer_owner_403_when_no_owner():
    r = _req(api_token=True, api_token_scopes=["sync:write"], api_token_owner=None)
    with pytest.raises(HTTPException) as ei:
        bearer_owner(r, SYNC_WRITE_SCOPES)
    assert ei.value.status_code == 403


def test_write_scope_is_subset_of_read():
    # A write-capable token can also pull (read).
    assert SYNC_WRITE_SCOPES.issubset(SYNC_READ_SCOPES)
