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

## Slice 1 — native mobile UI (Preact/HTM) + local-notifications proof

Slice 1 replaces the sync test-harness UI with the real capture/breakdown/home/library
screens (Preact + HTM, esbuild-bundled to `www/js/app.js`; no JSX, no framework runtime
beyond preact/htm) and adds a local-notifications smoke test via
`@capacitor/local-notifications`.

Build command (unchanged):
```
./mobile/build-apk.sh        # runs: npm install → cp sync-core.js → node build.mjs → cap sync android → gradlew assembleDebug → dist/odysseus.apk
```
Verified this session:
- `node build.mjs` → `built www/js/app.js` clean.
- `npx tsc --noEmit` → clean, no errors.
- `gradlew assembleDebug` → `BUILD SUCCESSFUL`; `APK → dist/odysseus.apk (3.9M)`.
- Bundle packaged into the APK: `unzip -l dist/odysseus.apk` shows
  `assets/public/index.html`, `assets/public/js/app.js`,
  `assets/public/js/sync-core.js` all present.
- `@capacitor/local-notifications` native plugin synced cleanly (`capacitor-local-notifications`
  Gradle module built as part of `assembleDebug`); merged manifest contains its receivers
  (`TimedNotificationPublisher`, `NotificationDismissReceiver`, `LocalNotificationRestoreReceiver`).

`scheduleTestNotification()` (`mobile/src/notify.ts`) is exposed as a small 🔔 tap target
in Home's header row (next to the sync status text), wired via `onTestReminder` threaded
from `main.ts`'s `Root` → `Home`. It calls `window.Capacitor.Plugins.LocalNotifications`
directly (no-op if the plugin/bridge is unavailable, e.g. in a desktop browser), requests
permission, and schedules a one-shot notification 10s out.

### On-device proof — PENDING (manual, requires a physical/emulated device; none attached to this build box)
1. `adb install -r dist/odysseus.apk`, open the app, paste an `ody_` token (`mobile_sync` profile).
2. **Todo:** capture a task (`pay rent @flat today 9pm !!`) → appears in today with `#flat`,
   project tag in Library, urgency parsed; toggle done; open a task → add steps; verify it
   round-trips to Notes on `https://chat.elsiga.ch`.
3. **Offline:** airplane mode → fully close → reopen → tasks present (cold-offline unchanged)
   → capture offline → back online → syncs.
4. **Notification:** tap the 🔔 test-reminder affordance on Home, lock the screen →
   notification fires within ~10s.

## Slice 2 — Subtasks + Description

Slice 2 turns Detail into a full task editor: editable title, a description
field (`note.content`), and checkable/editable subtasks (`note.items`), with
`note_type` derived (`checklist` when ≥1 subtask, else `note`) only when its current value is absent, `'note'`, or `'checklist'` — legacy web types are left untouched; per-item keys (`id`, `indent`, `agent_status`, `agent_session_id`) are also preserved through mobile edits.
TaskRow now shows a `done/total` count with a small progress bar. Zero backend
change; web parity comes from `note_type`/`items`/`content` alone.

Build command (unchanged):
```
bash mobile/build-apk.sh        # runs: npm install → cp sync-core.js → node build.mjs → cap sync android → gradlew assembleDebug → dist/odysseus.apk
```
Verified this session:
- `node build.mjs` → `built www/js/app.js` clean (no diff vs. the committed bundle).
- `gradlew assembleDebug` → `BUILD SUCCESSFUL`; `APK → dist/odysseus.apk (3.9M)`.
- Bundle packaged into the APK: `unzip -l dist/odysseus.apk` shows
  `assets/public/index.html`, `assets/public/js/app.js`,
  `assets/public/js/sync-core.js` all present.

### On-device proof — PENDING (manual, requires a physical/emulated device; none attached to this build box)
1. `adb install -r dist/odysseus.apk` (or copy to phone), open, token already saved.
2. Open a task → **edit its title**, **add a description**, **add 3 subtasks**, **check 1** →
   the row on Home/Library shows `1/3` with a ~33% progress bar; the description persists
   on reopen.
3. Open odysseus web Notes at `https://chat.elsiga.ch` → the same task renders as a
   **checklist** with those subtasks (one checked). Do **not** expect the description to
   appear — the web checklist view does not render `content` at all (see "Known web-parity
   gap" below).
4. Toggle a subtask on mobile → it reflects on web (round-trip); remove all subtasks →
   the task reverts to a plain note on web (`note_type` back to `note`).

**Known web-parity gap:** the mobile description field (`note.content`) is stored and
round-trips safely, but it is invisible and uneditable on web for `checklist` notes — the
web renders descriptions only for `goal` notes (`static/js/notes.js:1800,1834`); for other note types, it renders `content` only when there are no items, so `checklist` notes show subtasks but not `content`. The web checklist editor (`notes.js:2929`) has no description textarea.
Nothing is lost (the web save path omits `content` for checklist notes, so the backend
never clears it), it's just not surfaced there yet. Fixing that is deferred to the
end-stage web task-field slice.
