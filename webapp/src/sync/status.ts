import { useSyncExternalStore } from 'react'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'signed-out' | 'error'

let current: SyncStatus = 'signed-out'
const listeners = new Set<() => void>()

export function getSyncStatus(): SyncStatus {
  return current
}
export function setSyncStatus(s: SyncStatus) {
  if (s === current) return
  current = s
  for (const fn of listeners) fn()
}
export function subscribeSyncStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus)
}
