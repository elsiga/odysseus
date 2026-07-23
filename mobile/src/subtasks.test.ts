import { describe, it, expect } from 'vitest'
import { deriveNoteType, subtaskProgress } from './subtasks'

describe('deriveNoteType', () => {
  it('empty list → note', () => expect(deriveNoteType([])).toBe('note'))
  it('non-empty list → checklist', () =>
    expect(deriveNoteType([{ text: 'a', done: false }])).toBe('checklist'))
})

describe('subtaskProgress', () => {
  it('null and empty → 0/0, ratio 0', () => {
    expect(subtaskProgress(null)).toEqual({ done: 0, total: 0, ratio: 0 })
    expect(subtaskProgress(undefined)).toEqual({ done: 0, total: 0, ratio: 0 })
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0, ratio: 0 })
  })
  it('2 of 5 done → ratio 0.4', () => {
    const items = [
      { text: 'a', done: true }, { text: 'b', done: true },
      { text: 'c', done: false }, { text: 'd', done: false }, { text: 'e', done: false },
    ]
    expect(subtaskProgress(items)).toEqual({ done: 2, total: 5, ratio: 0.4 })
  })
  it('all done → ratio 1', () => {
    expect(subtaskProgress([{ text: 'a', done: true }, { text: 'b', done: true }]))
      .toEqual({ done: 2, total: 2, ratio: 1 })
  })
})
