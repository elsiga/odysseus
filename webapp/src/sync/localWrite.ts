import type { Table } from 'dexie'
import type { EntityKind, FieldPatch } from '../shared'
import { db as defaultDb, type OutboxRow } from '../db/db'
import { nextHlc } from './hlc'

type Dbi = typeof defaultDb
// CRITICAL invariant (carried from Task 8): the backend's synced-field set excludes
// updatedAt, id, and owner — apply_push raises INVALID_FIELD for anything else.
// `owner` is not a property of client Task rows at all, so it is excluded by
// construction; `id` and `updatedAt` are meta fields and must never be journaled
// as synced fields.
const META_FIELDS = new Set(['id', 'updatedAt', '_dirty', '_fieldTs'])

// Assigned by the sync engine (Task 10) to debounce a cycle after local writes.
export let notifySyncOfLocalWrite: () => void = () => {}
export function setLocalWriteListener(fn: () => void) {
  notifySyncOfLocalWrite = fn
}

function patchFields(values: Record<string, unknown>, ts: string): Record<string, FieldPatch> {
  const fields: Record<string, FieldPatch> = {}
  for (const [k, v] of Object.entries(values)) {
    if (!META_FIELDS.has(k)) fields[k] = { v: v as FieldPatch['v'], ts }
  }
  return fields
}

export async function syncedCreate<T extends { id: string }>(
  dbi: Dbi, entity: EntityKind, table: Table<T, string>, row: T,
): Promise<void> {
  await dbi.transaction('rw', [table, dbi.outbox, dbi.syncMeta], async () => {
    const ts = await nextHlc(dbi)
    const fields = patchFields(row as Record<string, unknown>, ts)
    const fieldTs = Object.fromEntries(Object.keys(fields).map((f) => [f, ts]))
    await table.add({ ...row, _dirty: 1, _fieldTs: fieldTs })
    await dbi.outbox.add({ entity, entityId: row.id, fields } satisfies OutboxRow)
  })
  notifySyncOfLocalWrite()
}

export async function syncedUpdate<T>(
  dbi: Dbi, entity: EntityKind, table: Table<T, string>, id: string, patch: Record<string, unknown>,
): Promise<void> {
  await dbi.transaction('rw', [table, dbi.outbox, dbi.syncMeta], async () => {
    const ts = await nextHlc(dbi)
    const fields = patchFields(patch, ts)
    const existing = (await table.get(id)) as { _fieldTs?: Record<string, string> } | undefined
    const fieldTs = { ...existing?._fieldTs, ...Object.fromEntries(Object.keys(fields).map((f) => [f, ts])) }
    await table.update(id, { ...patch, _dirty: 1, _fieldTs: fieldTs } as never)
    if (Object.keys(fields).length > 0) {
      await dbi.outbox.add({ entity, entityId: id, fields } satisfies OutboxRow)
    }
  })
  notifySyncOfLocalWrite()
}
