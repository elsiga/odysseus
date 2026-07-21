import { db, type NoteRow } from './db'
import { setLocalWriteListener } from './localWrite'

const META = new Set(['_dirty', '_baseRev', '_editedAt'])
const BACKOFF_MIN = 2000, BACKOFF_MAX = 60000

function stripMeta(row: NoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!META.has(k)) out[k] = v
  return out
}

export interface SyncClient { syncOnce(): Promise<void>; start(): void; stop(): void }

export function createSyncClient(opts: { apiBase?: string; fetchFn?: typeof fetch } = {}): SyncClient {
  const apiBase = opts.apiBase ?? '/api/sync'
  const fetchFn = opts.fetchFn ?? ((i: any, init?: any) => fetch(i, init))
  let queue: Promise<void> = Promise.resolve()
  let failures = 0, nextAllowedAt = 0
  let timer: any = null, interval: any = null

  async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetchFn(`${apiBase}${path}`, { credentials: 'same-origin', ...init })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  async function getCursor(): Promise<number> {
    return ((await db.meta.get('cursor'))?.value as number) ?? 0
  }

  async function pushOnce(): Promise<void> {
    const entries = await db.outbox.orderBy('seq').toArray()
    if (!entries.length) return
    const changes = [] as any[]
    for (const e of entries) {
      if (e.op === 'delete') {
        changes.push({ entity: 'note', id: e.id, op: 'delete', editedAt: e.editedAt })
      } else {
        const row = await db.notes.get(e.id)
        if (!row) continue
        changes.push({ entity: 'note', id: e.id, op: 'upsert', baseRev: row._baseRev, editedAt: e.editedAt, record: stripMeta(row) })
      }
    }
    if (!changes.length) {
      await db.outbox.bulkDelete(entries.map((e) => e.seq!))
      return
    }
    const { results } = await api('/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) })
    // Clear exactly what we sent FIRST, so the pending-check below sees only
    // edits that arrived DURING the round-trip.
    await db.outbox.bulkDelete(entries.map((e) => e.seq!))
    for (const r of results as any[]) {
      if (r.op === 'delete') continue
      // A newer local edit arrived mid-sync → leave it dirty; it will push next round.
      if ((await db.outbox.where('id').equals(r.id).count()) > 0) continue
      await db.notes.put({ ...r.record, _dirty: 0, _baseRev: r.rev, _editedAt: r.record.updated_at ?? new Date(0).toISOString() })
    }
  }

  async function applyChange(ch: any): Promise<void> {
    const local = await db.notes.get(ch.id)
    if (ch.op === 'delete') {
      if (!local || local._dirty === 0) await db.notes.delete(ch.id)
      return
    }
    if (local?._dirty === 1) return                 // pending local edit — resolve via push
    if (local && ch.rev <= local._baseRev) return    // own echo / stale
    await db.notes.put({ ...ch.record, _dirty: 0, _baseRev: ch.rev, _editedAt: ch.record.updated_at ?? new Date(0).toISOString() })
  }

  async function pullOnce(): Promise<void> {
    for (;;) {
      const cursor = await getCursor()
      const page = await api(`/pull?cursor=${cursor}&limit=500`)
      for (const ch of page.changes) await applyChange(ch)
      await db.meta.put({ key: 'cursor', value: page.cursor })
      if (!page.hasMore) break
    }
  }

  function syncOnce(): Promise<void> {
    const run = queue.then(async () => {
      if (Date.now() < nextAllowedAt) return
      try {
        await pushOnce(); await pullOnce(); failures = 0; nextAllowedAt = 0
      } catch {
        failures += 1
        nextAllowedAt = Date.now() + Math.min(BACKOFF_MIN * 2 ** (failures - 1), BACKOFF_MAX)
      }
    })
    queue = run.catch(() => {})
    return run
  }

  function start(): void {
    setLocalWriteListener(() => { clearTimeout(timer); timer = setTimeout(() => void syncOnce(), 3000) })
    if (typeof window !== 'undefined') window.addEventListener('online', () => void syncOnce())
    interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void syncOnce()
    }, 60000)
    void syncOnce()
  }

  function stop(): void { clearTimeout(timer); clearInterval(interval) }

  return { syncOnce, start, stop }
}
