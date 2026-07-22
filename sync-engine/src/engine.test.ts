import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './db'
import { syncedUpsert } from './localWrite'
import { createSyncClient } from './engine'

beforeEach(async () => { await db.notes.clear(); await db.outbox.clear(); await db.meta.clear() })

function fakeServer() {
  const store = new Map<string, any>()
  let seq = 0
  const log: any[] = []
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://t')
    if (url.pathname.endsWith('/push')) {
      const { changes } = JSON.parse(String(init!.body))
      const results = changes.map((ch: any) => {
        if (ch.op === 'delete') { store.delete(ch.id); log.push({ ...ch, seq: ++seq }); return { entity: 'note', id: ch.id, op: 'delete', rev: null, record: null } }
        const prev = store.get(ch.id)
        const rev = (prev?.rev ?? 0) + 1
        const rec = { ...ch.record, id: ch.id, rev, updated_at: ch.editedAt }
        store.set(ch.id, rec); log.push({ ...ch, seq: ++seq })
        return { entity: 'note', id: ch.id, op: 'upsert', rev, record: rec }
      })
      return new Response(JSON.stringify({ results, cursor: seq }), { status: 200 })
    }
    const cursor = Number(url.searchParams.get('cursor') || 0)
    const changes = cursor <= 0
      ? [...store.values()].map((r) => ({ entity: 'note', id: r.id, op: 'upsert', rev: r.rev, record: r }))
      : log.filter((l) => l.seq > cursor).map((l) => { const r = store.get(l.id); return r ? { entity: 'note', id: r.id, op: 'upsert', rev: r.rev, record: r } : { entity: 'note', id: l.id, op: 'delete', rev: null, record: null } })
    return new Response(JSON.stringify({ changes, cursor: seq, hasMore: false }), { status: 200 })
  }
}

describe('engine', () => {
  it('pushes a local note and reconciles rev without duplicating on echo', async () => {
    const client = createSyncClient({ fetchFn: fakeServer() as any })
    await syncedUpsert({ id: 'n1', title: 'hello' })
    await client.syncOnce()
    let row = await db.notes.get('n1')
    expect(row?._baseRev).toBe(1)
    expect(row?._dirty).toBe(0)
    // second sync pulls our own echo back — must not clobber or duplicate
    await client.syncOnce()
    row = await db.notes.get('n1')
    expect(row?._baseRev).toBe(1)
    expect((await db.notes.toArray()).length).toBe(1)
  })

  it('applies a remote note on pull', async () => {
    const server = fakeServer()
    // seed the server via a first client
    const c1 = createSyncClient({ fetchFn: server as any })
    await syncedUpsert({ id: 'remote1', title: 'from-other-device' })
    await c1.syncOnce()
    // fresh local store, pull it down
    await db.notes.clear(); await db.outbox.clear(); await db.meta.clear()
    const c2 = createSyncClient({ fetchFn: server as any })
    await c2.syncOnce()
    expect((await db.notes.get('remote1'))?.title).toBe('from-other-device')
  })

  it('skips a stale lower-rev echo when local is ahead (rev guard)', async () => {
    const client = createSyncClient({ fetchFn: fakeServer() as any })
    await syncedUpsert({ id: 'n1', title: 'v1' })
    await client.syncOnce()                                  // server rev1; local _baseRev=1,_dirty=0
    // Local has advanced past the server's rev (an edit not yet reflected server-side)
    await db.notes.update('n1', { title: 'newer-local', _baseRev: 5, _dirty: 0 })
    await db.meta.put({ key: 'cursor', value: 0 })           // force next pull to re-deliver rev1
    await client.syncOnce()                                  // pull returns n1 rev1 → rev guard must skip
    expect((await db.notes.get('n1'))?.title).toBe('newer-local')
  })

  it('skips an echo while a local edit is pending (dirty guard)', async () => {
    const client = createSyncClient({ fetchFn: fakeServer() as any })
    await syncedUpsert({ id: 'n2', title: 'v1' })
    await client.syncOnce()                                  // server rev1; local _baseRev=1
    // A pending local edit with a LOWER baseRev so the rev guard would NOT catch it —
    // only the dirty guard can. No outbox entry (direct update), so pushOnce is a no-op.
    await db.notes.update('n2', { title: 'dirty-local', _dirty: 1, _baseRev: 0 })
    await db.meta.put({ key: 'cursor', value: 0 })
    await client.syncOnce()                                  // pull returns n2 rev1 (>baseRev 0) but local _dirty → skip
    expect((await db.notes.get('n2'))?.title).toBe('dirty-local')
  })
})

describe('authHeader + apiBase seam', () => {
  it('sends Authorization and hits the absolute base URL on pull', async () => {
    await db.meta.put({ key: 'cursor', value: 0 })
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
      return { ok: true, json: async () => ({ changes: [], cursor: 0, hasMore: false }) }
    }) as any
    const client = createSyncClient({
      apiBase: 'https://chat.elsiga.ch/api/sync',
      fetchFn,
      authHeader: () => ({ Authorization: 'Bearer ody_test' }),
    })
    await client.syncOnce()
    const pull = calls.find((c) => c.url.includes('/pull'))!
    expect(pull.url.startsWith('https://chat.elsiga.ch/api/sync/pull')).toBe(true)
    expect(pull.headers.Authorization).toBe('Bearer ody_test')
  })

  it('omits Authorization when no authHeader is given (web path unchanged)', async () => {
    await db.meta.put({ key: 'cursor', value: 0 })
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
      return { ok: true, json: async () => ({ changes: [], cursor: 0, hasMore: false }) }
    }) as any
    const client = createSyncClient({ fetchFn })
    await client.syncOnce()
    const pull = calls.find((c) => c.url.includes('/pull'))!
    expect(pull.url.startsWith('/api/sync/pull')).toBe(true)
    expect(pull.headers.Authorization).toBeUndefined()
  })
})
