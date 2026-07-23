import { html } from '../html'
import { theme as T } from '../theme'
import { TaskRow } from '../components'
import type { NoteRec } from '../notes'

export function Project({ project, notes, onToggle, onOpen, onCapture }:
  { project: string; notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void }) {
  const rows = notes.filter(n => n.project === project && !n.archived && !n.done)
  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '16px', padding: '26px 20px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 21px ${T.mono}` }}>#${project}</span>
      </div>
      ${rows.map(n => html`<${TaskRow} key=${n.id} note=${n} onToggle=${() => onToggle(n)} onOpen=${() => onOpen(n)} />`)}
      <div onClick=${onCapture} style=${{ padding: '14px 16px', border: `1px dashed ${T.border}`, borderRadius: '14px',
        font: `400 14px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>＋ add a task to this project</div>
    </div>`
}
