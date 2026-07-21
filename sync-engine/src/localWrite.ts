import { db, type NoteRow } from './db'

export function nowIso(): string { return new Date().toISOString() }

let _listener: (() => void) | null = null
export function setLocalWriteListener(cb: () => void) { _listener = cb }
export function notifyLocalWrite() { if (_listener) _listener() }

export async function syncedUpsert(record: { id: string } & Record<string, unknown>): Promise<void> {
  const editedAt = nowIso()
  await db.transaction('rw', [db.notes, db.outbox], async () => {
    const existing = await db.notes.get(record.id)
    const row: NoteRow = {
      ...record, _dirty: 1, _baseRev: existing?._baseRev ?? 0, _editedAt: editedAt,
    }
    await db.notes.put(row)
    await db.outbox.add({ entity: 'note', id: record.id, op: 'upsert', editedAt })
  })
  notifyLocalWrite()
}

export async function syncedDelete(id: string): Promise<void> {
  const editedAt = nowIso()
  await db.transaction('rw', [db.notes, db.outbox], async () => {
    await db.notes.delete(id)
    await db.outbox.add({ entity: 'note', id, op: 'delete', editedAt })
  })
  notifyLocalWrite()
}
