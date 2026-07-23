export interface NoteRec {
  id: string; title?: string; text?: string; content?: string | null;
  items?: Array<{ text: string; done: boolean } & Record<string, unknown>> | null;
  done?: boolean; archived?: boolean; bucket?: string; urgency?: number;
  project?: string | null; sort_order?: number; due_date?: string | null;
  // Legacy web note types ('todo', 'goal', …) must round-trip through this
  // field untouched by mobile edits — see subtasks.ts#nextNoteType.
  note_type?: string;
}
export const notesRepo: {
  list(): Promise<NoteRec[]>
  create(data: Partial<NoteRec>): Promise<NoteRec>
  update(id: string, patch: Partial<NoteRec>): Promise<void>
  remove(id: string): Promise<void>
}
export function createSyncClient(opts: {
  apiBase: string; authHeader?: () => Record<string, string>; fetchFn?: typeof fetch
}): { start(): void; syncOnce(): Promise<void> }
export interface Segment { text: string; kind: 'text' | 'project' | 'bucket' | 'time' | 'urgency' }
export interface Parsed {
  title: string; project: string | null;
  bucket: 'today' | 'soon' | 'someday' | null;
  dueTime: string | null; urgency: 0 | 1 | 2; segments: Segment[]
}
export function parseCapture(text: string): Parsed
