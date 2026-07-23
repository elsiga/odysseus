import { useState, useEffect, useRef } from './html'
import { notesRepo, createSyncClient, API_BASE, type NoteRec } from './notes'
import { getToken } from './token'

// notesRepo.update reads the row OUTSIDE its write transaction, so overlapping
// calls would both read the same base row and the later commit would win.
// Serialize every write through one queue so each read-modify-write observes
// the previous one's commit. A rejected write must not poison the queue for
// subsequent writes, so the queue itself always resolves (never rejects) and
// each caller awaits its own operation's result/throw separately.
let _writeQ: Promise<unknown> = Promise.resolve()
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = _writeQ.then(fn, fn)
  // Swallow the outcome for queue-chaining purposes only, so one rejected
  // write never poisons the queue for the writes behind it.
  _writeQ = run.then(() => undefined, () => undefined)
  return run
}

export function useNotesStore() {
  const [notes, setNotes] = useState<NoteRec[]>([])
  const [status, setStatus] = useState('')
  const client = useRef<null | ReturnType<typeof createSyncClient>>(null)

  async function refresh() {
    const all = await notesRepo.list()
    setNotes(all.filter(n => !n.archived).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
  }
  async function syncNow() { await client.current?.syncOnce(); await refresh() }

  async function startSync(t: string) {
    const c = createSyncClient({ apiBase: API_BASE, authHeader: () => ({ Authorization: `Bearer ${t}` }) })
    client.current = c; c.start(); setStatus('syncing')
    await c.syncOnce(); await refresh(); setStatus(navigator.onLine ? 'synced' : 'offline')
  }

  useEffect(() => { (async () => {
    await refresh()
    const t = await getToken(); if (!t) { setStatus('no token'); return }
    await startSync(t)
  })() }, [])

  async function addTask(data: Partial<NoteRec>) {
    await enqueueWrite(() => notesRepo.create({ done: false, bucket: 'today', ...data }))
    await refresh(); void syncNow()
  }
  async function toggle(n: NoteRec) {
    await enqueueWrite(() => notesRepo.update(n.id, { done: !n.done }))
    await refresh(); void syncNow()
  }
  async function update(id: string, patch: Partial<NoteRec>) {
    await enqueueWrite(() => notesRepo.update(id, patch))
    await refresh(); void syncNow()
  }
  async function remove(n: NoteRec) {
    await enqueueWrite(() => notesRepo.remove(n.id))
    await refresh(); void syncNow()
  }

  return { notes, status, refresh, addTask, toggle, remove, update, syncNow, startSync }
}
