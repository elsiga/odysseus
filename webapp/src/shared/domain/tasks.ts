import type { Bucket } from '../entities'
import { sortOrderBefore } from './sortOrder'

export type TaskFields = {
  projectId: string | null
  title: string
  notes: string
  bucket: Bucket
  scheduledAt: string | null
  scheduledDurationMin: number | null
  sortOrder: number
  completedAt: string | null
  createdAt: string
  deletedAt: string | null
}

export function newTaskFields(
  input: {
    title: string
    notes?: string
    bucket?: Bucket
    scheduledAt?: string | null
    durationMin?: number | null
    projectId?: string | null
  },
  ctx: { nowIso: string; topSortOrder: number | undefined },
): TaskFields {
  return {
    projectId: input.projectId ?? null,
    title: input.title,
    notes: input.notes ?? '',
    bucket: input.bucket ?? 'today',
    scheduledAt: input.scheduledAt ?? null,
    scheduledDurationMin: input.durationMin ?? null,
    sortOrder: sortOrderBefore(ctx.topSortOrder),
    completedAt: null,
    createdAt: ctx.nowIso,
    deletedAt: null,
  }
}

export function moveTaskFields(ctx: { bucket: Bucket; topSortOrder: number | undefined }): {
  bucket: Bucket
  sortOrder: number
} {
  return { bucket: ctx.bucket, sortOrder: sortOrderBefore(ctx.topSortOrder) }
}

export function completeTaskFields(nowIso: string): { completedAt: string } {
  return { completedAt: nowIso }
}

export function uncompleteTaskFields(): { completedAt: null } {
  return { completedAt: null }
}

export function deleteTaskFields(nowIso: string): { deletedAt: string } {
  return { deletedAt: nowIso }
}
