"""Verify the local-first SPA (webapp/dist) is served by odysseus at /app.

Covers Task 12 of the Slice 1 SPA/sync plan: static built assets under
/app-assets, and the SPA shell (index.html) at /app and /app/<anything>
(client-side routing fallback), both backed by real files built via
`cd webapp && npm run build`.
"""

import os
import re

import pytest

# AUTH_ENABLED is read as a module-level constant in app.py at import time
# (it gates whether AuthMiddleware is installed at all), so it must be set
# before `from app import app` below — a post-import monkeypatch would be
# too late to affect the already-registered middleware. /app should behave
# like the SPA-serving routes below it (/tasks, /library, ...): reachable
# without auth in this unit test, same as the rest of this suite exercises
# app.py with auth disabled unless a test specifically targets auth.
os.environ.setdefault("AUTH_ENABLED", "false")

from fastapi.testclient import TestClient

from app import app

WEBAPP_DIST = os.path.join(os.path.dirname(__file__), "..", "webapp", "dist")
INDEX_HTML_PATH = os.path.join(WEBAPP_DIST, "index.html")

pytestmark = pytest.mark.skipif(
    not os.path.isfile(INDEX_HTML_PATH),
    reason="webapp/dist not built — run `cd webapp && npm run build` first",
)


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_app_serves_spa_shell(client):
    resp = client.get("/app")
    assert resp.status_code == 200
    body = resp.text
    assert "<div id=\"root\">" in body
    assert "/app-assets/" in body


def test_app_client_route_fallback(client):
    resp = client.get("/app/anything")
    assert resp.status_code == 200
    assert "<div id=\"root\">" in resp.text


def test_built_asset_referenced_in_index_resolves(client):
    with open(INDEX_HTML_PATH, "r", encoding="utf-8") as fh:
        index_html = fh.read()

    match = re.search(r'src="(/app-assets/[^"]+)"', index_html)
    assert match, "expected index.html to reference a built script under /app-assets/"
    asset_url = match.group(1)

    resp = client.get(asset_url)
    assert resp.status_code == 200
    assert len(resp.content) > 0
