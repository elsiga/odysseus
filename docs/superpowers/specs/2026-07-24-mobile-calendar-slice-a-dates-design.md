# Mobile Calendar — Slice A: Make Dates Real — Design

**Date:** 2026-07-24
**Status:** Approved (pending spec review)
**Scope:** Backend Note field (`duration_min`) + mobile date/time/duration/recurrence editing + a pure recurrence engine. **No calendar views** — those are Slice B.

## Problem

The roadmap's next feature is a mobile Calendar (Day/Week/Month). A calendar is only useful if tasks carry real dates, times, durations, and recurrence — but today mobile cannot set them properly:

- The **only** place mobile writes `due_date` is Capture, and it stores the raw parsed time token directly (`due_date: parsed.dueTime`, e.g. `"9pm"`) — not a valid `YYYY-MM-DDTHH:MM`, unparseable by `new Date()`, and wrong on web's `_formatDueDate`.
- Mobile **Detail has no date/time/repeat editing at all**.
- There is **no duration** field anywhere, so timed tasks have a start but no length.
- Recurrence (`repeat`) is a rich grammar the **web** already implements (`daily`/`yearly`/`weekly:W`/`monthly:day:N`/`monthly:nth:N:W`/`monthly:last:W` + legacy forms), but mobile has no code that reads or writes it, and a calendar needs to **enumerate** occurrences across a visible range, not just compute "next".

This slice makes dates first-class on mobile and ships the tested recurrence engine — the data foundation Slice B (the views) will render. It was split from the full calendar feature so the foundation lands in a smaller, safer increment.

## Goals

- Mobile tasks can carry a proper `due_date` (all-day or timed), an optional `duration_min`, and a recurrence, edited in Detail and stored correctly.
- Capture stores a real datetime instead of a raw time token.
- A pure, vitest-tested recurrence engine enumerates occurrences of a recurring task over a date range, semantically identical to the web's recurrence rules.
- Everything round-trips cleanly to web through the existing sync engine with **zero engine change** (one additive backend field).

## Non-goals

- The **Day/Week/Month calendar views** — Slice B.
- Stats screen, calendar settings (⚙), AI "plan my evening", and focus / "focused-that-day" data (their own later slices).
- Natural-language **date** parsing in Capture ("tomorrow", "mon", "3/15") — Capture handles time-→today only; arbitrary dates come from Detail's date picker.
- **Advanced recurrence authoring** (`monthly:nth`, `monthly:last`) — the engine READS them (so web-authored recurrences render), but the Detail UI does not write them.
- Drag-to-reschedule (a view interaction — Slice B).
- Hoisting recurrence into the shared bundle or changing the web; the web keeps its own copy.
- Any change to the sync engine, per-record LWW / conflict rules, `pushOnce`, the outbox, the change-log listeners, or `apply_push`/`pull_changes`.

## Architecture

Four components.

### 1. Backend — `duration_min` field

- **`core/database.py`:** add `duration_min` to the `Note` model — **integer, nullable, default `NULL`**. Represents the intended length of a timed task in minutes. End time is always **derived** (`start = due_date`, `end = due_date + duration_min`); no redundant end timestamp is stored, so it cannot drift.
- **Migration:** a guarded, idempotent `_migrate_add_*` (checks `PRAGMA table_info` first, then `ALTER TABLE notes ADD COLUMN duration_min INTEGER`), called at startup — same shape as the existing `repeat`/`sort_order` migration (`core/database.py:1121`) and `_migrate_add_notes_task_fields`.
- **Wire mapping (`routes/note/note_service.py`):** add `duration_min` to `_WIRE_IN_FIELDS`, to `note_to_wire`, and to the create/update field lists — exactly how `bucket`/`urgency`/`project`/`done` were threaded in Slice 1. The sync engine, change-log, listeners, apply/pull, and `notesRepo` are untouched (the additive field rides through for free).
- **Deploy:** the migration runs at startup, so the server must be rebuilt/restarted (`docker compose up -d --build`) for the live DB to gain the column (same lesson as the earlier stale-server issue).

### 2. `due_date` format contract

Mirror the web exactly so mobile and web agree byte-for-byte:

- **Timed task:** `YYYY-MM-DDTHH:MM` — local, no timezone (identical to web's `_toLocalDatetimeStr`).
- **All-day task:** `YYYY-MM-DD` — date only, no `T`.
- "Has a time" ⇔ the string matches `T\d{2}:\d{2}` (web's `_hasTimeComponent`). All-day tasks render on their date with no clock position; `duration_min` is only meaningful for timed tasks.

### 3. Mobile date/time editing

**New pure module `mobile/src/datetime.ts` (+ `datetime.test.ts`):**
- `parseTimeToken("9pm" | "14:30" | "9:30pm") → {hh, mm} | null`
- `composeDueDate(timeToken, now) → string | null` — when a time token is present, produce **today at that time** (no roll-over even if that instant already passed today; the user adjusts manually in Detail). No token → `null`.
- `hasTimeComponent(s)` / `toLocalDatetimeStr(d)` — matching web's format helpers.

**`mobile/src/screens/Capture.ts`:** store `due_date: composeDueDate(parsed.dueTime, new Date())` instead of the raw `parsed.dueTime`. `parseCapture` is unchanged (the shared bundle is not touched); `bucket` stays independent.

**`mobile/src/screens/Detail.ts` — a new "when" block** below title/description/subtasks, using native Capacitor-WebView pickers:
- **Date** — `<input type="date">` → `YYYY-MM-DD`. Clearing it sets `due_date = null` (task leaves the calendar).
- **Time (optional)** — `<input type="time">`. Set → combine with the date into `YYYY-MM-DDTHH:MM`; empty → all-day. Time set with no date → date defaults to today.
- **Duration** — only when a time is set: quick chips **15 / 25 / 45 / 60 / 90 min** (+ clear). Stored as `duration_min`; `null` when unset.
- **Recurrence** — selector **None / Daily / Weekly / Monthly / Yearly**, storing the **precise grammar derived from the chosen date** (like web's `_normalizeRepeat` of legacy bare values): Weekly → `weekly:<weekday>`, Monthly → `monthly:day:<dayOfMonth>`, Daily → `daily`, Yearly → `yearly`, None → `none`. Requires an active date.
- A small formatted label shows the current value (today / tomorrow / `Mar 15 · 9:00pm`).

**Persistence:** each picker change patches the note (`{due_date}` / `{duration_min}` / `{repeat}`) through `store.update` on the serialized write queue — consistent with Detail's existing persist model.

### 4. Recurrence engine — `mobile/src/recurrence.ts` (+ `recurrence.test.ts`)

Ports the web's recurrence semantics, reshaped from "next after now" into **range enumeration**:

- `normalizeRepeat(repeat, anchorDate) → string` — mirrors web's `_normalizeRepeat`: `none`/`daily`/`yearly` pass through; `weekly:`/`monthly:` pass through; legacy bare `weekly`/`monthly`/`monthly_nth_weekday`/`monthly_last_weekday` derive params from the anchor.
- `expandOccurrences(dueDate, repeat, rangeStart, rangeEnd) → string[]` — every occurrence datetime within `[rangeStart, rangeEnd]`, in the **same format as the anchor** (date-only stays date-only; timed preserves `hh:mm`). Recurrence runs forward from the anchor; a range starting after the anchor fast-forwards to the first in-range occurrence; a range entirely before the anchor yields `[]`. Iteration is capped with a guard (mirrors web's runaway protection).
- Internal helpers `nthWeekdayOfMonth` / `lastWeekdayOfMonth` ported from web.

**Grammar covered (read):** `none`, `daily`, `yearly`, `weekly:W`, `monthly:day:N` (month-length clamping — day 31 → last day of shorter months, like web's `Math.min(wantDay, lastDay)`), `monthly:nth:N:W`, `monthly:last:W`, plus legacy normalization.

**Duplication note:** the web keeps its own recurrence copy in `notes.js`; this mobile module must stay *semantically identical*, and the tests are the shared contract. Not hoisting both into the shared bundle this slice (that would touch working web code) — a known parallel implementation to keep aligned.

## Testing / Verification

- **Backend (pytest, `tests/test_notes_task_fields.py`):** `duration_min` round-trips through create/update/wire; the migration adds the column.
- **Mobile (vitest):**
  - `datetime.test.ts` — `parseTimeToken` variants (`9pm`/`14:30`/`9:30pm`/invalid); `composeDueDate` produces today+time with no roll-over and `null` on no token; format helpers.
  - `recurrence.test.ts` — none in/out of range; daily count across a range; weekly snaps to the right weekday; monthly:day clamping in February; monthly:nth (2nd Tuesday) and monthly:last (last Friday); yearly; legacy-bare normalization; all-day vs timed format preservation; range-before-anchor → `[]`; guard cap.
  - Existing `tasks`/`subtasks` suites stay green.
- **Build:** `node build.mjs` clean; `npx tsc --noEmit` clean.
- **APK:** rebuilt via `mobile/build-apk.sh`.
- **On-device proof (user):** capture "call mum 9pm" → stored as a real `…T21:00` (not `"9pm"`), renders correctly on web; in Detail set date / time / duration / recurrence → persists and round-trips to web (web renders `due_date`/`repeat` with its existing code); a "Weekly" pick stores `weekly:<weekday>`.

## Risks

- **Mobile/web recurrence drift** — two implementations of the same grammar. Mitigated by porting web's exact logic and encoding the contract in `recurrence.test.ts`; a future slice may hoist both into the shared bundle.
- **Native picker quirks** in the Capacitor WebView (`<input type="date">`/`type="time"`). Mitigated: Chromium WebView supports both as native pickers; the on-device proof exercises them.
- **Format mismatch** between mobile-authored `due_date` and web's parser. Mitigated by mirroring `_hasTimeComponent`/`_toLocalDatetimeStr` exactly and asserting the format in `datetime.test.ts`.
