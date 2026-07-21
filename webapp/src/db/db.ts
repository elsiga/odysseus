import Dexie, { type Table } from 'dexie'
import type { Task, EntityKind, FieldPatch } from '../shared'

// REDUCTION (Slice 1, task-only): ember's db.ts also declares subtasks, projects,
// sessions, sessionEvents, and memoryEntries tables. Slice 1 only syncs tasks, so
// only tasks/outbox/syncMeta/settings/activeTimer are kept.
export type SyncMeta = { _dirty: 0 | 1; _fieldTs?: Record<string, string> }
export type TaskRow = Task & SyncMeta
export type OutboxRow = { seq?: number; entity: EntityKind; entityId: string; fields: Record<string, FieldPatch> }
export type KV = { key: string; value: unknown }

class OdysseusDB extends Dexie {
  tasks!: Table<TaskRow, string>
  outbox!: Table<OutboxRow, number>
  syncMeta!: Table<KV, string>
  settings!: Table<KV, string>
  activeTimer!: Table<KV, string>

  constructor() {
    super('odysseus-app')
    this.version(1).stores({
      tasks: 'id, bucket, projectId, scheduledAt, updatedAt, [bucket+sortOrder]',
      outbox: '++seq, entityId',
      syncMeta: 'key',
      settings: 'key',
      activeTimer: 'key',
    })
  }
}

export const db = new OdysseusDB()
