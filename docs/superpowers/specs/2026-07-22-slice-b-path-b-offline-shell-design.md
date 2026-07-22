# Slice B (revised, "Path B") — Thin Offline Shell + Bearer Sync — Design

**Status:** Approved 2026-07-22. Supersedes the `server.url` wrapper approach of the original
Slice-B design (`docs/superpowers/specs/2026-07-22-slice-b-mobile-task-app-design.md`) for the
offline mechanism. The Slice-B *product* goals (a mobile task app over the Notes/todo domain,
odysseus dark theme, local-first) are unchanged; only the **offline architecture** pivots.

## Why this pivot

Slice B1 shipped a Capacitor wrapper using `server.url = https://chat.elsiga.ch` plus a
Capacitor-only app-shell service worker (`static/sw-native.js`) for cold-offline. The on-device
acceptance proof (B1 Task 4) **failed**: airplane-mode → fully close → reopen showed the WebView's
native `net::ERR_NAME_NOT_RESOLVED` error page, not the app.

**Root cause (architectural, confirmed by the symptom):** the WebView's *own* DNS error page
appeared, so the service worker was never in the cold main-frame navigation path. Android System
WebView does **not** route top-level/main-document navigation through a service worker (it only
intercepts subresources of an already-loaded page). With `server.url`, every cold launch points
the main frame at the remote origin, which DNS-fails offline before any SW/cache is consulted. This
is **not fixable in service-worker code** — it is a WebView platform limitation. This was the exact
risk B1 was built to surface cheaply, and it did.

**The fix (this design):** bundle a dedicated shell *inside* the APK so the main document loads
from the local scheme with zero network. The existing odysseus `index.html` cannot be that shell —
it has ~7 inline `<script nonce="{{CSP_NONCE}}">` blocks that require server-side nonce injection,
pulls katex/mermaid from `cdn.jsdelivr.net`, and is ~13 MB of mostly online-only features. So the
mobile app bundles its **own** minimal, self-contained shell — which is the native task UI the
original Slice B planned. "Make it a real offline app" and "build the native mobile UI" are
therefore the same work; this design does the first, thin increment of it.

## Scope of this increment

A **thin but real** offline task shell that de-risks the new Path-B mechanics (local-bundle
cold-offline + cross-origin bearer auth + sync) before investing in the full UI. Built as the
genuine foundation of the mobile app, not a throwaway.

**In scope:** local bundled shell; bearer-authed sync to `chat.elsiga.ch`; a minimal real task
list (list, toggle done, create, delete); cold-offline on-device proof; removal of the now-moot
B1 service-worker code.

**Out of scope (follow-up "full UI" increment):** capture NL parser, manual breakdown/steps,
Home / what-now suggestion, Library, Projects, the 4 additional Note fields
(`bucket`/`urgency`/`project`/`done`), a login-issues-token flow, iOS, push/deep-links.

## Architecture

- **No `server.url`.** `mobile/capacitor.config.ts` uses a **local `webDir`** (`mobile/www/`) with
  `androidScheme: 'https'`, so the WebView loads the bundled shell from `https://localhost`.
  Cold-offline is solved by construction — the shell is on-device; booting requires no network.
- **Dedicated shell** in `mobile/www/`: its own `index.html` + JS, the committed Slice-A sync
  bundle (`sync-core.js` → `notesRepo` + `createSyncClient`), odysseus dark-theme tokens. No
  CSP-nonce dependency, no CDN scripts.
- **Local-first data** via Slice-A's `notesRepo` + Dexie/IndexedDB outbox. Offline edits queue
  locally; when online the sync engine pushes/pulls against `https://chat.elsiga.ch/api/sync/*`.
- **Auth:** a bearer `ody_` API token (pasted once, stored in Android secure storage) sent as
  `Authorization: Bearer …` on sync calls. Reuses the existing `ApiToken` system.

## Components

### Client — `mobile/www/`
- `index.html` — minimal shell (dark theme), loads the app module. No inline-nonce scripts, no CDN.
- `js/app.js` (or similar) — boot: read token from secure storage → configure the sync client
  (base URL + auth header) → render the task list → subscribe to `notesRepo`. First run with no
  token → show the token-entry surface.
- `js/token.js` — settings surface: paste / save / clear the `ody_` token in Android secure storage
  (Capacitor Preferences, or a secure-storage plugin if warranted).
- A minimal task-list view: render title + done state; toggle done; create; delete. Odysseus dark
  tokens (coral accent, mono font) so it is a real foundation.

### Sync engine — `sync-engine/` (rebuild the committed `static/js/productivity/sync-core.js`)
- Add an **auth + base-URL seam**: `createSyncClient({ baseUrl, authHeader })` (or equivalent) so
  the engine targets `https://chat.elsiga.ch` and attaches `Authorization: Bearer …` on
  `/api/sync/push|pull`. Same-origin default preserved for the web path (baseUrl empty, no header).
- Rebuild the bundle (`npm --prefix sync-engine run build`); commit the regenerated `sync-core.js`
  (drift-checked, per Slice-A practice).

### Backend
- **Scope-aware bearer path for sync.** `/api/sync/push` and `/api/sync/pull` must accept a valid
  `ApiToken` with a sync scope and resolve the owner from `request.state.api_token_owner`, mirroring
  the `_scope_owner` / `_scope_owner_all` pattern in `routes/codex_routes.py`. Cookie-session auth
  must continue to work unchanged (parity). `require_user` is **not** modified.
- **New scopes** `sync:read`, `sync:write` added to `ALLOWED_SCOPES` in `routes/api_token_routes.py`.
- **CORS:** add the Capacitor app origin `https://localhost` to `ALLOWED_ORIGINS`. The
  `Authorization` header and credentials are already permitted by the CORS middleware.
- Odysseus's `connect-src 'self'` CSP does not bind the mobile app (the bundled shell has its own /
  no CSP and is served from `https://localhost`).

### Removed (now moot — no loose ends)
- `static/sw-native.js`
- `static/js/native/sw-register.js`
- the `GET /sw-native.js` route in `app.py` **and** its `/sw-native.js` entry in `AUTH_EXEMPT_EXACT`
- the `<script type="module" src="/static/js/native/sw-register.js">` tag in `static/index.html`
- the `test_sw_native_route.py` test

## Data flow

1. **Cold offline:** shell loads from the bundle → `notesRepo` reads Dexie → renders tasks. No
   network. (This is the exact criterion that failed under `server.url`.)
2. **Online sync:** the sync client (with bearer) pulls the bootstrap set from `/api/sync/pull` into
   Dexie; user edits call `notesRepo` local writes → outbox → the engine pushes to `/api/sync/push`.
3. **Token:** first run with no stored token → token-entry surface. With a token → normal boot.

The mobile app is **purely** local-first + sync engine: it reads from Dexie and syncs via
`/api/sync/*`, and does **not** call `/api/notes`. Therefore only the sync routes need the bearer
path. *(Verify during planning that `notesRepo.list` reads Dexie rather than `/api/notes`; if it
does hit `/api/notes`, either repoint it to Dexie for the mobile path or bearer-enable that read.)*

## Security

Reuses the existing `ApiToken` model: bcrypt-hashed server-side, per-owner, scoped, and
**revocable** via `is_active`. The mobile token is scoped to **sync only** (not admin/chat/email),
minted once via the existing admin-only `POST /api/tokens`, stored in Android secure storage, and
sent only over HTTPS (the tunnel is live; `SECURE_COOKIES=true`). No CSRF concern (bearer is not
ambient). **Web session / cookie / CSRF security is entirely untouched** — the only backend
additions are the scope-aware sync path, two new scope strings, and one `ALLOWED_ORIGINS` entry.
Residual risk = a compromised/unlocked device or a decompiled APK yielding the token exposes the
owner's own notes — equivalent to any logged-in mobile app, and revocable server-side. Single-user,
self-hosted: acceptable.

## Testing

- **Backend** (pytest, house `asyncio.run` pattern, run the specific test file — the full `tests/`
  dir hangs on heavy imports):
  - bearer token with a sync scope → 200 and pushes/pulls under the token's owner;
  - bearer token without a sync scope → 403;
  - no auth → 401;
  - cookie-session path still works (parity with today's behavior).
- **Sync engine** (vitest): with `baseUrl`/`authHeader` configured, `fetch` is called with the
  `Authorization` header and the configured absolute URL; with them absent, behavior is unchanged
  (same-origin, no header) so the web path is preserved.
- **On-device acceptance (manual, run by the user — the Path-B success criterion):**
  install the APK → paste the token → load tasks online → airplane mode → edit a task →
  **fully close the app → reopen still offline → the shell loads and the task is present** →
  reconnect → the outbox drains → confirm the edit on web at `chat.elsiga.ch`.

## What carries forward from B1 (kept)

`mobile/` Capacitor scaffold, `mobile/build-apk.sh` (including the `JAVA_HOME` full-JDK fix at
`/home/elsiga/jdks/jdk-17.0.19+10`), `docs/productivity/mobile-build.md`, and the tracked
`mobile/package-lock.json`. `capacitor.config.ts` changes from `server.url` to local `webDir` +
`androidScheme: 'https'`.

## Roadmap after this increment

1. **This increment:** local bundle + bearer sync + thin task list + cold-offline proof + remove B1 SW.
2. **Full native task UI** (capture / manual breakdown / Home + what-now / Library) layered onto this
   shell — the original Slice-B B3 screens.
3. **The 4 Note fields** (`bucket`, `urgency`, `project`, `done`) — original B2 — fold into the
   full-UI increment (they are only meaningful once the UI surfaces them).
4. Later slices unchanged: Calendar (C), Focus/Pomodoro (D), AI planning, Projects entity, iOS.

## Global constraints (for implementation)

- **Web stays unchanged.** No change to `require_user`, cookie auth, CSRF, or the web frontend's
  behavior. The sync engine's same-origin/no-header path must be preserved so the web app is
  byte-for-byte unaffected.
- **Only sync gets bearer.** Do not add bearer to `/api/notes` or touch `require_user`.
- **Token scoped to sync only** — never mint the mobile token with admin/chat/email scopes.
- **APK build** stays on the Linux box → `dist/odysseus.apk` (gitignored); `mobile/{node_modules,
  android}` + `dist/` gitignored. Do **not** `git add -A` (the untracked `design/` folder).
- **Backend tests:** run the specific test file, not the whole `tests/` dir.
- **Bundle drift:** regenerate `static/js/productivity/sync-core.js` from `sync-engine/src` and
  commit it; drift-check committed == fresh build.
