# Mobile Slice 1 — Foundation + Todo — Design

**Status:** Approved 2026-07-23. First feature slice of the fleshed-out native mobile UI. Builds the
Preact/HTM + esbuild component foundation from the foundation design
(`2026-07-23-mobile-native-ui-foundation-design.md`) **and** the todo surface on top of it, replacing
the current raw-DOM thin shell.

## Context

The mobile app (`mobile/`) is a proven thin Capacitor shell: a local-bundle WebView (`https://localhost`,
local `webDir`) over the shared Dexie `sync-core.js` + bearer sync. Cold-offline is **proven on device**
and the whole thing is **merged to `dev`** (`b23f295`). Its UI (`mobile/www/index.html` +
`mobile/www/js/app.js`, ~108 lines of raw imperative DOM) is a single flat checkbox list reading only
`title`/`done`. It does not scale to the target product.

The target UX is the **`design/Tasks + Calendar Prototype.dc.html`** prototype (the authoritative source —
the only one with week/month/stats/chat): dark, JetBrains Mono, coral `--accent`, no tab bar,
hub-and-spoke off Home, bottom sheets. `design/Screens.dc.html` is an older EMBER draft (reference only).
`design/` stays untracked.

The foundation design already locked the stack: **keep Capacitor + the proven Dexie `sync-core.js`
exactly as-is; add Preact + HTM bundled by a small esbuild step; native power comes from Capacitor
plugins, not the framework.** This slice is the first to build on that decision.

**Build order (user-approved 2026-07-23):** Slice 1 = Foundation + Todo together (this doc) → Calendar
(day/week/month) → Timer/Focus → Chat. Each is its own spec → plan → SDD cycle. Foundation and Todo are
built together because re-expressing the existing task list as components is the foundation's proving
ground, and it retires foundation risk inside a shippable feature.

## Scope & boundary

**In scope:**
- Preact/HTM + esbuild build pipeline wired into `mobile/`.
- The current task-list behavior (create / toggle / delete / sync / offline) re-expressed as components
  with **zero behavior regression**.
- Four additive `Note` fields: `bucket`, `urgency`, `project`, `done` (backend + migration + wire).
- Todo screens: Home/Today, Capture sheet, Library (buckets + projects), Project view, task rows,
  task detail / manual step (subtask) editing.
- `@capacitor/local-notifications` installed and one scheduled notification proven with the screen off
  (foundation success criterion). No real reminder wiring yet.

**Out of scope (later slices):** Calendar day/week/month/stats, Focus timer running/complete + live
lock-screen countdown, AI chat sheet, external CalDAV/Google calendar events, iOS. **No change** to the
sync engine (`sync-engine/` / `sync-core.js`), the change-log/listeners/apply/pull, Gradle, or Capacitor
native config.

## Decision A — Foundation (the proving ground)

- Add `mobile/src/` (Preact + HTM, TypeScript). An **esbuild** step bundles it to `mobile/www/js/app.js`,
  mirroring the `sync-engine/` toolchain. `build-apk.sh` gains a UI-bundle step; the existing
  `sync-core.js` copy step is unchanged. No change to the Android/Gradle/Capacitor layers.
- The existing task-list behavior is re-expressed as components. Repaint model follows the proven web
  pattern (`static/js/notes.js`): render imperatively after each awaited `notesRepo` mutation and after
  the initial `syncOnce()` lands — **not** via `notesRepo.subscribe()` (that fired pre-commit and caused
  the stale-repaint bug fixed in `afd0f84`). In Preact terms: local state is updated after each awaited
  write, driving a re-render.
- `npm i @capacitor/local-notifications`; prove one scheduled notification fires with the screen off.
  Timestamp-based only (store `startedAt`/`endsAt` when it becomes relevant); real deadline/focus
  reminders are wired in the Timer slice.

## Decision B — Four additive Note fields (backend, TDD)

Add to the `Note` model + an **additive migration** (the established `_migrate_add_*` pattern):

| field      | type          | default   | meaning                                  |
|------------|---------------|-----------|------------------------------------------|
| `bucket`   | str           | `'today'` | `today` / `soon` / `someday`             |
| `urgency`  | int           | `0`       | `0` / `1` / `2` (`!` / `!!` at capture)   |
| `project`  | str, nullable | `NULL`    | a plain string tag, **not** a table       |
| `done`     | bool          | `false`   | task-level completion (distinct from per-`items[]` step `done`) |

Add the four to `note_service`'s `_CREATE_FIELDS`, `_UPDATE_FIELDS`, `_WIRE_IN_FIELDS`, and `note_to_wire`.
The sync change-log listeners, `apply_push`, `pull_changes`, and `notesRepo` are **unchanged** — the
record is free-form and the fields sync as-is. Tests first: field round-trip through create/update/wire,
and the additive migration.

`schedule` (the calendar time field) is **not** added here — it belongs to the Calendar slice.

## Decision C — Todo UI (Preact over `notesRepo`)

`odysseus` theme (dark, JetBrains Mono, coral `--accent`). No tab bar: Home is the only root screen;
Library and Project are one tap in and back/swipe out (hub-and-spoke).

- **Home / Today:** date header; **WHAT-NOW** card — a single static suggestion picked from today's
  tasks, with a "not this one →" swap. The card's **`Start` button is deferred/inert** until the Timer
  slice (decision: inert now rather than opening breakdown — keeps the focus flow whole for its own
  slice). Today list: task rows, tap-to-toggle `done`, capped display with a gentle overfull triage
  line ("N more in today — move some to soon?"). Bucket chips row (`soon · N`, `someday · N`,
  `projects`). Pinned bottom **Capture** pill. Empty state ("Today is clear.") and overfull state.
- **Capture sheet:** bottom sheet, focused input, bucket chips (today/soon/someday), Save →
  `notesRepo.create`. **NL token parse** via a pure, vitest-tested `parseCapture()` in the sync-engine
  bundle: `@project`, bucket keywords (`today`/`soon`/`someday`), a time token (e.g. `9pm`), `!`/`!!`
  urgency — with the live highlight overlay from the prototype. `parseCapture()` is the **first thing to
  trim** if scope runs hot; a plain input + bucket chips still ships a working capture.
- **Library:** the three buckets as lists + a projects/#tags listing.
- **Project view:** tasks filtered by the `project` string + "add a task to this project."
- **Task detail / breakdown:** manual step (subtask) editing over the existing `items[]` — add / edit /
  × / reorder. No AI, no "start step 1" (Timer slice).
- **Component inventory** (reusable): task row (default / active / done / rolled-forward), subtask row,
  bucket chips + project tag, buttons, bottom sheet, toast.

## Data flow

Capture / edits → Preact component → `notesRepo` write (awaited) → local state update → re-render, and
→ Dexie outbox → `syncOnce()` → `/api/sync` (bearer) → backend per-record LWW over the native `notes`
table. Reads: `notesRepo.list()` (Dexie) → derive buckets/today/overfull → render. Cold-offline and the
existing sync path are unchanged.

## Testing & success criteria

- **Backend:** the 4-field round-trip (create/update/wire) and additive-migration tests are green.
- **Client:** `parseCapture()` and the pure derivations (bucket counts, today/overfull logic) are
  vitest-green.
- **Build/behavior:** esbuild emits `mobile/www/js/app.js`; the **APK builds and runs**; the existing
  create / toggle / delete / sync / **offline** behavior is unchanged (no regression); one
  `@capacitor/local-notifications` notification fires with the screen off.

## Non-goals for this slice

- No Calendar views, Focus timer, AI chat, external calendar events, or iOS.
- No `background-runner` / foreground service (Timer slice).
- No change to `sync-engine/` / `sync-core.js`, the change-log/listeners/apply/pull, Gradle, or
  Capacitor native config.
- No change to the web/desktop UI (mobile surface is Capacitor-only).
