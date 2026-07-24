# Mobile Calendar — Slice A.1: Recurrence Authoring + When-Block Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the mobile Detail "when" block to web-parity recurrence authoring (weekday for weekly; Day-N / Nth-weekday for monthly, with due-date snapping) and polish it — typable duration, prefill-today/18:00, calendar/clock icons, and a global tap-highlight fix.

**Architecture:** All mobile. Two pure additions to the existing `mobile/src/recurrence.ts` engine (`snapToRepeat`, `monthlyDescriptor`) plus a small `expandOccurrences` weekly guard; a full rewrite of the Detail "when" block that stores the recurrence rule *explicitly* (no re-derivation on date/time edit — supersedes Slice A's `rep0`/`repeat0` logic); and a one-line global CSS fix. No backend change — `Note.duration_min` and the full recurrence grammar already exist from Slice A.

**Tech Stack:** TypeScript + Preact/HTM + esbuild (mobile), vitest; Capacitor Android WebView native `<input type="date"|"time"|"number">`.

Design: `docs/superpowers/specs/2026-07-24-mobile-calendar-slice-a1-recurrence-and-when-polish-design.md`

## Global Constraints

- **Mobile-only.** Touch only `mobile/src/recurrence.ts`, `mobile/src/recurrence.test.ts`, `mobile/src/screens/Detail.ts`, `mobile/www/index.html`, `mobile/www/js/app.js`, and `docs/productivity/mobile-build.md`. **NO backend change**; do NOT touch `sync-engine/`, `static/` (web), `parseCapture`, `core/`, or `routes/`.
- **NO JSX** — `html` tagged templates only; hooks come from `./html`.
- **Detail persists via its `onUpdate` prop** (wired to the serialized `store.update` write queue) — never call `notesRepo` directly.
- **`due_date` format (mirror web exactly):** timed = `YYYY-MM-DDTHH:MM` (local, no TZ); all-day = `YYYY-MM-DD`; "has a time" ⇔ `/T\d{2}:\d{2}/`.
- **Clearing persists as a NON-`None` value (Slice-2/A lesson):** clear due date → `""` (composeWhen returns `""`, not null); clear duration → `0`. `update_note_record` skips `None`.
- **Recurrence authoring set = web's exactly:** the UI *writes* `none`/`daily`/`weekly:W`/`monthly:day:N`/`monthly:nth:N:W` (N = 1..4)/`yearly`. The engine still *reads* `monthly:last:W` + legacy bare forms (web/legacy data) but the UI does NOT author `monthly:last`. **Store the explicit rule verbatim (`fullRep`); do NOT re-derive it when the date/time moves.** This supersedes Slice A's date-driven re-derivation and its `rep0`/`repeat0` guard, which Task 3 removes — web-authored `monthly:nth`/`monthly:last` is preserved because `fullRep` is initialized from `normalizeRepeat(note.repeat, …)` and passed through unchanged on date/time edits.
- **Default when:** a note with no `due_date` shows today (`toDateOnlyStr(new Date())`) / `18:00` as *display* values only; nothing persists on open — only an actual interaction (`onDate`/`onTime`/duration/repeat-chip) writes.
- **`mobile/www/js/app.js` is the tracked built artifact** — after editing `mobile/src/**`, run `cd mobile && node build.mjs` and stage the regenerated `app.js` in that task's commit.
- **Stage EXPLICIT paths only** — never `git add -A` (untracked `design/` must never be staged; `dist/odysseus.apk` is gitignored).
- Build/test: mobile unit `cd mobile && npx vitest run src/<file>.test.ts`; full suite `cd mobile && npx vitest run`; typecheck `cd mobile && npx tsc --noEmit`; bundle `cd mobile && node build.mjs`; APK `bash mobile/build-apk.sh`.

---

### Task 1: Engine — `snapToRepeat` + `monthlyDescriptor` + weekly `expandOccurrences` guard

**Files:**
- Modify: `mobile/src/recurrence.ts` (append two exports; add a guard inside `expandOccurrences`)
- Modify: `mobile/src/recurrence.test.ts` (extend the import; append cases)

(No `app.js` rebuild — these symbols are not imported at runtime until Task 3, which rebuilds.)

**Interfaces:**
- Consumes: existing `nthWeekdayOfMonth`, `lastWeekdayOfMonth`, `normalizeRepeat` (already in the file); `toLocalDatetimeStr`/`toDateOnlyStr` from `./datetime`.
- Produces:
  - `snapToRepeat(currentDate: Date, normRepeat: string, now?: Date): Date | null` — snaps a datetime forward to the next slot matching a normalized `weekly:W`/`monthly:day:N`/`monthly:nth:N:W`/`monthly:last:W` rule (preserving time-of-day); `null` for `none`/`daily`/`yearly` or malformed. `now` defaults to `new Date()` (a seam for deterministic tests; web has no such param).
  - `monthlyDescriptor(norm: string): string` — `"Day 24"` / `"2nd Tue"` / `"Last Fri"`; `""` for non-monthly.
  Consumed by Detail (Task 3).

- [ ] **Step 1: Write the failing tests**

In `mobile/src/recurrence.test.ts`, change the import line:

```ts
import { normalizeRepeat, simpleRepeat, expandOccurrences } from './recurrence'
```

to:

```ts
import { normalizeRepeat, simpleRepeat, expandOccurrences, snapToRepeat, monthlyDescriptor } from './recurrence'
```

Then append these `describe` blocks at the end of the file (after the final `})` of the `expandOccurrences` block):

```ts
describe('snapToRepeat', () => {
  it('returns null for none/daily/yearly', () => {
    const d = new Date(2026, 6, 15, 9, 0)
    expect(snapToRepeat(d, 'none')).toBeNull()
    expect(snapToRepeat(d, 'daily')).toBeNull()
    expect(snapToRepeat(d, 'yearly')).toBeNull()
  })

  it('weekly: snaps a future anchor forward to the target weekday, preserving time', () => {
    const cur = new Date(2026, 6, 15, 9, 0)   // Wed 2026-07-15 09:00
    const now = new Date(2026, 6, 13, 0, 0)   // before the anchor
    const s = snapToRepeat(cur, 'weekly:1', now)!  // Monday
    expect([s.getFullYear(), s.getMonth(), s.getDate()]).toEqual([2026, 6, 20]) // next Monday
    expect(s.getDay()).toBe(1)
    expect([s.getHours(), s.getMinutes()]).toEqual([9, 0])
  })

  it('weekly: a matching future anchor stays put', () => {
    const cur = new Date(2026, 6, 15, 9, 0)   // Wed
    const now = new Date(2026, 6, 13, 0, 0)
    const s = snapToRepeat(cur, 'weekly:3', now)! // Wednesday
    expect(s.getDate()).toBe(15)
  })

  it('monthly:day snaps forward to the next matching day, preserving time', () => {
    const cur = new Date(2026, 6, 10, 8, 30)  // 2026-07-10 08:30
    const now = new Date(2026, 6, 20, 0, 0)   // already past day 10 in July
    const s = snapToRepeat(cur, 'monthly:day:10', now)!
    expect([s.getMonth(), s.getDate()]).toEqual([7, 10]) // Aug 10
    expect([s.getHours(), s.getMinutes()]).toEqual([8, 30])
  })

  it('monthly:nth snaps forward to the Nth weekday', () => {
    const cur = new Date(2026, 6, 1, 12, 0)
    const now = new Date(2026, 6, 20, 0, 0)   // past the 2nd Tue of July
    const s = snapToRepeat(cur, 'monthly:nth:2:2', now)! // 2nd Tuesday
    expect([s.getMonth(), s.getDate()]).toEqual([7, 11]) // Aug 11 2026 is the 2nd Tue
    expect(s.getDay()).toBe(2)
  })
})

describe('monthlyDescriptor', () => {
  it('renders day / nth / last and empty for non-monthly', () => {
    expect(monthlyDescriptor('monthly:day:24')).toBe('Day 24')
    expect(monthlyDescriptor('monthly:nth:2:2')).toBe('2nd Tue')
    expect(monthlyDescriptor('monthly:last:5')).toBe('Last Fri')
    expect(monthlyDescriptor('weekly:3')).toBe('')
    expect(monthlyDescriptor('none')).toBe('')
  })
})

describe('expandOccurrences weekly off-weekday guard', () => {
  it('snaps an off-weekday anchor to the target weekday before enumerating', () => {
    // anchor 2026-07-15 is a Wednesday; weekly:1 = Mondays
    const occ = expandOccurrences('2026-07-15', 'weekly:1', new Date('2026-07-15'), new Date('2026-08-05T23:59'))
    expect(occ).toEqual(['2026-07-20', '2026-07-27', '2026-08-03'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && npx vitest run src/recurrence.test.ts`
Expected: the new `snapToRepeat`/`monthlyDescriptor` cases FAIL (imports are `undefined` — not exported yet); the weekly-guard case FAILS (currently emits the raw Wed anchor `2026-07-15` first). Pre-existing cases still pass.

- [ ] **Step 3: Add `snapToRepeat`**

In `mobile/src/recurrence.ts`, append after `expandOccurrences` (end of file). This mirrors web's `_snapToRepeat` (static/js/notes.js:686-739) with an injectable `now` for tests:

```ts
// Snap a chosen datetime FORWARD to the next slot matching a normalized weekly/
// monthly rule, preserving time-of-day. Anchors to `currentDate` when it is in
// the future (so a far-future pick isn't dragged back), else to `now`. Returns
// null for daily/yearly/none. Semantic port of web's _snapToRepeat.
export function snapToRepeat(currentDate: Date, normRepeat: string, now: Date = new Date()): Date | null {
  const hh = currentDate.getHours()
  const mm = currentDate.getMinutes()
  const nowMs = now.getTime()
  const anchor = currentDate.getTime() > nowMs ? currentDate : now
  const parts = normRepeat.split(':')
  const kind = parts[0]
  if (kind === 'weekly') {
    const targetWd = parseInt(parts[1], 10)
    if (isNaN(targetWd)) return null
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), hh, mm, 0, 0)
    const delta = (targetWd - d.getDay() + 7) % 7
    d.setDate(d.getDate() + delta)
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 7)
    return d
  }
  if (kind === 'monthly') {
    const sub = parts[1]
    let y = anchor.getFullYear()
    let m = anchor.getMonth()
    for (let tries = 0; tries < 14; tries++) {
      let target: Date
      if (sub === 'day') {
        const wantDay = parseInt(parts[2], 10)
        if (isNaN(wantDay)) return null
        const lastDay = new Date(y, m + 1, 0).getDate()
        target = new Date(y, m, Math.min(wantDay, lastDay))
      } else if (sub === 'nth') {
        const n = parseInt(parts[2], 10)
        const wd = parseInt(parts[3], 10)
        if (isNaN(n) || isNaN(wd)) return null
        target = nthWeekdayOfMonth(y, m, wd, n)
      } else if (sub === 'last') {
        const wd = parseInt(parts[2], 10)
        if (isNaN(wd)) return null
        target = lastWeekdayOfMonth(y, m, wd)
      } else {
        return null
      }
      target.setHours(hh, mm, 0, 0)
      if (target.getTime() > nowMs && target.getTime() >= anchor.getTime()) return target
      m++
      if (m > 11) { m = 0; y++ }
    }
    return null
  }
  return null
}
```

- [ ] **Step 4: Add `monthlyDescriptor`**

Append after `snapToRepeat` in `mobile/src/recurrence.ts` (mirrors web's `_monthlyShortDescriptor` at static/js/notes.js:3407-3421):

```ts
const _ORDINALS = ['1st', '2nd', '3rd', '4th', '5th']
const _DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Compact label for a normalized monthly rule: "Day 24" / "2nd Tue" / "Last Fri".
// Returns "" for any non-monthly value.
export function monthlyDescriptor(norm: string): string {
  const parts = (norm || '').split(':')
  if (parts[0] !== 'monthly') return ''
  if (parts[1] === 'day') return `Day ${parts[2]}`
  if (parts[1] === 'nth') {
    const n = parseInt(parts[2], 10)
    const wd = parseInt(parts[3], 10)
    return `${_ORDINALS[n - 1] || `${n}th`} ${_DAYS[wd].slice(0, 3)}`
  }
  if (parts[1] === 'last') {
    const wd = parseInt(parts[2], 10)
    return `Last ${_DAYS[wd].slice(0, 3)}`
  }
  return ''
}
```

- [ ] **Step 5: Add the weekly off-weekday guard to `expandOccurrences`**

In `mobile/src/recurrence.ts`, in `expandOccurrences`, find:

```ts
  const hh = anchor.getHours(), mm = anchor.getMinutes()
  let d: Date | null = new Date(anchor)
  let guard = 10000
```

and insert the weekly snap between the `d` declaration and the `guard` line:

```ts
  const hh = anchor.getHours(), mm = anchor.getMinutes()
  let d: Date | null = new Date(anchor)
  // Weekly rules: if the anchor's weekday doesn't match, snap the first emitted
  // occurrence forward to the target weekday (an off-weekday anchor otherwise
  // leaks through as the first item).
  if (/^weekly:/.test(norm)) {
    const twd = parseInt(norm.split(':')[1], 10)
    if (!isNaN(twd) && d.getDay() !== twd) d.setDate(d.getDate() + ((twd - d.getDay() + 7) % 7))
  }
  let guard = 10000
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd mobile && npx vitest run src/recurrence.test.ts`
Expected: PASS — all new + pre-existing recurrence cases green (the existing `weekly:3` case is unaffected because its anchor already matches weekday 3, so `delta === 0`).

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/recurrence.ts mobile/src/recurrence.test.ts
git commit -m "feat(mobile): recurrence snapToRepeat + monthlyDescriptor + weekly expand guard"
```

---

### Task 2: Global tap-highlight fix

**Files:**
- Modify: `mobile/www/index.html` (the `<style>` block)

(No `app.js` rebuild — `index.html` is copied verbatim into the APK by `build-apk.sh`.)

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Add the tap-highlight rule**

In `mobile/www/index.html`, find the universal selector rule inside `<style>`:

```css
    * { box-sizing: border-box; }
```

and replace it with:

```css
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
```

(This removes the grey rectangle the Android WebView flashes on tap. Chip-level `user-select: none` is applied inline in Detail in Task 3.)

- [ ] **Step 2: Sanity-check the HTML**

Run: `node --check mobile/www/index.html 2>/dev/null || echo "not JS (expected)"; grep -n "tap-highlight-color" mobile/www/index.html`
Expected: the `grep` prints the edited line (the `node --check` note is irrelevant — HTML isn't JS).

- [ ] **Step 3: Commit**

```bash
git add mobile/www/index.html
git commit -m "fix(mobile): disable WebView tap-highlight flash globally"
```

---

### Task 3: Detail when-block rewrite (icons · typable duration · prefill+clear · inline recurrence)

**Files:**
- Modify: `mobile/src/screens/Detail.ts` (imports; state + handlers; the "when" render block; two module-level icon consts)
- Regenerate: `mobile/www/js/app.js`

**Interfaces:**
- Consumes: `datePart`, `timePart`, `composeWhen`, `toDateOnlyStr`, `toLocalDatetimeStr` from `../datetime`; `normalizeRepeat`, `simpleRepeat`, `snapToRepeat`, `monthlyDescriptor` from `../recurrence`; `NoteRec.due_date`/`repeat`/`duration_min`.
- Produces: no new exported interface. Persists `{ due_date }` (with `""` on clear), `{ repeat }` (explicit rule verbatim), `{ duration_min }` (0 on clear) through `onUpdate`.

**Note:** this task REMOVES the Slice-A `rep0`/`repeat0` preservation logic and the old `commitWhen`/`DURATIONS`/duration-chip render, replacing them with explicit-rule storage. Web-authored `monthly:nth`/`monthly:last` stays preserved because `fullRep` initializes from `normalizeRepeat(note.repeat, …)` and is passed through unchanged on date/time edits.

- [ ] **Step 1: Update the imports**

In `mobile/src/screens/Detail.ts`, replace these two lines (currently lines 5-6):

```ts
import { datePart, timePart, composeWhen, toDateOnlyStr } from '../datetime'
import { normalizeRepeat, simpleRepeat } from '../recurrence'
```

with:

```ts
import { datePart, timePart, composeWhen, toDateOnlyStr, toLocalDatetimeStr } from '../datetime'
import { normalizeRepeat, simpleRepeat, snapToRepeat, monthlyDescriptor } from '../recurrence'
```

- [ ] **Step 2: Add the two module-level icon constants**

In `mobile/src/screens/Detail.ts`, immediately after the import block (before `export function Detail(`), add:

```ts
const CAL_ICON = html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style=${{ flex: 'none' }}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`
const CLOCK_ICON = html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style=${{ flex: 'none' }}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`
```

- [ ] **Step 3: Replace the "when" state + handlers**

In `mobile/src/screens/Detail.ts`, replace the whole block from `const [dateStr, setDateStr] = useState(datePart(note.due_date))` through the `const onDuration = …` line (currently lines 14-51, i.e. everything from the `dateStr` state down to and including `onDuration`, including the removed `rep0`/`repeat0` consts, the `DURATIONS` const, the old `commitWhen`, `onDate`, `onTime`, `onRepeat`, `onDuration`) with:

```ts
  const initDate = datePart(note.due_date) || toDateOnlyStr(new Date())
  const initTime = timePart(note.due_date) || '18:00'
  const [dateStr, setDateStr] = useState(initDate)
  const [timeStr, setTimeStr] = useState(initTime)
  const [dur, setDur] = useState<number>(note.duration_min ?? 0)
  // The full, normalized recurrence rule (weekly:W / monthly:*), stored verbatim.
  const [fullRep, setFullRep] = useState<string>(
    normalizeRepeat(note.repeat, note.due_date ? new Date(note.due_date) : new Date(`${initDate}T${initTime}`)))
  const [rep, setRep] = useState<string>(simpleRepeat(note.repeat))
  const [monthNth, setMonthNth] = useState<boolean>(/^monthly:nth:/.test(fullRep))
  const [nthN, setNthN] = useState<number>(() => { const m = /^monthly:nth:(\d):(\d)$/.exec(fullRep); return m ? +m[1] : 0 })
  const [nthW, setNthW] = useState<number>(() => { const m = /^monthly:nth:(\d):(\d)$/.exec(fullRep); return m ? +m[2] : -1 })

  const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  const ORD = ['1st', '2nd', '3rd', '4th']
  const dueDay = +dateStr.slice(8, 10) || new Date().getDate()
  const dueWd = new Date(`${dateStr || toDateOnlyStr(new Date())}T${timeStr || '00:00'}`).getDay()

  // Persist due_date (composeWhen → "" on clear) with an EXPLICIT repeat rule.
  // The rule is stored verbatim and NOT re-derived when the date/time moves —
  // matching web, where picking a rule snaps the date and the rule then stands.
  function commit(nd: string, nt: string, repeatVal: string) {
    const due = composeWhen(nd, nt, new Date())
    onUpdate({ due_date: due, repeat: due ? repeatVal : 'none' })
  }
  const onDate = (v: string) => { setDateStr(v); commit(v, timeStr, fullRep) }
  const onTime = (v: string) => {
    const nd = v && !dateStr ? toDateOnlyStr(new Date()) : dateStr
    setTimeStr(v); if (nd !== dateStr) setDateStr(nd)
    commit(nd, v, fullRep)
  }
  const onDuration = (v: number) => { setDur(v); onUpdate({ duration_min: v }) }
  function clearWhen() {
    setDateStr(''); setTimeStr(''); setFullRep('none'); setRep('none'); setMonthNth(false)
    onUpdate({ due_date: '', repeat: 'none' })
  }

  // Apply an explicit rule; when `snap`, move the due date forward to its next
  // matching slot (web parity), then persist date + rule together.
  function applyRepeat(val: string, snap: boolean) {
    let nd = dateStr, nt = timeStr
    if (snap) {
      const snapped = snapToRepeat(new Date(`${dateStr || toDateOnlyStr(new Date())}T${timeStr || '18:00'}`), val)
      if (snapped) { const s = toLocalDatetimeStr(snapped); nd = datePart(s); nt = timePart(s) }
    }
    setDateStr(nd); setTimeStr(nt); setFullRep(val); setRep(simpleRepeat(val))
    onUpdate({ due_date: composeWhen(nd, nt, new Date()), repeat: val })
  }
  function onRepeatChip(r: string) {
    if (r === 'none' || r === 'daily' || r === 'yearly') { setMonthNth(false); applyRepeat(r, false) }
    else if (r === 'weekly') { setMonthNth(false); applyRepeat(`weekly:${dueWd}`, false) }
    else if (r === 'monthly') { setMonthNth(false); applyRepeat(`monthly:day:${dueDay}`, false) }
  }
  const onWeeklyPick = (w: number) => applyRepeat(`weekly:${w}`, true)
  const onMonthlyDay = () => { setMonthNth(false); applyRepeat(`monthly:day:${dueDay}`, false) }
  const onNthN = (n: number) => { setNthN(n); if (nthW >= 0) applyRepeat(`monthly:nth:${n}:${nthW}`, true) }
  const onNthW = (w: number) => { setNthW(w); if (nthN > 0) applyRepeat(`monthly:nth:${nthN}:${w}`, true) }
```

- [ ] **Step 4: Replace the "when" render block**

In `mobile/src/screens/Detail.ts`, replace the entire `<div>` that renders the when-block — from `<div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 4px 0' }}>` through its matching `</div>` immediately before the `<div ...>break it down</div>` line (currently lines 84-115) — with:

```ts
      <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 4px 0' }}>
        <div style=${{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0,
            background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px', padding: '0 12px', color: T.muted }}>
            ${CAL_ICON}
            <input type="date" value=${dateStr} onInput=${(e: any) => onDate(e.target.value)}
              style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                padding: '10px 0', font: `400 14px ${T.mono}`, color: T.text }} />
          </div>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', width: '128px',
            background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px', padding: '0 12px', color: T.muted }}>
            ${CLOCK_ICON}
            <input type="time" value=${timeStr} onInput=${(e: any) => onTime(e.target.value)}
              style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                padding: '10px 0', font: `400 14px ${T.mono}`, color: T.text }} />
          </div>
          <span onClick=${clearWhen} title="Clear" style=${{ width: '40px', height: '40px', flex: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none',
            color: T.muted, font: `400 18px ${T.mono}` }}>×</span>
        </div>

        <div style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>duration</span>
          <input type="number" inputmode="numeric" min="0" step="5" value=${dur || ''}
            onInput=${(e: any) => onDuration(Math.max(0, parseInt(e.target.value, 10) || 0))}
            placeholder="—"
            style=${{ width: '72px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px',
              padding: '8px 10px', font: `400 14px ${T.mono}`, color: T.text }} />
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted }}>min</span>
        </div>

        <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>repeat</span>
          ${(['none', 'daily', 'weekly', 'monthly', 'yearly']).map(r => html`
            <span key=${r} onClick=${dateStr || r === 'none' ? () => onRepeatChip(r) : undefined}
              style=${{ padding: '6px 12px', borderRadius: '999px', userSelect: 'none',
                cursor: dateStr || r === 'none' ? 'pointer' : 'default',
                font: `500 12.5px ${T.mono}`, opacity: dateStr || r === 'none' ? 1 : 0.4,
                border: `1px solid ${rep === r ? T.accent : T.card2}`,
                background: rep === r ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                color: rep === r ? T.accent : T.muted }}>${r}</span>`)}
        </div>

        ${rep === 'weekly' && dateStr ? html`
          <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '4px' }}>
            <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>on</span>
            ${WEEK.map((d, i) => html`
              <span key=${i} onClick=${() => onWeeklyPick(i)}
                style=${{ width: '30px', height: '30px', borderRadius: '999px', userSelect: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', font: `500 12px ${T.mono}`,
                  border: `1px solid ${fullRep === `weekly:${i}` ? T.accent : T.card2}`,
                  background: fullRep === `weekly:${i}` ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                  color: fullRep === `weekly:${i}` ? T.accent : T.muted }}>${d}</span>`)}
          </div>` : ''}

        ${rep === 'monthly' && dateStr ? html`
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '4px' }}>
            <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span key="day" onClick=${onMonthlyDay}
                style=${{ padding: '6px 12px', borderRadius: '999px', userSelect: 'none', cursor: 'pointer', font: `500 12.5px ${T.mono}`,
                  border: `1px solid ${!monthNth && /^monthly:day:/.test(fullRep) ? T.accent : T.card2}`,
                  background: !monthNth && /^monthly:day:/.test(fullRep) ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                  color: !monthNth && /^monthly:day:/.test(fullRep) ? T.accent : T.muted }}>Day ${dueDay}</span>
              <span key="nth" onClick=${() => setMonthNth(true)}
                style=${{ padding: '6px 12px', borderRadius: '999px', userSelect: 'none', cursor: 'pointer', font: `500 12.5px ${T.mono}`,
                  border: `1px solid ${monthNth || /^monthly:nth:/.test(fullRep) ? T.accent : T.card2}`,
                  background: monthNth || /^monthly:nth:/.test(fullRep) ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                  color: monthNth || /^monthly:nth:/.test(fullRep) ? T.accent : T.muted }}>${/^monthly:nth:/.test(fullRep) ? monthlyDescriptor(fullRep) : 'Nth weekday'} ›</span>
            </div>
            ${monthNth ? html`
              <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>which</span>
                ${ORD.map((o, i) => html`
                  <span key=${i} onClick=${() => onNthN(i + 1)}
                    style=${{ padding: '5px 10px', borderRadius: '999px', userSelect: 'none', cursor: 'pointer', font: `500 12px ${T.mono}`,
                      border: `1px solid ${nthN === i + 1 ? T.accent : T.card2}`,
                      background: nthN === i + 1 ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                      color: nthN === i + 1 ? T.accent : T.muted }}>${o}</span>`)}
              </div>
              <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>day</span>
                ${WEEK.map((d, i) => html`
                  <span key=${i} onClick=${() => onNthW(i)}
                    style=${{ width: '30px', height: '30px', borderRadius: '999px', userSelect: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', font: `500 12px ${T.mono}`,
                      border: `1px solid ${nthW === i ? T.accent : T.card2}`,
                      background: nthW === i ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                      color: nthW === i ? T.accent : T.muted }}>${d}</span>`)}
              </div>` : ''}
          </div>` : ''}
      </div>
```

- [ ] **Step 5: Typecheck + rebuild the bundle**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean (no unused-symbol errors — `DURATIONS`, `rep0`, `repeat0`, and the old `commitWhen`/`onRepeat` are gone; every new symbol is used).

Run: `cd mobile && node build.mjs`
Expected: builds `www/js/app.js` with no error.

- [ ] **Step 6: Confirm the full mobile suite still passes**

Run: `cd mobile && npx vitest run`
Expected: PASS — `datetime`, `recurrence` (incl. Task 1's new cases), `tasks`, `subtasks`, `nav` suites all green.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/Detail.ts mobile/www/js/app.js
git commit -m "feat(mobile): Detail when-block — icons, typable duration, prefill+clear, inline web-parity recurrence"
```

---

### Task 4: APK rebuild + docs + on-device proof

**Files:**
- Modify: `docs/productivity/mobile-build.md`
- Build: `dist/odysseus.apk` (gitignored — NOT committed)

**Interfaces:**
- Consumes: the rebuilt `mobile/www/js/app.js` (Task 3) and the edited `mobile/www/index.html` (Task 2).
- Produces: an installable APK + a documented proof checklist.

- [ ] **Step 1: Rebuild the APK**

Run: `bash mobile/build-apk.sh`
Expected: prints `APK → dist/odysseus.apk (…M)` and exits 0.

- [ ] **Step 2: Verify the new engine symbols + CSS fix are packaged**

Run: `grep -c "snapToRepeat\|monthlyDescriptor" mobile/www/js/app.js`
Expected: ≥ 1 (Detail's import pulls both into the bundle).

Run: `grep -c "tap-highlight-color" mobile/www/index.html`
Expected: `1`.

Run: `unzip -l dist/odysseus.apk | grep -c "assets/public/js/app.js"`
Expected: `1`.

- [ ] **Step 3: Document the slice + proof steps**

In `docs/productivity/mobile-build.md`, append:

```markdown
## Calendar Slice A.1 — recurrence authoring + when-block polish (2026-07-24)

Web-parity recurrence in the mobile Detail "when" block (weekday for weekly; Day-N / Nth-weekday for monthly, with due-date snapping), a typable duration field, a prefilled today/18:00 default that persists only on interaction, calendar/clock icons, and a global tap-highlight fix. Engine gained `snapToRepeat` + `monthlyDescriptor`. **No backend change** — no server redeploy needed for this slice (the `duration_min` column shipped with Slice A).

### On-device proof (PENDING)
1. `adb install -r dist/odysseus.apk`, open a task in Detail.
2. **Deadline sync:** set the date to **today** and time **18:30** → on `https://chat.elsiga.ch` the task shows the 🔔 bell with today 18:30.
3. **Weekly:** Repeat = Weekly → pick **Monday** while the date is a non-Monday → the due date snaps to the next Monday; web shows "Weekly on Mondays ↻".
4. **Monthly Nth:** Repeat = Monthly → **Nth weekday** → **2nd** / **Tuesday** → web shows "Monthly on 2nd Tuesday".
5. **Duration:** type a custom value (e.g. 37) → reopen: it persists.
6. **Default prefill:** open a task with no date → fields show today / 18:00; leave without touching them → the task still has no due date; touch a field/chip → the due persists.
7. **Clear:** tap **×** on the date row → the due is removed (no date on reopen and on web).
8. **Polish:** calendar/clock icons show; no grey rectangle flash when tapping any chip.
```

- [ ] **Step 4: Commit**

```bash
git add docs/productivity/mobile-build.md
git commit -m "docs(mobile): calendar Slice A.1 build + on-device proof steps"
```

---

## Self-Review

**Spec coverage:**
- Fuller recurrence (weekly weekday; monthly Day-N / Nth-weekday) with web-parity authoring + snapping → Task 1 (`snapToRepeat`, `monthlyDescriptor`) + Task 3 (inline expand UI). ✓
- Typable duration replacing chips → Task 3 (number input; `DURATIONS` chips removed). ✓
- Default when (prefill today/18:00, persist on interaction) → Task 3 (`initDate`/`initTime`; handlers persist only on interaction). ✓
- ✕ clear affordance → Task 3 (`clearWhen`). ✓
- Calendar/clock inline-SVG icons → Task 3 (`CAL_ICON`/`CLOCK_ICON`, icon-wrapped inputs). ✓
- Global tap-highlight fix → Task 2 (`-webkit-tap-highlight-color`) + per-chip `userSelect:'none'` in Task 3. ✓
- Deadline-sync acceptance (today 18:30 → web 🔔) → Task 4 proof step 2. ✓
- Deferred final-review #4 (weekly off-weekday first anchor) → Task 1 Step 5 guard + test. ✓
- Preserve web-authored `monthly:nth`/`monthly:last` on unrelated edits → Task 3 (explicit `fullRep` stored verbatim; not re-derived on date/time edit; supersedes the removed `rep0`/`repeat0`). ✓
- Non-goals (typed capture, `monthly:last` authoring, Slice B views, backend change) → none built. ✓

**Placeholder scan:** none. Every code step ships complete code; every command states its expected result.

**Type consistency:** `snapToRepeat(currentDate, normRepeat, now?) → Date | null` and `monthlyDescriptor(norm) → string` (Task 1) are imported and used verbatim in Task 3. Detail state: `fullRep: string`, `rep: string`, `dur: number`, `monthNth: boolean`, `nthN: number`, `nthW: number`. `applyRepeat(val: string, snap: boolean)`, `commit(nd, nt, repeatVal)`, `clearWhen()`, `onDuration(v: number)`, `onWeeklyPick`/`onNthN`/`onNthW(n|w: number)`, `onMonthlyDay()`, `onRepeatChip(r: string)` — all defined and referenced consistently. `onUpdate` patches use only `NoteRec` keys (`due_date`, `repeat`, `duration_min`, plus the untouched `items`/`note_type`/`title`/`content` paths). `datetime` imports extended with `toLocalDatetimeStr`; `recurrence` imports extended with `snapToRepeat`/`monthlyDescriptor`.
```