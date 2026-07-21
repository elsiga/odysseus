import { z } from 'zod'

// REDUCTION (Slice 1, task-only): ember's entityKindSchema includes
// 'task' | 'subtask' | 'project' | 'session' | 'session_event' | 'memory_entry'.
// Slice 1 only syncs tasks, so the enum is reduced to just 'task'.
export const entityKindSchema = z.enum(['task'])
export type EntityKind = z.infer<typeof entityKindSchema>

// uuidv7 — zod's .uuid() historically rejects version 7, so match the shape ourselves.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

const jsonValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const fieldPatchSchema = z.object({ v: jsonValue, ts: z.string().min(20) })
export type FieldPatch = z.infer<typeof fieldPatchSchema>

export const entityPatchSchema = z.object({
  entity: entityKindSchema,
  entityId: uuid,
  fields: z.record(z.string(), fieldPatchSchema),
})
export type EntityPatch = z.infer<typeof entityPatchSchema>

export const pushRequestSchema = z.object({
  deviceId: z.string().min(1).max(64),
  patches: z.array(entityPatchSchema).max(200),
})
export type PushRequest = z.infer<typeof pushRequestSchema>

export const pushResponseSchema = z.object({ applied: z.number().int(), serverSeq: z.number().int() })
export type PushResponse = z.infer<typeof pushResponseSchema>

export const pullChangeSchema = entityPatchSchema.extend({ seq: z.number().int() })
export type PullChange = z.infer<typeof pullChangeSchema>

export const pullResponseSchema = z.object({
  changes: z.array(pullChangeSchema),
  cursor: z.number().int(),
  hasMore: z.boolean(),
})
export type PullResponse = z.infer<typeof pullResponseSchema>
