import { uuidv7 } from 'uuidv7'
import { hlcTimestamp } from '../shared'
import type { db as OdysseusDb } from '../db/db'

type Dbi = typeof OdysseusDb
const DEVICE_KEY = 'deviceId'
const HLC_KEY = 'hlc' // { lastWall: string, counter: number }

export async function getDeviceId(dbi: Dbi): Promise<string> {
  return dbi.transaction('rw', dbi.syncMeta, async () => {
    const existing = await dbi.syncMeta.get(DEVICE_KEY)
    if (existing) return existing.value as string
    const id = `d-${uuidv7()}`
    await dbi.syncMeta.put({ key: DEVICE_KEY, value: id })
    return id
  })
}

// Monotonic hybrid-lite stamp (DESIGN.md §7.3). Runs in its own tx, or joins an
// open transaction as long as that tx includes syncMeta.
export async function nextHlc(dbi: Dbi): Promise<string> {
  return dbi.transaction('rw', dbi.syncMeta, async () => {
    const stored = (await dbi.syncMeta.get(HLC_KEY))?.value as { lastWall: string; counter: number } | undefined
    const now = new Date().toISOString()
    let wall: string
    let counter: number
    if (!stored || now > stored.lastWall) {
      wall = now
      counter = 0
    } else {
      wall = stored.lastWall
      counter = stored.counter + 1
    }
    await dbi.syncMeta.put({ key: HLC_KEY, value: { lastWall: wall, counter } })
    return hlcTimestamp(wall, counter)
  })
}
