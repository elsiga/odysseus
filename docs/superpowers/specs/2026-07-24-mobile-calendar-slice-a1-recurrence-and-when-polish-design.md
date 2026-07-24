# Mobile Calendar — Slice A.1: Recurrence Authoring + When-Block Polish — Design

**Status:** Approved (2026-07-24)

**Predecessor:** Slice A ("make dates real") — `docs/superpowers/specs/2026-07-24-mobile-calendar-slice-a-dates-design.md`. Built + reviewed + merged-pending on branch `integration` at `bf58589`. Slice A added `Note.duration_min`, `mobile/src/datetime.ts`, `mobile/src/recurrence.ts` (full web-parity grammar), and a first-pass Detail "when" block (native date/time, duration chips, 5 coarse recurrence chips).

## Goal

Bring the mobile Detail "when" block to parity with the web's recurrence authoring, and polish the block per user feedback: a typable duration, sensible default date/time, calendar/clock icons, and a fix for the WebView tap-highlight flash. All changes live in the mobile Detail screen plus one engine helper and a global CSS line. **No backend change** — `duration_min` and the full recurrence grammar already exist.

## Non-Goals (deferred to future slices)

- **Todoist-style typed capture** ("do X tonight at 18:00", `!!2` priority, `#project`) — a separate future slice; the existing plan already deferred NL-date parsing.
- **`monthly:last` authoring** — the web authoring UI does not offer it either (only Day-N and Nth 1st–4th); the engine still *reads* `monthly:last:W` from web/legacy data.
- **Slice B** — Day/Week/Month calendar views.

## Architecture

Three touch points; the engine already owns the recurrence grammar, so this is mostly UI + one pure helper.

### 1. Engine — `mobile/src/recurrence.ts` (+ `recurrence.test.ts`)

Additive; no change to existing exports (`normalizeRepeat`, `simpleRepeat`, `expandOccurrences`).

- **`snapToRepeat(currentDate: Date, normRepeat: string): Date | null`** — semantic port of web's `_snapToRepeat` (static/js/notes.js:686-740). Snaps a chosen datetime **forward** to the next slot matching a normalized `weekly:W` / `monthly:day:N` / `monthly:nth:N:W` / `monthly:last:W` pattern, preserving time-of-day. Anchors to `currentDate` when it is in the future (so picking a recurrence on a far-future date doesn't drag it back to today), otherwise to `now`. Returns `null` for `daily` / `yearly` / `none` (nothing to snap). Used by Detail when the user picks a weekly/monthly variant whose weekday/day doesn't match the current due date.

- **`monthlyDescriptor(norm: string): string`** — compact human label for a normalized monthly (or any) repeat, for the inline summary: `monthly:day:24` → `"Day 24"`, `monthly:nth:2:2` → `"2nd Tue"`, `monthly:last:5` → `"last Fri"`. Mirrors web's `_monthlyShortDescriptor`. Uses local `DAYS`/`ORDINALS` tables.

- **Bonus (final-review #4 guard):** in `expandOccurrences`, when the pattern is `weekly:W` and the anchor's weekday ≠ W, advance the first emitted occurrence to the matching weekday before enumerating (today `expandOccurrences` emits the raw anchor first even if off-weekday). Low-risk, same-file, tested; closes the deferred Slice-A finding.

Tests (append to `recurrence.test.ts`): `snapToRepeat` — weekly Wed→next Mon; weekly same-day-in-future stays; monthly:day forward; monthly:nth forward; `daily`/`yearly`/`none` → `null`; future-date anchor vs now anchor. `monthlyDescriptor` — day/nth/last forms. The weekly off-weekday `expandOccurrences` guard.

### 2. Detail "when" block — `mobile/src/screens/Detail.ts`

The single UI surface for all six user requests. Persists exclusively through the existing `onUpdate` prop (serialized `store.update` queue) — never `notesRepo` directly. Keeps the Slice-A + final-review invariants (compose to `""` on clear; `duration_min` 0 = cleared; preserve web-authored `monthly:nth`/`last` when the recurrence selection is unchanged — the `rep0`/`repeat0` guard).

- **Icons.** Each of the date and time inputs is wrapped in a flex container with a leading inline-SVG stroke icon (calendar for date, clock for time), sized to the mono aesthetic. The native right-edge picker indicator is left as-is.

- **Typable duration.** Replace the `DURATIONS` preset chips with one `<input type="number" inputmode="numeric" min="0" step="5">` bound to `dur`, rendered with a trailing `min` label. Empty input ⇒ `0` (cleared). Persists via `onUpdate({ duration_min })` on input. Always visible (a time is always present now, via the prefill default).

- **Default when (prefill, persist on interaction).** For a note with no `due_date`, the fields **display** today (`toDateOnlyStr(new Date())`) and **18:00**; these are display defaults only. State is thereafter user-controlled and is NOT re-derived from `note`. Nothing is persisted on open — the existing `commitWhen`/`onUpdate` handlers already fire only on interaction (`onDate`/`onTime`/`onRepeat`/duration input), so the first interaction composes today+18:00 (or the edited value) and saves. A note that already has a `due_date` initializes from it, unchanged.

- **Clear affordance.** Because the fields are no longer blank, add a small `✕` control on the date/time row. Tapping it sets `dateStr=''`, `timeStr=''` and persists `onUpdate({ due_date: '', repeat: 'none' })` (`''` not `null`, per Slice-A clearing rule); `duration_min` is left untouched. This is the only path to a genuinely date-less note now.

- **Recurrence — inline expand.** Keep the 5 coarse chips (`none/daily/weekly/monthly/yearly`); the selected chip is the `simpleRepeat` label. Sub-controls appear only when a date exists:
  - **Weekly selected** → a weekday row `S M T W T F S` (indices 0–6), highlighting the current `weekly:W`. Tapping a day sets `weekly:W`, runs `snapToRepeat` to move the due date to the next matching weekday, and persists `{ due_date, repeat }` together.
  - **Monthly selected** → a row with **`Day N`** (N = the due date's day-of-month → `monthly:day:N`, no snap needed) and **`Nth weekday ▸`** showing `monthlyDescriptor` of the current value when it is an nth form. Tapping `Nth weekday` expands a further row: **which** (`1st 2nd 3rd 4th`) and **weekday** (`S..S`). A local draft `{ n, w }` (seeded from the current `monthly:nth:N:W`) commits `monthly:nth:N:W` + `snapToRepeat` as soon as both are chosen; changing either re-commits.
  - Authoring set matches web exactly (Day-N + Nth 1st–4th); `monthly:last` is read/preserved but not authored.
  - Chip and sub-control gating (cursor/opacity **and** the `onClick` handler) stays on `dateStr || r === 'none'`, per final-review #3.

### 3. Global — `mobile/www/index.html`

Add to the `<style>` block:
- `* { -webkit-tap-highlight-color: transparent; }` — kills the rectangular tap flash in the Android WebView.
- `user-select: none` on the tappable chip elements (or a shared class) so a long-press doesn't select their text.

### 4. Build

Rebuild `mobile/www/js/app.js` (tracked artifact) via `cd mobile && node build.mjs`; stage it with the source. No backend files change.

## Data Flow

`note.due_date` / `note.repeat` / `note.duration_min` → Detail initializes `dateStr`/`timeStr` (with prefill fallback), `rep`/`rep0`/`repeat0`, `dur` → user edits → `commitWhen` composes `due_date` (`composeWhen`, `""` on clear) and re-derives/preserves `repeat` (with `snapToRepeat` for weekly/monthly picks) → `onUpdate({ due_date, repeat })` / `onUpdate({ duration_min })` → serialized `store.update` → sync engine → web renders the deadline (🔔 bell + date/time) and recurrence label (`_formatRepeatLabel`).

## Error / Edge Handling

- Clearing: `✕` → `due_date=''`, `repeat='none'`; empty duration → `0`. Both non-`null` (backend `update_note_record` skips `None`).
- `snapToRepeat` returns `null` for daily/yearly/none → due date left unchanged.
- Picking a recurrence while the date field shows a prefill-but-unsaved default persists today+18:00 as the due (interaction ⇒ save), which is the intended way to set a recurring task from a fresh note.
- Preserve web-authored `monthly:nth`/`monthly:last` on unrelated date/time edits (existing `rep0`/`repeat0` guard) — a user who never opens the monthly sub-controls never downgrades the stored form.

## Testing

- **Engine:** `recurrence.test.ts` gains `snapToRepeat`, `monthlyDescriptor`, and the weekly off-weekday `expandOccurrences` cases (pure, vitest). Existing datetime/recurrence/tasks/subtasks/nav suites stay green.
- **Detail:** no unit-test harness (Preact component), consistent with Slice A — verified via `tsc --noEmit`, `node build.mjs`, the full mobile suite, and the on-device proof.

### On-device proof (acceptance criteria)

1. **Deadline sync (user's criterion):** set **today 18:30** on mobile → on `chat.elsiga.ch` the task shows the 🔔 bell with **today 18:30**.
2. **Weekly:** set Repeat = Weekly, pick **Monday** while the date is a Wednesday → the due date snaps to the next Monday; web shows "Weekly on Mondays ↻".
3. **Monthly Nth:** set Repeat = Monthly → Nth weekday → **2nd / Tuesday** → web shows "Monthly on 2nd Tuesday".
4. **Duration:** type a custom minute value (e.g. 37) → reopen: persists.
5. **Default prefill:** open a task with no date → fields show today / 18:00; leave without touching them → task still has no due; touch a field/chip → the due persists.
6. **Clear:** `✕` removes the due entirely (no date on reopen and on web).
7. **Polish:** calendar/clock icons present; no rectangular tap-flash on any chip.
