import { db, type NoteRow } from './db'
import { syncedUpsert, syncedDelete } from './localWrite'

const META = new Set(['_dirty', '_baseRev', '_editedAt'])
function clean(row: NoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!META.has(k)) out[k] = v
  return out
}
function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : 'n_' + Math.random().toString(36).slice(2)
}

export const notesRepo = {
  async list(): Promise<Record<string, unknown>[]> {
    return (await db.notes.toArray()).map(clean)
  },
  async create(note: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = (note.id as string) || newId()
    await syncedUpsert({ ...note, id })
    return clean((await db.notes.get(id))!)
  },
  async update(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await db.notes.get(id)
    await syncedUpsert({ ...(existing ? clean(existing) : {}), ...patch, id })
    return clean((await db.notes.get(id))!)
  },
  async remove(id: string): Promise<void> { await syncedDelete(id) },
  async reorder(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      const row = await db.notes.get(ids[i])
      if (row) await syncedUpsert({ ...clean(row), sort_order: i })
    }
  },
  subscribe(cb: () => void): () => void {
    const h = () => cb()
    db.notes.hook('creating', h); db.notes.hook('updating', h); db.notes.hook('deleting', h)
    return () => { db.notes.hook('creating').unsubscribe(h); db.notes.hook('updating').unsubscribe(h); db.notes.hook('deleting').unsubscribe(h) }
  },
}
