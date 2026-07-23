import { describe, it, expect } from 'vitest'
import { parseCapture } from './parseCapture'

describe('parseCapture', () => {
  it('extracts project, bucket, time, urgency and cleans the title', () => {
    const r = parseCapture('pay rent @flat today 9pm !!')
    expect(r.title).toBe('pay rent')
    expect(r.project).toBe('flat')
    expect(r.bucket).toBe('today')
    expect(r.dueTime).toBe('9pm')
    expect(r.urgency).toBe(2)
  })

  it('defaults: no tokens → plain title, null/zero fields', () => {
    const r = parseCapture('call the dentist')
    expect(r.title).toBe('call the dentist')
    expect(r.project).toBeNull()
    expect(r.bucket).toBeNull()
    expect(r.dueTime).toBeNull()
    expect(r.urgency).toBe(0)
  })

  it('single ! is urgency 1; 24h time is recognized', () => {
    const r = parseCapture('review notes soon 14:30 !')
    expect(r.bucket).toBe('soon')
    expect(r.dueTime).toBe('14:30')
    expect(r.urgency).toBe(1)
  })

  it('segments cover the whole input in order', () => {
    const r = parseCapture('x @p today')
    expect(r.segments.map(s => s.text).join('')).toBe('x @p today')
    expect(r.segments.some(s => s.kind === 'project' && s.text === '@p')).toBe(true)
    expect(r.segments.some(s => s.kind === 'bucket' && s.text === 'today')).toBe(true)
  })

  it('3+ consecutive ! saturates urgency at 2', () => {
    const r = parseCapture('ship it !!!')
    expect(r.urgency).toBe(2)
    expect(r.segments.map(s => s.text).join('')).toBe('ship it !!!')
  })
})
