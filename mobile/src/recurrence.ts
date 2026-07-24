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
  // Weekly rules: if the anchor's weekday doesn't match, snap the first emitted
  // occurrence forward to the target weekday (an off-weekday anchor otherwise
  // leaks through as the first item).
  if (/^weekly:/.test(norm)) {
    const twd = parseInt(norm.split(':')[1], 10)
    if (!isNaN(twd) && d.getDay() !== twd) d.setDate(d.getDate() + ((twd - d.getDay() + 7) % 7))
  }
  let guard = 10000
  while (d && d <= rangeEnd) {
    if (--guard <= 0) break
    if (d >= rangeStart) out.push(fmt(d))
    d = stepOnce(d, norm, hh, mm)
  }
  return out
}

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
