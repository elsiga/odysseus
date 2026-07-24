import { html, useState } from '../html'
import { theme as T } from '../theme'
import { nextNoteType, nextRid, toRows, toItems, type Row } from '../subtasks'
import type { NoteRec } from '../notes'
import { datePart, timePart, composeWhen, toDateOnlyStr, toLocalDatetimeStr } from '../datetime'
import { normalizeRepeat, simpleRepeat, snapToRepeat, monthlyDescriptor } from '../recurrence'

const CAL_ICON = html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style=${{ flex: 'none' }}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`
const CLOCK_ICON = html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style=${{ flex: 'none' }}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`

export function Detail({ note, onUpdate }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void }) {
  const [title, setTitle] = useState(note.title || '')
  const [desc, setDesc] = useState(note.content || '')
  const [rows, setRows] = useState<Row[]>(toRows(note.items || []))

  const initDate = datePart(note.due_date) || toDateOnlyStr(new Date())
  const initTime = note.due_date ? timePart(note.due_date) : '18:00'
  const [dateStr, setDateStr] = useState(initDate)
  const [timeStr, setTimeStr] = useState(initTime)
  const [dur, setDur] = useState<number>(note.duration_min ?? 0)
  // The full, normalized recurrence rule (weekly:W / monthly:*), stored verbatim.
  const [fullRep, setFullRep] = useState<string>(
    normalizeRepeat(note.repeat, note.due_date ? new Date(note.due_date) : new Date(`${initDate}T${initTime}`)))
  const [rep, setRep] = useState<string>(simpleRepeat(note.repeat))
  const [monthNth, setMonthNth] = useState<boolean>(/^monthly:nth:/.test(fullRep))
  const [nthN, setNthN] = useState<number>(() => { const m = /^monthly:nth:(\d):(\d)$/.exec(fullRep); return m ? +m[1] : 0 })
  const [nthW, setNthW] = useState<number>(() => { const m = /^monthly:nth:(\d):(\d)$/.exec(fullRep); return m ? +m[2] : -1 })

  const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  const ORD = ['1st', '2nd', '3rd', '4th']
  const dueDay = +dateStr.slice(8, 10) || new Date().getDate()
  const dueWd = new Date(`${dateStr || toDateOnlyStr(new Date())}T${timeStr || '00:00'}`).getDay()

  // Persist due_date (composeWhen → "" on clear) with an EXPLICIT repeat rule.
  // The rule is stored verbatim and NOT re-derived when the date/time moves —
  // matching web, where picking a rule snaps the date and the rule then stands.
  function commit(nd: string, nt: string, repeatVal: string) {
    const due = composeWhen(nd, nt, new Date())
    onUpdate({ due_date: due, repeat: due ? repeatVal : 'none' })
  }
  const onDate = (v: string) => { setDateStr(v); commit(v, timeStr, fullRep) }
  const onTime = (v: string) => {
    const nd = v && !dateStr ? toDateOnlyStr(new Date()) : dateStr
    setTimeStr(v); if (nd !== dateStr) setDateStr(nd)
    commit(nd, v, fullRep)
  }
  const onDuration = (v: number) => { setDur(v); onUpdate({ duration_min: v }) }
  function clearWhen() {
    setDateStr(''); setTimeStr(''); setFullRep('none'); setRep('none'); setMonthNth(false)
    onUpdate({ due_date: '', repeat: 'none' })
  }

  // Apply an explicit rule; when `snap`, move the due date forward to its next
  // matching slot (web parity), then persist date + rule together.
  function applyRepeat(val: string, snap: boolean) {
    let nd = dateStr, nt = timeStr
    if (snap) {
      const snapped = snapToRepeat(new Date(`${dateStr || toDateOnlyStr(new Date())}T${timeStr || '18:00'}`), val)
      if (snapped) { const s = toLocalDatetimeStr(snapped); nd = datePart(s); nt = timePart(s) }
    }
    setDateStr(nd); setTimeStr(nt); setFullRep(val); setRep(simpleRepeat(val))
    onUpdate({ due_date: composeWhen(nd, nt, new Date()), repeat: val })
  }
  function onRepeatChip(r: string) {
    if (r === 'none' || r === 'daily' || r === 'yearly') { setMonthNth(false); applyRepeat(r, false) }
    else if (r === 'weekly') { setMonthNth(false); applyRepeat(`weekly:${dueWd}`, false) }
    else if (r === 'monthly') { setMonthNth(false); applyRepeat(`monthly:day:${dueDay}`, false) }
  }
  const onWeeklyPick = (w: number) => applyRepeat(`weekly:${w}`, true)
  const onMonthlyDay = () => { setMonthNth(false); applyRepeat(`monthly:day:${dueDay}`, false) }
  const onNthN = (n: number) => { setNthN(n); if (nthW >= 0) applyRepeat(`monthly:nth:${n}:${nthW}`, true) }
  const onNthW = (w: number) => { setNthW(w); if (nthN > 0) applyRepeat(`monthly:nth:${nthN}:${w}`, true) }

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
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0,
            background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px', padding: '0 12px', color: T.muted }}>
            ${CAL_ICON}
            <input type="date" value=${dateStr} onInput=${(e: any) => onDate(e.target.value)}
              style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                padding: '10px 0', font: `400 14px ${T.mono}`, color: T.text }} />
          </div>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', width: '128px',
            background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px', padding: '0 12px', color: T.muted }}>
            ${CLOCK_ICON}
            <input type="time" value=${timeStr} onInput=${(e: any) => onTime(e.target.value)}
              style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                padding: '10px 0', font: `400 14px ${T.mono}`, color: T.text }} />
          </div>
          <span onClick=${clearWhen} title="Clear" style=${{ width: '40px', height: '40px', flex: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none',
            color: T.muted, font: `400 18px ${T.mono}` }}>×</span>
        </div>

        <div style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>duration</span>
          <input type="number" inputmode="numeric" min="0" step="5" value=${dur || ''}
            onInput=${(e: any) => onDuration(Math.max(0, parseInt(e.target.value, 10) || 0))}
            placeholder="—"
            style=${{ width: '72px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '10px',
              padding: '8px 10px', font: `400 14px ${T.mono}`, color: T.text }} />
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted }}>min</span>
        </div>

        <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>repeat</span>
          ${(['none', 'daily', 'weekly', 'monthly', 'yearly']).map(r => html`
            <span key=${r} onClick=${dateStr || r === 'none' ? () => onRepeatChip(r) : undefined}
              style=${{ padding: '6px 12px', borderRadius: '999px', userSelect: 'none',
                cursor: dateStr || r === 'none' ? 'pointer' : 'default',
                font: `500 12.5px ${T.mono}`, opacity: dateStr || r === 'none' ? 1 : 0.4,
                border: `1px solid ${rep === r ? T.accent : T.card2}`,
                background: rep === r ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                color: rep === r ? T.accent : T.muted }}>${r}</span>`)}
        </div>

        ${rep === 'weekly' && dateStr ? html`
          <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '4px' }}>
            <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>on</span>
            ${WEEK.map((d, i) => html`
              <span key=${i} onClick=${() => onWeeklyPick(i)}
                style=${{ width: '30px', height: '30px', borderRadius: '999px', userSelect: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', font: `500 12px ${T.mono}`,
                  border: `1px solid ${fullRep === `weekly:${i}` ? T.accent : T.card2}`,
                  background: fullRep === `weekly:${i}` ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                  color: fullRep === `weekly:${i}` ? T.accent : T.muted }}>${d}</span>`)}
          </div>` : ''}

        ${rep === 'monthly' && dateStr ? html`
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '4px' }}>
            <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span key="day" onClick=${onMonthlyDay}
                style=${{ padding: '6px 12px', borderRadius: '999px', userSelect: 'none', cursor: 'pointer', font: `500 12.5px ${T.mono}`,
                  border: `1px solid ${!monthNth && /^monthly:day:/.test(fullRep) ? T.accent : T.card2}`,
                  background: !monthNth && /^monthly:day:/.test(fullRep) ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                  color: !monthNth && /^monthly:day:/.test(fullRep) ? T.accent : T.muted }}>Day ${dueDay}</span>
              <span key="nth" onClick=${() => setMonthNth(true)}
                style=${{ padding: '6px 12px', borderRadius: '999px', userSelect: 'none', cursor: 'pointer', font: `500 12.5px ${T.mono}`,
                  border: `1px solid ${monthNth || /^monthly:nth:/.test(fullRep) ? T.accent : T.card2}`,
                  background: monthNth || /^monthly:nth:/.test(fullRep) ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                  color: monthNth || /^monthly:nth:/.test(fullRep) ? T.accent : T.muted }}>${/^monthly:nth:/.test(fullRep) ? monthlyDescriptor(fullRep) : 'Nth weekday'} ›</span>
            </div>
            ${monthNth ? html`
              <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>which</span>
                ${ORD.map((o, i) => html`
                  <span key=${i} onClick=${() => onNthN(i + 1)}
                    style=${{ padding: '5px 10px', borderRadius: '999px', userSelect: 'none', cursor: 'pointer', font: `500 12px ${T.mono}`,
                      border: `1px solid ${nthN === i + 1 ? T.accent : T.card2}`,
                      background: nthN === i + 1 ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                      color: nthN === i + 1 ? T.accent : T.muted }}>${o}</span>`)}
              </div>
              <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style=${{ font: `400 12px ${T.mono}`, color: T.muted, marginRight: '2px' }}>day</span>
                ${WEEK.map((d, i) => html`
                  <span key=${i} onClick=${() => onNthW(i)}
                    style=${{ width: '30px', height: '30px', borderRadius: '999px', userSelect: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', font: `500 12px ${T.mono}`,
                      border: `1px solid ${nthW === i ? T.accent : T.card2}`,
                      background: nthW === i ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                      color: nthW === i ? T.accent : T.muted }}>${d}</span>`)}
              </div>` : ''}
          </div>` : ''}
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
