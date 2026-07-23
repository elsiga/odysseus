import { html, useState } from '../html'
import { theme as T } from '../theme'
import { nextNoteType, nextRid, toRows, toItems, type Row } from '../subtasks'
import type { NoteRec } from '../notes'

export function Detail({ note, onUpdate }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void }) {
  const [title, setTitle] = useState(note.title || '')
  const [desc, setDesc] = useState(note.content || '')
  const [rows, setRows] = useState<Row[]>(toRows(note.items || []))

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
