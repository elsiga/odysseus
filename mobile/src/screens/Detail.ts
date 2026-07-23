import { html, useState } from '../html'
import { theme as T } from '../theme'
import type { NoteRec } from '../notes'

type Step = { text: string; done: boolean }

export function Detail({ note, onUpdate, onBack }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void; onBack: () => void }) {
  const [steps, setSteps] = useState<Step[]>((note.items as Step[]) || [])

  function commit(next: Step[]) { setSteps(next); onUpdate({ items: next }) }
  const edit = (i: number, text: string) => commit(steps.map((s, j) => j === i ? { ...s, text } : s))
  const remove = (i: number) => commit(steps.filter((_, j) => j !== i))
  const add = () => commit([...steps, { text: '', done: false }])

  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '16px', padding: '26px 20px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 20px ${T.mono}` }}>${note.title || '(untitled)'}</span>
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>← back</span>
      </div>
      <div style=${{ font: `400 13px ${T.mono}`, color: T.muted, padding: '0 4px' }}>break it down</div>
      ${steps.map((s, i) => html`
        <div key=${i} style=${{ display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 6px 6px 14px',
          background: T.card, border: `1px solid ${T.border}`, borderRadius: '12px' }}>
          <span style=${{ font: `500 13px ${T.mono}`, color: T.accent, width: '16px' }}>${i + 1}</span>
          <input value=${s.text} onInput=${(e: any) => edit(i, e.target.value)}
            style=${{ flex: 1, background: 'transparent', border: 'none', font: `400 15px ${T.mono}`, color: T.text, padding: '10px 0' }} />
          <span onClick=${() => remove(i)} style=${{ width: '44px', height: '44px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: T.muted, cursor: 'pointer', font: `400 18px ${T.mono}` }}>×</span>
        </div>`)}
      <div onClick=${add} style=${{ padding: '13px 14px', border: `1px dashed ${T.border}`, borderRadius: '12px',
        font: `400 14px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>＋ add a step</div>
    </div>`
}
