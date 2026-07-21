import { z } from 'zod'

// REDUCTION (Slice 1, task-only): ember's entities.ts also defines subtask,
// project, session, session_event, and memory_entry schemas. Slice 1 only
// syncs tasks, so only taskSchema/Task and bucketSchema/Bucket are ported.
export const bucketSchema = z.enum(['today', 'soon', 'someday'])
export type Bucket = z.infer<typeof bucketSchema>

const isoString = z.string()

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  title: z.string(),
  notes: z.string(),
  bucket: bucketSchema,
  scheduledAt: isoString.nullable(),
  scheduledDurationMin: z.number().int().nullable(),
  sortOrder: z.number(),
  completedAt: isoString.nullable(),
  createdAt: isoString,
  updatedAt: isoString,
  deletedAt: isoString.nullable(),
})
export type Task = z.infer<typeof taskSchema>
