# Slice B — Mobile Task App (Capacitor wrapper + rich Notes/todo + mobile UI) — Design

**Status:** Authoritative spec for Slice B. Builds directly on the Slice-A native offline-first Notes/sync layer (`docs/superpowers/specs/2026-07-21-odysseus-native-offline-productivity-design.md`). Terminology note that governs this whole doc: **"task" = a Note** (the Google-Keep-style `notes` domain that is the user's personal todo system). It is **NOT** odysseus's agent-automation "Tasks" (`scheduled_tasks`/`task_runs`, the AI's scheduled jobs) — those are untouched. The design prototype's word "task" always means a Note.

## 1. Goal

Ship an **Android app** (Capacitor) that presents the Notes/todo domain as a **native-feeling mobile task app** matching the `design/Tasks + Calendar Prototype.dc.html` prototype (its default "odysseus" theme), and works **cold-offline** on-device (reopen with no network and keep using it). It reuses the Slice-A local-first sync path, extends the Note model with the axes the design needs (bucket/urgency/project/done), and adds the mobile task screens (Home/Capture/Breakdown/Library) with a deterministic natural-language capture parser. Web and desktop are untouched.

**Out of scope (deferred to their own slices):** Calendar day/week/month + stats (Slice C), Focus/pomodoro + time tracking + the Complete "bloom" screen (Slice D), AI step-generation and AI "plan my evening" (later), a first-class Project entity/metadata (later), push notifications / deep links / iOS / a locally-bundled webDir + bearer-scoped routes, and any mobile-*web* redesign (the mobile UI is Capacitor-only).

## 2. Architecture — wrapper & offline (approved)

**Capacitor `server.url` + a Capacitor-only service worker.**

- A new Capacitor Android project whose WebView loads **`https://chat.elsiga.ch` directly** (`server.url`, configurable). Because the WebView origin *is* the server: **cookies work same-origin** (normal TOTP login), there is **no CORS**, **no bearer token**, and **zero backend auth changes**. The full odysseus app runs natively as-is.
- **Cold-offline** comes from a **service worker** (`static/sw-native.js`, new — distinct from the retired Slice-1 `/app` SW) that caches the app shell: `index.html`, the `static/js/*` ES modules, CSS, and `static/lib/*`. On an offline cold launch the WebView navigation is served from the SW cache; Note data comes from the Slice-A IndexedDB (`odysseus-productivity`) store. **CSP stays valid** because the SW replays the server's own cached response — the cached `index.html` and its cached `Content-Security-Policy` header carry the same nonce, so the inline boot script still validates offline. No CSP changes needed.
- The SW is **registered only when `window.Capacitor` is present** (a small guarded `navigator.serviceWorker.register('/sw-native.js')` call). Web browsers hitting `chat.elsiga.ch` never register it → **web stays SW-free and online-only**, honoring Slice-A spec §9 ("no web PWA"). The `sw-native.js` file existing on the server is inert unless registered.
- **First launch must be online** (to populate the SW cache); subsequent cold launches work offline. Documented behavior, not a bug.
- **SW cache versioning:** the SW carries a version constant; on activate it deletes old caches. A deploy that changes shell assets bumps the version (or the SW uses stale-while-revalidate so the next online launch refreshes). Watch-out: a stale shell after a deploy — mitigated by SWR + version bump.
- `ALLOWED_ORIGINS` unchanged (same-origin). `SECURE_COOKIES=true` + HTTPS is fine in the WebView; cookie persistence across app launches is handled by Capacitor's cookie storage (a B1 watch-out to verify on-device).
- Native plugins beyond what Capacitor needs (push, secure storage, deep links) are **out of scope** this slice.

**Trade-off (accepted):** the app is "the live site in a native shell," not a self-contained bundled app — ideal for a personal self-hosted deployment and the fastest route to a real APK. The "proper" bundled app (local webDir + bearer-scoped `/api/notes`/`/api/sync` routes + CSP/config/fetch surgery) remains a possible future hardening, unneeded to validate the premise.

## 3. Data model — extend Notes (approved)

The design's rich "task" is a Note plus four axes. **Additive columns** on the `notes` table (Slice-A `_migrate_add_*` idempotent pattern), all synced by the existing per-record engine:

| New column | Type / default | Purpose |
| --- | --- | --- |
| `bucket` | `String`, default `'today'` | `today` / `soon` / `someday` |
| `urgency` | `Integer`, default `0` | `0` / `1` (`!`) / `2` (`!!`) |
| `project` | `String`, nullable | the `@project` name — **a string**, not a table (Library/Project views derive the list from distinct values; a Project entity + metadata is a deferred future slice, reached via a string→FK migration) |
| `done` | `Boolean`, default `False` | **task-level completion** — the design's circle checkbox completes the whole task (Notes has only item-level `done` and `archived`, which are different). (A `completed_at` timestamp can replace this later for stats without reworking the UI.) |

Unchanged, already present and synced: `items[{text,done}]` = **steps/subtasks**, `due_date` = **deadline**, `repeat` = **recurrence**, `label`/`color`/`pinned`/`archived` as-is.

**Sync is nearly free** (Slice-A carries whole records per-record). Server touches only:
- `Note` model: add the 4 columns; `_migrate_add_notes_task_fields()` migration wired into `init_db()`.
- `routes/note/note_service.py`: add the 4 fields to `_CREATE_FIELDS`/`_UPDATE_FIELDS` and to `note_from_wire`'s `_WIRE_IN_FIELDS`; add them to `note_to_wire` output. All are plain scalars (`done` is a bool like `pinned`; no datetime-wire handling needed — this is why `done` beats `completed_at` for this slice).
- The change-log, listeners, `apply_push`, `pull_changes`, and the client `notesRepo`/engine need **no changes** — they are field-agnostic and carry whole records; new fields flow automatically. The client `NoteRow` is already `Record<string, unknown>`.

**Simplification:** the mobile app treats **every note as a task row** (a plain note = a task with no steps); no note-vs-task type flag this slice. Desktop/web ignore the new fields (non-breaking).

## 4. Mobile task UI (approved)

A **new vanilla-JS mobile surface** — matching odysseus's no-build ES-module approach; the React `dc-runtime` prototype is **reference only, not shipped**. Activated when `window.Capacitor` is present: a `body.is-native` class hides odysseus's desktop chrome and mounts a full-screen mobile app container. It reads/writes through the **same Slice-A `notesRepo`** (offline-first, synced) and relies on the sync client already booted by `notes.js` (both load in the same page — **do not** boot a second client; reuse the singleton `notesRepo` + its `subscribe`).

**Location:** new modules under `static/js/native/` (e.g. `boot.js`, `taskapp.js`, screen/render modules) + a `static/css/native.css` (or a `<style>` block) with the design tokens mapped to odysseus vars. Loaded from `index.html` as normal modules; `boot.js` no-ops unless `window.Capacitor`.

**Design tokens → odysseus vars:** `--accent` → `--red`; `JetBrains Mono` → `Fira Code`; reconcile `--bg/--card/--border/--text` with the design's odysseus-theme values. Dark-only, hairline borders, radii 10–24, 999-pills, bottom sheets, **no tab bar** (hub-and-spoke off Home, per the design's explicit stance).

**Screens (todo domain only):**
- **Home / Today** — header (day + a `time · day view` link that is **inert/deferred** until Slice C); **WHAT-NOW** single suggestion card (the one top task ranked by `urgency` desc, then `due_date` asc; empty state "Today is clear."); the **today list** (`bucket='today'`, not `done`); bucket chips (`soon N` / `someday N` / `projects`); a pinned **Capture bar**.
- **Capture sheet** — bottom sheet; a text input with **live NL token parsing** (see §5) rendering inline highlight chips; a `today/soon/someday` bucket picker (default today); **Save** → `notesRepo.create({...parsed})`; success toast. This is the only create path.
- **Breakdown** — full-screen; **manual** step rows editing the note's `items[]` (add / edit / delete / reorder); the `✨ ask AI` control is **hidden/stubbed** (deferred). A primary "done" returns Home.
- **Library** — `soon` / `someday` lists + a **projects** list derived from distinct non-null `project` values (`N open →`).
- **Project view** — the notes where `project=X`.
- **Task completion** — the circle checkbox toggles `done` (optimistic via `notesRepo.update`); done rows strike/fade and drop out of the active list.

**Components (vanilla render functions):** `TaskRow` (circle checkbox → `done`, urgency dot, title + sub-line, right tag from recurrence/deadline), `SegmentPill`, `BucketChip`, `BottomSheet`, `CaptureInput` (transparent input over a token-highlight overlay), `StepRow`, `SuggestionCard`, `Toast`. State in module vars; re-render on `notesRepo.subscribe`. (Focus/Complete/Calendar/Stats components are explicitly later slices.)

## 5. Capture parser (the one unit-tested logic piece)

`parseCapture(text) -> { title, project?, dueDate?, urgency, repeat? }` is a **pure function shipped in the `sync-engine` bundle** (`sync-engine/src/parseCapture.ts`, exported from `index.ts` → available on `sync-core.js`), so it is **vitest-tested**. The mobile `CaptureInput` calls it live to render highlight chips and on Save to build the note.

Deterministic tokens (subset from the prototype's `parseCapture`, no AI):
- `@word` → `project` (strip the `@`; the rest is the title).
- `!` / `!!` (standalone) → `urgency` 1 / 2.
- `every day` / `daily` / `weekly` / `every <weekday>` → `repeat` (mapped to odysseus's `repeat` values).
- Dates/times: `today`, `tomorrow`, weekday names, and clock times like `9pm` / `14:30` → an ISO `dueDate` (resolved against "now", passed in as a parameter so the function stays pure/testable — no bare `Date.now()` inside).
- Remaining text (tokens stripped) → `title`.

Tests cover: each token type, combinations (`pay rent @flat today 9pm !!`), no-token plain text, and that unmatched text stays in the title.

## 6. Build sequence

Each sub-slice = its own plan → SDD build, in order. Each ends independently testable.

1. **B1 — Capacitor wrapper + cold-offline.** New Capacitor Android project (config, `server.url`, app id/name/icons); `static/sw-native.js` shell-caching SW + the `window.Capacitor`-guarded registration; the `body.is-native` gate (B1 may show the **existing** Notes UI in the shell — the mobile redesign lands in B3). **Proof (manual, like Slice A):** build the APK, install on device/emulator, log in online once, then airplane-mode **cold launch** → the app shell loads and a Note edited offline persists + syncs on reconnect.
2. **B2 — Rich Note fields + sync.** The 4 columns + `_migrate_add_notes_task_fields()` + `note_service`/`note_to_wire`/`note_from_wire` additions. **Tests:** migration adds the columns; a sync round-trip create/update with `bucket`/`urgency`/`project`/`done` returns them via pull; per-record LWW still holds (extends the Slice-A backend suite — house `asyncio.run` pattern).
3. **B3 — Mobile task UI + capture parser.** `parseCapture` in the bundle (vitest); the `static/js/native/` mobile app (Home/Capture/Breakdown/Library, components, tokens) over `notesRepo`; `native.css`. **Verify:** parser unit tests; the mobile screens manually on-device (create via Capture with tokens → correct fields; complete a task; edit steps; buckets/projects navigate).

## 7. Risks & watch-outs

- **Android build environment** — the APK build needs the Android SDK/Gradle/JDK. **Prerequisite to confirm at B1:** does this run on the Linux server or the user's Mac? (Wrapper config + SW + JS are authored here regardless.)
- **Cookie persistence in the WebView** across app launches under `SECURE_COOKIES` — verify Capacitor persists the session cookie so the user isn't logged out each cold start.
- **SW cache staleness after a deploy** — version the cache + stale-while-revalidate so a new online launch refreshes the shell; a bad SW can "pin" an old app.
- **First-launch-must-be-online** for the cache to populate — acceptable, documented.
- **Single sync client** — the mobile app must reuse the `notes.js`-booted client/`notesRepo`, not start a second one (double push/pull).
- **Hand-rolled vanilla UI** — several screens with no framework; accept the effort and keep components small/focused.
- **`server.url` = hosted-webview** — fine for a sideloaded personal APK; would not pass app-store review (not a goal here).

## 8. Out of scope / YAGNI

- Calendar (Slice C), Focus/pomodoro + time tracking + Complete screen (Slice D), Stats, AI step-generation, AI "plan my evening."
- A first-class Project entity + project metadata (string now; table later via migration).
- Push notifications, deep links, iOS, secure-storage/bearer auth, a locally-bundled webDir.
- Any change to mobile-*web* or desktop (the mobile UI is Capacitor-gated).
- `completed_at` timestamp / completion stats (a `done` boolean now).
