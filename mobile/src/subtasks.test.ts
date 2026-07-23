import { describe, it, expect } from 'vitest'
import { deriveNoteType, subtaskProgress, nextNoteType, toRows, toItems, type Subtask } from './subtasks'

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

describe('nextNoteType', () => {
  it('undefined current, empty items → note', () => {
    expect(nextNoteType(undefined, [])).toBe('note')
  })
  it('note current, non-empty items → checklist', () => {
    expect(nextNoteType('note', [{ text: 'a', done: false }])).toBe('checklist')
  })
  it('checklist current, empty items → note', () => {
    expect(nextNoteType('checklist', [])).toBe('note')
  })
  it('legacy goal type with items → undefined (untouched)', () => {
    expect(nextNoteType('goal', [{ text: 'a', done: false }])).toBeUndefined()
  })
  it('legacy todo type, empty items → undefined (untouched)', () => {
    expect(nextNoteType('todo', [])).toBeUndefined()
  })
})

describe('toRows / toItems round-trip', () => {
  it('preserves unknown web item keys and strips only rid', () => {
    const webItem: Subtask = {
      text: 'step 1', done: false,
      id: 'srv-1', indent: 1, agent_status: 'running', agent_session_id: 's-9',
    }
    const rows = toRows([webItem])
    const roundTripped = toItems(rows)[0]
    expect(roundTripped.id).toBe('srv-1')
    expect(roundTripped.indent).toBe(1)
    expect(roundTripped.agent_status).toBe('running')
    expect(roundTripped.agent_session_id).toBe('s-9')
    expect((roundTripped as any).rid).toBeUndefined()
  })
})
