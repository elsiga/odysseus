import { html, useState } from '../html'
import { theme as T } from '../theme'
import { TaskRow, BucketChip, PrimaryButton } from '../components'
import { todayView, bucketCounts, pickSuggestion } from '../tasks'
import type { NoteRec } from '../notes'

export function Home({ notes, status, onToggle, onOpen, onCapture, onLibrary }:
  { notes: NoteRec[]; status: string; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void; onLibrary: () => void }) {
  const [suggIdx, setSuggIdx] = useState(0)
  const { visible, overflow } = todayView(notes)
  const counts = bucketCounts(notes)
  const sugg = pickSuggestion(notes, suggIdx)
  const now = new Date()
  const day = now.toLocaleDateString('en', { weekday: 'long' })

  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '16px', padding: '26px 20px 92px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 21px ${T.mono}` }}>${day}</span>
        <span style=${{ font: `400 13px ${T.mono}`, color: T.muted }}>${status}</span>
      </div>

      ${sugg ? html`
        <div style=${{ background: T.card, border: `1px solid ${T.border}`, borderRadius: '18px', padding: '20px',
                       display: 'flex', flexDirection: 'column', gap: '13px' }}>
          <span style=${{ font: `600 11px ${T.mono}`, letterSpacing: '.16em', color: T.muted }}>WHAT NOW</span>
          <div style=${{ font: `700 23px ${T.mono}`, minHeight: '32px' }}>${sugg.title}</div>
          <${PrimaryButton} label="Start" disabled=${true} />
          <div onClick=${() => setSuggIdx(i => i + 1)}
               style=${{ textAlign: 'center', font: `400 13.5px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '6px' }}>not this one →</div>
        </div>`
      : html`
        <div style=${{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <div style=${{ font: `700 22px ${T.mono}` }}>Today is clear.</div>
          <div style=${{ font: `400 14px ${T.mono}`, color: T.muted, textAlign: 'center' }}>Pull something from soon, or enjoy the space.</div>
        </div>`}

      <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
        ${visible.map(n => html`<${TaskRow} key=${n.id} note=${n} onToggle=${() => onToggle(n)} onOpen=${() => onOpen(n)} />`)}
        ${overflow > 0 ? html`
          <div style=${{ padding: '13px 16px', borderRadius: '12px', background: 'rgba(30,39,51,.7)',
                         border: `1px solid ${T.border}`, font: `400 13.5px ${T.mono}`, color: T.muted }}>
            ${overflow} more in today — <span style=${{ color: T.text }}>move some to soon?</span></div>` : ''}
      </div>

      <div style=${{ display: 'flex', gap: '8px', padding: '0 2px' }}>
        <${BucketChip} label=${`soon · ${counts.soon}`} onClick=${onLibrary} />
        <${BucketChip} label=${`someday · ${counts.someday}`} onClick=${onLibrary} />
        <${BucketChip} label="projects" onClick=${onLibrary} />
      </div>

      <div onClick=${onCapture}
        style=${{ position: 'fixed', left: '16px', right: '16px', bottom: '16px', height: '54px', borderRadius: '999px',
        background: T.card, border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: '10px', padding: '0 20px' }}>
        <span style=${{ font: `400 20px ${T.mono}`, color: T.accent }}>＋</span>
        <span style=${{ font: `400 15px ${T.mono}`, color: T.muted }}>Capture a thought…</span>
      </div>
    </div>`
}
