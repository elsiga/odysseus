import type { NoteRec } from './notes'
export type Bucket = 'today' | 'soon' | 'someday'
const BUCKETS: Bucket[] = ['today', 'soon', 'someday']

export function bucketOf(n: NoteRec): Bucket {
  const b = (n.bucket || 'today') as Bucket
  return BUCKETS.includes(b) ? b : 'today'
}

function isActive(n: NoteRec): boolean { return !n.archived && !n.done }

export function activeByBucket(notes: NoteRec[]): Record<Bucket, NoteRec[]> {
  const out: Record<Bucket, NoteRec[]> = { today: [], soon: [], someday: [] }
  for (const n of notes) if (isActive(n)) out[bucketOf(n)].push(n)
  return out
}

export function bucketCounts(notes: NoteRec[]): Record<Bucket, number> {
  const by = activeByBucket(notes)
  return { today: by.today.length, soon: by.soon.length, someday: by.someday.length }
}

export function todayView(notes: NoteRec[], cap = 5): { visible: NoteRec[]; overflow: number } {
  const today = activeByBucket(notes).today
  return { visible: today.slice(0, cap), overflow: Math.max(0, today.length - cap) }
}

export function pickSuggestion(notes: NoteRec[], idx: number): NoteRec | null {
  const today = activeByBucket(notes).today
  if (today.length === 0) return null
  return today[((idx % today.length) + today.length) % today.length]
}

export function projectsOf(notes: NoteRec[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const n of notes) {
    if (!isActive(n) || !n.project) continue
    counts.set(n.project, (counts.get(n.project) || 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
}
