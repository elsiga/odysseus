import { html, render, useState, useRef } from './html'
import { useNotesStore } from './store'
import { getToken, setToken } from './token'
import { Home } from './screens/Home'
import { Capture } from './screens/Capture'
import { Library } from './screens/Library'
import { Project } from './screens/Project'
import { Detail } from './screens/Detail'
import { Day } from './screens/Day'
import { scheduleTestNotification } from './notify'
import { pushRoute, popRoute, shouldExit, type Route } from './nav'
import { useBackButton, exitApp } from './backButton'
import type { NoteRec } from './notes'

function Root() {
  const store = useNotesStore()
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }])
  const [tok, setTok] = useState<string | null | undefined>(undefined)
  const lastBackAt = useRef(0)

  const route = stack[stack.length - 1]
  // Any stack change disarms the root exit gesture — see back() below.
  const navigate = (r: Route) => { lastBackAt.current = 0; setStack(s => pushRoute(s, r)) }

  // Back: pop one entry, or at the root require a second press within
  // EXIT_WINDOW_MS to exit. No toast, by design decision.
  function back() {
    if (stack.length > 1) { lastBackAt.current = 0; setStack(s => popRoute(s)); return }
    const now = Date.now()
    if (shouldExit(lastBackAt.current, now)) { exitApp(); return }
    lastBackAt.current = now
  }
  // Registered before any conditional return so hook order stays stable.
  useBackButton(back)

  // token gate
  useState(() => { void getToken().then(t => setTok(t ?? null)) })
  if (tok === undefined) return html`<p style="padding:24px">…</p>`
  if (tok === null) return html`<${TokenGate} onSave=${async (t: string) => { await setToken(t); setTok(t); await store.startSync(t) }} />`

  const openDetail = (n: NoteRec) => navigate({ name: 'detail', id: n.id })
  if (route.name === 'home')
    return html`<${Home} notes=${store.notes} status=${store.status}
      onToggle=${store.toggle} onOpen=${openDetail}
      onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
      onDay=${() => navigate({ name: 'day' })}
      onTestReminder=${scheduleTestNotification} />`
  if (route.name === 'capture')
    return html`
      <${Home} notes=${store.notes} status=${store.status} onToggle=${store.toggle} onOpen=${openDetail}
        onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
        onDay=${() => navigate({ name: 'day' })}
        onTestReminder=${scheduleTestNotification} />
      <${Capture} onSave=${store.addTask} onClose=${back} defaultProject=${route.project} />`
  if (route.name === 'library')
    return html`<${Library} notes=${store.notes} onToggle=${store.toggle} onOpen=${openDetail}
      onOpenProject=${(name: string) => navigate({ name: 'project', project: name })} />`
  if (route.name === 'project') {
    const p = route.project
    return html`<${Project} project=${p} notes=${store.notes} onToggle=${store.toggle} onOpen=${openDetail}
      onCapture=${() => navigate({ name: 'capture', project: p })} />`
  }
  if (route.name === 'detail') {
    const n = store.notes.find(x => x.id === route.id)
    // Render a fallback rather than calling setState during render. Hardware
    // back pops this entry.
    if (!n) return html`<p style="padding:26px 20px">task not found — press back</p>`
    return html`<${Detail} note=${n} onUpdate=${(patch: any) => store.update(n.id, patch)} />`
  }
  if (route.name === 'day')
    return html`<${Day} notes=${store.notes} onOpen=${openDetail}
      onHome=${() => navigate({ name: 'home' })} initialDate=${route.date} />`
  return html`<p style="padding:24px">…</p>`
}

function TokenGate({ onSave }: { onSave: (t: string) => void }) {
  const [t, setT] = useState(''); const [err, setErr] = useState('')
  return html`
    <div style="padding:24px;font-family:monospace">
      <p>Paste your sync API token (<code>ody_…</code>).</p>
      <textarea style="width:100%;height:80px" value=${t} onInput=${(e: any) => setT(e.target.value)}></textarea>
      <div><button onClick=${() => { const v = t.trim(); if (!v.startsWith('ody_')) return setErr('bad token'); onSave(v) }}>Save token</button> <span style="color:#FF6B5E">${err}</span></div>
    </div>`
}

render(html`<${Root} />`, document.getElementById('root')!)
