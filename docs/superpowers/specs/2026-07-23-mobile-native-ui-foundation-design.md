# Mobile Native UI — Stack Decision & Foundation — Design

**Status:** Proposed 2026-07-23. Decision slice (no product features). Sets the architecture the
richer mobile UI ("EMBER" six-screen design, `design/Screens.dc.html`) will be built on, and the
build order for the feature slices that follow.

## Context

The mobile app today (`mobile/`) is a thin Capacitor WebView shell. Its UI (`mobile/www/index.html`
+ `mobile/www/js/app.js`) is a single flat screen: a checkbox task list, a "New task…" composer,
and a token/settings panel. It reads only two note fields (`title`, `done`) and renders with raw
imperative DOM. The offline-first sync engine (`sync-engine/` → esbuild → `sync-core.js`, copied
into the shell by `mobile/build-apk.sh`) is **built, proven cold-offline on device, and merged**
(b23f295). The sync record is free-form: it carries arbitrary fields through unchanged.

The target UX is the "EMBER, Pass 2" design (`design/Screens.dc.html`) — **six screens**: Home/Today,
Capture sheet, Focus mode (running), Focus mode (breakdown proposal), Session complete, Day view —
plus buckets (today/soon/someday), projects/#tags, subtask breakdown, and a focus timer with a ring.

Six screens of raw imperative DOM (the pattern that left the current app "barebones and stuck") does
not scale. This slice picks the stack to build them on, **without disturbing the sync engine that is
the app's proven core.**

## Decision 1 — UI stack

**Keep the Capacitor WebView + the shared Dexie `sync-core.js` exactly as-is. Add a lightweight
component layer — Preact + HTM — bundled with a small esbuild step that mirrors `sync-engine/`'s
existing toolchain.**

Rejected alternatives:

- **Raw DOM, no build (status quo).** Cheapest tooling, but six screens of `document.createElement`
  rots fast (state-sync bugs, duplication). This is how the app got stuck. Rejected.
- **Expo / React Native (true native).** Best native feel, but IndexedDB does not exist in RN, so the
  Dexie-based `sync-core.js` would have to be reimplemented on expo-sqlite and offline/conflict
  behavior re-verified — throwing away the one thing proven on device, diverging from the web's
  shared engine, and adding a new build pipeline. Too much risk against an offline-first app whose
  sync already works. Rejected for now; revisit only if native-native feel becomes a hard requirement
  worth a sync rewrite.

Why Preact + HTM specifically: component ergonomics for six screens; no JSX transform required (HTM
is tagged-template literals); tiny runtime; same TS→esbuild toolchain already in the repo. The
choice is orthogonal to native capability (see Decision 2) — the framework only draws inside the
WebView; native power comes from Capacitor plugins.

**Build pipeline:** an esbuild step bundles the mobile UI (`mobile/src/` → `mobile/www/js/app.js`),
alongside the existing copy of `sync-core.js`. `mobile/build-apk.sh` gains the UI bundle step; the
sync-core copy step is unchanged. No change to the Android/Gradle/Capacitor layers.

## Decision 2 — Native capabilities

Native power comes from **Capacitor plugins**, not the UI framework. Two capabilities are committed:

1. **Local notifications** — `@capacitor/local-notifications`. Schedules through Android AlarmManager,
   so deadline reminders and "focus session done" alerts fire with the screen off or the app killed.
   **Timers are timestamp-based, not tick-based:** store `startedAt` / `endsAt`, schedule a
   notification for `endsAt`, and recompute the visible countdown from the wall clock whenever the
   screen is on. This covers ~all focus-timer needs with **no background execution**.

2. **Live lock-screen countdown** — `@capacitor-community/background-runner` + an Android
   **foreground service**. Provides the ticking "24:59 remaining" persistent/lock-screen notification.
   **Caveats (accepted):** Android-only; requires battery-optimization/Doze exemptions, native
   configuration, and a runtime permission prompt. It is the highest-complexity native piece.

**Sequencing:** the foundation slice sets up Preact/HTM + esbuild + `local-notifications` only. The
`background-runner` + foreground-service lock-screen countdown lands in the **Focus Mode slice**,
where it is actually used — containing the native-config complexity to that one milestone. (User
decision 2026-07-23.)

## Decision 3 — Note model additions

Notes gain a **deadline** and a **schedule**, surfaced and editable in the mobile UI. **Reuse the
web app's existing field names** (`due_date` for the deadline, `schedule`) so the two clients
interoperate. Because the sync record is free-form, this needs **no backend change** — mobile reads
and writes the fields and they sync as-is. The exact shape of `schedule` is a feature-slice detail
(match whatever the web notes already emit; verify at implementation time).

## Decision 4 — Calendar / Google (out of mobile scope; roadmap dependency)

The web calendar reads from `/api/calendar/events`, backed by **CalDAV** (`app.py:790`) — there is
no direct Google Calendar API. Google Calendar connects **via CalDAV** (Google speaks CalDAV) or an
external GCal→CalDAV bridge, configured on the **odysseus-web/backend** side.

Boundary: **mobile owns the note fields (`due_date`, `schedule`) + local reminders; the
web/backend owns note↔calendar-event bridging and Google.** Mobile rides the synced fields and
schedules its own local notifications from them. Note↔event bridging and GCal are recorded here as a
**backend dependency on the roadmap, not built in any mobile slice.**

## Roadmap — feature build order

Each is its own spec → plan → implementation cycle. Order chosen so native-timer complexity is
contained to the Focus milestone:

1. **Foundation (this decision → first buildable slice):** Preact/HTM + esbuild wired into
   `mobile/`, `local-notifications` installed, the current task-list screen re-expressed as
   components (no behavior regression) as the proving ground. Deadline/schedule fields may be
   surfaced here or in Home/Today.
2. **Home / Today:** task list, bucket chips (today/soon/someday), "WHAT NOW" card (static first),
   capture bar, deadline/schedule display.
3. **Capture sheet:** quick capture routed into buckets.
4. **Focus mode** (running + breakdown proposal + session complete): the timer ring, subtask
   breakdown, and the `background-runner` + foreground-service lock-screen countdown.
5. **Day view:** scheduled timeline (consumes `schedule`; read-only against calendar until the
   backend bridging dependency lands).

## Non-goals for this slice

- No new product screens beyond re-expressing the existing task list as components.
- No `background-runner` / foreground service yet (Focus slice).
- No calendar/GCal integration (backend roadmap dependency).
- No change to `sync-engine/` / `sync-core.js`, Gradle, or Capacitor native config.

## Success criteria

- `mobile/` builds via esbuild into a Preact/HTM `app.js`; APK builds and runs; the existing
  task-list behavior (create/toggle/delete/sync, offline) is unchanged.
- `@capacitor/local-notifications` installed and able to fire a scheduled notification with the
  screen off.
- This document approved as the reference for the mobile UI stack and build order.
