export type Subtask = { text: string; done: boolean } & Record<string, unknown>

export function deriveNoteType(items: Subtask[]): 'note' | 'checklist' {
  return items.length > 0 ? 'checklist' : 'note'
}

// Derive note_type ONLY for notes we own the shape of. Legacy web types
// ('todo', 'goal', …) must survive a mobile subtask edit untouched, so we
// return undefined and the caller omits note_type from the patch.
export function nextNoteType(
  current: string | null | undefined,
  items: Subtask[],
): 'note' | 'checklist' | undefined {
  if (current == null || current === 'note' || current === 'checklist') {
    return deriveNoteType(items)
  }
  return undefined
}

export function subtaskProgress(
  items: Subtask[] | null | undefined,
): { done: number; total: number; ratio: number } {
  const list = items ?? []
  const total = list.length
  const done = list.filter(s => s.done).length
  return { done, total, ratio: total > 0 ? done / total : 0 }
}

// View-local rows carry a stable rid for keying; rid is NEVER persisted to
// note.items. Named `rid` (not `id`) because web items already carry a
// persisted `id` field that must never be clobbered or confused with it.
export type Row = Subtask & { rid: number }
let _uid = 0
export const nextRid = (): number => ++_uid
export const toRows = (items: Subtask[]): Row[] =>
  items.map(s => ({ ...s, rid: nextRid(), text: s.text ?? '', done: !!s.done }))
// Strip ONLY the view-local rid; every other key (id, indent, agent_status,
// agent_session_id, …) round-trips back to the web untouched.
export const toItems = (rows: Row[]): Subtask[] => rows.map(({ rid, ...item }) => item)
