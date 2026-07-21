import type { EntityPatch, PullChange, PullResponse, PushResponse, FieldPatch } from '../shared'
import type { Table } from 'dexie'
import { db as defaultDb, type OutboxRow } from '../db/db'
import { getDeviceId } from './hlc'
import { nextHlc } from './hlc'
import { setLocalWriteListener } from './localWrite'
import { setSyncStatus } from './status'

type Dbi = typeof defaultDb

// REDUCTION (Slice 1, task-only): ember's TABLES also maps subtask/project/session/
// session_event/memory_entry. Slice 1's EntityKind enum is reduced to just 'task'
// (see shared/entities.ts), so only that mapping is kept.
const TABLES: Record<EntityPatch['entity'], (dbi: Dbi) => Table<Record<string, unknown>, string>> = {
  task: (d) => d.tasks as never,
}
const META = new Set(['id', '_dirty', '_fieldTs'])
const CURSOR_KEY = 'cursor'
const BOOTSTRAP_KEY = 'bootstrapped'
const BATCH = 200
const BACKOFF_MIN = 5_000
const BACKOFF_MAX = 300_000

export interface SyncClientOpts {
  db?: Dbi
  apiBase: string
  getToken: () => Promise<string | null>
  // Narrowed from `typeof fetch`: engine.ts only ever calls fetchFn with a string
  // URL (never Request/URL), so this is the actual contract and lets test doubles
  // (which only accept `string`) satisfy it without a variance error.
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>
}
export interface SyncClient {
  syncOnce(): Promise<void>
  start(): void
  stop(): void
}

export function createSyncClient(opts: SyncClientOpts): SyncClient {
  const dbi = opts.db ?? defaultDb
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis)
  let queue: Promise<void> = Promise.resolve()
  let failures = 0
  let nextAllowedAt = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let intervalTimer: ReturnType<typeof setInterval> | undefined
  const onOnline = () => void syncOnce()

  // COOKIE AUTH ADAPTATION (Slice 1): ember's api() always sends `authorization:
  // Bearer ${token}` because getToken() always resolves a real bearer token there.
  // In Slice 1, getToken() resolves null (auth is via same-origin session cookie),
  // so the Authorization header must be omitted entirely rather than sent as the
  // literal string "Bearer null". credentials is set explicitly so the cookie
  // rides along even if a caller's fetchFn/environment doesn't default to it.
  async function api(path: string, init?: RequestInit): Promise<Response> {
    const token = await opts.getToken()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    }
    if (token) headers.authorization = `Bearer ${token}`
    return fetchFn(`${opts.apiBase}${path}`, {
      ...init,
      headers,
      credentials: init?.credentials ?? 'same-origin',
    })
  }

  async function bootstrapIfNeeded() {
    const cursor = (await dbi.syncMeta.get(CURSOR_KEY))?.value as number | undefined
    if (cursor !== undefined && cursor > 0) return
    if ((await dbi.syncMeta.get(BOOTSTRAP_KEY))?.value === 1) return
    // First sync: enqueue a full-row patch for EVERY dirty row, even ones that already
    // have outbox entries. Pre-slice-3 rows have no outbox entry (or only a partial one
    // if edited before first sign-in) — a partial patch for a row the server has never
    // seen fails its NOT NULL insert (400 INCOMPLETE_CREATE) and bricks sync in backoff.
    // Duplicates are harmless: pushOnce coalesces per entity keeping the newest ts per
    // field, and this patch is built from CURRENT row state (edits included), so its
    // fresh HLC winning the coalesce changes no values. The persistent bootstrapped flag
    // makes this run once — the enqueued rows survive in the outbox across restarts, so
    // a failing first push must not re-enqueue on every retry.
    for (const [entity, pick] of Object.entries(TABLES) as [EntityPatch['entity'], (d: Dbi) => Table<Record<string, unknown>, string>][]) {
      const rows = await pick(dbi).toArray()
      for (const row of rows) {
        if (row._dirty !== 1) continue
        const ts = await nextHlc(dbi)
        const fields: Record<string, FieldPatch> = {}
        for (const [k, v] of Object.entries(row)) {
          if (!META.has(k) && k !== 'updatedAt') fields[k] = { v: v as FieldPatch['v'], ts }
        }
        await dbi.outbox.add({ entity, entityId: String(row.id), fields } satisfies OutboxRow)
      }
    }
    await dbi.syncMeta.put({ key: BOOTSTRAP_KEY, value: 1 })
  }

  async function pushOnce() {
    const rows = await dbi.outbox.orderBy('seq').toArray()
    if (rows.length === 0) return
    // Coalesce to one patch per entity, newest ts per field.
    const byEntity = new Map<string, { patch: EntityPatch; seqs: number[] }>()
    for (const row of rows) {
      const key = `${row.entity}:${row.entityId}`
      const cur = byEntity.get(key)
      if (!cur) {
        byEntity.set(key, { patch: { entity: row.entity, entityId: row.entityId, fields: { ...row.fields } }, seqs: [row.seq!] })
      } else {
        for (const [f, fp] of Object.entries(row.fields)) {
          const prev = cur.patch.fields[f]
          if (!prev || prev.ts < fp.ts) cur.patch.fields[f] = fp
        }
        cur.seqs.push(row.seq!)
      }
    }
    const entries = [...byEntity.values()]
    const deviceId = await getDeviceId(dbi)
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH)
      const res = await api('/push', {
        method: 'POST',
        body: JSON.stringify({ deviceId, patches: batch.map((e) => e.patch) }),
      })
      if (!res.ok) throw new HttpError(res.status)
      await res.json() as PushResponse
      await dbi.outbox.bulkDelete(batch.flatMap((e) => e.seqs))
    }
  }

  async function applyChange(change: PullChange) {
    const table = TABLES[change.entity](dbi)
    await dbi.transaction('rw', table, async () => {
      const row = await table.get(change.entityId)
      if (!row) {
        const values: Record<string, unknown> = { id: change.entityId }
        const fieldTs: Record<string, string> = {}
        for (const [f, fp] of Object.entries(change.fields)) {
          values[f] = fp.v
          fieldTs[f] = fp.ts
        }
        await table.add({ ...values, _dirty: 0, _fieldTs: fieldTs })
        return
      }
      const fieldTs = { ...(row._fieldTs as Record<string, string> | undefined) }
      const updates: Record<string, unknown> = {}
      for (const [f, fp] of Object.entries(change.fields)) {
        const local = fieldTs[f]
        if (local === undefined || local < fp.ts) { // strict >: own echoes (equal ts) are skipped
          updates[f] = fp.v
          fieldTs[f] = fp.ts
        }
      }
      if (Object.keys(updates).length > 0) await table.update(change.entityId, { ...updates, _fieldTs: fieldTs })
    })
  }

  async function pullOnce() {
    for (;;) {
      const cursor = ((await dbi.syncMeta.get(CURSOR_KEY))?.value as number | undefined) ?? 0
      const res = await api(`/pull?cursor=${cursor}&limit=500`)
      if (!res.ok) throw new HttpError(res.status)
      const page = await res.json() as PullResponse
      for (const change of page.changes) await applyChange(change)
      await dbi.syncMeta.put({ key: CURSOR_KEY, value: page.cursor })
      if (!page.hasMore) return
    }
  }

  function syncOnce(): Promise<void> {
    const run = queue.then(async () => {
      if (Date.now() < nextAllowedAt) return
      setSyncStatus('syncing')
      try {
        await bootstrapIfNeeded()
        await pushOnce()
        await pullOnce()
        failures = 0
        nextAllowedAt = 0
        setSyncStatus('idle')
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) return setSyncStatus('signed-out')
        failures += 1
        nextAllowedAt = Date.now() + Math.min(BACKOFF_MIN * 2 ** (failures - 1), BACKOFF_MAX)
        setSyncStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
      }
    })
    queue = run.catch(() => {})
    return run
  }

  function start() {
    setLocalWriteListener(() => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void syncOnce(), 3_000)
    })
    window.addEventListener('online', onOnline)
    intervalTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void syncOnce()
    }, 60_000)
    void syncOnce()
  }

  function stop() {
    setLocalWriteListener(() => {})
    window.removeEventListener('online', onOnline)
    clearTimeout(debounceTimer)
    clearInterval(intervalTimer)
  }

  return { syncOnce, start, stop }
}

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`)
  }
}
