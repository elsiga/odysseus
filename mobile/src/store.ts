import { useState, useEffect, useRef } from './html'
import { notesRepo, createSyncClient, API_BASE, type NoteRec } from './notes'
import { getToken } from './token'

export function useNotesStore() {
  const [notes, setNotes] = useState<NoteRec[]>([])
  const [status, setStatus] = useState('')
  const client = useRef<null | ReturnType<typeof createSyncClient>>(null)

  async function refresh() {
    const all = await notesRepo.list()
    setNotes(all.filter(n => !n.archived).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
  }
  async function syncNow() { await client.current?.syncOnce(); await refresh() }

  useEffect(() => { (async () => {
    await refresh()
    const t = await getToken(); if (!t) { setStatus('no token'); return }
    const c = createSyncClient({ apiBase: API_BASE, authHeader: () => ({ Authorization: `Bearer ${t}` }) })
    client.current = c; c.start(); setStatus('syncing')
    await c.syncOnce(); await refresh(); setStatus(navigator.onLine ? 'synced' : 'offline')
  })() }, [])

  async function addTask(data: Partial<NoteRec>) { await notesRepo.create({ done: false, bucket: 'today', ...data }); await refresh(); void syncNow() }
  async function toggle(n: NoteRec) { await notesRepo.update(n.id, { done: !n.done }); await refresh(); void syncNow() }
  async function update(id: string, patch: Partial<NoteRec>) { await notesRepo.update(id, patch); await refresh(); void syncNow() }
  async function remove(n: NoteRec) { await notesRepo.remove(n.id); await refresh(); void syncNow() }

  return { notes, status, refresh, addTask, toggle, remove, update, syncNow }
}
