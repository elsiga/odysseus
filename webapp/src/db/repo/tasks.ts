import { uuidv7 } from 'uuidv7'
import type { Bucket, Task } from '../../shared'
import { newTaskFields, deleteTaskFields } from '../../shared'
import { db, type TaskRow } from '../db'
import { syncedCreate, syncedUpdate } from '../../sync/localWrite'

// REDUCTION (Slice 1, task-only): ember's repo/tasks.ts also exports captureTask
// (needs parseShorthand + liveProjects), rebucketTask, uncompleteTask, and
// rebalanceBucket. Slice 1 only needs the 7 functions below.

function now() {
  return new Date().toISOString()
}

async function openBucketRows(bucket: Bucket): Promise<TaskRow[]> {
  const rows = await db.tasks.where('[bucket+sortOrder]').between([bucket, -Infinity], [bucket, Infinity]).toArray()
  return rows.filter((t) => t.deletedAt === null && t.completedAt === null)
}

export async function liveTasksByBucket(bucket: Bucket): Promise<TaskRow[]> {
  return openBucketRows(bucket)
}

// Home's today list keeps completed tasks visible (dimmed, sorted last) so a just-finished
// task doesn't vanish mid-glance — every other bucket/screen still hides completed rows
// via liveTasksByBucket.
export async function liveTodayTasks(): Promise<TaskRow[]> {
  const rows = await db.tasks.where('[bucket+sortOrder]').between(['today', -Infinity], ['today', Infinity]).toArray()
  const open = rows.filter((t) => t.deletedAt === null)
  return open.sort((a, b) => {
    const doneDiff = Number(a.completedAt !== null) - Number(b.completedAt !== null)
    return doneDiff !== 0 ? doneDiff : a.sortOrder - b.sortOrder
  })
}

export async function createTask(input: { title: string; bucket?: Bucket; projectId?: string | null }): Promise<TaskRow> {
  const bucket = input.bucket ?? 'today'
  return db.transaction('rw', [db.tasks, db.outbox, db.syncMeta], async () => {
    const top = (await openBucketRows(bucket))[0]
    const ts = now()
    const fields = newTaskFields(
      { title: input.title, bucket, projectId: input.projectId ?? null },
      { nowIso: ts, topSortOrder: top?.sortOrder },
    )
    const row: TaskRow = { id: uuidv7(), ...fields, updatedAt: ts, _dirty: 1 }
    await syncedCreate(db, 'task', db.tasks, row)
    return row
  })
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  await syncedUpdate(db, 'task', db.tasks, id, { ...patch, updatedAt: now() })
}

export async function completeTask(id: string): Promise<void> {
  await updateTask(id, { completedAt: now() })
}

export async function deleteTask(id: string): Promise<void> {
  await updateTask(id, deleteTaskFields(now()))
}

export async function setTaskSortOrder(id: string, sortOrder: number): Promise<void> {
  await updateTask(id, { sortOrder })
}
