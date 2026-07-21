import Dexie, { type Table } from 'dexie'

export type NoteRow = Record<string, unknown> & {
  id: string; _dirty: 0 | 1; _baseRev: number; _editedAt: string
}
export type OutboxRow = {
  seq?: number; entity: 'note'; id: string; op: 'upsert' | 'delete'; editedAt: string
}
export type KV = { key: string; value: unknown }

class ProductivityDB extends Dexie {
  notes!: Table<NoteRow, string>
  outbox!: Table<OutboxRow, number>
  meta!: Table<KV, string>
  constructor() {
    super('odysseus-productivity')
    this.version(1).stores({ notes: 'id, updated_at', outbox: '++seq, id', meta: 'key' })
  }
}

export const db = new ProductivityDB()
