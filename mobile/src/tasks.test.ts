import { describe, it, expect } from 'vitest'
import { bucketOf, activeByBucket, bucketCounts, todayView, pickSuggestion, projectsOf } from './tasks'
import type { NoteRec } from './notes'

const N = (o: Partial<NoteRec>): NoteRec => ({ id: Math.random().toString(36), title: 't', ...o })

describe('tasks derivations', () => {
  const notes: NoteRec[] = [
    N({ id: 'a', bucket: 'today', done: false }),
    N({ id: 'b', bucket: 'today', done: true }),
    N({ id: 'c', bucket: 'soon', done: false, project: 'flat' }),
    N({ id: 'd', bucket: 'someday', done: false, project: 'flat' }),
    N({ id: 'e', archived: true, bucket: 'today', done: false }),
  ]

  it('bucketOf defaults to today', () => {
    expect(bucketOf(N({ bucket: undefined }))).toBe('today')
    expect(bucketOf(N({ bucket: 'soon' }))).toBe('soon')
  })

  it('activeByBucket excludes done and archived', () => {
    const by = activeByBucket(notes)
    expect(by.today.map(n => n.id)).toEqual(['a'])   // b done, e archived
    expect(by.soon.map(n => n.id)).toEqual(['c'])
    expect(by.someday.map(n => n.id)).toEqual(['d'])
  })

  it('bucketCounts counts active per bucket', () => {
    expect(bucketCounts(notes)).toEqual({ today: 1, soon: 1, someday: 1 })
  })

  it('todayView caps and reports overflow', () => {
    const many = Array.from({ length: 7 }, (_, i) => N({ id: 's' + i, bucket: 'today', done: false }))
    const v = todayView(many, 5)
    expect(v.visible).toHaveLength(5)
    expect(v.overflow).toBe(2)
  })

  it('pickSuggestion cycles active today tasks, null when none', () => {
    expect(pickSuggestion(notes, 0)!.id).toBe('a')
    expect(pickSuggestion(notes, 1)!.id).toBe('a')  // only one → wraps
    expect(pickSuggestion([], 0)).toBeNull()
  })

  it('projectsOf lists projects with active counts', () => {
    expect(projectsOf(notes)).toEqual([{ name: 'flat', count: 2 }])
  })
})
