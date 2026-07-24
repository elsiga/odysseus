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
