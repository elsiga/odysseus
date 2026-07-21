import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { syncedUpsert, syncedDelete } from './localWrite'

beforeEach(async () => { await db.notes.clear(); await db.outbox.clear() })

describe('localWrite', () => {
  it('upsert writes a dirty row + upsert outbox entry', async () => {
    await syncedUpsert({ id: 'n1', title: 'hi' })
    const row = await db.notes.get('n1')
    expect(row?._dirty).toBe(1)
    expect(typeof row?._editedAt).toBe('string')
    const ob = await db.outbox.toArray()
    expect(ob[0]).toMatchObject({ entity: 'note', id: 'n1', op: 'upsert' })
  })

  it('delete removes the row + appends a delete outbox entry', async () => {
    await syncedUpsert({ id: 'n1', title: 'hi' })
    await syncedDelete('n1')
    expect(await db.notes.get('n1')).toBeUndefined()
    const ops = (await db.outbox.toArray()).map((o) => o.op)
    expect(ops).toContain('delete')
  })
})
