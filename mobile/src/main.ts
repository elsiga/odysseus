import { html, render, useState } from './html'
import { useNotesStore } from './store'
import { getToken, setToken } from './token'
import { Home } from './screens/Home'
import type { NoteRec } from './notes'

type Route = { name: 'home' } | { name: 'capture' } | { name: 'library' } | { name: 'project'; project: string } | { name: 'detail'; id: string }

function Root() {
  const store = useNotesStore()
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [tok, setTok] = useState<string | null | undefined>(undefined)

  // token gate
  useState(() => { void getToken().then(t => setTok(t ?? null)) })
  if (tok === undefined) return html`<p style="padding:24px">…</p>`
  if (tok === null) return html`<${TokenGate} onSave=${async (t: string) => { await setToken(t); setTok(t) }} />`

  const openDetail = (n: NoteRec) => setRoute({ name: 'detail', id: n.id })
  if (route.name === 'home')
    return html`<${Home} notes=${store.notes} status=${store.status}
      onToggle=${store.toggle} onOpen=${openDetail}
      onCapture=${() => setRoute({ name: 'capture' })} onLibrary=${() => setRoute({ name: 'library' })} />`
  return html`<p style="padding:24px">…</p>` // routes filled in Tasks 7-9
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
