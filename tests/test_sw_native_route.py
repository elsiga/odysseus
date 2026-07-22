import asyncio, httpx
from app import app


def test_sw_native_served_with_scope_header():
    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.get("/sw-native.js")
            assert r.status_code == 200
            assert "javascript" in r.headers["content-type"]
            assert r.headers.get("service-worker-allowed") == "/"
            assert r.headers.get("cache-control") == "no-cache"
            assert "addEventListener" in r.text  # it's the actual SW source
    asyncio.run(_run())
