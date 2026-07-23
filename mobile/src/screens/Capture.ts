import { html, useState } from '../html'
import { theme as T } from '../theme'
import { BottomSheet, BucketChip, PrimaryButton } from '../components'
import { parseCapture } from '../notes'

const SEG_COLOR: Record<string, string> = {
  text: T.text, project: T.accent, bucket: '#7FB3FF', time: '#8FD69A', urgency: '#FFC15E',
}

export function Capture({ onSave, onClose, defaultProject }:
  { onSave: (d: { title: string; bucket: string; project: string | null; urgency: number; due_date: string | null }) => Promise<void>;
    onClose: () => void; defaultProject?: string }) {
  const [text, setText] = useState('')
  const [bucketOverride, setBucketOverride] = useState<string | null>(null)
  const parsed = parseCapture(text)
  const bucket = bucketOverride || parsed.bucket || 'today'
  const canSave = parsed.title.length > 0

  async function save() {
    if (!canSave) return
    await onSave({
      title: parsed.title, bucket, urgency: parsed.urgency,
      project: parsed.project || defaultProject || null, due_date: parsed.dueTime,
    })
    onClose()
  }

  return html`
    <${BottomSheet} onClose=${onClose}>
      ${defaultProject ? html`<div style=${{ alignSelf: 'flex-start', padding: '5px 12px', borderRadius: '999px',
        background: T.bg2, border: `1px solid ${T.border}`, font: `400 12px ${T.mono}`, color: T.text2 }}>＃ ${defaultProject}</div>` : ''}
      <div style=${{ position: 'relative', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '12px' }}>
        <div style=${{ position: 'absolute', inset: 0, padding: '16px', font: `400 17px ${T.mono}`,
          whiteSpace: 'pre-wrap', pointerEvents: 'none', lineHeight: 1.35 }}>
          ${parsed.segments.map((g, i) => html`<span key=${i} style=${{ color: SEG_COLOR[g.kind] }}>${g.text}</span>`)}
        </div>
        <input value=${text} onInput=${(e: any) => setText(e.target.value)} placeholder="What's on your mind?"
          autofocus style=${{ position: 'relative', background: 'transparent', border: 'none', padding: '16px',
          font: `400 17px ${T.mono}`, lineHeight: 1.35, color: text ? 'transparent' : T.muted,
          caretColor: T.text, width: '100%' }} />
      </div>
      <div style=${{ font: `400 11.5px ${T.mono}`, color: T.faint }}>try: pay rent @flat today 9pm !!</div>
      <div style=${{ display: 'flex', gap: '8px' }}>
        ${(['today', 'soon', 'someday'] as const).map(b =>
          html`<${BucketChip} key=${b} label=${b} selected=${bucket === b} onClick=${() => setBucketOverride(b)} />`)}
      </div>
      <${PrimaryButton} label="Save" disabled=${!canSave} onClick=${save} />
    </${BottomSheet}>`
}
