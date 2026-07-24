# Mobile Calendar — Slice B: Day View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the mobile Day view — a scrollable full-day timeline that places timed tasks as duration blocks (lane-packed for overlaps), shows all-day tasks in a top strip, expands recurrences onto the right day, auto-scrolls to now with earlier hours faded, and opens the existing Detail editor on tap — plus the pure `calendar.ts` data module that Week/Month (next slice) will reuse.

**Architecture:** One pure, fully-tested data module (`calendar.ts`: `dayOccurrences` + `packLanes`) built on the existing `recurrence.ts`/`datetime.ts`; a new `Day.ts` Preact/HTM screen that converts its minutes+lanes output to pixels; a new `day` route + a Home entry point. No backend change — notes already sync offline-first.

**Tech Stack:** TypeScript + Preact/HTM + esbuild (mobile), vitest; Capacitor Android WebView.

Design: `docs/superpowers/specs/2026-07-24-mobile-calendar-slice-b-day-view-design.md`

## Global Constraints

- **Mobile-only.** Touch only `mobile/src/calendar.ts`, `mobile/src/calendar.test.ts`, `mobile/src/nav.ts`, `mobile/src/nav.test.ts`, `mobile/src/screens/Day.ts`, `mobile/src/main.ts`, `mobile/src/screens/Home.ts`, `mobile/www/js/app.js`, and `docs/productivity/mobile-build.md`. **NO backend change**; do NOT touch `sync-engine/`, `static/` (web), `parseCapture`, `core/`, `routes/`, or the existing `recurrence.ts`/`datetime.ts`.
- **NO JSX** — `html` tagged templates only; hooks come from `./html` (which re-exports `useState`/`useEffect`/`useRef`).
- **Read + open only:** tap a block/all-day chip → the existing Detail editor via the existing `openDetail` path. No drag-to-reschedule, no tap-slot-to-create, no store change.
- **Calendar data is pure + unit-agnostic:** `calendar.ts` returns minutes + lanes; `Day.ts` converts to pixels. `calendar.ts` imports only from `./recurrence`, `./datetime`, `./notes` (types) — no DOM, no Capacitor.
- **Non-recurring notes are matched by exact local date string** (`datePart(due_date) === targetDate`) — do NOT round-trip them through `expandOccurrences` (its date-only anchors parse as UTC and would shift across the day boundary). Only recurring notes use `expandOccurrences` over a widened range, then filter by `datePart`.
- **Notes without a `due_date` never appear on the calendar.** Timed task with no `duration_min` → `DEFAULT_DURATION_MIN`. A block is clamped at `endMin = 1440` (midnight).
- **`mobile/www/js/app.js` is the tracked built artifact** — after editing `mobile/src/**`, run `cd mobile && node build.mjs` and stage the regenerated `app.js` in that task's commit.
- **Stage EXPLICIT paths only** — never `git add -A` (untracked `design/` must never be staged; `dist/odysseus.apk` is gitignored).
- **`week`/`month` pills are rendered but inert this slice** (wired live when the next slice adds those views).
- Build/test: mobile unit `cd mobile && npx vitest run src/<file>.test.ts`; full suite `cd mobile && npx vitest run`; typecheck `cd mobile && npx tsc --noEmit`; bundle `cd mobile && node build.mjs`; APK `bash mobile/build-apk.sh`.

---

### Task 1: Pure calendar data module — `calendar.ts`

**Files:**
- Create: `mobile/src/calendar.ts`
- Create: `mobile/src/calendar.test.ts`

(No `app.js` rebuild — imported at runtime first by `Day.ts` in Task 3, which rebuilds.)

**Interfaces:**
- Consumes: `expandOccurrences` from `./recurrence`; `hasTimeComponent`, `datePart`, `timePart`, `toDateOnlyStr` from `./datetime`; `NoteRec` type from `./notes`.
- Produces:
  - `DEFAULT_DURATION_MIN: number`
  - `interface DayOcc { noteId; title; done; recurring; startMin: number|null; durationMin }`
  - `interface TimedOcc extends DayOcc { startMin: number; endMin; lane; laneCount }`
  - `packLanes(occs: TimedOcc[]): TimedOcc[]`
  - `dayOccurrences(notes: NoteRec[], date: Date): { allDay: DayOcc[]; timed: TimedOcc[] }`
  Consumed by `Day.ts` (Task 3) and, next slice, Week/Month.

- [ ] **Step 1: Write the failing tests**

Create `mobile/src/calendar.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dayOccurrences, packLanes, DEFAULT_DURATION_MIN, type TimedOcc } from './calendar'
import type { NoteRec } from './notes'

const note = (o: Partial<NoteRec>): NoteRec => ({ id: 'x', title: 'T', ...o } as NoteRec)
const t = (startMin: number, endMin: number): TimedOcc =>
  ({ noteId: 'n', title: 'T', done: false, recurring: false, startMin, endMin, durationMin: endMin - startMin, lane: 0, laneCount: 1 })
const D = (s: string) => new Date(s)

describe('packLanes', () => {
  it('empty → empty', () => { expect(packLanes([])).toEqual([]) })
  it('single → lane 0 of 1', () => {
    const [o] = packLanes([t(600, 630)]); expect([o.lane, o.laneCount]).toEqual([0, 1])
  })
  it('non-overlapping → same lane, count 1', () => {
    const r = packLanes([t(600, 630), t(660, 690)])
    expect(r.map(o => [o.lane, o.laneCount])).toEqual([[0, 1], [0, 1]])
  })
  it('overlapping → adjacent lanes, count 2', () => {
    const r = packLanes([t(600, 660), t(630, 690)])
    expect(r.map(o => [o.lane, o.laneCount])).toEqual([[0, 2], [1, 2]])
  })
  it('two overlap as a cluster, a third stands alone', () => {
    const r = packLanes([t(540, 600), t(570, 630), t(645, 660)])
    expect(r.map(o => [o.lane, o.laneCount])).toEqual([[0, 2], [1, 2], [0, 1]])
  })
})

describe('dayOccurrences', () => {
  it('places a timed note with explicit duration', () => {
    const { timed, allDay } = dayOccurrences([note({ id: 'a', due_date: '2026-07-24T09:00', duration_min: 45 })], D('2026-07-24T12:00'))
    expect(allDay).toEqual([])
    expect(timed).toHaveLength(1)
    expect([timed[0].startMin, timed[0].endMin, timed[0].noteId]).toEqual([540, 585, 'a'])
  })
  it('defaults duration when none set', () => {
    const { timed } = dayOccurrences([note({ id: 'a', due_date: '2026-07-24T09:00' })], D('2026-07-24T12:00'))
    expect(timed[0].endMin).toBe(540 + DEFAULT_DURATION_MIN)
  })
  it('clamps a block at midnight', () => {
    const { timed } = dayOccurrences([note({ id: 'a', due_date: '2026-07-24T23:30', duration_min: 60 })], D('2026-07-24T12:00'))
    expect(timed[0].endMin).toBe(1440)
  })
  it('puts an all-day note in the strip', () => {
    const { allDay, timed } = dayOccurrences([note({ id: 'a', due_date: '2026-07-24' })], D('2026-07-24T12:00'))
    expect(timed).toEqual([])
    expect(allDay.map(o => o.noteId)).toEqual(['a'])
    expect(allDay[0].startMin).toBeNull()
  })
  it('skips notes on other days and notes without a due date', () => {
    const notes = [note({ id: 'a', due_date: '2026-07-25T09:00' }), note({ id: 'b' })]
    const { timed, allDay } = dayOccurrences(notes, D('2026-07-24T12:00'))
    expect(timed).toEqual([]); expect(allDay).toEqual([])
  })
  it('expands a daily recurrence onto the target day', () => {
    const { timed } = dayOccurrences([note({ id: 'a', due_date: '2026-07-01T08:00', repeat: 'daily' })], D('2026-07-24T12:00'))
    expect(timed).toHaveLength(1); expect(timed[0].startMin).toBe(480)
  })
  it('shows a weekly recurrence only on matching weekdays', () => {
    // 2026-07-24 is a Friday (getDay 5): weekly:5 matches, weekly:1 does not
    const fri = dayOccurrences([note({ id: 'a', due_date: '2026-07-24T08:00', repeat: 'weekly:5' })], D('2026-07-24T12:00'))
    const mon = dayOccurrences([note({ id: 'a', due_date: '2026-07-24T08:00', repeat: 'weekly:1' })], D('2026-07-24T12:00'))
    expect(fri.timed).toHaveLength(1); expect(mon.timed).toHaveLength(0)
  })
  it('marks recurring occurrences', () => {
    const { timed } = dayOccurrences([note({ id: 'a', due_date: '2026-07-24T08:00', repeat: 'daily' })], D('2026-07-24T12:00'))
    expect(timed[0].recurring).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && npx vitest run src/calendar.test.ts`
Expected: FAIL — `./calendar` module does not exist yet.

- [ ] **Step 3: Implement `calendar.ts`**

Create `mobile/src/calendar.ts`:

```ts
// Pure calendar data layer: turns synced notes into per-day occurrences the
// views render. Unit-agnostic (minutes + lanes); screens convert to pixels.
// Depends only on the tested recurrence + datetime modules — no backend, no DOM.
import { expandOccurrences } from './recurrence'
import { hasTimeComponent, datePart, timePart, toDateOnlyStr } from './datetime'
import type { NoteRec } from './notes'

// A timed task with no explicit duration still needs a tappable block.
export const DEFAULT_DURATION_MIN = 30

export interface DayOcc {
  noteId: string
  title: string
  done: boolean
  recurring: boolean
  startMin: number | null   // minutes from local midnight; null = all-day
  durationMin: number       // 0 for all-day
}
export interface TimedOcc extends DayOcc {
  startMin: number
  endMin: number
  lane: number
  laneCount: number
}

// Greedy column packing: each occurrence takes the first lane free at its start;
// then each overlap cluster's blocks all take that cluster's lane count.
export function packLanes(occs: TimedOcc[]): TimedOcc[] {
  const sorted = [...occs].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const laneEnds: number[] = []              // last endMin per lane
  for (const o of sorted) {
    let lane = laneEnds.findIndex(end => end <= o.startMin)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(o.endMin) }
    else laneEnds[lane] = o.endMin
    o.lane = lane
  }
  let i = 0
  while (i < sorted.length) {
    let j = i, maxEnd = sorted[i].endMin, maxLane = sorted[i].lane
    while (j + 1 < sorted.length && sorted[j + 1].startMin < maxEnd) {
      j++; maxEnd = Math.max(maxEnd, sorted[j].endMin); maxLane = Math.max(maxLane, sorted[j].lane)
    }
    const laneCount = maxLane + 1
    for (let k = i; k <= j; k++) sorted[k].laneCount = laneCount
    i = j + 1
  }
  return sorted
}

export function dayOccurrences(notes: NoteRec[], date: Date): { allDay: DayOcc[]; timed: TimedOcc[] } {
  const target = toDateOnlyStr(date)
  // Recurring notes only: widen ±1 day then filter by exact local date, so a
  // date-only anchor that expandOccurrences parses as UTC still lands right.
  const lo = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 0, 0, 0, 0)
  const hi = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 23, 59, 59, 999)
  const allDay: DayOcc[] = []
  const timed: TimedOcc[] = []
  for (const n of notes) {
    if (!n.due_date) continue
    const recurring = !!n.repeat && n.repeat !== 'none'
    // Non-recurring: exact date-string match (timezone-proof, no Date parse).
    const occs = recurring
      ? expandOccurrences(n.due_date, n.repeat, lo, hi).filter(o => datePart(o) === target)
      : (datePart(n.due_date) === target ? [n.due_date] : [])
    for (const occ of occs) {
      const base = { noteId: n.id, title: n.title || '', done: !!n.done, recurring }
      if (!hasTimeComponent(occ)) { allDay.push({ ...base, startMin: null, durationMin: 0 }); continue }
      const hm = timePart(occ)                 // "HH:MM"
      const startMin = (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5))
      const durationMin = n.duration_min || DEFAULT_DURATION_MIN
      const endMin = Math.min(startMin + durationMin, 1440)
      timed.push({ ...base, startMin, durationMin, endMin, lane: 0, laneCount: 1 })
    }
  }
  return { allDay, timed: packLanes(timed) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && npx vitest run src/calendar.test.ts`
Expected: PASS — all packLanes + dayOccurrences cases green.

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/calendar.ts mobile/src/calendar.test.ts
git commit -m "feat(mobile): calendar.ts pure data module — dayOccurrences + lane packing"
```

---

### Task 2: `day` route

**Files:**
- Modify: `mobile/src/nav.ts` (`Route` union + `routeKey`)
- Modify: `mobile/src/nav.test.ts` (append cases)

(No `app.js` rebuild — `main.ts` wires the route in Task 3, which rebuilds.)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Route` gains `{ name: 'day'; date?: string }`; `routeKey` returns `day:${date ?? ''}`. Consumed by `main.ts` (Task 3).

- [ ] **Step 1: Write the failing tests**

In `mobile/src/nav.test.ts`, append at the end of the file (after the last `describe`'s closing `})`):

```ts
describe('day route', () => {
  it('key is stable and param-aware', () => {
    expect(routeKey({ name: 'day' })).toBe('day:')
    expect(routeKey({ name: 'day', date: '2026-07-24' })).toBe('day:2026-07-24')
    expect(routeKey({ name: 'day', date: '2026-07-24' })).not.toBe(routeKey({ name: 'day' }))
  })
  it('pushRoute unwinds to an existing day entry', () => {
    const day: Route = { name: 'day' }
    expect(pushRoute([home, day, { name: 'detail', id: '1' }], day)).toEqual([home, day])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && npx vitest run src/nav.test.ts`
Expected: FAIL — `routeKey`/`Route` don't handle `'day'` yet (a TS error on the `{ name: 'day' }` literal and/or a wrong key).

- [ ] **Step 3: Add the route to the union**

In `mobile/src/nav.ts`, change the `Route` union:

```ts
export type Route =
  | { name: 'home' }
  | { name: 'capture'; project?: string }
  | { name: 'library' }
  | { name: 'project'; project: string }
  | { name: 'detail'; id: string }
```

to add the `day` case:

```ts
export type Route =
  | { name: 'home' }
  | { name: 'capture'; project?: string }
  | { name: 'library' }
  | { name: 'project'; project: string }
  | { name: 'detail'; id: string }
  | { name: 'day'; date?: string }
```

- [ ] **Step 4: Add the routeKey case**

In `mobile/src/nav.ts`, in `routeKey`, add the `day` case alongside the others (before `default`):

```ts
    case 'detail': return `detail:${r.id}`
    case 'day': return `day:${r.date ?? ''}`
    default: return r.name
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd mobile && npx vitest run src/nav.test.ts`
Expected: PASS — the new `day` cases + all pre-existing nav cases green.

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/nav.ts mobile/src/nav.test.ts
git commit -m "feat(mobile): add day route to the nav stack"
```

---

### Task 3: Day view screen + wiring

**Files:**
- Create: `mobile/src/screens/Day.ts`
- Modify: `mobile/src/main.ts` (import + render the `day` route; pass `onDay` to Home)
- Modify: `mobile/src/screens/Home.ts` (add `onDay` prop + a "calendar →" entry chip)
- Regenerate: `mobile/www/js/app.js`

**Interfaces:**
- Consumes: `dayOccurrences` from `../calendar`; `toDateOnlyStr` from `../datetime`; `NoteRec`; the existing `openDetail`/`navigate` in `main.ts`.
- Produces: `Day({ notes, onOpen, onHome, initialDate })`. No new exported data interface.

- [ ] **Step 1: Create the Day view**

Create `mobile/src/screens/Day.ts`:

```ts
import { html, useState, useEffect, useRef } from '../html'
import { theme as T } from '../theme'
import { dayOccurrences } from '../calendar'
import { toDateOnlyStr } from '../datetime'
import type { NoteRec } from '../notes'

const HOUR_PX = 56
const PX_PER_MIN = HOUR_PX / 60
const MIN_BLOCK_PX = 30
const GUTTER = 52          // left space for hour labels
const GAP = 4

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

export function Day({ notes, onOpen, onHome, initialDate }:
  { notes: NoteRec[]; onOpen: (n: NoteRec) => void; onHome: () => void; initialDate?: string }) {
  const [viewDate, setViewDate] = useState<Date>(() => initialDate ? new Date(`${initialDate}T00:00`) : new Date())
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const now = new Date()
  const isToday = toDateOnlyStr(viewDate) === toDateOnlyStr(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const { allDay, timed } = dayOccurrences(notes, viewDate)

  // Auto-scroll to ~now (today) or ~08:00 otherwise, once per viewDate.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const focusMin = isToday ? nowMin : 8 * 60
    el.scrollTop = Math.max(0, focusMin * PX_PER_MIN - 120)
  }, [toDateOnlyStr(viewDate)])

  const stepDay = (delta: number) => setViewDate(d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta))
  const open = (noteId: string) => { const n = notes.find(x => x.id === noteId); if (n) onOpen(n) }
  const title = isToday ? "Today's shape" : viewDate.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })

  const pill = (label: string, active: boolean, inert: boolean) => html`
    <span style=${{ padding: '8px 16px', borderRadius: '999px', userSelect: 'none',
      border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : T.card2}`,
      background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
      font: `${active ? 500 : 400} 12.5px ${T.mono}`,
      color: active ? T.accent : T.muted, opacity: inert ? 0.4 : 1, cursor: inert ? 'default' : 'pointer' }}>${label}</span>`

  return html`
    <div style=${{ height: '100vh', display: 'flex', flexDirection: 'column', gap: '12px', padding: '26px 20px 8px', boxSizing: 'border-box' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 21px ${T.mono}` }}>${title}</span>
        <span onClick=${onHome} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '6px' }}>← home</span>
      </div>

      <div style=${{ display: 'flex', gap: '8px', alignItems: 'center', padding: '0 2px' }}>
        ${pill('day', true, false)}
        ${pill('week', false, true)}
        ${pill('month', false, true)}
        <div style=${{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span onClick=${() => stepDay(-1)} style=${{ font: `400 17px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '2px 8px' }}>‹</span>
          <span onClick=${() => setViewDate(new Date())} style=${{ font: `400 12.5px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '2px 6px' }}>today</span>
          <span onClick=${() => stepDay(1)} style=${{ font: `400 17px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '2px 8px' }}>›</span>
        </div>
      </div>

      ${allDay.length ? html`
        <div style=${{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '0 2px' }}>
          ${allDay.map(o => html`
            <span key=${o.noteId} onClick=${() => open(o.noteId)}
              style=${{ padding: '6px 12px', borderRadius: '999px', background: T.card, border: `1px solid ${T.border}`,
                font: `400 12.5px ${T.mono}`, color: o.done ? T.muted : T.text, cursor: 'pointer', userSelect: 'none',
                textDecoration: o.done ? 'line-through' : 'none' }}>${o.recurring ? '↻ ' : ''}${o.title || 'Untitled'}</span>`)}
        </div>` : ''}

      <div ref=${scrollRef} style=${{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div style=${{ position: 'relative', height: `${24 * HOUR_PX}px` }}>
          ${Array.from({ length: 24 }, (_, h) => html`
            <div key=${'r' + h} style=${{ position: 'absolute', top: `${h * HOUR_PX}px`, left: `${GUTTER}px`, right: 0, height: '1px', background: T.card2 }}></div>
            <div key=${'l' + h} style=${{ position: 'absolute', top: `${h * HOUR_PX - 6}px`, left: 0, width: `${GUTTER - 8}px`,
              textAlign: 'right', font: `400 11px ${T.mono}`, color: T.muted }}>${h === 0 ? '' : hhmm(h * 60)}</div>`)}

          ${timed.map(o => html`
            <div key=${o.noteId + ':' + o.startMin} onClick=${() => open(o.noteId)}
              style=${{ position: 'absolute', top: `${o.startMin * PX_PER_MIN}px`,
                height: `${Math.max((o.endMin - o.startMin) * PX_PER_MIN, MIN_BLOCK_PX)}px`,
                left: `calc(${GUTTER}px + ${o.lane} * (100% - ${GUTTER}px) / ${o.laneCount})`,
                width: `calc((100% - ${GUTTER}px) / ${o.laneCount} - ${GAP}px)`,
                background: T.card, border: `1px solid ${o.done ? T.border : T.accent}`, borderRadius: '10px',
                padding: '6px 9px', boxSizing: 'border-box', overflow: 'hidden', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style=${{ font: `600 12.5px ${T.mono}`, color: o.done ? T.muted : T.text,
                textDecoration: o.done ? 'line-through' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ${o.recurring ? '↻ ' : ''}${o.title || 'Untitled'}</span>
              <span style=${{ font: `400 10.5px ${T.mono}`, color: T.muted }}>${hhmm(o.startMin)}–${hhmm(o.endMin)}</span>
            </div>`)}

          ${isToday ? html`
            <div style=${{ position: 'absolute', top: 0, left: 0, right: 0, height: `${nowMin * PX_PER_MIN}px`,
              background: T.bg, opacity: 0.55, pointerEvents: 'none' }}></div>
            <div style=${{ position: 'absolute', top: `${nowMin * PX_PER_MIN}px`, left: `${GUTTER}px`, right: 0, height: '1px', background: T.accent }}></div>
            <div style=${{ position: 'absolute', top: `${nowMin * PX_PER_MIN - 6}px`, left: 0, width: `${GUTTER - 6}px`, textAlign: 'right',
              font: `400 10px ${T.mono}`, color: T.accent }}>${hhmm(nowMin)}</div>` : ''}

          ${!allDay.length && !timed.length ? html`
            <div style=${{ position: 'absolute', top: '38%', left: 0, right: 0, textAlign: 'center',
              font: `italic 400 13px ${T.mono}`, color: T.muted }}>nothing scheduled</div>` : ''}
        </div>
      </div>
    </div>`
}
```

- [ ] **Step 2: Wire the `day` route in `main.ts`**

In `mobile/src/main.ts`, add the import after the other screen imports (after `import { Detail } from './screens/Detail'`):

```ts
import { Day } from './screens/Day'
```

Then add the `day` route render — insert it immediately before the final `return html\`<p style="padding:24px">…</p>\`` fallback line at the end of `Root()`:

```ts
  if (route.name === 'day')
    return html`<${Day} notes=${store.notes} onOpen=${openDetail}
      onHome=${() => navigate({ name: 'home' })} initialDate=${route.date} />`
```

- [ ] **Step 3: Pass `onDay` to Home in both Home renders**

In `mobile/src/main.ts`, the `home` route render currently is:

```ts
  if (route.name === 'home')
    return html`<${Home} notes=${store.notes} status=${store.status}
      onToggle=${store.toggle} onOpen=${openDetail}
      onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
      onTestReminder=${scheduleTestNotification} />`
```

Add `onDay=${() => navigate({ name: 'day' })}` to it:

```ts
  if (route.name === 'home')
    return html`<${Home} notes=${store.notes} status=${store.status}
      onToggle=${store.toggle} onOpen=${openDetail}
      onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
      onDay=${() => navigate({ name: 'day' })}
      onTestReminder=${scheduleTestNotification} />`
```

And the `capture` route render (which also renders `Home` as the backdrop) currently is:

```ts
      <${Home} notes=${store.notes} status=${store.status} onToggle=${store.toggle} onOpen=${openDetail}
        onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
        onTestReminder=${scheduleTestNotification} />
```

Add the same prop:

```ts
      <${Home} notes=${store.notes} status=${store.status} onToggle=${store.toggle} onOpen=${openDetail}
        onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
        onDay=${() => navigate({ name: 'day' })}
        onTestReminder=${scheduleTestNotification} />
```

- [ ] **Step 4: Add the `onDay` prop + entry chip to Home**

In `mobile/src/screens/Home.ts`, change the props destructure + type (currently):

```ts
export function Home({ notes, status, onToggle, onOpen, onCapture, onLibrary, onTestReminder }:
  { notes: NoteRec[]; status: string; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void; onLibrary: () => void; onTestReminder?: () => void }) {
```

to add `onDay`:

```ts
export function Home({ notes, status, onToggle, onOpen, onCapture, onLibrary, onDay, onTestReminder }:
  { notes: NoteRec[]; status: string; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void; onLibrary: () => void; onDay: () => void; onTestReminder?: () => void }) {
```

Then add a "calendar →" chip to the bucket-chips row. Change:

```ts
      <div style=${{ display: 'flex', gap: '8px', padding: '0 2px' }}>
        <${BucketChip} label=${`soon · ${counts.soon}`} onClick=${onLibrary} />
        <${BucketChip} label=${`someday · ${counts.someday}`} onClick=${onLibrary} />
        <${BucketChip} label="projects" onClick=${onLibrary} />
      </div>
```

to:

```ts
      <div style=${{ display: 'flex', gap: '8px', padding: '0 2px', flexWrap: 'wrap' }}>
        <${BucketChip} label=${`soon · ${counts.soon}`} onClick=${onLibrary} />
        <${BucketChip} label=${`someday · ${counts.someday}`} onClick=${onLibrary} />
        <${BucketChip} label="projects" onClick=${onLibrary} />
        <${BucketChip} label="calendar →" onClick=${onDay} />
      </div>
```

- [ ] **Step 5: Typecheck + rebuild the bundle**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean (Day.ts, the new route, and Home's new prop all type-consistent).

Run: `cd mobile && node build.mjs`
Expected: builds `www/js/app.js` (now including `calendar.ts` via `Day.ts`) with no error.

- [ ] **Step 6: Confirm the full mobile suite still passes**

Run: `cd mobile && npx vitest run`
Expected: PASS — `calendar`, `nav` (incl. the new `day` case), `datetime`, `recurrence`, `tasks`, `subtasks` suites all green.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/Day.ts mobile/src/main.ts mobile/src/screens/Home.ts mobile/www/js/app.js
git commit -m "feat(mobile): Day view — scrollable timeline w/ duration blocks, all-day strip, now-line; Home entry"
```

---

### Task 4: APK rebuild + docs + on-device proof

**Files:**
- Modify: `docs/productivity/mobile-build.md`
- Build: `dist/odysseus.apk` (gitignored — NOT committed)

**Interfaces:**
- Consumes: the rebuilt `mobile/www/js/app.js` from Task 3.
- Produces: an installable APK + a documented proof checklist.

- [ ] **Step 1: Rebuild the APK**

Run: `bash mobile/build-apk.sh`
Expected: prints `APK → dist/odysseus.apk (…M)` and exits 0.

- [ ] **Step 2: Verify the Day view + calendar module are packaged**

Run: `grep -c "dayOccurrences\|packLanes" mobile/www/js/app.js`
Expected: ≥ 1 (Day.ts's import pulls `calendar.ts` into the bundle).

Run: `unzip -l dist/odysseus.apk | grep -c "assets/public/js/app.js"`
Expected: `1`.

- [ ] **Step 3: Document the slice + proof steps**

In `docs/productivity/mobile-build.md`, append:

```markdown
## Calendar Slice B — Day view (2026-07-24)

The first calendar view: a scrollable full-day timeline (`mobile/src/screens/Day.ts`) over a pure `mobile/src/calendar.ts` data module (`dayOccurrences` + lane packing). Timed tasks render as duration blocks (overlaps sit side-by-side), all-day tasks in a top strip, recurrences expand onto the right day; the grid auto-scrolls to now with earlier hours faded and a live now-line. Reached from Home's "calendar →" chip; tap a block → the Detail editor. Week + Month are the next slice (their pills render but are inert). **No backend change** — no server redeploy for this slice.

### On-device proof (PENDING)
1. `adb install -r dist/odysseus.apk`. From Home, tap **calendar →** → the Day view opens, auto-scrolled to now, earlier hours faded, a now-line at the current time.
2. A task due today at a set time + duration shows as a block of the right height/position; two overlapping tasks sit side-by-side.
3. A timed task with no duration still shows a tappable default-height block.
4. An all-day-dated task shows in the top strip.
5. A weekly/monthly recurring task appears on today when today is an occurrence (and not otherwise).
6. Tap a block → Detail opens for that task; hardware back returns to the Day view.
7. `‹ / ›` move to adjacent days (no now-line/fade off today); `today` returns.
8. `week` / `month` pills are visibly present but inert.
```

- [ ] **Step 4: Commit**

```bash
git add docs/productivity/mobile-build.md
git commit -m "docs(mobile): calendar Slice B (Day view) build + on-device proof steps"
```

---

## Self-Review

**Spec coverage:**
- Pure `calendar.ts` (`dayOccurrences` + `packLanes`, recurrence expansion, all-day/timed split, default duration, midnight clamp) → Task 1. ✓
- `day` route + Home entry → Task 2 (route) + Task 3 (Home chip + main wiring). ✓
- Day view: scrollable 24h grid, auto-scroll to now, past-faded scrim, now-line, all-day strip, duration blocks w/ lane packing, `↻`/done styling, `‹ today ›` nav, inert week/month pills, tap→Detail → Task 3. ✓
- Read + open only; no store change; notes without due_date excluded → Tasks 1 & 3. ✓
- Timezone-proof non-recurring matching (date-string compare); recurring via widen-then-filter → Task 1 (`dayOccurrences`). ✓
- Deferred (Stats/⚙/AI/focused-dots/external cal/drag/create) → none built. ✓
- APK + docs + proof → Task 4. ✓

**Placeholder scan:** none. Every code step ships complete code; every command states its expected result.

**Type consistency:** `DayOcc`/`TimedOcc` defined in Task 1 and consumed by `Day.ts` (Task 3) via `dayOccurrences`. `packLanes(TimedOcc[]) → TimedOcc[]` and `dayOccurrences(NoteRec[], Date) → { allDay: DayOcc[]; timed: TimedOcc[] }` used verbatim. `Route` gains `{ name: 'day'; date?: string }` (Task 2), constructed in `main.ts` as `{ name: 'day' }` / read as `route.date` (Task 3). `Day` props `{ notes, onOpen, onHome, initialDate }` match the `main.ts` call site. `Home` gains `onDay: () => void`, wired in both `main.ts` Home renders. `DEFAULT_DURATION_MIN` is the shared default. Day-view layout constants (`HOUR_PX`, `PX_PER_MIN`, `MIN_BLOCK_PX`, `GUTTER`, `GAP`) are local to `Day.ts`.
```