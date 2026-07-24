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
