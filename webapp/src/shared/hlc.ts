// Hybrid-lite timestamps (DESIGN.md §7.3): ISO wall clock + per-device monotonic
// counter suffix, compared lexicographically; ties broken by deviceId.
export interface HlcStamp {
  ts: string
  deviceId: string
}

export function hlcTimestamp(wallIso: string, counter: number): string {
  return `${wallIso}-${String(counter).padStart(6, '0')}`
}

export function compareHlc(a: HlcStamp, b: HlcStamp): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  return 0
}
