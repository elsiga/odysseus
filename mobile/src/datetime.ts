// Date/time helpers for the mobile task app. The due_date wire format mirrors
// the web (static/js/notes.js) EXACTLY so mobile- and web-authored dates agree:
//   timed   = YYYY-MM-DDTHH:MM  (local, no timezone)
//   all-day = YYYY-MM-DD

export function hasTimeComponent(s: string | null | undefined): boolean {
  return typeof s === 'string' && /T\d{2}:\d{2}/.test(s)
}

export function toLocalDatetimeStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function toDateOnlyStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function parseTimeToken(tok: string | null | undefined): { hh: number; mm: number } | null {
  if (!tok) return null
  const t = tok.trim().toLowerCase()
  let m = /^(\d{1,2}):(\d{2})$/.exec(t)         // 24h "HH:MM" / "H:MM"
  if (m) {
    const hh = +m[1], mm = +m[2]
    return hh > 23 || mm > 59 ? null : { hh, mm }
  }
  m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t)  // 12h "9pm" / "9:30pm" / "12am"
  if (m) {
    let hh = +m[1]; const mm = m[2] ? +m[2] : 0; const ap = m[3]
    if (hh < 1 || hh > 12 || mm > 59) return null
    if (ap === 'am') hh = hh === 12 ? 0 : hh
    else hh = hh === 12 ? 12 : hh + 12
    return { hh, mm }
  }
  return null
}

// Capture path: compose TODAY at the token time. No roll-over even if the time
// already passed today — the user adjusts manually in Detail.
export function composeDueDate(tok: string | null | undefined, now: Date): string | null {
  const t = parseTimeToken(tok)
  if (!t) return null
  return toLocalDatetimeStr(new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hh, t.mm, 0, 0))
}

export function datePart(due: string | null | undefined): string {
  if (!due) return ''
  return due.slice(0, 10)
}

export function timePart(due: string | null | undefined): string {
  if (!hasTimeComponent(due)) return ''
  return (due as string).slice(11, 16)
}

// Detail path: assemble the picker parts back into a due_date. Returns "" (NOT
// null) when cleared, because update_note_record skips None values (Slice 2
// lesson) — "" persists the clear, null would be a no-op.
export function composeWhen(dateStr: string, timeStr: string, now: Date): string {
  if (!dateStr && !timeStr) return ''
  const d = dateStr || toDateOnlyStr(now)
  return timeStr ? `${d}T${timeStr}` : d
}
