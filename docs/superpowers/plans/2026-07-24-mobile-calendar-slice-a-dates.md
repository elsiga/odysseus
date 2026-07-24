# Mobile Calendar — Slice A: Make Dates Real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dates first-class on the mobile task app — an additive backend `duration_min` field, a Capture datetime fix, date/time/duration/recurrence editing in Detail, and a pure vitest-tested recurrence engine — the data foundation the Day/Week/Month calendar views (Slice B) will render.

**Architecture:** One additive nullable `Note.duration_min` column (guarded migration + wire mapping, sync engine untouched). Two new pure mobile modules — `datetime.ts` (time-token → real datetime, format helpers) and `recurrence.ts` (web-identical recurrence grammar + range enumeration) — both fully unit-tested. Capture and Detail become thin glue over those helpers. No calendar views this slice.

**Tech Stack:** Python/SQLAlchemy + SQLite (backend), pytest; TypeScript + Preact/HTM + esbuild (mobile), vitest; Capacitor Android WebView native `<input type="date">`/`type="time"` pickers.

Design: `docs/superpowers/specs/2026-07-24-mobile-calendar-slice-a-dates-design.md`

## Global Constraints

- **Additive backend field ONLY.** `Note.duration_min` = `INTEGER`, nullable, default `NULL`. Migration is guarded + idempotent (checks `PRAGMA table_info` first). Do NOT alter the sync engine, change-log listeners, `apply_push`/`pull_changes`, the outbox, or per-record LWW.
- **Touch only:** `core/database.py`, `routes/note/note_service.py`, `tests/test_notes_task_fields.py`, `mobile/src/**`, `mobile/www/js/app.js`, `docs/productivity/mobile-build.md`. Do NOT touch `sync-engine/`, `static/` (web), or `parseCapture` (the shared `static/js/productivity/sync-core.js` bundle stays as-is).
- **`due_date` format (mirror web exactly):** timed = `YYYY-MM-DDTHH:MM` (local, no TZ); all-day = `YYYY-MM-DD`. "Has a time" ⇔ matches `/T\d{2}:\d{2}/` (web's `_hasTimeComponent`).
- **`composeDueDate` (Capture): today at the given time, NO roll-over** even if that instant already passed today.
- **Clearing persists as a non-`None` value (Slice 2 lesson):** `update_note_record` skips keys whose value is `None`, so clearing a due date sends `""` (not `null`) and clearing a duration sends `0` (not `null`). `0`/`null` duration both mean "no explicit duration".
- **Recurrence grammar mirrors web:** the Detail UI *writes* `none`/`daily`/`weekly:W`/`monthly:day:N`/`yearly`; the engine also *reads* `monthly:nth:N:W`/`monthly:last:W` + legacy bare forms (web-authored data).
- **NO JSX** — `html` tagged templates; hooks come from `./html` (which re-exports `useState` etc.).
- **`mobile/www/js/app.js` is the tracked built artifact** — rebuild (`cd mobile && node build.mjs`) and stage it in every task that changes `mobile/src/**`.
- **Stage EXPLICIT paths only** — never `git add -A` (untracked `design/` must never be staged; `dist/odysseus.apk` is gitignored).
- **Detail persists via its `onUpdate` prop** (wired to the serialized `store.update` write queue) — do not call `notesRepo` directly.
- Build/test: backend `python -m pytest tests/test_notes_task_fields.py -v`; mobile unit `cd mobile && npx vitest run src/<file>.test.ts`; bundle `cd mobile && node build.mjs`; typecheck `cd mobile && npx tsc --noEmit`; APK `bash mobile/build-apk.sh`.

---

### Task 1: Backend `duration_min` field (model + migration + wire mapping)

**Files:**
- Modify: `core/database.py` (Note model ~`1785`; new migration fn near `_migrate_add_notes_task_fields` at `1152`; startup call at `1987`)
- Modify: `routes/note/note_service.py` (`_CREATE_FIELDS`, `_UPDATE_FIELDS`, `_WIRE_IN_FIELDS`, `note_to_wire`)
- Test: `tests/test_notes_task_fields.py` (append cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `duration_min` round-trips through `create_note_record` / `update_note_record` / `note_to_wire` / `note_from_wire` as an optional integer. Consumed by the mobile client (Task 2 adds the type; Task 4 writes it).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_notes_task_fields.py` (these reuse the file's existing `_s`, `create_note_record`, `update_note_record`, `note_to_wire`, `note_from_wire` imports):

```python
def test_duration_min_default_null_and_roundtrip(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T"})
    assert n.duration_min is None
    assert note_to_wire(n)["duration_min"] is None


def test_duration_min_create_and_update(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T", "duration_min": 25})
    assert n.duration_min == 25
    assert note_to_wire(n)["duration_min"] == 25
    n2 = update_note_record(s, "alice", n.id, {"duration_min": 45})
    assert n2.duration_min == 45
    # Clearing uses 0 (update skips None), meaning "no explicit duration"
    n3 = update_note_record(s, "alice", n.id, {"duration_min": 0})
    assert n3.duration_min == 0


def test_duration_min_wire_in_filters(tmp_path):
    data = note_from_wire({"title": "T", "duration_min": 60, "not_a_field": 9})
    assert data["duration_min"] == 60 and "not_a_field" not in data
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_notes_task_fields.py -v`
Expected: the three new tests FAIL — `duration_min` is not a Note column / not in the wire dict (`AttributeError` or `KeyError`). Pre-existing tests still pass.

- [ ] **Step 3: Add the model column**

In `core/database.py`, in the `Note` class, add the column immediately after the `done` line (currently `done = Column(Boolean, default=False)  # task-level completion`):

```python
    duration_min = Column(Integer, nullable=True)   # intended length of a timed task, in minutes; NULL/0 = none
```

- [ ] **Step 4: Add the guarded migration**

In `core/database.py`, add this function directly after `_migrate_add_notes_task_fields` (which ends near line 1178, before `def _migrate_add_notes_rev():`):

```python
def _migrate_add_notes_duration():
    """Add duration_min to notes if missing. Guarded + idempotent."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(notes)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "duration_min" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN duration_min INTEGER")
        conn.commit()
        logging.getLogger(__name__).info("Migrated: added duration_min to notes")
    except Exception as e:
        logging.getLogger(__name__).warning(f"notes duration_min migration failed: {e}")
    finally:
        if conn:
            conn.close()
```

- [ ] **Step 5: Call the migration at startup**

In `core/database.py`, find the startup migration block and add the call on the line immediately after `_migrate_add_notes_task_fields()` (line 1987):

```python
    _migrate_add_notes_task_fields()
    _migrate_add_notes_duration()
```

- [ ] **Step 6: Thread `duration_min` through the wire mapping**

In `routes/note/note_service.py`:

Change `_CREATE_FIELDS` (line 8-10) to add `"duration_min"` at the end of the tuple:

```python
_CREATE_FIELDS = ("title", "content", "note_type", "color", "label", "pinned",
                  "due_date", "source", "session_id", "image_url", "repeat", "sort_order",
                  "bucket", "urgency", "project", "done", "duration_min")
```

Change `_UPDATE_FIELDS` (line 11-13) to add `"duration_min"`:

```python
_UPDATE_FIELDS = ("title", "content", "note_type", "color", "label", "pinned",
                  "archived", "due_date", "image_url", "repeat", "sort_order",
                  "agent_session_id", "bucket", "urgency", "project", "done", "duration_min")
```

Change `_WIRE_IN_FIELDS` (line ~88-91) to add `"duration_min"`:

```python
_WIRE_IN_FIELDS = ("title", "content", "items", "note_type", "color", "label",
                   "pinned", "archived", "due_date", "image_url", "repeat",
                   "sort_order", "source", "session_id", "agent_session_id",
                   "bucket", "urgency", "project", "done", "duration_min")
```

In `note_to_wire` (the returned dict, after the `"done": bool(note.done),` line), add:

```python
        "duration_min": getattr(note, "duration_min", None),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `python -m pytest tests/test_notes_task_fields.py -v`
Expected: PASS — all new + pre-existing cases green, output clean.

- [ ] **Step 8: Commit**

```bash
git add core/database.py routes/note/note_service.py tests/test_notes_task_fields.py
git commit -m "feat(notes): additive duration_min field (nullable int) + migration + wire mapping"
```

---

### Task 2: Mobile `datetime.ts` util + Capture datetime fix

**Files:**
- Create: `mobile/src/datetime.ts`
- Create: `mobile/src/datetime.test.ts`
- Modify: `mobile/src/sync-core.d.ts` (add `repeat` + `duration_min` to `NoteRec`)
- Modify: `mobile/src/screens/Capture.ts` (compose a real datetime)
- Regenerate: `mobile/www/js/app.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `mobile/src/datetime.ts` exporting:
  - `hasTimeComponent(s: string | null | undefined): boolean`
  - `toLocalDatetimeStr(d: Date): string` → `YYYY-MM-DDTHH:MM`
  - `toDateOnlyStr(d: Date): string` → `YYYY-MM-DD`
  - `parseTimeToken(tok: string | null | undefined): { hh: number; mm: number } | null`
  - `composeDueDate(tok: string | null | undefined, now: Date): string | null`
  - `datePart(due: string | null | undefined): string` / `timePart(due: string | null | undefined): string`
  - `composeWhen(dateStr: string, timeStr: string, now: Date): string`
  Consumed by `recurrence.ts` (Task 3, `toLocalDatetimeStr`/`toDateOnlyStr`) and Detail (Task 4).

- [ ] **Step 1: Write the failing tests**

Create `mobile/src/datetime.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  hasTimeComponent, toLocalDatetimeStr, toDateOnlyStr, parseTimeToken,
  composeDueDate, datePart, timePart, composeWhen,
} from './datetime'

describe('datetime', () => {
  it('hasTimeComponent distinguishes timed from all-day', () => {
    expect(hasTimeComponent('2026-07-24T21:00')).toBe(true)
    expect(hasTimeComponent('2026-07-24')).toBe(false)
    expect(hasTimeComponent('')).toBe(false)
    expect(hasTimeComponent(null)).toBe(false)
  })

  it('formats local datetime and date-only', () => {
    const d = new Date(2026, 6, 24, 21, 5) // 2026-07-24 21:05 local
    expect(toLocalDatetimeStr(d)).toBe('2026-07-24T21:05')
    expect(toDateOnlyStr(d)).toBe('2026-07-24')
  })

  it('parses 12h and 24h time tokens', () => {
    expect(parseTimeToken('9pm')).toEqual({ hh: 21, mm: 0 })
    expect(parseTimeToken('12am')).toEqual({ hh: 0, mm: 0 })
    expect(parseTimeToken('12pm')).toEqual({ hh: 12, mm: 0 })
    expect(parseTimeToken('14:30')).toEqual({ hh: 14, mm: 30 })
    expect(parseTimeToken('9:05')).toEqual({ hh: 9, mm: 5 })
    expect(parseTimeToken('nope')).toBeNull()
    expect(parseTimeToken('')).toBeNull()
    expect(parseTimeToken(null)).toBeNull()
  })

  it('composeDueDate = today at the token time, NO roll-over', () => {
    const now = new Date(2026, 6, 24, 22, 0) // 10pm
    // 9pm is already past today, but we do NOT roll to tomorrow
    expect(composeDueDate('9pm', now)).toBe('2026-07-24T21:00')
    expect(composeDueDate(null, now)).toBeNull()
    expect(composeDueDate('garbage', now)).toBeNull()
  })

  it('splits a due_date into date/time parts', () => {
    expect(datePart('2026-07-24T21:00')).toBe('2026-07-24')
    expect(timePart('2026-07-24T21:00')).toBe('21:00')
    expect(datePart('2026-07-24')).toBe('2026-07-24')
    expect(timePart('2026-07-24')).toBe('')
    expect(datePart('')).toBe('')
    expect(timePart(null)).toBe('')
  })

  it('composeWhen assembles date+time; empties clear to "" ; time-only defaults to today', () => {
    const now = new Date(2026, 6, 24, 12, 0)
    expect(composeWhen('', '', now)).toBe('')
    expect(composeWhen('2026-08-01', '', now)).toBe('2026-08-01')
    expect(composeWhen('2026-08-01', '09:30', now)).toBe('2026-08-01T09:30')
    expect(composeWhen('', '09:30', now)).toBe('2026-07-24T09:30')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && npx vitest run src/datetime.test.ts`
Expected: FAIL — `./datetime` module does not exist yet.

- [ ] **Step 3: Implement `datetime.ts`**

Create `mobile/src/datetime.ts`:

```ts
// Date/time helpers for the mobile task app. The due_date wire format mirrors
// the web (static/js/notes.js) EXACTLY so mobile- and web-authored dates agree:
//   timed   = YYYY-MM-DDTHH:MM  (local, no timezone)
//   all-day = YYYY-MM-DD

export function hasTimeComponent(s: string | null | undefined): boolean {
  return typeof s === 'string' && /T\d{2}:\d{2}/.test(s)
}

export function toLocalDatetimeStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function toDateOnlyStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function parseTimeToken(tok: string | null | undefined): { hh: number; mm: number } | null {
  if (!tok) return null
  const t = tok.trim().toLowerCase()
  let m = /^(\d{1,2}):(\d{2})$/.exec(t)         // 24h "HH:MM" / "H:MM"
  if (m) {
    const hh = +m[1], mm = +m[2]
    return hh > 23 || mm > 59 ? null : { hh, mm }
  }
  m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t)  // 12h "9pm" / "9:30pm" / "12am"
  if (m) {
    let hh = +m[1]; const mm = m[2] ? +m[2] : 0; const ap = m[3]
    if (hh < 1 || hh > 12 || mm > 59) return null
    if (ap === 'am') hh = hh === 12 ? 0 : hh
    else hh = hh === 12 ? 12 : hh + 12
    return { hh, mm }
  }
  return null
}

// Capture path: compose TODAY at the token time. No roll-over even if the time
// already passed today — the user adjusts manually in Detail.
export function composeDueDate(tok: string | null | undefined, now: Date): string | null {
  const t = parseTimeToken(tok)
  if (!t) return null
  return toLocalDatetimeStr(new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hh, t.mm, 0, 0))
}

export function datePart(due: string | null | undefined): string {
  if (!due) return ''
  return due.slice(0, 10)
}

export function timePart(due: string | null | undefined): string {
  if (!hasTimeComponent(due)) return ''
  return (due as string).slice(11, 16)
}

// Detail path: assemble the picker parts back into a due_date. Returns "" (NOT
// null) when cleared, because update_note_record skips None values (Slice 2
// lesson) — "" persists the clear, null would be a no-op.
export function composeWhen(dateStr: string, timeStr: string, now: Date): string {
  if (!dateStr && !timeStr) return ''
  const d = dateStr || toDateOnlyStr(now)
  return timeStr ? `${d}T${timeStr}` : d
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && npx vitest run src/datetime.test.ts`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Add `repeat` + `duration_min` to `NoteRec`**

In `mobile/src/sync-core.d.ts`, extend the `NoteRec` interface. Change the block:

```ts
  done?: boolean; archived?: boolean; bucket?: string; urgency?: number;
  project?: string | null; sort_order?: number; due_date?: string | null;
```

to:

```ts
  done?: boolean; archived?: boolean; bucket?: string; urgency?: number;
  project?: string | null; sort_order?: number; due_date?: string | null;
  repeat?: string; duration_min?: number | null;
```

- [ ] **Step 6: Fix Capture to store a real datetime**

In `mobile/src/screens/Capture.ts`, add the import (after the existing `import { parseCapture } from '../notes'` line):

```ts
import { composeDueDate } from '../datetime'
```

Then change the `onSave` call inside `save()` — replace `due_date: parsed.dueTime,` with:

```ts
      project: parsed.project || defaultProject || null, due_date: composeDueDate(parsed.dueTime, new Date()),
```

(The full `await onSave({...})` object otherwise unchanged.)

- [ ] **Step 7: Typecheck + rebuild the bundle**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

Run: `cd mobile && node build.mjs`
Expected: builds `www/js/app.js` with no error.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/datetime.ts mobile/src/datetime.test.ts mobile/src/sync-core.d.ts mobile/src/screens/Capture.ts mobile/www/js/app.js
git commit -m "feat(mobile): datetime util + Capture stores a real datetime; NoteRec gains repeat/duration_min"
```

---

### Task 3: Mobile `recurrence.ts` engine + tests

**Files:**
- Create: `mobile/src/recurrence.ts`
- Create: `mobile/src/recurrence.test.ts`

(No `app.js` rebuild: this module is not imported at runtime until Task 4. It ships as tested source now — the foundation Slice B's views will consume.)

**Interfaces:**
- Consumes: `toLocalDatetimeStr`, `toDateOnlyStr` from `./datetime` (Task 2).
- Produces: `mobile/src/recurrence.ts` exporting:
  - `normalizeRepeat(repeat: string | null | undefined, anchor: Date): string`
  - `simpleRepeat(repeat: string | null | undefined): 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'`
  - `expandOccurrences(dueDate: string, repeat: string | null | undefined, rangeStart: Date, rangeEnd: Date): string[]`
  Consumed by Detail (Task 4, `normalizeRepeat`/`simpleRepeat`) and later by Slice B's views (`expandOccurrences`).

- [ ] **Step 1: Write the failing tests**

Create `mobile/src/recurrence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeRepeat, simpleRepeat, expandOccurrences } from './recurrence'

const D = (s: string) => new Date(s)

describe('normalizeRepeat', () => {
  it('passes through none/daily/yearly and already-parameterized forms', () => {
    const anchor = D('2026-07-15T09:00') // Wednesday, 3rd week
    expect(normalizeRepeat('none', anchor)).toBe('none')
    expect(normalizeRepeat(null, anchor)).toBe('none')
    expect(normalizeRepeat('daily', anchor)).toBe('daily')
    expect(normalizeRepeat('yearly', anchor)).toBe('yearly')
    expect(normalizeRepeat('weekly:1', anchor)).toBe('weekly:1')
    expect(normalizeRepeat('monthly:day:15', anchor)).toBe('monthly:day:15')
  })
  it('derives params from the anchor for legacy bare forms', () => {
    const anchor = D('2026-07-15T09:00') // Wed (getDay()===3), date 15, 3rd Wed
    expect(normalizeRepeat('weekly', anchor)).toBe('weekly:3')
    expect(normalizeRepeat('monthly', anchor)).toBe('monthly:day:15')
    expect(normalizeRepeat('monthly_nth_weekday', anchor)).toBe('monthly:nth:3:3')
    expect(normalizeRepeat('monthly_last_weekday', anchor)).toBe('monthly:last:3')
  })
})

describe('simpleRepeat', () => {
  it('maps stored grammar back to a UI label', () => {
    expect(simpleRepeat('none')).toBe('none')
    expect(simpleRepeat(null)).toBe('none')
    expect(simpleRepeat('daily')).toBe('daily')
    expect(simpleRepeat('yearly')).toBe('yearly')
    expect(simpleRepeat('weekly:3')).toBe('weekly')
    expect(simpleRepeat('monthly:day:15')).toBe('monthly')
    expect(simpleRepeat('monthly:nth:3:3')).toBe('monthly')
    expect(simpleRepeat('monthly:last:3')).toBe('monthly')
  })
})

describe('expandOccurrences', () => {
  it('none: yields the anchor only when it is inside the range', () => {
    expect(expandOccurrences('2026-07-15T09:00', 'none', D('2026-07-01'), D('2026-07-31T23:59')))
      .toEqual(['2026-07-15T09:00'])
    expect(expandOccurrences('2026-07-15T09:00', 'none', D('2026-08-01'), D('2026-08-31')))
      .toEqual([])
  })

  it('daily: one per day across the range, preserving the time', () => {
    const occ = expandOccurrences('2026-07-15T09:00', 'daily', D('2026-07-15'), D('2026-07-18T23:59'))
    expect(occ).toEqual(['2026-07-15T09:00', '2026-07-16T09:00', '2026-07-17T09:00', '2026-07-18T09:00'])
  })

  it('daily: fast-forwards when the range starts after the anchor', () => {
    const occ = expandOccurrences('2026-07-01T08:00', 'daily', D('2026-07-15'), D('2026-07-16T23:59'))
    expect(occ).toEqual(['2026-07-15T08:00', '2026-07-16T08:00'])
  })

  it('weekly: snaps to the requested weekday', () => {
    // weekly:3 = Wednesdays; anchor is a Wednesday
    const occ = expandOccurrences('2026-07-15T09:00', 'weekly:3', D('2026-07-15'), D('2026-08-05T23:59'))
    expect(occ).toEqual(['2026-07-15T09:00', '2026-07-22T09:00', '2026-07-29T09:00', '2026-08-05T09:00'])
  })

  it('monthly:day clamps to the last day of shorter months', () => {
    // day 31 → Feb clamps to 28 (2027 is not a leap year)
    const occ = expandOccurrences('2027-01-31', 'monthly:day:31', D('2027-01-01'), D('2027-03-31'))
    expect(occ).toEqual(['2027-01-31', '2027-02-28', '2027-03-31'])
  })

  it('monthly:nth = the Nth weekday of each month', () => {
    // 2nd Tuesday (nth:2, weekday 2)
    const occ = expandOccurrences('2026-07-14', 'monthly:nth:2:2', D('2026-07-01'), D('2026-09-30'))
    expect(occ).toEqual(['2026-07-14', '2026-08-11', '2026-09-08'])
  })

  it('monthly:last = the last weekday of each month', () => {
    // last Friday (weekday 5)
    const occ = expandOccurrences('2026-07-31', 'monthly:last:5', D('2026-07-01'), D('2026-09-30'))
    expect(occ).toEqual(['2026-07-31', '2026-08-28', '2026-09-25'])
  })

  it('yearly: one per year', () => {
    const occ = expandOccurrences('2026-03-10', 'yearly', D('2026-01-01'), D('2028-12-31'))
    expect(occ).toEqual(['2026-03-10', '2027-03-10', '2028-03-10'])
  })

  it('all-day anchors stay date-only; timed anchors keep the time', () => {
    expect(expandOccurrences('2026-07-15', 'daily', D('2026-07-15'), D('2026-07-16T23:59')))
      .toEqual(['2026-07-15', '2026-07-16'])
  })

  it('range entirely before the anchor yields nothing', () => {
    expect(expandOccurrences('2026-07-15T09:00', 'daily', D('2026-06-01'), D('2026-06-30')))
      .toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && npx vitest run src/recurrence.test.ts`
Expected: FAIL — `./recurrence` module does not exist yet.

- [ ] **Step 3: Implement `recurrence.ts`**

Create `mobile/src/recurrence.ts`:

```ts
// Recurrence engine — a semantic PORT of the web's rules (static/js/notes.js:
// _normalizeRepeat / _advanceRecurring / _nthWeekdayOfMonth / _lastWeekdayOfMonth),
// reshaped from "next occurrence after now" into RANGE ENUMERATION for the
// calendar views (Slice B). Must stay semantically identical to web; the tests
// are the shared contract. Grammar:
//   none | daily | yearly
//   weekly:W                (W = weekday 0=Sun..6=Sat)
//   monthly:day:N           (N = day-of-month; clamps to the month's last day)
//   monthly:nth:N:W         (Nth weekday of the month)
//   monthly:last:W          (last weekday of the month)
import { toLocalDatetimeStr, toDateOnlyStr } from './datetime'

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  let day = 1 + offset + (n - 1) * 7
  const lastDay = new Date(year, month + 1, 0).getDate()
  if (day > lastDay) day -= 7
  return new Date(year, month, day, 0, 0, 0)
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(year, month + 1, 0)
  const back = (lastDay.getDay() - weekday + 7) % 7
  return new Date(year, month, lastDay.getDate() - back, 0, 0, 0)
}

export function normalizeRepeat(repeat: string | null | undefined, anchor: Date): string {
  if (!repeat || repeat === 'none') return 'none'
  if (repeat === 'daily' || repeat === 'yearly') return repeat
  if (/^(weekly|monthly):/.test(repeat)) return repeat
  const wd = anchor.getDay()
  const n = Math.ceil(anchor.getDate() / 7)
  if (repeat === 'weekly') return `weekly:${wd}`
  if (repeat === 'monthly') return `monthly:day:${anchor.getDate()}`
  if (repeat === 'monthly_nth_weekday') return `monthly:nth:${n}:${wd}`
  if (repeat === 'monthly_last_weekday') return `monthly:last:${wd}`
  return repeat
}

export function simpleRepeat(repeat: string | null | undefined): 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' {
  if (!repeat || repeat === 'none') return 'none'
  if (repeat === 'daily') return 'daily'
  if (repeat === 'yearly') return 'yearly'
  if (/^weekly:/.test(repeat) || repeat === 'weekly') return 'weekly'
  if (/^monthly:/.test(repeat) || repeat.startsWith('monthly')) return 'monthly'
  return 'none'
}

// Advance one step of a normalized pattern, preserving time-of-day (hh:mm).
function stepOnce(d: Date, norm: string, hh: number, mm: number): Date | null {
  if (norm === 'daily') { const n = new Date(d); n.setDate(n.getDate() + 1); return n }
  if (norm === 'yearly') { const n = new Date(d); n.setFullYear(n.getFullYear() + 1); return n }
  const parts = norm.split(':')
  const kind = parts[0]
  if (kind === 'weekly') {
    const targetWd = parseInt(parts[1], 10)
    const n = new Date(d)
    let delta = (targetWd - n.getDay() + 7) % 7
    if (delta === 0) delta = 7
    n.setDate(n.getDate() + delta); n.setHours(hh, mm, 0, 0)
    return n
  }
  if (kind === 'monthly') {
    const sub = parts[1]
    const ny = d.getFullYear() + (d.getMonth() === 11 ? 1 : 0)
    const nm = (d.getMonth() + 1) % 12
    let target: Date
    if (sub === 'day') {
      const wantDay = parseInt(parts[2], 10)
      const lastDay = new Date(ny, nm + 1, 0).getDate()
      target = new Date(ny, nm, Math.min(wantDay, lastDay))
    } else if (sub === 'nth') {
      target = nthWeekdayOfMonth(ny, nm, parseInt(parts[3], 10), parseInt(parts[2], 10))
    } else if (sub === 'last') {
      target = lastWeekdayOfMonth(ny, nm, parseInt(parts[2], 10))
    } else {
      return null
    }
    target.setHours(hh, mm, 0, 0)
    return target
  }
  return null
}

export function expandOccurrences(
  dueDate: string, repeat: string | null | undefined, rangeStart: Date, rangeEnd: Date,
): string[] {
  if (!dueDate) return []
  const anchor = new Date(dueDate)
  if (isNaN(anchor.getTime())) return []
  const timed = /T\d{2}:\d{2}/.test(dueDate)
  const fmt = (d: Date) => (timed ? toLocalDatetimeStr(d) : toDateOnlyStr(d))
  const norm = normalizeRepeat(repeat, anchor)

  const out: string[] = []
  if (norm === 'none') {
    if (anchor >= rangeStart && anchor <= rangeEnd) out.push(fmt(anchor))
    return out
  }
  const hh = anchor.getHours(), mm = anchor.getMinutes()
  let d: Date | null = new Date(anchor)
  let guard = 10000
  while (d && d <= rangeEnd) {
    if (--guard <= 0) break
    if (d >= rangeStart) out.push(fmt(d))
    d = stepOnce(d, norm, hh, mm)
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && npx vitest run src/recurrence.test.ts`
Expected: PASS — all cases green.

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/recurrence.ts mobile/src/recurrence.test.ts
git commit -m "feat(mobile): recurrence engine — web-identical grammar + range occurrence enumeration"
```

---

### Task 4: Detail "when" block (date / time / duration / recurrence editing)

**Files:**
- Modify: `mobile/src/screens/Detail.ts`
- Regenerate: `mobile/www/js/app.js`

**Interfaces:**
- Consumes: `datePart`, `timePart`, `composeWhen` from `./datetime`; `normalizeRepeat`, `simpleRepeat` from `./recurrence`; `NoteRec.repeat`/`NoteRec.duration_min` from Task 2.
- Produces: no new exported interface. Persists `{ due_date }`, `{ duration_min }`, `{ repeat }` patches through the existing `onUpdate` prop.

- [ ] **Step 1: Add imports**

In `mobile/src/screens/Detail.ts`, add after the existing imports (after `import type { NoteRec } from '../notes'`):

```ts
import { datePart, timePart, composeWhen } from '../datetime'
import { normalizeRepeat, simpleRepeat } from '../recurrence'
```

- [ ] **Step 2: Add the "when" state and handlers**

In `Detail(...)`, after the existing `const [rows, setRows] = useState<Row[]>(toRows(note.items || []))` line, add:

```ts
  const [dateStr, setDateStr] = useState(datePart(note.due_date))
  const [timeStr, setTimeStr] = useState(timePart(note.due_date))
  const [dur, setDur] = useState<number>(note.duration_min ?? 0)
  const [rep, setRep] = useState<string>(simpleRepeat(note.repeat))

  const DURATIONS = [15, 25, 45, 60, 90]

  // Persist due_date + (re-derived) repeat together: when the date moves, a
  // weekly/monthly rule must re-derive its weekday / day-of-month from the new
  // date. composeWhen returns "" (not null) so a cleared date persists through
  // update_note_record (which skips None).
  function commitWhen(nd: string, nt: string, nr: string) {
    const due = composeWhen(nd, nt, new Date())
    const repeat = nr === 'none' || !due ? 'none' : normalizeRepeat(nr, new Date(due))
    onUpdate({ due_date: due, repeat })
  }
  const onDate = (v: string) => { setDateStr(v); commitWhen(v, timeStr, rep) }
  const onTime = (v: string) => { setTimeStr(v); commitWhen(dateStr, v, rep) }
  const onRepeat = (v: string) => { setRep(v); commitWhen(dateStr, timeStr, v) }
  const onDuration = (v: number) => { const nv = dur === v ? 0 : v; setDur(nv); onUpdate({ duration_min: nv }) }
```

- [ ] **Step 3: Render the "when" block**

In `mobile/src/screens/Detail.ts`, insert this block inside the returned template, immediately BEFORE the `<div ...>break it down</div>` line (i.e. between the description `</textarea>` and the "break it down" label):

```ts
      <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 4px 0' }}>
        <div style=${{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input type="date" value=${dateStr} onInput=${(e: any) => onDate(e.target.value)}
            style=${{ flex: 1, minWidth: 0, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px',
              padding: '10px 12px', font: `400 14px ${T.mono}`, color: T.text }} />
          <input type="time" value=${timeStr} onInput=${(e: any) => onTime(e.target.value)}
            style=${{ width: '118px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px',
              padding: '10px 12px', font: `400 14px ${T.mono}`, color: T.text }} />
        </div>

        ${timeStr ? html`
          <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>for</span>
            ${DURATIONS.map(m => html`
              <span key=${m} onClick=${() => onDuration(m)} style=${{ padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
                font: `500 12.5px ${T.mono}`,
                border: `1px solid ${dur === m ? T.accent : T.card2}`,
                background: dur === m ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                color: dur === m ? T.accent : T.muted }}>${m}m</span>`)}
          </div>` : ''}

        <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>repeat</span>
          ${(['none', 'daily', 'weekly', 'monthly', 'yearly']).map(r => html`
            <span key=${r} onClick=${() => onRepeat(r)} style=${{ padding: '6px 12px', borderRadius: '999px',
              cursor: dateStr || r === 'none' ? 'pointer' : 'default',
              font: `500 12.5px ${T.mono}`, opacity: dateStr || r === 'none' ? 1 : 0.4,
              border: `1px solid ${rep === r ? T.accent : T.card2}`,
              background: rep === r ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
              color: rep === r ? T.accent : T.muted }}>${r}</span>`)}
        </div>
      </div>
```

- [ ] **Step 4: Typecheck + rebuild the bundle**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

Run: `cd mobile && node build.mjs`
Expected: builds `www/js/app.js` (now including `datetime.ts` + `recurrence.ts` via the Detail import) with no error.

- [ ] **Step 5: Confirm the existing mobile suites still pass**

Run: `cd mobile && npx vitest run`
Expected: PASS — `datetime`, `recurrence`, `tasks`, `subtasks`, `nav` suites all green.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/screens/Detail.ts mobile/www/js/app.js
git commit -m "feat(mobile): Detail date/time/duration/recurrence editing (the when block)"
```

---

### Task 5: APK rebuild + docs + on-device proof

**Files:**
- Modify: `docs/productivity/mobile-build.md`
- Build: `dist/odysseus.apk` (gitignored — NOT committed)

**Interfaces:**
- Consumes: the rebuilt `mobile/www/js/app.js` from Task 4.
- Produces: an installable APK + a documented proof checklist.

- [ ] **Step 1: Rebuild the APK**

Run: `bash mobile/build-apk.sh`
Expected: prints `APK → dist/odysseus.apk (…M)` and exits 0.

- [ ] **Step 2: Verify the new modules are packaged in the bundle**

Run: `grep -c "composeWhen\|expandOccurrences" mobile/www/js/app.js`
Expected: ≥ 1 (the Detail import pulls `datetime.ts`; `recurrence.ts` is bundled via Detail's `normalizeRepeat`/`simpleRepeat` import — `composeWhen` and `simpleRepeat` are both present).

Run: `unzip -l dist/odysseus.apk | grep -c "assets/public/js/app.js"`
Expected: `1` (the bundle is packaged inside the APK).

- [ ] **Step 3: Document the slice + proof steps**

In `docs/productivity/mobile-build.md`, append a new section:

```markdown
## Calendar Slice A — dates are real (2026-07-24)

Adds `Note.duration_min` (nullable int; **redeploy the server** — `docker compose up -d --build` — so the startup migration adds the column), fixes Capture to store a real `YYYY-MM-DDTHH:MM`, and adds date/time/duration/recurrence editing to Detail. No calendar views yet (Slice B).

### On-device proof (PENDING)
1. `adb install -r dist/odysseus.apk`, open a task in Detail.
2. Capture "call mum 9pm" → open it → the date shows **today** and the time **21:00** (NOT the literal text "9pm"); on `https://chat.elsiga.ch` the note's due date renders as a real today-9:00pm (not garbage).
3. In Detail set a **date** (native picker), a **time**, a **duration** chip (e.g. 45m), and **repeat = Weekly** → reopen: all persist.
4. On web, the same note shows the due date + a recurring (↻) marker; the recurrence stored is `weekly:<weekday>` (verify in the live DB or via the web reminder behavior).
5. Clear the date in Detail → it persists as cleared (task has no due date on reopen and on web).
```

- [ ] **Step 4: Commit**

```bash
git add docs/productivity/mobile-build.md
git commit -m "docs(mobile): calendar Slice A build + on-device proof steps"
```

---

## Self-Review

**Spec coverage:**
- `duration_min` additive field + migration + wire mapping → Task 1. ✓
- `due_date` format contract (timed `…THH:MM` / all-day `…`) → `datetime.ts` (`hasTimeComponent`/`toLocalDatetimeStr`/`toDateOnlyStr`), Task 2. ✓
- Capture composes a real datetime, no roll-over → Task 2 (`composeDueDate` + Capture edit). ✓
- Detail date/time/duration/recurrence editing → Task 4. ✓
- Recurrence engine (normalize + range expansion, web-identical, reads nth/last) → Task 3. ✓
- Clearing persists as non-`None` (`""` for date, `0` for duration) → `composeWhen` returns `""` (Task 2), `onDuration` clears to `0` (Task 4), tested in Task 1 (`duration_min` 0) + Task 2 (`composeWhen('','')==''`). ✓
- No engine/web/parseCapture change → not in any file list; `mobile/www/js/app.js` rebuilt but `sync-core.js` untouched. ✓
- Backend/mobile tests + build + APK + on-device proof → Tasks 1-5. ✓
- Non-goals (views, stats, settings, AI, focus data, NL-date parsing, advanced recurrence authoring) → none built. ✓

**Placeholder scan:** none. Every code step ships complete code; every command states its expected result.

**Type consistency:** `NoteRec` gains `repeat?: string` + `duration_min?: number | null` (Task 2 Step 5), consumed by Detail (Task 4). `datetime.ts` signatures (Task 2 Interfaces) are used verbatim by `recurrence.ts` (`toLocalDatetimeStr`/`toDateOnlyStr`) and Detail (`datePart`/`timePart`/`composeWhen`). `recurrence.ts` exports `normalizeRepeat`/`simpleRepeat`/`expandOccurrences` (Task 3 Interfaces), and Detail imports exactly `normalizeRepeat`/`simpleRepeat` (Task 4 Step 1). `duration_min` is an integer everywhere (Python `INTEGER`, TS `number | null`; `0` = cleared). `onUpdate` patches use only `NoteRec` keys (`due_date`, `repeat`, `duration_min`, `items`, `note_type`, `title`, `content`).
