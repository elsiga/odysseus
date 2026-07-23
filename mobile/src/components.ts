import { html } from './html'
import { theme as T } from './theme'
import type { NoteRec } from './notes'
import { subtaskProgress } from './subtasks'

// Task row — states via props (active/done handled by caller styling)
export function TaskRow({ note, onToggle, onOpen }:
  { note: NoteRec; onToggle: () => void; onOpen?: () => void }) {
  const done = !!note.done
  const { done: sd, total: st, ratio } = subtaskProgress(note.items)
  return html`
    <div style=${{ display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 14px',
                   border: `1px solid ${T.card2}`, borderRadius: '12px', opacity: done ? 0.55 : 1 }}>
      <div onClick=${(e: any) => { e.stopPropagation(); onToggle() }}
           style=${{ width: '22px', height: '22px', borderRadius: '50%',
                     border: `2px solid ${done ? T.accent : '#4A5866'}`,
                     background: done ? T.accent : 'transparent', flex: 'none', cursor: 'pointer' }}></div>
      <div onClick=${onOpen} style=${{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px',
             cursor: onOpen ? 'pointer' : 'default' }}>
        <span style=${{ font: `400 15px ${T.mono}`, color: done ? T.muted : T.text,
               textDecoration: done ? 'line-through' : 'none' }}>${note.title || '(untitled)'}</span>
        ${st > 0 ? html`
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style=${{ flex: 1, maxWidth: '120px', height: '3px', borderRadius: '2px',
                   background: T.card2, overflow: 'hidden' }}>
              <div style=${{ width: `${Math.round(ratio * 100)}%`, height: '100%', background: T.accent }}></div>
            </div>
            <span style=${{ font: `400 11px ${T.mono}`, color: T.muted, flex: 'none' }}>${sd}/${st}</span>
          </div>` : ''}
      </div>
      <span style=${{ font: `400 11px ${T.mono}`, color: T.muted, flex: 'none' }}>${note.project ? '#' + note.project : ''}</span>
    </div>`
}

export function BucketChip({ label, selected, onClick }:
  { label: string; selected?: boolean; onClick?: () => void }) {
  return html`
    <span onClick=${onClick} style=${{ padding: '10px 18px', borderRadius: '999px', cursor: onClick ? 'pointer' : 'default',
      font: `500 13px ${T.mono}`, border: `1px solid ${selected ? T.accent : T.border}`,
      background: selected ? 'rgba(255,107,94,.12)' : 'transparent', color: selected ? T.accent : T.muted }}>${label}</span>`
}

export function ProjectTag({ name }: { name: string }) {
  return html`<span style=${{ padding: '5px 12px', borderRadius: '999px', background: T.card,
    border: `1px solid ${T.border}`, font: `400 12px ${T.mono}`, color: T.text2 }}>#${name}</span>`
}

export function PrimaryButton({ label, onClick, disabled }:
  { label: string; onClick?: () => void; disabled?: boolean }) {
  return html`
    <div onClick=${disabled ? undefined : onClick}
      style=${{ height: '52px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: `700 17px ${T.mono}`, cursor: disabled ? 'default' : 'pointer',
        background: disabled ? T.card : T.accent, color: disabled ? T.faint : T.bg }}>${label}</div>`
}

export function BottomSheet({ children, onClose }: { children: any; onClose: () => void }) {
  return html`
    <div style=${{ position: 'fixed', inset: 0, zIndex: 10 }}>
      <div onClick=${onClose} style=${{ position: 'absolute', inset: 0, background: T.scrim }}></div>
      <div style=${{ position: 'absolute', left: 0, right: 0, bottom: 0, background: T.card,
        border: `1px solid ${T.border}`, borderBottom: 'none', borderRadius: '24px 24px 0 0',
        padding: '14px 20px 26px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style=${{ width: '36px', height: '4px', borderRadius: '2px', background: T.border, margin: '0 auto' }}></div>
        ${children}
      </div>
    </div>`
}

export function Toast({ text }: { text: string }) {
  return html`
    <div style=${{ position: 'fixed', left: '50%', top: '64px', transform: 'translateX(-50%)',
      background: T.card, border: `1px solid ${T.accent}`, borderRadius: '999px', padding: '10px 20px',
      font: `500 14px ${T.mono}`, zIndex: 20 }}>${text}</div>`
}
