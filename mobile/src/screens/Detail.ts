import { html, useState } from '../html'
import { theme as T } from '../theme'
import { nextNoteType, nextRid, toRows, toItems, type Row } from '../subtasks'
import type { NoteRec } from '../notes'
import { datePart, timePart, composeWhen, toDateOnlyStr } from '../datetime'
import { normalizeRepeat, simpleRepeat } from '../recurrence'

export function Detail({ note, onUpdate }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void }) {
  const [title, setTitle] = useState(note.title || '')
  const [desc, setDesc] = useState(note.content || '')
  const [rows, setRows] = useState<Row[]>(toRows(note.items || []))

  const [dateStr, setDateStr] = useState(datePart(note.due_date))
  const [timeStr, setTimeStr] = useState(timePart(note.due_date))
  const [dur, setDur] = useState<number>(note.duration_min ?? 0)
  const [rep, setRep] = useState<string>(simpleRepeat(note.repeat))

  // Original recurrence, captured once. The mobile chips can only express the
  // coarse label (simpleRepeat collapses monthly:nth/monthly:last → 'monthly'),
  // so when the user edits the date/time WITHOUT changing the recurrence
  // selection we must carry the web-authored complex form through unchanged
  // rather than let normalizeRepeat downgrade it to monthly:day:N.
  const rep0 = simpleRepeat(note.repeat)
  const repeat0 = normalizeRepeat(note.repeat, note.due_date ? new Date(note.due_date) : new Date())

  const DURATIONS = [15, 25, 45, 60, 90]

  // Persist due_date + (re-derived) repeat together: when the date moves, a
  // weekly/monthly rule must re-derive its weekday / day-of-month from the new
  // date. composeWhen returns "" (not null) so a cleared date persists through
  // update_note_record (which skips None). When the recurrence selection is
  // unchanged from the note's original AND that original was a monthly:nth/last
  // form, carry it through unchanged instead of re-deriving (see rep0/repeat0).
  function commitWhen(nd: string, nt: string, nr: string) {
    const due = composeWhen(nd, nt, new Date())
    let repeat: string
    if (nr === 'none' || !due) repeat = 'none'
    else if (nr === rep0 && /^monthly:(nth|last):/.test(repeat0)) repeat = repeat0
    else repeat = normalizeRepeat(nr, new Date(due))
    onUpdate({ due_date: due, repeat })
  }
  const onDate = (v: string) => { setDateStr(v); commitWhen(v, timeStr, rep) }
  const onTime = (v: string) => {
    const nd = v && !dateStr ? toDateOnlyStr(new Date()) : dateStr
    setTimeStr(v)
    if (nd !== dateStr) setDateStr(nd)
    commitWhen(nd, v, rep)
  }
  const onRepeat = (v: string) => { setRep(v); commitWhen(dateStr, timeStr, v) }
  const onDuration = (v: number) => { const nv = dur === v ? 0 : v; setDur(nv); onUpdate({ duration_min: nv }) }

  // Persist subtasks + (conditionally) derived note_type together (Global Constraint).
  // note_type is omitted entirely for legacy web types we don't own the shape of
  // (see nextNoteType) so a mobile edit never converts a goal/todo note.
  function persist(next: Row[]) {
    const items = toItems(next)
    const nt = nextNoteType(note.note_type, items)
    onUpdate(nt === undefined ? { items } : { items, note_type: nt })
  }
  function setAndPersist(next: Row[]) { setRows(next); persist(next) }

  const toggle = (rid: number) => setAndPersist(rows.map(r => r.rid === rid ? { ...r, done: !r.done } : r))
  const remove = (rid: number) => setAndPersist(rows.filter(r => r.rid !== rid))
  const add = () => setAndPersist([...rows, { rid: nextRid(), text: '', done: false }])
  const editLocal = (rid: number, text: string) => setRows(rows.map(r => r.rid === rid ? { ...r, text } : r))

  const saveTitle = () => { const t = title.trim(); if (t !== (note.title || '')) onUpdate({ title: t }) }
  const saveDesc = () => { if (desc !== (note.content || '')) onUpdate({ content: desc }) }

  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '16px', padding: '26px 20px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px' }}>
        <input value=${title} onInput=${(e: any) => setTitle(e.target.value)} onBlur=${saveTitle}
          placeholder="Task title"
          style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', font: `700 20px ${T.mono}`, color: T.text }} />
      </div>

      <textarea value=${desc} onInput=${(e: any) => setDesc(e.target.value)} onBlur=${saveDesc}
        placeholder="Add a description…" rows=${3}
        style=${{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '12px', padding: '14px',
          font: `400 14px ${T.mono}`, color: T.text2, resize: 'vertical', width: '100%' }}></textarea>

      <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 4px 0' }}>
        <div style=${{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input type="date" value=${dateStr} onInput=${(e: any) => onDate(e.target.value)}
            style=${{ flex: 1, minWidth: 0, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px',
              padding: '10px 12px', font: `400 14px ${T.mono}`, color: T.text }} />
          <input type="time" value=${timeStr} onInput=${(e: any) => onTime(e.target.value)}
            style=${{ width: '118px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px',
              padding: '10px 12px', font: `400 14px ${T.mono}`, color: T.text }} />
        </div>

        ${timeStr ? html`
          <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>for</span>
            ${DURATIONS.map(m => html`
              <span key=${m} onClick=${() => onDuration(m)} style=${{ padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
                font: `500 12.5px ${T.mono}`,
                border: `1px solid ${dur === m ? T.accent : T.card2}`,
                background: dur === m ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                color: dur === m ? T.accent : T.muted }}>${m}m</span>`)}
          </div>` : ''}

        <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>repeat</span>
          ${(['none', 'daily', 'weekly', 'monthly', 'yearly']).map(r => html`
            <span key=${r} onClick=${dateStr || r === 'none' ? () => onRepeat(r) : undefined} style=${{ padding: '6px 12px', borderRadius: '999px',
              cursor: dateStr || r === 'none' ? 'pointer' : 'default',
              font: `500 12.5px ${T.mono}`, opacity: dateStr || r === 'none' ? 1 : 0.4,
              border: `1px solid ${rep === r ? T.accent : T.card2}`,
              background: rep === r ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
              color: rep === r ? T.accent : T.muted }}>${r}</span>`)}
        </div>
      </div>

      <div style=${{ font: `400 13px ${T.mono}`, color: T.muted, padding: '0 4px' }}>break it down</div>
      ${rows.map(r => html`
        <div key=${r.rid} style=${{ display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 6px 6px 14px',
          background: T.card, border: `1px solid ${T.border}`, borderRadius: '12px' }}>
          <div onClick=${() => toggle(r.rid)} style=${{ width: '20px', height: '20px', borderRadius: '6px', flex: 'none', cursor: 'pointer',
            border: `2px solid ${r.done ? T.accent : '#4A5866'}`, background: r.done ? T.accent : 'transparent' }}></div>
          <input value=${r.text} onInput=${(e: any) => editLocal(r.rid, e.target.value)} onBlur=${() => persist(rows)}
            placeholder="Subtask"
            style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', font: `400 15px ${T.mono}`,
              color: r.done ? T.muted : T.text, textDecoration: r.done ? 'line-through' : 'none', padding: '10px 0' }} />
          <span onClick=${() => remove(r.rid)} style=${{ width: '44px', height: '44px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: T.muted, cursor: 'pointer', font: `400 18px ${T.mono}`, flex: 'none' }}>×</span>
        </div>`)}
      <div onClick=${add} style=${{ padding: '13px 14px', border: `1px dashed ${T.border}`, borderRadius: '12px',
        font: `400 14px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>＋ add a subtask</div>
    </div>`
}
