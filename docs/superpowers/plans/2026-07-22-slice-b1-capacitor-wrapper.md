# Slice B1 — Capacitor Wrapper + Cold-Offline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Capacitor Android app that loads odysseus (`https://chat.elsiga.ch`) in a native WebView and works **cold-offline** — reopen with no network and the app shell loads (from a Capacitor-only service worker) while Notes edits persist/sync via the Slice-A local-first layer.

**Architecture:** Capacitor `server.url` points the WebView at the live server, so cookies are same-origin and there are zero backend auth/CORS changes. A service worker (`static/sw-native.js`), registered **only** when `window.Capacitor` is present, runtime-caches the app shell (navigation + `static/*` assets) so cold launches work offline; `/api/*` is passed straight through to the network (the Slice-A outbox handles offline writes). The APK is built on this Linux server (Android SDK present) and copied to `dist/odysseus.apk`.

**Tech Stack:** Capacitor 6 (`@capacitor/core`/`cli`/`android`), Android SDK at `/home/elsiga/Android/Sdk` (JDK 17, Gradle via the project's `gradlew`), a vanilla service worker, FastAPI (one static-serving route), pytest (house `asyncio.run` pattern, no pytest-asyncio).

## Global Constraints

- **Web stays SW-free / online-only.** The service worker is registered ONLY inside Capacitor (`window.Capacitor` guard). A normal browser hitting `chat.elsiga.ch` must never register `sw-native.js` (Slice-A spec §9). — spec §2.
- **No backend auth/CORS changes.** `server.url` = same-origin, so cookies work; do NOT touch `require_user`, `ALLOWED_ORIGINS`, or add bearer routes. — spec §2.
- **SW passes `/api/*` through to the network** (never caches API responses) — the Slice-A IndexedDB outbox owns offline writes. The SW only caches the app shell (navigation + `static/*` + `static/lib/*`). — spec §2.
- **APK output:** built on the Linux server, copied to **`dist/odysseus.apk`**; `dist/` is **gitignored** (built binary). — spec §7.
- **Capacitor config:** `appId: ch.elsiga.odysseus`, `appName: Odysseus`, `server.url: https://chat.elsiga.ch`. — spec §2.
- **First launch must be online** (populates the SW cache); later cold launches work offline. Documented, not a bug. — spec §2.
- **Do NOT `git add -A`** — stage explicit paths; `mobile/node_modules/`, `mobile/android/`, and `dist/` are gitignored. (Carried from the Slice-A ledger: `git add -A` sweeps the untracked `design/` folder.)
- **Backend tests:** run the SPECIFIC test file, not the whole `tests/` dir (it hangs on heavy imports) — carried from Slice A.

---

## Task 1: Service worker + Capacitor-gated registration + serving route

**Files:**
- Create: `static/sw-native.js`
- Create: `static/js/native/sw-register.js`
- Modify: `app.py` (add a `GET /sw-native.js` route; wire the register script into the served HTML head)
- Modify: `static/index.html` (load the register module in the head)
- Test: `tests/test_sw_native_route.py` (create)

**Interfaces:**
- Consumes: `STATIC_DIR` (already defined in `app.py`), `serve_html_with_nonce` (unchanged — the register `<script>` is external `src`, needs no nonce).
- Produces:
  - `GET /sw-native.js` → the SW file, `Content-Type: application/javascript`, header `Service-Worker-Allowed: /`, `Cache-Control: no-cache`.
  - `static/js/native/sw-register.js` — on `window.Capacitor`, adds `is-native` to `<html>`/`<body>` and calls `navigator.serviceWorker.register('/sw-native.js', {scope:'/'})`. No-ops on the web.

- [ ] **Step 1: Write the failing backend test**

```python
# tests/test_sw_native_route.py
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
            assert "addEventListener" in r.text  # it's the actual SW source
    asyncio.run(_run())
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sw_native_route.py -q`
Expected: FAIL — 404 (no `/sw-native.js` route yet).

- [ ] **Step 3: Write `static/sw-native.js`**

```js
// Capacitor-only app-shell service worker. Registered ONLY inside the native
// app (see sw-register.js). Runtime-caches navigation + static assets so cold
// launches work offline; /api/* is passed through to the network (the Slice-A
// IndexedDB outbox owns offline writes).
const SHELL = 'ody-native-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // ignore cross-origin
  if (url.pathname.startsWith('/api/')) return;       // API → network (offline layer handles)

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        (await caches.open(SHELL)).put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match(req)) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // static assets: stale-while-revalidate
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(req);
    const network = fetch(req).then((net) => { cache.put(req, net.clone()); return net; }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
```

- [ ] **Step 4: Write `static/js/native/sw-register.js`**

```js
// Registers the offline app-shell SW ONLY inside the Capacitor native app.
// Web browsers never reach the register() call (Slice-A spec §9: no web PWA).
if (typeof window !== 'undefined' && window.Capacitor) {
  document.documentElement.classList.add('is-native');
  const markBody = () => document.body && document.body.classList.add('is-native');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markBody);
  else markBody();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw-native.js', { scope: '/' })
      .catch((err) => console.warn('sw-native register failed', err));
  }
}
```

- [ ] **Step 5: Add the serving route in `app.py`**

Near the other root-level static routes, add:

```python
@app.get("/sw-native.js", include_in_schema=False)
async def _sw_native():
    from fastapi.responses import FileResponse
    return FileResponse(
        os.path.join(STATIC_DIR, "sw-native.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )
```

- [ ] **Step 6: Load the register module from `static/index.html`**

In the `<head>` of `static/index.html`, after the existing inline boot script, add (external `src` needs no CSP nonce — `script-src 'self'` covers it):

```html
    <script type="module" src="/static/js/native/sw-register.js"></script>
```

- [ ] **Step 7: Run the backend test + confirm web-safety**

Run: `python -m pytest tests/test_sw_native_route.py -q`
Expected: PASS.
Run: `grep -n "window.Capacitor" static/js/native/sw-register.js`
Expected: the registration is inside the `window.Capacitor` guard (web never registers).

- [ ] **Step 8: Verify CSP does not block the worker (inspect, fix only if needed)**

Run: `grep -n "Content-Security-Policy\|script-src\|worker-src" core/middleware.py`
Expected: `script-src 'self' …` present. A same-origin `/sw-native.js` is allowed by `script-src 'self'` (worker inherits when `worker-src` is absent). **If** `worker-src` is explicitly set to something without `'self'`, add `'self'` to it; otherwise no change. Note the result in the report.

- [ ] **Step 9: Commit**

```bash
git add static/sw-native.js static/js/native/sw-register.js app.py static/index.html tests/test_sw_native_route.py
git commit -m "feat(native): app-shell service worker + Capacitor-only registration + /sw-native.js route"
```

---

## Task 2: Capacitor Android project scaffold + config

**Files:**
- Create: `mobile/package.json`, `mobile/capacitor.config.ts`, `mobile/www/index.html` (placeholder webDir)
- Create/modify: `.gitignore` (ignore `mobile/node_modules/`, `mobile/android/`, `dist/`)
- Generated (gitignored): `mobile/android/` (via `cap add android`)

**Interfaces:**
- Consumes: Node 24 + npm (present); Android SDK at `ANDROID_HOME=/home/elsiga/Android/Sdk`.
- Produces: a synced Capacitor Android project at `mobile/android/` pointed at `server.url = https://chat.elsiga.ch`.

- [ ] **Step 1: Write `mobile/package.json`**

```json
{
  "name": "odysseus-mobile",
  "private": true,
  "version": "0.1.0",
  "dependencies": {
    "@capacitor/core": "^6.1.2",
    "@capacitor/android": "^6.1.2"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.1.2"
  }
}
```

- [ ] **Step 2: Write `mobile/capacitor.config.ts`**

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ch.elsiga.odysseus',
  appName: 'Odysseus',
  webDir: 'www',
  server: {
    url: 'https://chat.elsiga.ch',
    cleartext: false,
  },
};

export default config;
```

- [ ] **Step 3: Write the placeholder `mobile/www/index.html`**

(webDir is required by Capacitor even with `server.url`; it is only the fallback bundle — the app actually loads the remote URL.)

```html
<!doctype html>
<meta charset="utf-8">
<title>Odysseus</title>
<body style="background:#171E28;color:#A9CBDC;font-family:monospace;display:grid;place-items:center;height:100vh;margin:0">
<p>Loading Odysseus…</p>
</body>
```

- [ ] **Step 4: Add gitignore entries**

Append to `.gitignore` (repo root):

```
# Slice B — Capacitor mobile app
mobile/node_modules/
mobile/android/
dist/
```

- [ ] **Step 5: Install + add the Android platform**

Run:
```bash
npm --prefix mobile install
cd mobile && npx cap add android && npx cap sync android && cd ..
```
Expected: `cap add android` scaffolds `mobile/android/`; `cap sync` copies `www` + the config and reports `Sync finished`. If `cap add android` errors on the SDK, ensure `ANDROID_HOME=/home/elsiga/Android/Sdk` is exported and report the exact error (do not guess).

- [ ] **Step 6: Verify the scaffold + config**

Run:
```bash
test -d mobile/android && echo "android project present"
grep -n "chat.elsiga.ch" mobile/android/app/src/main/assets/capacitor.config.json
git status --short | grep -E "mobile/(node_modules|android)|^..dist/" || echo "generated dirs correctly gitignored"
```
Expected: android project present; the synced config JSON contains the server URL; `mobile/node_modules`, `mobile/android`, `dist/` do NOT appear as untracked (they're ignored).

- [ ] **Step 7: Commit (config + placeholder only — NOT node_modules/android)**

```bash
git add mobile/package.json mobile/capacitor.config.ts mobile/www/index.html .gitignore
git status --short   # confirm ONLY those 4 files staged (+ no design/, node_modules, android)
git commit -m "feat(native): Capacitor Android scaffold pointed at chat.elsiga.ch (server.url)"
```

---

## Task 3: One-command APK build → `dist/odysseus.apk`

**Files:**
- Create: `mobile/build-apk.sh`
- Create: `docs/productivity/mobile-build.md` (the documented build/install command)

**Interfaces:**
- Consumes: the Task-2 scaffold; `mobile/android/gradlew`; Android SDK.
- Produces: `dist/odysseus.apk` (a debug APK), rebuildable via one command.

- [ ] **Step 1: Write `mobile/build-apk.sh`**

```bash
#!/usr/bin/env bash
# Build the Odysseus Android APK on this Linux box and drop it in dist/ for easy download.
set -euo pipefail
cd "$(dirname "$0")"                     # → mobile/
export ANDROID_HOME="${ANDROID_HOME:-/home/elsiga/Android/Sdk}"

npm install
[ -d android ] || npx cap add android
npx cap sync android

( cd android && ./gradlew --no-daemon assembleDebug )

mkdir -p ../dist
cp android/app/build/outputs/apk/debug/app-debug.apk ../dist/odysseus.apk
echo "APK → dist/odysseus.apk ($(du -h ../dist/odysseus.apk | cut -f1))"
```

- [ ] **Step 2: Make it executable and run it**

Run:
```bash
chmod +x mobile/build-apk.sh
./mobile/build-apk.sh
```
Expected: Gradle downloads dependencies (first run, needs network) and prints `BUILD SUCCESSFUL`; the script prints `APK → dist/odysseus.apk`. If Gradle fails, capture the exact error and report BLOCKED (do not fake an APK).

- [ ] **Step 3: Verify the APK is real**

Run:
```bash
test -f dist/odysseus.apk && echo "apk present"
unzip -l dist/odysseus.apk | grep -E "AndroidManifest.xml|classes.dex" | head
```
Expected: `apk present`; the zip listing shows `AndroidManifest.xml` and `classes.dex` (a valid APK).

- [ ] **Step 4: Write `docs/productivity/mobile-build.md`**

```markdown
# Odysseus Android app (Slice B) — build & install

The Android app is a Capacitor wrapper that loads `https://chat.elsiga.ch` in a
native WebView, with a Capacitor-only service worker (`static/sw-native.js`) for
cold-offline. It is built on the Linux server.

## Build the APK
```
./mobile/build-apk.sh        # → dist/odysseus.apk
```
`mobile/android/` and `dist/` are gitignored (generated / binary). Re-run any time.

## Install on a device (USB debugging on) or emulator
```
adb install -r dist/odysseus.apk
```
Or download `dist/odysseus.apk` (scp) and open it on the phone to sideload.

## First run
Launch **online once** and log in (TOTP) so the service worker caches the app
shell. After that, a cold launch works offline (Notes edits queue locally and
sync on reconnect).
```

- [ ] **Step 5: Commit (script + doc; dist/ stays gitignored)**

```bash
git add mobile/build-apk.sh docs/productivity/mobile-build.md
git commit -m "build(native): one-command APK build → dist/odysseus.apk + build docs"
```

---

## Task 4: Cold-offline acceptance proof (on-device, documented)

**Files:** none (verification + recording the result).

**Interfaces:** Consumes `dist/odysseus.apk` (Task 3) + a device/emulator reachable via `adb`.

This is the acceptance step that validates the whole B1 premise (server.url + Capacitor-only SW → cold-offline). It is manual/on-device, like Slice A's offline proof. It is **run by the user** (or the controller if an emulator/device is on `adb`).

- [ ] **Step 1: Install the app**

Run: `adb devices` (confirm a device/emulator is listed), then `adb install -r dist/odysseus.apk`.
Expected: `Success`. (If no device: start an emulator/AVD or connect a phone with USB debugging; document which was used.)

- [ ] **Step 2: First online launch + login**

Open the Odysseus app (online). Log in (TOTP). Open **Notes**. Confirm notes load. Leave it a few seconds so the service worker caches the shell.
Verification the SW installed: `adb logcat | grep -i "serviceworker\|sw-native"` may show registration; or in a `chrome://inspect` remote-devtools session, Application → Service Workers shows `sw-native.js` activated and a `ody-native-v1` cache populated.

- [ ] **Step 3: Warm-offline edit**

Enable **airplane mode**. In the still-open app, create/edit a Note (check an item / change a title). Confirm it renders instantly and (via remote devtools → IndexedDB → `odysseus-productivity` → `outbox`) an outbox entry exists.

- [ ] **Step 4: COLD-offline launch (the key check)**

Fully close the app (swipe from recents). **Still in airplane mode**, reopen it.
Expected: **the app shell loads** (not a "no internet" error) — served by the service worker cache — and the offline-edited Note is present (from IndexedDB). This is the B1 success criterion.

- [ ] **Step 5: Reconnect + sync**

Disable airplane mode. Within a few seconds the outbox drains; confirm on another client (web at `chat.elsiga.ch`) that the edited Note now shows the change. `GET /api/notes` reflects it.

- [ ] **Step 6: Record the result**

Write the outcome (pass/fail, device/emulator used, any SW caveats) into `docs/productivity/mobile-build.md` under a `## Cold-offline proof (result)` heading, and commit:

```bash
git add docs/productivity/mobile-build.md
git commit -m "docs(native): record B1 cold-offline proof result"
```

**If cold-offline FAILS** (WebView doesn't run the SW for a `server.url` app, or the shell doesn't cache): this is the risk B1 exists to surface. Do NOT hack around it — report it. The fallback is the heavier Path B (locally-bundled webDir + bearer-scoped `/api/notes`/`/api/sync` routes), which is a spec-level pivot to escalate to the user.

---

## Self-Review notes (coverage)

- Spec §2 wrapper: Task 2 (server.url config) + Task 1 (Capacitor-only SW + web-safe guard) + Task 4 (cold-offline proof). ✅
- Spec §2 "SW passes /api through / caches shell": Task 1 Step 3 SW logic. ✅
- Spec §7 APK → dist/ on Linux, gitignored: Task 2 (gitignore) + Task 3 (build → dist). ✅
- Spec §7 first-launch-online + cookie persistence + SW staleness: Task 4 Step 2 (first online launch); cookie persistence is observed in Task 4 (a cold launch that stays logged in); SW versioning is in the SW (`SHELL` const + activate cleanup). ✅
- No backend auth/CORS change: only additions are the `/sw-native.js` route + a guarded register script. ✅
- `is-native` gate (for B3): set in Task 1 Step 4 (no UI change in B1 — the existing Notes UI validates offline, per spec §6 B1). ✅
