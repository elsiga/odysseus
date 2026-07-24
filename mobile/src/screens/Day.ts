import { html, useState, useEffect, useRef } from '../html'
import { theme as T } from '../theme'
import { dayOccurrences } from '../calendar'
import { toDateOnlyStr } from '../datetime'
import type { NoteRec } from '../notes'

const HOUR_PX = 56
const PX_PER_MIN = HOUR_PX / 60
const MIN_BLOCK_PX = 30
const GUTTER = 52          // left space for hour labels
const GAP = 4

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

export function Day({ notes, onOpen, onHome, initialDate }:
  { notes: NoteRec[]; onOpen: (n: NoteRec) => void; onHome: () => void; initialDate?: string }) {
  const [viewDate, setViewDate] = useState<Date>(() => initialDate ? new Date(`${initialDate}T00:00`) : new Date())
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const now = new Date()
  const isToday = toDateOnlyStr(viewDate) === toDateOnlyStr(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const { allDay, timed } = dayOccurrences(notes, viewDate)

  // Auto-scroll to ~now (today) or ~08:00 otherwise, once per viewDate.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const focusMin = isToday ? nowMin : 8 * 60
    el.scrollTop = Math.max(0, focusMin * PX_PER_MIN - 120)
  }, [toDateOnlyStr(viewDate)])

  const stepDay = (delta: number) => setViewDate(d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta))
  const open = (noteId: string) => { const n = notes.find(x => x.id === noteId); if (n) onOpen(n) }
  const title = isToday ? "Today's shape" : viewDate.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })

  const pill = (label: string, active: boolean, inert: boolean) => html`
    <span style=${{ padding: '8px 16px', borderRadius: '999px', userSelect: 'none',
      border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : T.card2}`,
      background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
      font: `${active ? 500 : 400} 12.5px ${T.mono}`,
      color: active ? T.accent : T.muted, opacity: inert ? 0.4 : 1, cursor: inert ? 'default' : 'pointer' }}>${label}</span>`

  return html`
    <div style=${{ height: '100vh', display: 'flex', flexDirection: 'column', gap: '12px', padding: '26px 20px 8px', boxSizing: 'border-box' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 21px ${T.mono}` }}>${title}</span>
        <span onClick=${onHome} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '6px' }}>← home</span>
      </div>

      <div style=${{ display: 'flex', gap: '8px', alignItems: 'center', padding: '0 2px' }}>
        ${pill('day', true, false)}
        ${pill('week', false, true)}
        ${pill('month', false, true)}
        <div style=${{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span onClick=${() => stepDay(-1)} style=${{ font: `400 17px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '2px 8px' }}>‹</span>
          <span onClick=${() => setViewDate(new Date())} style=${{ font: `400 12.5px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '2px 6px' }}>today</span>
          <span onClick=${() => stepDay(1)} style=${{ font: `400 17px ${T.mono}`, color: T.muted, cursor: 'pointer', padding: '2px 8px' }}>›</span>
        </div>
      </div>

      ${allDay.length ? html`
        <div style=${{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '0 2px' }}>
          ${allDay.map(o => html`
            <span key=${o.noteId} onClick=${() => open(o.noteId)}
              style=${{ padding: '6px 12px', borderRadius: '999px', background: T.card, border: `1px solid ${T.border}`,
                font: `400 12.5px ${T.mono}`, color: o.done ? T.muted : T.text, cursor: 'pointer', userSelect: 'none',
                textDecoration: o.done ? 'line-through' : 'none' }}>${o.recurring ? '↻ ' : ''}${o.title || 'Untitled'}</span>`)}
        </div>` : ''}

      <div ref=${scrollRef} style=${{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div style=${{ position: 'relative', height: `${24 * HOUR_PX}px` }}>
          ${Array.from({ length: 24 }, (_, h) => html`
            <div key=${'r' + h} style=${{ position: 'absolute', top: `${h * HOUR_PX}px`, left: `${GUTTER}px`, right: 0, height: '1px', background: T.card2 }}></div>
            <div key=${'l' + h} style=${{ position: 'absolute', top: `${h * HOUR_PX - 6}px`, left: 0, width: `${GUTTER - 8}px`,
              textAlign: 'right', font: `400 11px ${T.mono}`, color: T.muted }}>${h === 0 ? '' : hhmm(h * 60)}</div>`)}

          ${timed.map(o => html`
            <div key=${o.noteId + ':' + o.startMin} onClick=${() => open(o.noteId)}
              style=${{ position: 'absolute', top: `${o.startMin * PX_PER_MIN}px`,
                height: `${Math.max((o.endMin - o.startMin) * PX_PER_MIN, MIN_BLOCK_PX)}px`,
                left: `calc(${GUTTER}px + ${o.lane} * (100% - ${GUTTER}px) / ${o.laneCount})`,
                width: `calc((100% - ${GUTTER}px) / ${o.laneCount} - ${GAP}px)`,
                background: T.card, border: `1px solid ${o.done ? T.border : T.accent}`, borderRadius: '10px',
                padding: '6px 9px', boxSizing: 'border-box', overflow: 'hidden', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style=${{ font: `600 12.5px ${T.mono}`, color: o.done ? T.muted : T.text,
                textDecoration: o.done ? 'line-through' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ${o.recurring ? '↻ ' : ''}${o.title || 'Untitled'}</span>
              <span style=${{ font: `400 10.5px ${T.mono}`, color: T.muted }}>${hhmm(o.startMin)}–${hhmm(o.endMin)}</span>
            </div>`)}

          ${isToday ? html`
            <div style=${{ position: 'absolute', top: 0, left: 0, right: 0, height: `${nowMin * PX_PER_MIN}px`,
              background: T.bg, opacity: 0.55, pointerEvents: 'none' }}></div>
            <div style=${{ position: 'absolute', top: `${nowMin * PX_PER_MIN}px`, left: `${GUTTER}px`, right: 0, height: '1px', background: T.accent }}></div>
            <div style=${{ position: 'absolute', top: `${nowMin * PX_PER_MIN - 6}px`, left: 0, width: `${GUTTER - 6}px`, textAlign: 'right',
              font: `400 10px ${T.mono}`, color: T.accent }}>${hhmm(nowMin)}</div>` : ''}

          ${!allDay.length && !timed.length ? html`
            <div style=${{ position: 'absolute', top: '38%', left: 0, right: 0, textAlign: 'center',
              font: `italic 400 13px ${T.mono}`, color: T.muted }}>nothing scheduled</div>` : ''}
        </div>
      </div>
    </div>`
}
