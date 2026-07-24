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
