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
