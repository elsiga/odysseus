import { notesRepo, createSyncClient, parseCapture } from './sync-core.js'
export type { NoteRec, Parsed, Segment } from './sync-core.js'
export { notesRepo, createSyncClient, parseCapture }
export const API_BASE = 'https://chat.elsiga.ch/api/sync'
