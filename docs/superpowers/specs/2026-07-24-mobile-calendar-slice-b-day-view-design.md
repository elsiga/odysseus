# Mobile Calendar — Slice B: Day View — Design

**Status:** Approved (2026-07-24). Build in a fresh SDD session **after the user updates the design prototype** (`design/Tasks + Calendar Prototype.dc.html`).

**Predecessors:** Slice A ("make dates real") + Slice A.1 ("recurrence authoring + when-block polish") — both built, reviewed, and merged to `dev` at `e64182f`. Those shipped `Note.duration_min`, `mobile/src/datetime.ts`, and `mobile/src/recurrence.ts` (full web-parity grammar + `expandOccurrences(dueDate, repeat, rangeStart, rangeEnd)` range enumeration). This slice renders that data.

## Goal

Ship the first calendar **view** — a Day view — on the mobile task app: a scrollable full-day timeline that places timed tasks as duration blocks, shows all-day tasks in a top strip, expands recurrences onto the right day, auto-positions to "now" with earlier hours faded, and opens the existing Detail editor on tap. Introduce the pure `calendar.ts` data module that Week and Month (the next slice) will reuse.

## Scope Decisions (user-approved)

- **Day view first.** Week + Month are the immediate next slice, built on the same `calendar.ts` module.
- **Day time model:** a **scrollable full-day grid (00:00–24:00)** that **auto-scrolls to ~now on mount**; when viewing **today**, hours before now are **faded** (a scrim over the past region). (This supersedes the prototype's evening-only mock — the user will update the prototype.)
- **Interaction:** **read + open** — tap a block → the existing Detail editor. Creation stays in Capture. **No drag-to-reschedule, no tap-empty-slot-to-create** this slice.
- **All-day / untimed tasks** go in a **top strip**; notes with **no `due_date`** do not appear on the calendar (they live in Home/Library).
- **Deferred to future slices:** Stats view, ⚙ calendar-settings, AI "plan my evening" + free-gap suggestions, "focused that day" month dots (needs focus/pomodoro data), external-calendar events, drag-to-reschedule, tap-slot-to-create.

## Architecture

Three mobile files; **no backend change** (notes already sync offline-first).

### 1. Pure data module — `mobile/src/calendar.ts` (+ `calendar.test.ts`)

The keystone. Depends only on `expandOccurrences` (recurrence.ts) and `hasTimeComponent`/`datePart`/`timePart`/`toDateOnlyStr` (datetime.ts). Unit-agnostic (minutes + lanes) — the view converts to pixels.

Types:

```ts
export interface DayOcc {
  noteId: string
  title: string
  done: boolean
  recurring: boolean
  startMin: number | null   // minutes from local midnight; null = all-day
  durationMin: number       // 0 for all-day
}
export interface TimedOcc extends DayOcc {
  startMin: number          // non-null
  endMin: number            // startMin + effective duration, clamped to 1440
  lane: number              // 0-based column within its overlap cluster
  laneCount: number         // columns in that cluster
}
```

Exports:

- **`dayOccurrences(notes, date): { allDay: DayOcc[]; timed: TimedOcc[] }`** — for each note with a `due_date`, enumerate occurrences with `expandOccurrences(due_date, repeat, rangeStart, rangeEnd)` over a range **widened to date ± 1 day** and then **filter by exact local date string** (`datePart(occ) === toDateOnlyStr(date)`). Widen-then-filter deliberately sidesteps `expandOccurrences`'s UTC-parse of date-only anchors at the day boundary, so an all-day note lands on its intended local day regardless of timezone — the engine stays untouched. All-day occurrences (`!hasTimeComponent`) → `allDay` with `startMin: null`, `durationMin: 0`. Timed occurrences → `startMin` from `timePart`, `durationMin = note.duration_min || DEFAULT_DURATION_MIN` (a shared default so a timed task with no explicit duration still renders a tappable block), `endMin = min(startMin + durationMin, 1440)`. `recurring = !!note.repeat && note.repeat !== 'none'`. The `timed` list is returned already lane-packed via `packLanes`.

- **`packLanes(occs): TimedOcc[]`** — greedy column packing for overlapping blocks: sort by `startMin` then `endMin`; assign each occurrence the first lane whose last block ends `<= startMin` (else a new lane); then per overlap **cluster** (a maximal run where each block starts before the running max `endMin`), set every block's `laneCount` to that cluster's lane count. Non-overlapping blocks get `lane 0, laneCount 1`.

Tested thoroughly: bucketing (timed vs all-day split), recurrence expansion onto a target day (daily/weekly/monthly land on the right day; a non-matching day yields nothing), the widen-then-filter day-boundary behavior, default-duration fallback, `endMin` clamping at midnight, and lane packing (none/two-overlap/three-with-one-separate/nested).

### 2. Day view — `mobile/src/screens/Day.ts`

A Preact/HTM component (NO JSX). Props: `{ notes: NoteRec[]; onOpen: (n: NoteRec) => void; onHome: () => void; initialDate?: string }`.

- **State:** `viewDate` (local `useState`, seeded from `initialDate ?? today`); `‹ today ›` controls step it ±1 day / reset to today.
- **Layout constants:** `HOUR_PX` (e.g. 56) → `pxPerMin = HOUR_PX/60`; grid height `24 * HOUR_PX`.
- **Header:** title (`Today's shape` when viewDate is today, else the date) + `← home`; a pill row `day` (active) / `week` · `month` (dimmed + inert this slice — wired live when the next slice lands); `‹ today ›` day nav.
- **All-day strip:** the `allDay` occurrences as a small wrapping row of chips above the scroll area; tap → `onOpen`.
- **Scroll body:** a `position: relative` grid of height `24*HOUR_PX` inside an `overflow-y: auto` container.
  - Hour rules + labels at `h * HOUR_PX` for h = 0..23.
  - **Now-line** at `nowMin * pxPerMin` + a `now · HH:MM` label — only when `viewDate` is today.
  - **Past scrim:** when `viewDate` is today, a semi-transparent overlay from `top: 0` to `nowMin * pxPerMin` fades earlier hours.
  - **Timed blocks:** each `TimedOcc` absolutely positioned — `top = startMin*pxPerMin`, `height = max((endMin-startMin)*pxPerMin, MIN_BLOCK_PX)`, `left = GUTTER + lane*colW`, `width = colW - GAP` where `colW = (100% - GUTTER)/laneCount`. Renders title + `HH:MM–HH:MM`; `done` → struck-through/dimmed; `recurring` → `↻`. Tap → `onOpen(note)` (looked up from `notes` by `noteId`).
  - **Auto-scroll:** on mount (`useEffect` + a scroll-container `useRef`), scroll so the now-line (or ~08:00 for a non-today date) is near the top.
- Empty day → a quiet "nothing scheduled" affordance.

The view resolves a `TimedOcc.noteId` back to its `NoteRec` via `notes.find` before calling `onOpen`, reusing the existing Detail path — no store change.

### 3. Navigation + Home entry

- **`mobile/src/nav.ts`** — add `{ name: 'day'; date?: string }` to the `Route` union; extend `routeKey` (`day:${r.date ?? ''}`). **`mobile/src/nav.test.ts`** gains cases for the new route (key stability, push/unwind).
- **`mobile/src/main.ts`** — import `Day`; render it for `route.name === 'day'` with `notes=${store.notes}`, `onOpen=${openDetail}`, `onHome=${() => navigate({ name: 'home' })}`, `initialDate=${route.date}`. Hardware back already pops via the existing stack.
- **`mobile/src/screens/Home.ts`** — add a `onDay` prop and a "today's shape →" affordance (a header link or a chip) that calls it; `main.ts` wires `onDay=${() => navigate({ name: 'day' })}`. Existing Home props/behavior otherwise unchanged.

### 4. Build

Rebuild `mobile/www/js/app.js` via `cd mobile && node build.mjs`; stage with the source. No backend files change.

## Data Flow

`store.notes` (synced) → `dayOccurrences(notes, viewDate)` → `{ allDay, timed(lane-packed) }` → Day view converts minutes→pixels and renders blocks/strip/now-line → tap → `notes.find(noteId)` → `onOpen` → existing Detail editor → `store.update` → sync.

## Error / Edge Handling

- Notes without `due_date` are skipped (not on the calendar).
- Timed task with no `duration_min` → `DEFAULT_DURATION_MIN` block (still tappable).
- A block running past midnight is clamped at `endMin = 1440` (multi-day spanning is out of scope this slice).
- Recurrence expansion is bounded by `expandOccurrences`'s own guard; the day query is a 3-day window filtered to one local date.
- Non-today dates: no now-line, no past scrim, auto-scroll to a sensible default hour.

## Testing

- **`calendar.test.ts`** (pure, vitest): occurrence bucketing, recurrence-onto-day, widen-then-filter boundary, default-duration, midnight clamp, lane packing.
- **`nav.test.ts`**: the new `day` route.
- **`Day.ts`**: Preact component — no unit harness (consistent with prior slices); verified via `tsc --noEmit`, `node build.mjs`, the full mobile suite, and the on-device proof.

### On-device proof (acceptance)

1. From Home, tap the "today's shape →" affordance → the Day view opens, auto-scrolled to now, earlier hours faded, a now-line at the current time.
2. A task due today at a set time with a duration shows as a block of the right height at the right position; two overlapping tasks sit side-by-side.
3. A task with a time but no duration still shows a tappable default-height block.
4. An all-day-dated task appears in the top strip.
5. A weekly/monthly recurring task shows on today when today is an occurrence (and not when it isn't).
6. Tap a block → the Detail editor opens for that task; back returns to the Day view.
7. `‹ / ›` moves to adjacent days (no now-line/fade off today); `today` returns.
8. `week` / `month` pills are visibly present but inert (wired in the next slice).
