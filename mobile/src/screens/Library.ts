import { html } from '../html'
import { theme as T } from '../theme'
import { TaskRow, ProjectTag } from '../components'
import { activeByBucket, projectsOf, type Bucket } from '../tasks'
import type { NoteRec } from '../notes'

export function Library({ notes, onToggle, onOpen, onOpenProject, onBack }:
  { notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onOpenProject: (name: string) => void; onBack: () => void }) {
  const by = activeByBucket(notes)
  const projects = projectsOf(notes)
  const section = (label: string, rows: NoteRec[]) => html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style=${{ font: `600 11px ${T.mono}`, letterSpacing: '.14em', color: T.muted, padding: '0 2px' }}>${label.toUpperCase()} · ${rows.length}</div>
      ${rows.length ? rows.map(n => html`<${TaskRow} key=${n.id} note=${n} onToggle=${() => onToggle(n)} onOpen=${() => onOpen(n)} />`)
        : html`<div style=${{ font: `400 13px ${T.mono}`, color: T.faint, padding: '0 2px' }}>nothing here</div>`}
    </div>`

  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '18px', padding: '26px 20px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 21px ${T.mono}` }}>Library</span>
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>← home</span>
      </div>
      ${(['today', 'soon', 'someday'] as Bucket[]).map(b => section(b, by[b]))}
      <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style=${{ font: `600 11px ${T.mono}`, letterSpacing: '.14em', color: T.muted, padding: '0 2px' }}>PROJECTS</div>
        <div style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          ${projects.length ? projects.map(p => html`
            <div key=${p.name} onClick=${() => onOpenProject(p.name)} style=${{ cursor: 'pointer' }}>
              <${ProjectTag} name=${`${p.name} · ${p.count}`} /></div>`)
            : html`<span style=${{ font: `400 13px ${T.mono}`, color: T.faint }}>no projects yet</span>`}
        </div>
      </div>
    </div>`
}
