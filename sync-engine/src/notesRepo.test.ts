import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { notesRepo } from './notesRepo'

beforeEach(async () => { await db.notes.clear(); await db.outbox.clear() })

describe('notesRepo', () => {
  it('create mints an id and list returns it without meta fields', async () => {
    const saved = await notesRepo.create({ title: 'hi', items: [{ text: 'a', done: false }] })
    expect(saved.id).toBeTruthy()
    const list = await notesRepo.list()
    expect(list.length).toBe(1)
    expect((list[0] as any)._dirty).toBeUndefined()
    expect((list[0] as any).title).toBe('hi')
  })

  it('update merges a patch; remove deletes', async () => {
    const n = await notesRepo.create({ title: 'a' })
    await notesRepo.update(n.id, { color: 'red' })
    expect((await notesRepo.list())[0]).toMatchObject({ title: 'a', color: 'red' })
    await notesRepo.remove(n.id)
    expect((await notesRepo.list()).length).toBe(0)
  })
})
