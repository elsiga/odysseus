# Odysseus Android app (Slice B, Path B) — build & install

The Android app bundles its own offline task shell (loads with no network) and
syncs the Notes/todo domain to `https://chat.elsiga.ch/api/sync` using a scoped
bearer token. Built on the Linux server.

## Build the APK
```
./mobile/build-apk.sh        # → dist/odysseus.apk
```
Requires a full JDK 17 (not just a JRE); the script defaults
`JAVA_HOME=/home/elsiga/jdks/jdk-17.0.19+10` (override via `JAVA_HOME`).
`mobile/{android,node_modules}`, `mobile/www/js/sync-core.js`, and `dist/` are gitignored.

## Server config (one-time)
Add the app origin to `ALLOWED_ORIGINS` in `.env` so its cross-origin sync calls
are CORS-allowed, then restart odysseus:
```
ALLOWED_ORIGINS=…existing…,https://localhost
```
Note: CORS is global middleware with `allow_credentials=True`, so this origin is
allowed for *all* API routes, not just `/api/sync`. `https://localhost` is the
machine-local Capacitor WebView origin; keep it as a deploy-time `.env` entry
(never committed) and don't add broader public origins alongside it. The app
itself authenticates with a bearer header and `same-origin` credentials, so it
does not depend on credentialed CORS.

## Mint a sync token
In odysseus admin → API tokens, mint a token with the `mobile_sync` profile
(scopes `sync:read`, `sync:write`). Copy the `ody_…` value once.

## Install + first run
```
adb install -r dist/odysseus.apk
```
Open the app → ⚙ → paste the `ody_…` token → Save. Tasks load and sync.
The token is stored in app-private storage; revoke it server-side any time.

## Cold-offline proof (result)

PENDING — awaiting on-device run (no adb device attached at build time). To verify: airplane mode → create a task → fully close app → reopen offline → shell must load (not ERR_NAME_NOT_RESOLVED) with the task present → disable airplane mode → outbox drains.
