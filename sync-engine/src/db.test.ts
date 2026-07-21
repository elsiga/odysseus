import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { db } from './db'

describe('db', () => {
  it('stores a note row and an outbox entry', async () => {
    await db.notes.put({ id: 'n1', title: 'x', _dirty: 1, _baseRev: 0, _editedAt: '2026-07-21T10:00:00Z' })
    await db.outbox.add({ entity: 'note', id: 'n1', op: 'upsert', editedAt: '2026-07-21T10:00:00Z' })
    expect((await db.notes.get('n1'))?.title).toBe('x')
    expect((await db.outbox.toArray()).length).toBe(1)
  })
})
