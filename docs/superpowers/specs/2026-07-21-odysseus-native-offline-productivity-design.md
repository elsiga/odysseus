# Odysseus Native Offline-First Productivity — Revised Program Design

**Status:** Supersedes the standalone-SPA approach in `2026-07-21-odysseus-mobile-program-design.md`. That earlier doc's *foundation decision* (a separate React/Vite SPA served at `/app`, bundled into Capacitor, syncing new sync-owned tables with per-field HLC) is replaced by this document. The earlier doc's single-backend principle, reuse-from-ember stance, fork/upstream strategy, and hardening notes still hold.

**Why the pivot (2026-07-21):** After Slice 1 shipped a working standalone SPA + per-field HLC sync, the user redirected: the productivity features should mesh **natively into odysseus's own app** (its sidebar and screens), not live as an isolated `/app` subdirectory. The web version does **not** need to work offline; offline is a **mobile** requirement. This inverts the "one shared offline SPA that doubles as the Android app" bet.

## 1. Goal

Make odysseus's **own** productivity domains — **Notes/todos** first, then **Calendar** — work **offline on mobile** (edits happen locally and sync back on reconnect; LLM/chat stay online-only), while on the **web** they behave as normal always-online screens. One app: odysseus, with offline capability bolted onto its existing features. Single backend: odysseus.

## 2. Key findings that shaped this design

- **odysseus's frontend is hand-rolled vanilla JS with NO build step** — `static/index.html` (2.5k lines) + `static/app.js` (4.4k lines) + ~88 native ES modules in `static/js/`, loaded via `<script type="module">`. It has a real `<nav class="sidebar">` with "tool" entries; page routes (`/`, `/notes`, `/calendar`, …) all serve the same `index.html` and the JS switches screens client-side. Strict CSP with a `{{CSP_NONCE}}`.
- **odysseus already ships the relevant screens:**
  - **"Tasks"** = *agent automation* (cron-like scheduled LLM/action jobs; `scheduled_tasks`/`task_runs`). **Not** personal todos — out of scope for this layer.
  - **"Notes"** = *the real todo/checklist domain* (Google-Keep-style: notes + checklists with inline JSON `items:[{text,done}]`, reminders, labels, pinning, colors). Table `notes`, owner-scoped, **online-only** today. Routes `/api/notes*`, module `static/js/notes.js`.
  - **"Calendar"** = a real calendar with **CalDAV two-way (server↔server) sync**. Tables `calendars`/`calendar_events`/`caldav_deleted_events`, **online-only** on the client. Routes `/api/calendar*`, module `static/js/calendar.js`.
- **Nothing in odysseus is offline/local-first today** (the only `localStorage` use is a Notes view-mode preference; CalDAV is server↔server, not device-offline).
- **Native tables lack delta-tracking:** `Note` has no reliable `updated_at`; `CalendarEvent` has none. SQLAlchemy event listeners are **already used** in `core/database.py`, so change-capture has an idiomatic home.
- **Single-user, self-hosted** — this justifies per-record LWW over CRDT/OT.

## 3. Architecture

Four units, each with one job and a clean interface.

### 3.1 Backend — generic entity-sync over odysseus's native tables
- **One new sync-infra table `sync_change_log`** (not a domain table): append-only `(seq, owner, entity, entity_id, op, rev)` recording *what changed*, populated by **SQLAlchemy `after_insert/after_update/after_delete` listeners** on the synced models (`Note` first, `CalendarEvent` later). Listeners catch **every** write path — web UI, agents, CalDAV write-back.
- **Additive columns** on native tables via the existing `_migrate_add_*` pattern: `updated_at` (server-stamped, `onupdate`) + a monotonic `rev` for LWW/change-detection.
- **Endpoints** (generalize Slice 1's `/api/sync`):
  - `GET /api/sync/pull?cursor=&limit=` → changed records since cursor across registered entities, each `{entity, id, op, record|null, rev}`; cursor + `hasMore`.
  - `POST /api/sync/push` → apply client edits with **per-record LWW**, **routed through the domain service functions** (the same code `/api/notes` / `/api/calendar` use) so reminders, AI-classification, and CalDAV write-back still fire. Returns the winning records.
  - `GET /api/sync/ping`.
  - A generalized `REGISTRY` maps `note`/`calendar_event` → model + wire mapping + service hooks. Owner-scoped throughout (`require_user` + single-user `FALLBACK_OWNER`, mirroring `calendar_routes`).
- **Correctness principle:** the sync push is not a blind row overwrite — it invokes the domain's create/update/delete service logic (extract those from the route handlers if needed) so there is **one source of truth for domain writes**.

### 3.2 Client — headless bundled local-first layer
- Lives at `static/js/productivity/` as a **dev-time-built, committed JS bundle** (Option A): keep the tested TS sync engine + Dexie; a bundler (run only when the engine changes, on the Node box) emits a self-contained ES module; **odysseus's runtime stays build-less**.
- Contains: a Dexie store mirroring the synced entities, an outbox, a sync cursor, and the Slice-1 sync loop retargeted to per-record LWW over native entities.
- Exposes a small typed **repo API** to the screens (e.g. `notesRepo.list/create/update/delete` + change notifications). Screens never `fetch` — they call the repo.

### 3.3 Frontend — native odysseus screens
- Refactor the **existing** module's data access (`static/js/notes.js` first, `calendar.js` later) to go through the repo instead of `fetch('/api/notes')`. The UI/rendering stays; only the data source swaps. Same sidebar entry, now offline-capable. (A real but contained refactor of a large file; accepted merge-surface cost, consistent with the "heavier fork divergence" stance.)

### 3.4 Mobile — Capacitor wrapper
- Wraps the **whole** odysseus web app. The synced domains work offline via the store already present in the frontend; LLM/chat/research degrade to online-only. Auth via `ody_` bearer token in secure storage; `ALLOWED_ORIGINS` includes the Capacitor origin. Android first (iOS later on the user's Mac).

### 3.5 Data flow (one todo edit)
```
Notes screen → notesRepo.update() → local Dexie write + outbox entry → instant re-render
                                          │ (when online)
                                          ▼
   POST /api/sync/push → note SERVICE applies per-record LWW → notes table
                                          │ after_update listener
                                          ▼
                                   sync_change_log (+seq)
                                          │
   other device: GET /api/sync/pull?cursor= → apply locally
```
The domain data stays in odysseus's real tables; only `sync_change_log` + the client store are new plumbing.

## 4. Conflict model — per-record LWW + tombstones

- **Per-record last-write-wins.** Two distinct roles: **`rev`** (a per-record integer version, bumped on every write) is the *optimistic-concurrency check* — "did the server move since the client's base?"; **`updated_at`** (server-stamped) is the *tie-break* — the later timestamp wins. No per-field HLC, no CRDT/OT — single-user; matches the design doc's "per-record LWW, escalate only if it bites." (Distinct from `sync_change_log.seq`, which is the global pull cursor, not a per-record version.)
- **Push reconcile:** a client edit carries the record's base `rev`. If the server's current `rev` still equals that base → apply, bump `rev`. If the server moved on (its `rev` is higher) → **the record with the later `updated_at` wins the whole record**; server returns the winner so the client converges.
- **Accepted weakness (documented):** two *offline* edits to different fields of the **same** note (e.g. checking different checklist items on two devices) → one whole `items` blob overwrites the other, losing a change. Rare for a single user editing one device at a time. **Checklist item-level merge is a named future enhancement**, not built now (YAGNI).
- **Deletes / tombstones:** native Notes hard-delete; the `after_delete` listener writes a `sync_change_log` `op=delete, id` row. Pull ships it; clients delete locally by id. **Delete wins** over a concurrent offline edit; a push to an already-deleted id is dropped and returned as a delete. A "trash/undo" softening is a later option.
- **CalDAV coexistence (Calendar slice):** device-offline sync makes **odysseus the hub** in a 3-way `device ↔ odysseus ↔ CalDAV`. It composes only because push routes through the calendar service: a device edit → service applies → existing CalDAV write-back fires unchanged; a CalDAV-pulled change → updates the table → listener logs it → devices pull it. Device-vs-remote conflicts resolve by LWW at odysseus; CalDAV's own etag handling stays. This 3-way is why **Calendar comes after Notes**.

## 5. What the shipped Slice 1 keeps vs. retires

| Slice 1 artifact | Fate |
| --- | --- |
| Sync backbone concept (append-only change-log + cursor pull + outbox + local store + `REGISTRY`) | **Carries forward** — the reusable core |
| Dexie client store + sync loop (`webapp/src/sync`, `db`) | **Re-homed** into the bundled `static/js/productivity/` layer, retargeted to native entities |
| Per-field HLC LWW on `sync_task` (`hlc.py`, `winners.py`, per-field `apply/pull`) | **Replaced** by per-record LWW over native tables |
| `sync_task` table + Slice-1's per-field `sync_change_log` schema (`fields` JSON, `deviceId`) | **Retired.** `sync_task` is dropped; a new **generic** `sync_change_log` (same name, redesigned schema: `seq, owner, entity, entity_id, op, rev`) replaces the per-field one and indexes changes to the native tables |
| React SPA (`webapp/`) + `/app` serving + PWA | **Retired for web**; UI becomes native vanilla-JS screens; offline moves to the mobile wrapper |

The design and a good chunk of the engine survive; the React SPA, the `sync_task` schema, the per-field-HLC apply/pull, and `/app` serving are superseded.

## 6. Roadmap

Each slice = its own spec → plan → build.

1. **Slice A — Notes/todos offline, native (the thinnest vertical).** Cleanup (retire the Slice-1 spike: remove `webapp/`, `/app` serving, and the per-field-HLC/`sync_task` specifics; keep the generalizable `REGISTRY`/apply/pull skeleton + test discipline). Backend: `sync_change_log` + `Note` listeners + additive `updated_at`/`rev` + generalized per-record-LWW `/api/sync/pull|push` routed through the note service. Client: bundled local-first layer + Notes repo. Frontend: refactor `notes.js` onto the repo. Proof: edit a todo with the browser forced offline → persists and syncs on reconnect. No external sync → clean first vertical.
2. **Slice B — Capacitor Android wrapper.** Wrap the full odysseus app; `ody_` token auth + `ALLOWED_ORIGINS`; native notifications; the Notes domain works offline on-device. **Placed here to validate the mobile-offline premise early**, right after the first offline domain exists.
3. **Slice C — Calendar offline, native + CalDAV 3-way.** Extend sync to `calendar_event`; refactor `calendar.js` onto the repo; offline edits compose with CalDAV write-back (odysseus as hub). The hard sync slice.
4. **Slice D — Pomodoro / focus timer (native).** Port ember's focus timer as a native module + sidebar entry (mostly local state).
5. **Slice E — Email drafts offline** → **Slice F — Documents offline** (LWW + odysseus's existing version history as conflict copies) → **Slice G — reminder untangling / Honcho** — same pattern, as in the original roadmap.

## 7. Slice A scope (what the implementation plan will cover next)

**Backend**
- Additive migration: `notes.updated_at` (DateTime, `onupdate`), `notes.rev` (monotonic).
- `sync_change_log` model (generic) + `create_*` helper, on `Base`, created at sync-router setup.
- SQLAlchemy `after_insert/after_update/after_delete` listeners on `Note` → append change-log rows (owner, entity=`note`, id, op, rev).
- `REGISTRY["note"]` with wire mapping (native `notes` columns incl. inline `items` JSON) + service hooks.
- Generalized `/api/sync/pull` (cursor over `sync_change_log`, returns live `note` rows / delete tombstones) and `/api/sync/push` (per-record LWW via the note service create/update/delete; extract those service functions from `routes/note/note_routes.py` if they're inline). `/ping`. Owner-scoped.
- Tests (house `asyncio.run` pattern — no pytest-asyncio): listener writes change-log; pull bootstrap + incremental; push LWW newer-wins / older-loses / delete-wins; owner gate.

**Client (bundled)**
- Dev-time bundler config emitting `static/js/productivity/sync-core.js` (committed) from the TS engine + Dexie.
- Dexie store for `notes` mirror + outbox + cursor; sync loop (push/pull, per-record LWW apply).
- `notesRepo` API + change notifications. Vitest for the engine + repo.

**Frontend**
- Refactor `static/js/notes.js` data access (its `fetch('/api/notes*')` call sites) to `notesRepo.*`. Keep the UI. Verify the Notes screen works online, and offline (devtools-offline) with sync-on-reconnect.

**Cleanup**
- Remove `webapp/`, the `/app` mount + routes in `app.py`, `tests/test_app_spa.py`; drop the `sync_task` table + per-field-HLC modules; keep/repurpose the generalizable `src/sync` skeleton. This makes the `integration → dev` PR moot.

## 8. Risks & watch-outs

- **Refactoring large existing modules** (`notes.js` 5.4k lines, later `calendar.js` 3.7k) — swap data access only; do not restructure UI. Contained but touches hot files → merge surface (accepted).
- **Push through the service layer** — the note/calendar service functions may be inline in route handlers; extracting them cleanly (without behavior change) is prerequisite work. If extraction is risky, isolate the minimum.
- **CalDAV 3-way (Slice C)** — the genuinely hard part; sequence after Notes and after the mobile wrapper is proven.
- **Committed generated bundle** — the `static/js/productivity/` bundle is a build artifact in git; document the regen command; ensure the source (TS engine) is the source of truth.
- **Heavier fork divergence** — deeper native integration + additive columns/listeners on hot files raise the upstream-merge surface; the user has accepted less-frequent upstream syncing as the trade-off.

## 9. Out of scope / YAGNI

- Per-field HLC / CRDT / OT for notes or calendar (per-record LWW only).
- Browser (web) offline / PWA / service worker — offline is a mobile-only requirement now.
- A second backend of any kind.
- Checklist item-level merge, trash/undo — named future enhancements, not now.
