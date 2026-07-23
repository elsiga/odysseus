import { html, render, useState, useEffect } from './html'
import { notesRepo, createSyncClient, API_BASE, type NoteRec } from './notes'
import { getToken, setToken } from './token'

function App() {
  const [notes, setNotes] = useState<NoteRec[]>([])
  const [token, setTok] = useState<string | null | undefined>(undefined) // undefined = loading
  const [status, setStatus] = useState('')
  const [draft, setDraft] = useState('')
  const clientRef = { current: null as null | ReturnType<typeof createSyncClient> }

  async function refresh() {
    const all = await notesRepo.list()
    setNotes(all.filter(n => !n.archived).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
  }

  async function boot() {
    await refresh()                              // local first (offline)
    const t = await getToken()
    setTok(t ?? null)
    if (!t) { setStatus('no token'); return }
    const client = createSyncClient({ apiBase: API_BASE, authHeader: () => ({ Authorization: `Bearer ${t}` }) })
    clientRef.current = client
    client.start(); setStatus('syncing')
    await client.syncOnce(); await refresh()
    setStatus(navigator.onLine ? 'synced' : 'offline')
  }
  useEffect(() => { void boot() }, [])

  async function add() {
    const title = draft.trim(); if (!title) return
    setDraft('')
    await notesRepo.create({ title, done: false })
    await refresh(); void clientRef.current?.syncOnce()
  }
  async function toggle(n: NoteRec) {
    await notesRepo.update(n.id, { done: !n.done }); await refresh(); void clientRef.current?.syncOnce()
  }
  async function del(n: NoteRec) {
    await notesRepo.remove(n.id); await refresh(); void clientRef.current?.syncOnce()
  }
  async function saveToken(t: string) {
    if (!t.startsWith('ody_')) { setStatus('bad token'); return }
    await setToken(t); await boot()
  }

  if (token === undefined) return html`<p style="padding:24px">…</p>`
  if (token === null) return html`<${TokenGate} onSave=${saveToken} status=${status} />`

  return html`
    <div style="font-family:monospace;padding:16px">
      <div style="opacity:.6;font-size:11px">${status}</div>
      ${notes.map(n => html`
        <div key=${n.id} style="display:flex;gap:10px;padding:10px;border:1px solid #2A3644;border-radius:8px;margin:6px 0">
          <input type="checkbox" checked=${!!n.done} onChange=${() => toggle(n)} />
          <span style=${{ flex: 1, textDecoration: n.done ? 'line-through' : 'none' }}>${n.title || '(untitled)'}</span>
          <button onClick=${() => del(n)}>×</button>
        </div>`)}
      <div style="display:flex;gap:8px;margin-top:12px">
        <input style="flex:1;padding:10px" placeholder="New task…" value=${draft}
               onInput=${(e: any) => setDraft(e.target.value)}
               onKeyDown=${(e: any) => { if (e.key === 'Enter') add() }} />
        <button onClick=${add}>Add</button>
      </div>
    </div>`
}

function TokenGate({ onSave, status }: { onSave: (t: string) => void; status: string }) {
  const [t, setT] = useState('')
  return html`
    <div style="font-family:monospace;padding:24px">
      <p>Paste your sync API token (<code>ody_…</code>).</p>
      <textarea style="width:100%;height:80px" value=${t} onInput=${(e: any) => setT(e.target.value)}></textarea>
      <div><button onClick=${() => onSave(t.trim())}>Save token</button> <span style="opacity:.6">${status}</span></div>
    </div>`
}

render(html`<${App} />`, document.getElementById('root')!)
