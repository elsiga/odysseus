export type Subtask = { text: string; done: boolean }

export function deriveNoteType(items: Subtask[]): 'note' | 'checklist' {
  return items.length > 0 ? 'checklist' : 'note'
}

export function subtaskProgress(
  items: Subtask[] | null | undefined,
): { done: number; total: number; ratio: number } {
  const list = items ?? []
  const total = list.length
  const done = list.filter(s => s.done).length
  return { done, total, ratio: total > 0 ? done / total : 0 }
}
