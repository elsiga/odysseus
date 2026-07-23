# Mobile Slice 1 — Foundation + Todo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-DOM mobile shell with a Preact/HTM + esbuild component app that delivers the todo surface (Home/Today, Capture, Library, Project, task detail) over the existing proven `notesRepo`/`sync-core.js`, and add the four `Note` task fields that surface needs.

**Architecture:** Keep Capacitor + the Dexie `sync-core.js` untouched. Add `mobile/src/` (Preact + HTM, no JSX transform — `htm.bind(h)` tagged templates) bundled by a small esbuild step to `mobile/www/js/app.js`, importing the copied `sync-core.js` as an external module. Pure logic (capture parsing, bucket/today derivations) lives in tested modules; Preact components are presentational. Backend gains four additive `Note` columns synced free through the existing engine.

**Tech Stack:** Python/SQLAlchemy (backend), esbuild, Preact, HTM, TypeScript, Vitest (client), Capacitor, `@capacitor/local-notifications`.

## Global Constraints

- **Do NOT touch** the sync engine internals: `sync-engine/src/{engine,db,localWrite,notesRepo}.ts`, the change-log/listeners/`apply_push`/`pull_changes`, Gradle, or Capacitor native config. (parseCapture is an additive new module in `sync-engine/src/` — allowed.)
- **Authoritative visual source:** `design/Tasks + Calendar Prototype.dc.html`, `odysseus` theme — dark, JetBrains Mono, coral `--accent`. `design/` stays untracked (never `git add` it).
- **No tab bar.** Hub-and-spoke: Home is the only root; Library and Project are one tap in and back out.
- **Repaint model:** render after each *awaited* `notesRepo` mutation (and after the initial `syncOnce()`), never via `notesRepo.subscribe()` (fires pre-commit → stale paint; see `afd0f84`). In Preact: update local state after each awaited write.
- **Offline-first:** always render local `notesRepo` data before the token gate / sync.
- **Out of scope (later slices):** Calendar day/week/month/stats, Focus timer running/complete + live countdown, AI chat, external calendar events, iOS. The WHAT-NOW **`Start` button is inert** this slice.
- **API base:** `https://chat.elsiga.ch/api/sync`. Bearer token from Capacitor Preferences (`ody_…`).
- **Build/test commands:** backend `python -m pytest <file> -v`; sync-engine `cd sync-engine && npx vitest run <file>`; mobile unit `cd mobile && npx vitest run <file>`; mobile bundle `cd mobile && node build.mjs`.

---

### Task 1: Backend — four additive `Note` task fields

**Files:**
- Modify: `core/database.py` — `Note` model (~1754) + a new migration fn + register it (~1955)
- Modify: `routes/note/note_service.py:8-12,87-115` — field lists + `note_to_wire`
- Test: `tests/test_notes_task_fields.py` (create)

**Interfaces:**
- Produces: `Note.bucket:str='today'`, `Note.urgency:int=0`, `Note.project:str|None`, `Note.done:bool=False`; these appear in `note_to_wire(note)` output and are accepted by `create_note_record`/`update_note_record` via `_CREATE_FIELDS`/`_UPDATE_FIELDS`/`_WIRE_IN_FIELDS`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_notes_task_fields.py`:

```python
import core.database as db
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from routes.note.note_service import (
    create_note_record, update_note_record, note_to_wire, note_from_wire,
)


def _s(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path/'s.db'}", connect_args={"check_same_thread": False})
    db.Base.metadata.create_all(eng, tables=[db.Note.__table__])
    return sessionmaker(bind=eng)()


def test_task_fields_default_and_roundtrip(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {"title": "T"})
    # defaults
    assert n.bucket == "today" and n.urgency == 0 and n.project is None and n.done is False
    wire = note_to_wire(n)
    assert wire["bucket"] == "today" and wire["urgency"] == 0
    assert wire["project"] is None and wire["done"] is False


def test_task_fields_create_and_update(tmp_path):
    s = _s(tmp_path)
    n = create_note_record(s, "alice", {
        "title": "T", "bucket": "soon", "urgency": 2, "project": "flat", "done": False,
    })
    assert n.bucket == "soon" and n.urgency == 2 and n.project == "flat"
    n2 = update_note_record(s, "alice", n.id, {"done": True, "bucket": "someday"})
    assert n2.done is True and n2.bucket == "someday"


def test_task_fields_wire_in_filters(tmp_path):
    data = note_from_wire({"title": "T", "bucket": "soon", "project": "x",
                           "urgency": 1, "done": True, "not_a_field": 9})
    assert data["bucket"] == "soon" and data["done"] is True and "not_a_field" not in data
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_notes_task_fields.py -v`
Expected: FAIL — `AttributeError`/`TypeError` (columns/fields don't exist).

- [ ] **Step 3: Add the columns to the `Note` model**

In `core/database.py`, in `class Note` immediately before `rev = Column(...)` (line ~1754), add:

```python
    bucket     = Column(String, default="today")    # today, soon, someday
    urgency    = Column(Integer, default=0)          # 0, 1, 2
    project    = Column(String, nullable=True)       # plain string tag, not a table
    done       = Column(Boolean, default=False)      # task-level completion
```

- [ ] **Step 4: Add + register the migration**

In `core/database.py`, add near `_migrate_add_notes_sort_order` (~1120):

```python
def _migrate_add_notes_task_fields():
    """Add bucket/urgency/project/done to notes if missing. Guarded + idempotent."""
    import sqlite3
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        return
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("PRAGMA table_info(notes)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "bucket" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN bucket TEXT DEFAULT 'today'")
        if columns and "urgency" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN urgency INTEGER DEFAULT 0")
        if columns and "project" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN project TEXT")
        if columns and "done" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN done BOOLEAN DEFAULT 0")
        conn.commit()
        logging.getLogger(__name__).info("Migrated: added task fields to notes")
    except Exception as e:
        logging.getLogger(__name__).warning(f"notes task-fields migration failed: {e}")
    finally:
        if conn:
            conn.close()
```

Then register it next to `_migrate_add_notes_sort_order()` (~1955):

```python
    _migrate_add_notes_sort_order()
    _migrate_add_notes_task_fields()
```

- [ ] **Step 5: Add the fields to `note_service`**

In `routes/note/note_service.py`:

`_CREATE_FIELDS` (line 8-9) — append the four:
```python
_CREATE_FIELDS = ("title", "content", "note_type", "color", "label", "pinned",
                  "due_date", "source", "session_id", "image_url", "repeat", "sort_order",
                  "bucket", "urgency", "project", "done")
```
`_UPDATE_FIELDS` (line 10-12) — append the four:
```python
_UPDATE_FIELDS = ("title", "content", "note_type", "color", "label", "pinned",
                  "archived", "due_date", "image_url", "repeat", "sort_order",
                  "agent_session_id", "bucket", "urgency", "project", "done")
```
`_WIRE_IN_FIELDS` (line 87-89) — append the four:
```python
_WIRE_IN_FIELDS = ("title", "content", "items", "note_type", "color", "label",
                   "pinned", "archived", "due_date", "image_url", "repeat",
                   "sort_order", "source", "session_id", "agent_session_id",
                   "bucket", "urgency", "project", "done")
```
`note_to_wire` return dict (line 105-115) — add the four keys (e.g. after `"repeat": ...`):
```python
        "bucket": note.bucket or "today", "urgency": note.urgency or 0,
        "project": note.project, "done": bool(note.done),
```

Note: `bucket`/`urgency`/`done` are safe in `_UPDATE_FIELDS` even though it skips `None` values (`if data[f] is not None`); `done: False` and `urgency: 0` are not `None`, so they apply.

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_notes_task_fields.py tests/test_note_service.py -v`
Expected: PASS (new file green; existing note_service tests still green).

- [ ] **Step 7: Guard the sync round-trip didn't regress**

Run: `python -m pytest tests/test_sync_registry.py tests/test_sync_routes.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add core/database.py routes/note/note_service.py tests/test_notes_task_fields.py
git commit -m "feat(notes): additive bucket/urgency/project/done task fields"
```

---

### Task 2: sync-engine — `parseCapture()` natural-language capture parser

**Files:**
- Create: `sync-engine/src/parseCapture.ts`
- Modify: `sync-engine/src/index.ts` (add export)
- Test: `sync-engine/src/parseCapture.test.ts` (create)
- Regenerate: `static/js/productivity/sync-core.js` (via `node build.mjs`)

**Interfaces:**
- Produces: `parseCapture(text: string): Parsed` where
  ```ts
  type Bucket = 'today' | 'soon' | 'someday'
  interface Segment { text: string; kind: 'text' | 'project' | 'bucket' | 'time' | 'urgency' }
  interface Parsed {
    title: string; project: string | null; bucket: Bucket | null;
    dueTime: string | null; urgency: 0 | 1 | 2; segments: Segment[];
  }
  ```
  Consumed by the Capture sheet (Task 7). `dueTime` is the raw matched time token (e.g. `"9pm"`), not yet a timestamp.

- [ ] **Step 1: Write the failing test**

Create `sync-engine/src/parseCapture.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseCapture } from './parseCapture'

describe('parseCapture', () => {
  it('extracts project, bucket, time, urgency and cleans the title', () => {
    const r = parseCapture('pay rent @flat today 9pm !!')
    expect(r.title).toBe('pay rent')
    expect(r.project).toBe('flat')
    expect(r.bucket).toBe('today')
    expect(r.dueTime).toBe('9pm')
    expect(r.urgency).toBe(2)
  })

  it('defaults: no tokens → plain title, null/zero fields', () => {
    const r = parseCapture('call the dentist')
    expect(r.title).toBe('call the dentist')
    expect(r.project).toBeNull()
    expect(r.bucket).toBeNull()
    expect(r.dueTime).toBeNull()
    expect(r.urgency).toBe(0)
  })

  it('single ! is urgency 1; 24h time is recognized', () => {
    const r = parseCapture('review notes soon 14:30 !')
    expect(r.bucket).toBe('soon')
    expect(r.dueTime).toBe('14:30')
    expect(r.urgency).toBe(1)
  })

  it('segments cover the whole input in order', () => {
    const r = parseCapture('x @p today')
    expect(r.segments.map(s => s.text).join('')).toBe('x @p today')
    expect(r.segments.some(s => s.kind === 'project' && s.text === '@p')).toBe(true)
    expect(r.segments.some(s => s.kind === 'bucket' && s.text === 'today')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sync-engine && npx vitest run src/parseCapture.test.ts`
Expected: FAIL — cannot resolve `./parseCapture`.

- [ ] **Step 3: Implement `parseCapture`**

Create `sync-engine/src/parseCapture.ts`:

```ts
export type Bucket = 'today' | 'soon' | 'someday'
export interface Segment { text: string; kind: 'text' | 'project' | 'bucket' | 'time' | 'urgency' }
export interface Parsed {
  title: string
  project: string | null
  bucket: Bucket | null
  dueTime: string | null
  urgency: 0 | 1 | 2
  segments: Segment[]
}

// One combined matcher so segments are produced in source order.
const TOKEN = /(@[a-z0-9_-]+)|\b(today|soon|someday)\b|\b(\d{1,2}:\d{2}|\d{1,2}(?:am|pm))\b|(!{1,2})/gi

export function parseCapture(text: string): Parsed {
  let project: string | null = null
  let bucket: Bucket | null = null
  let dueTime: string | null = null
  let urgency: 0 | 1 | 2 = 0
  const segments: Segment[] = []
  const titleParts: string[] = []

  let last = 0
  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) {
      const plain = text.slice(last, m.index)
      segments.push({ text: plain, kind: 'text' })
      titleParts.push(plain)
    }
    const tok = m[0]
    if (m[1]) { project = tok.slice(1); segments.push({ text: tok, kind: 'project' }) }
    else if (m[2]) { bucket = tok.toLowerCase() as Bucket; segments.push({ text: tok, kind: 'bucket' }) }
    else if (m[3]) { dueTime = tok.toLowerCase(); segments.push({ text: tok, kind: 'time' }) }
    else if (m[4]) { urgency = (tok.length >= 2 ? 2 : 1) as 0 | 1 | 2; segments.push({ text: tok, kind: 'urgency' }) }
    last = m.index + tok.length
  }
  if (last < text.length) {
    const tail = text.slice(last)
    segments.push({ text: tail, kind: 'text' })
    titleParts.push(tail)
  }

  const title = titleParts.join('').replace(/\s+/g, ' ').trim()
  return { title, project, bucket, dueTime, urgency, segments }
}
```

- [ ] **Step 4: Export it**

In `sync-engine/src/index.ts` add:
```ts
export { parseCapture } from './parseCapture'
export type { Parsed, Segment, Bucket } from './parseCapture'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd sync-engine && npx vitest run src/parseCapture.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Rebuild the shared bundle**

Run: `cd sync-engine && npm run build`
Expected: prints `built static/js/productivity/sync-core.js`. Verify `parseCapture` is present:
Run: `grep -c 'function parseCapture' static/js/productivity/sync-core.js` → Expected: `1` or more.

- [ ] **Step 7: Commit**

```bash
git add sync-engine/src/parseCapture.ts sync-engine/src/parseCapture.test.ts sync-engine/src/index.ts static/js/productivity/sync-core.js
git commit -m "feat(sync-engine): parseCapture() NL capture parser + rebuild bundle"
```

---

### Task 3: Mobile foundation — Preact/HTM + esbuild pipeline, existing task list re-expressed

**Files:**
- Modify: `mobile/package.json` (deps + build/test scripts)
- Create: `mobile/build.mjs`, `mobile/tsconfig.json`, `mobile/src/sync-core.d.ts`
- Create: `mobile/src/main.ts`, `mobile/src/html.ts`, `mobile/src/token.ts`, `mobile/src/notes.ts`
- Rewrite: `mobile/www/index.html` (mount root only)
- Modify: `mobile/build-apk.sh` (add UI-bundle step)
- Delete: `mobile/www/js/app.js`, `mobile/www/js/token.js` (superseded by the bundle)

**Interfaces:**
- Produces: `mobile/src/html.ts` exporting `html` (`htm.bind(h)`) and re-exporting `h, render`, `useState, useEffect, useMemo, useCallback` from preact/hooks; `mobile/src/token.ts` exporting `getToken()/setToken(t)/clearToken()`; `mobile/src/notes.ts` exporting `notesRepo, createSyncClient, parseCapture` (typed re-exports of the external `./sync-core.js`) plus `API_BASE`.
- Consumed by all later mobile tasks.

- [ ] **Step 1: Add dependencies and scripts to `mobile/package.json`**

Replace the file with:

```json
{
  "name": "odysseus-mobile",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run"
  },
  "dependencies": {
    "@capacitor/android": "^6.1.2",
    "@capacitor/core": "^6.1.2",
    "@capacitor/preferences": "^6.0.2",
    "@capacitor/local-notifications": "^6.0.0",
    "preact": "^10.23.0",
    "htm": "^3.1.1"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.1.2",
    "esbuild": "^0.23.0",
    "typescript": "^5.9.3",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `cd mobile && npm install`
Expected: installs without error; `node_modules/preact` and `node_modules/@capacitor/local-notifications` exist.

- [ ] **Step 3: Add esbuild config**

Create `mobile/build.mjs`:

```js
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'www/js/app.js',
  external: ['./sync-core.js'],   // copied separately into www/js by build-apk.sh
  banner: { js: '// GENERATED by mobile/build.mjs — do not edit. Source: mobile/src/' },
})
console.log('built www/js/app.js')
```

Create `mobile/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "skipLibCheck": true, "noEmit": true,
    "jsx": "preserve", "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

Create `mobile/src/sync-core.d.ts` (types for the external bundle):

```ts
declare module './sync-core.js' {
  export interface NoteRec {
    id: string; title?: string; text?: string; content?: string | null;
    items?: Array<{ text: string; done: boolean }> | null;
    done?: boolean; archived?: boolean; bucket?: string; urgency?: number;
    project?: string | null; sort_order?: number; due_date?: string | null;
  }
  export const notesRepo: {
    list(): Promise<NoteRec[]>
    create(data: Partial<NoteRec>): Promise<NoteRec>
    update(id: string, patch: Partial<NoteRec>): Promise<void>
    remove(id: string): Promise<void>
  }
  export function createSyncClient(opts: {
    apiBase: string; authHeader?: () => Record<string, string>; fetchFn?: typeof fetch
  }): { start(): void; syncOnce(): Promise<void> }
  export interface Segment { text: string; kind: 'text' | 'project' | 'bucket' | 'time' | 'urgency' }
  export interface Parsed {
    title: string; project: string | null;
    bucket: 'today' | 'soon' | 'someday' | null;
    dueTime: string | null; urgency: 0 | 1 | 2; segments: Segment[]
  }
  export function parseCapture(text: string): Parsed
}
```

- [ ] **Step 4: Add the shared runtime modules**

Create `mobile/src/html.ts`:

```ts
import { h, render } from 'preact'
import htm from 'htm'
export const html = htm.bind(h)
export { h, render }
export { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks'
```

Create `mobile/src/token.ts` (port of the old `token.js`):

```ts
const KEY = 'sync_api_token'
function prefs(): any {
  const w = window as any
  return (w.Capacitor && w.Capacitor.Plugins && w.Capacitor.Plugins.Preferences) || null
}
export async function getToken(): Promise<string | null> {
  const p = prefs(); if (!p) return null
  const { value } = await p.get({ key: KEY }); return value || null
}
export async function setToken(token: string): Promise<void> {
  const p = prefs(); if (!p) return; await p.set({ key: KEY, value: token })
}
export async function clearToken(): Promise<void> {
  const p = prefs(); if (!p) return; await p.remove({ key: KEY })
}
```

Create `mobile/src/notes.ts`:

```ts
import { notesRepo, createSyncClient, parseCapture } from './sync-core.js'
export type { NoteRec, Parsed, Segment } from './sync-core.js'
export { notesRepo, createSyncClient, parseCapture }
export const API_BASE = 'https://chat.elsiga.ch/api/sync'
```

- [ ] **Step 5: Rewrite `mobile/www/index.html` to a mount root**

Replace `mobile/www/index.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Odysseus Tasks</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./js/app.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write the foundation app (task list re-expressed) in `mobile/src/main.ts`**

This reproduces the current behavior (offline-first local render → token gate → sync → live repaint after awaited writes) as Preact. Screens/components land in later tasks; this proves the pipeline.

```ts
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
```

- [ ] **Step 7: Add the UI-bundle step to `build-apk.sh`**

In `mobile/build-apk.sh`, after the `cp ../static/js/productivity/sync-core.js www/js/sync-core.js` line and after `npm install`, add the bundle step so it runs before `cap sync`. The relevant block becomes:

```bash
npm install
mkdir -p www/js
cp ../static/js/productivity/sync-core.js www/js/sync-core.js
node build.mjs                          # bundle src/ → www/js/app.js
[ -d android ] || npx cap add android
npx cap sync android
```

- [ ] **Step 8: Remove the superseded raw-DOM files**

```bash
git rm mobile/www/js/app.js mobile/www/js/token.js
```
(The bundle regenerates `mobile/www/js/app.js`; it is a build artifact from here on. Leave it untracked or track the built file consistently with the repo's current choice — it was tracked before, so it will be re-added as the built output in Step 9's commit.)

- [ ] **Step 9: Build the bundle and verify**

Run: `cd mobile && cp ../static/js/productivity/sync-core.js www/js/sync-core.js && node build.mjs`
Expected: prints `built www/js/app.js`; `mobile/www/js/app.js` exists and contains the banner `GENERATED by mobile/build.mjs`.
Run: `node -e "require('fs').accessSync('www/js/app.js')" && echo OK`
Expected: `OK`.

- [ ] **Step 10: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/build.mjs mobile/tsconfig.json \
        mobile/src mobile/www/index.html mobile/www/js/app.js mobile/build-apk.sh
git commit -m "feat(mobile): Preact/HTM+esbuild foundation; task list re-expressed; local-notifications dep"
```

---

### Task 4: Mobile — pure task-derivation logic (`tasks.ts`)

**Files:**
- Create: `mobile/src/tasks.ts`
- Test: `mobile/src/tasks.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  import type { NoteRec } from './notes'
  export type Bucket = 'today' | 'soon' | 'someday'
  export function bucketOf(n: NoteRec): Bucket                 // n.bucket, defaulting to 'today'
  export function activeByBucket(notes: NoteRec[]): Record<Bucket, NoteRec[]>  // not-done, not-archived
  export function bucketCounts(notes: NoteRec[]): Record<Bucket, number>
  export function todayView(notes: NoteRec[], cap?: number): { visible: NoteRec[]; overflow: number }
  export function pickSuggestion(notes: NoteRec[], idx: number): NoteRec | null
  export function projectsOf(notes: NoteRec[]): Array<{ name: string; count: number }>
  ```
- Consumed by Home (Task 6), Library (Task 8), Project (Task 9).

- [ ] **Step 1: Write the failing test**

Create `mobile/src/tasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bucketOf, activeByBucket, bucketCounts, todayView, pickSuggestion, projectsOf } from './tasks'
import type { NoteRec } from './notes'

const N = (o: Partial<NoteRec>): NoteRec => ({ id: Math.random().toString(36), title: 't', ...o })

describe('tasks derivations', () => {
  const notes: NoteRec[] = [
    N({ id: 'a', bucket: 'today', done: false }),
    N({ id: 'b', bucket: 'today', done: true }),
    N({ id: 'c', bucket: 'soon', done: false, project: 'flat' }),
    N({ id: 'd', bucket: 'someday', done: false, project: 'flat' }),
    N({ id: 'e', archived: true, bucket: 'today', done: false }),
  ]

  it('bucketOf defaults to today', () => {
    expect(bucketOf(N({ bucket: undefined }))).toBe('today')
    expect(bucketOf(N({ bucket: 'soon' }))).toBe('soon')
  })

  it('activeByBucket excludes done and archived', () => {
    const by = activeByBucket(notes)
    expect(by.today.map(n => n.id)).toEqual(['a'])   // b done, e archived
    expect(by.soon.map(n => n.id)).toEqual(['c'])
    expect(by.someday.map(n => n.id)).toEqual(['d'])
  })

  it('bucketCounts counts active per bucket', () => {
    expect(bucketCounts(notes)).toEqual({ today: 1, soon: 1, someday: 1 })
  })

  it('todayView caps and reports overflow', () => {
    const many = Array.from({ length: 7 }, (_, i) => N({ id: 's' + i, bucket: 'today', done: false }))
    const v = todayView(many, 5)
    expect(v.visible).toHaveLength(5)
    expect(v.overflow).toBe(2)
  })

  it('pickSuggestion cycles active today tasks, null when none', () => {
    expect(pickSuggestion(notes, 0)!.id).toBe('a')
    expect(pickSuggestion(notes, 1)!.id).toBe('a')  // only one → wraps
    expect(pickSuggestion([], 0)).toBeNull()
  })

  it('projectsOf lists projects with active counts', () => {
    expect(projectsOf(notes)).toEqual([{ name: 'flat', count: 2 }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx vitest run src/tasks.test.ts`
Expected: FAIL — cannot resolve `./tasks`.

- [ ] **Step 3: Implement `tasks.ts`**

Create `mobile/src/tasks.ts`:

```ts
import type { NoteRec } from './notes'
export type Bucket = 'today' | 'soon' | 'someday'
const BUCKETS: Bucket[] = ['today', 'soon', 'someday']

export function bucketOf(n: NoteRec): Bucket {
  const b = (n.bucket || 'today') as Bucket
  return BUCKETS.includes(b) ? b : 'today'
}

function isActive(n: NoteRec): boolean { return !n.archived && !n.done }

export function activeByBucket(notes: NoteRec[]): Record<Bucket, NoteRec[]> {
  const out: Record<Bucket, NoteRec[]> = { today: [], soon: [], someday: [] }
  for (const n of notes) if (isActive(n)) out[bucketOf(n)].push(n)
  return out
}

export function bucketCounts(notes: NoteRec[]): Record<Bucket, number> {
  const by = activeByBucket(notes)
  return { today: by.today.length, soon: by.soon.length, someday: by.someday.length }
}

export function todayView(notes: NoteRec[], cap = 5): { visible: NoteRec[]; overflow: number } {
  const today = activeByBucket(notes).today
  return { visible: today.slice(0, cap), overflow: Math.max(0, today.length - cap) }
}

export function pickSuggestion(notes: NoteRec[], idx: number): NoteRec | null {
  const today = activeByBucket(notes).today
  if (today.length === 0) return null
  return today[((idx % today.length) + today.length) % today.length]
}

export function projectsOf(notes: NoteRec[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const n of notes) {
    if (!isActive(n) || !n.project) continue
    counts.set(n.project, (counts.get(n.project) || 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx vitest run src/tasks.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/tasks.ts mobile/src/tasks.test.ts
git commit -m "feat(mobile): pure task-derivation logic (buckets/today/suggestion/projects)"
```

---

### Task 5: Mobile — theme tokens + reusable presentational components

**Files:**
- Create: `mobile/src/theme.ts`, `mobile/src/components.ts`
- Modify: `mobile/www/index.html` (font + base body style)

**Interfaces:**
- Produces: `theme` (color/font token object) from `theme.ts`; from `components.ts`: `TaskRow`, `BucketChip`, `ProjectTag`, `PrimaryButton`, `BottomSheet`, `Toast` — all Preact components taking typed props (below).
- Consumed by Tasks 6–9.

- [ ] **Step 1: Add the theme tokens**

Create `mobile/src/theme.ts` (values from the prototype `odysseus` theme):

```ts
export const theme = {
  bg: '#171E28', bg2: '#12181F', card: '#1E2733', card2: '#2A3644',
  border: '#2A3644', text: '#EFE9E1', text2: '#C9C2D2', muted: '#5C7080',
  faint: '#3A4A5A', accent: '#FF6B5E', scrim: 'rgba(0,0,0,.55)',
  mono: "'JetBrains Mono',ui-monospace,monospace",
}
```

- [ ] **Step 2: Set the app-wide font/background in `index.html`**

Update `mobile/www/index.html` `<head>` to preload the font and style `body` (fallback to system mono if the webfont is unavailable offline — bundle-free, so use system mono and JetBrains Mono if present):

```html
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; background:#171E28; color:#EFE9E1;
           font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;
           padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
    input,textarea,button { font-family:inherit; }
  </style>
```

- [ ] **Step 3: Implement the components**

Create `mobile/src/components.ts`:

```ts
import { html } from './html'
import { theme as T } from './theme'
import type { NoteRec } from './notes'

// Task row — states via props (active/done handled by caller styling)
export function TaskRow({ note, onToggle, onOpen }:
  { note: NoteRec; onToggle: () => void; onOpen?: () => void }) {
  const done = !!note.done
  return html`
    <div style=${{ display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 14px',
                   border: `1px solid ${T.card2}`, borderRadius: '12px', opacity: done ? 0.55 : 1 }}>
      <div onClick=${(e: any) => { e.stopPropagation(); onToggle() }}
           style=${{ width: '22px', height: '22px', borderRadius: '50%',
                     border: `2px solid ${done ? T.accent : '#4A5866'}`,
                     background: done ? T.accent : 'transparent', flex: 'none', cursor: 'pointer' }}></div>
      <span onClick=${onOpen} style=${{ flex: 1, font: `400 15px ${T.mono}`,
             color: done ? T.muted : T.text, textDecoration: done ? 'line-through' : 'none',
             cursor: onOpen ? 'pointer' : 'default' }}>${note.title || '(untitled)'}</span>
      <span style=${{ font: `400 11px ${T.mono}`, color: T.muted }}>${note.project ? '#' + note.project : ''}</span>
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
```

- [ ] **Step 4: Verify the bundle still builds**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js` (no unresolved imports; components compile).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/theme.ts mobile/src/components.ts mobile/www/index.html mobile/www/js/app.js
git commit -m "feat(mobile): odysseus theme tokens + reusable task/chip/button/sheet/toast components"
```

---

### Task 6: Mobile — Home / Today screen

**Files:**
- Create: `mobile/src/screens/Home.ts`
- Modify: `mobile/src/main.ts` (render Home when authed; lift notes/actions into a store hook)
- Create: `mobile/src/store.ts` (shared notes state + actions hook)

**Interfaces:**
- Produces: `useNotesStore()` from `store.ts` → `{ notes, status, refresh, addTask, toggle, remove, update, syncNow }`; `Home` component consuming the store + `nav` callbacks `{ onOpenCapture, onOpenLibrary, onOpenProjects }`.
- Consumed by main (Task 6) and later screens (Tasks 7–9 reuse `useNotesStore`).

- [ ] **Step 1: Extract the store hook**

Create `mobile/src/store.ts` (moves the boot/refresh/mutation logic out of main so every screen shares it):

```ts
import { useState, useEffect, useRef } from './html'
import { notesRepo, createSyncClient, API_BASE, type NoteRec } from './notes'
import { getToken } from './token'

export function useNotesStore() {
  const [notes, setNotes] = useState<NoteRec[]>([])
  const [status, setStatus] = useState('')
  const client = useRef<null | ReturnType<typeof createSyncClient>>(null)

  async function refresh() {
    const all = await notesRepo.list()
    setNotes(all.filter(n => !n.archived).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
  }
  async function syncNow() { await client.current?.syncOnce(); await refresh() }

  useEffect(() => { (async () => {
    await refresh()
    const t = await getToken(); if (!t) { setStatus('no token'); return }
    const c = createSyncClient({ apiBase: API_BASE, authHeader: () => ({ Authorization: `Bearer ${t}` }) })
    client.current = c; c.start(); setStatus('syncing')
    await c.syncOnce(); await refresh(); setStatus(navigator.onLine ? 'synced' : 'offline')
  })() }, [])

  async function addTask(data: Partial<NoteRec>) { await notesRepo.create({ done: false, bucket: 'today', ...data }); await refresh(); void syncNow() }
  async function toggle(n: NoteRec) { await notesRepo.update(n.id, { done: !n.done }); await refresh(); void syncNow() }
  async function update(id: string, patch: Partial<NoteRec>) { await notesRepo.update(id, patch); await refresh(); void syncNow() }
  async function remove(n: NoteRec) { await notesRepo.remove(n.id); await refresh(); void syncNow() }

  return { notes, status, refresh, addTask, toggle, remove, update, syncNow }
}
```

- [ ] **Step 2: Write the Home screen**

Create `mobile/src/screens/Home.ts`:

```ts
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
```

- [ ] **Step 3: Wire Home into `main.ts`**

Replace `mobile/src/main.ts` with a router root that uses the store and renders Home (Capture/Library/Project screens attach in Tasks 7–9):

```ts
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
```

- [ ] **Step 4: Build and verify**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`, no unresolved-import errors.

- [ ] **Step 5: Smoke-render in a browser (optional, fast)**

Open `mobile/www/index.html` via a static server after copying the bundle:
Run: `cd mobile && cp ../static/js/productivity/sync-core.js www/js/sync-core.js && python -m http.server -d www 8099`
Then load `http://localhost:8099` in a browser: the token gate shows (no Capacitor Preferences → treated as no token), the layout uses the theme. (Full task flow needs the APK.)

- [ ] **Step 6: Commit**

```bash
git add mobile/src/store.ts mobile/src/screens/Home.ts mobile/src/main.ts mobile/www/js/app.js
git commit -m "feat(mobile): Home/Today screen — WHAT-NOW, today list, bucket chips, capture pill"
```

---

### Task 7: Mobile — Capture sheet

**Files:**
- Create: `mobile/src/screens/Capture.ts`
- Modify: `mobile/src/main.ts` (route `capture`)

**Interfaces:**
- Consumes: `parseCapture` (from `./notes`), `store.addTask`, `BottomSheet`/`BucketChip`/`PrimaryButton`/`Toast`.
- Produces: `Capture` component with props `{ onSave: (data) => Promise<void>; onClose: () => void; defaultProject?: string }`, where `data` is `{ title, bucket, project, urgency, due_date }`.

- [ ] **Step 1: Write the Capture sheet**

Create `mobile/src/screens/Capture.ts`:

```ts
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
```

- [ ] **Step 2: Route it in `main.ts`**

In `mobile/src/main.ts`, add the import and the `capture` route. Add near the other imports:
```ts
import { Capture } from './screens/Capture'
```
Replace the `if (route.name === 'home')` block's sibling fall-through so capture renders over Home. After the Home return, add:
```ts
  if (route.name === 'capture')
    return html`
      <${Home} notes=${store.notes} status=${store.status} onToggle=${store.toggle} onOpen=${openDetail}
        onCapture=${() => setRoute({ name: 'capture' })} onLibrary=${() => setRoute({ name: 'library' })} />
      <${Capture} onSave=${store.addTask} onClose=${() => setRoute({ name: 'home' })} />`
```
(Home stays mounted behind the sheet; `store.addTask` already defaults `done:false`.)

- [ ] **Step 3: Build and verify**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/Capture.ts mobile/src/main.ts mobile/www/js/app.js
git commit -m "feat(mobile): capture sheet with live NL parse highlight + bucket chips"
```

---

### Task 8: Mobile — Library (buckets + projects)

**Files:**
- Create: `mobile/src/screens/Library.ts`
- Modify: `mobile/src/main.ts` (route `library`)

**Interfaces:**
- Consumes: `activeByBucket`, `projectsOf` (from `./tasks`), `TaskRow`, `ProjectTag`, `store`.
- Produces: `Library` component props `{ notes; onToggle; onOpen; onOpenProject: (name) => void; onBack: () => void }`.

- [ ] **Step 1: Write the Library screen**

Create `mobile/src/screens/Library.ts`:

```ts
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
```

- [ ] **Step 2: Route it in `main.ts`**

Add import `import { Library } from './screens/Library'` and the route branch:
```ts
  if (route.name === 'library')
    return html`<${Library} notes=${store.notes} onToggle=${store.toggle} onOpen=${openDetail}
      onOpenProject=${(name: string) => setRoute({ name: 'project', project: name })}
      onBack=${() => setRoute({ name: 'home' })} />`
```

- [ ] **Step 3: Build and verify**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/screens/Library.ts mobile/src/main.ts mobile/www/js/app.js
git commit -m "feat(mobile): Library screen — bucket sections + project tags"
```

---

### Task 9: Mobile — Project view + task detail / manual step editing

**Files:**
- Create: `mobile/src/screens/Project.ts`, `mobile/src/screens/Detail.ts`
- Modify: `mobile/src/main.ts` (routes `project`, `detail`; capture with `defaultProject`)

**Interfaces:**
- Consumes: `store.{notes,toggle,update,addTask}`, `TaskRow`, `PrimaryButton`.
- Produces: `Project` props `{ project; notes; onToggle; onOpen; onCapture; onBack }`; `Detail` props `{ note; onUpdate: (patch) => void; onBack }` where step edits write `items: Array<{text,done}>` via `onUpdate`.

- [ ] **Step 1: Write the Project screen**

Create `mobile/src/screens/Project.ts`:

```ts
import { html } from '../html'
import { theme as T } from '../theme'
import { TaskRow } from '../components'
import type { NoteRec } from '../notes'

export function Project({ project, notes, onToggle, onOpen, onCapture, onBack }:
  { project: string; notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void; onBack: () => void }) {
  const rows = notes.filter(n => n.project === project && !n.archived && !n.done)
  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '16px', padding: '26px 20px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <span style=${{ font: `700 21px ${T.mono}` }}>#${project}</span>
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>← back</span>
      </div>
      ${rows.map(n => html`<${TaskRow} key=${n.id} note=${n} onToggle=${() => onToggle(n)} onOpen=${() => onOpen(n)} />`)}
      <div onClick=${onCapture} style=${{ padding: '14px 16px', border: `1px dashed ${T.border}`, borderRadius: '14px',
        font: `400 14px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>＋ add a task to this project</div>
    </div>`
}
```

- [ ] **Step 2: Write the Detail / step-editor screen**

Create `mobile/src/screens/Detail.ts`:

```ts
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
```

- [ ] **Step 3: Route both in `main.ts`, and pass `defaultProject` to Capture from Project**

Add imports:
```ts
import { Project } from './screens/Project'
import { Detail } from './screens/Detail'
```
Add route branches (before the final fall-through):
```ts
  if (route.name === 'project') {
    const p = route.project
    return html`<${Project} project=${p} notes=${store.notes} onToggle=${store.toggle} onOpen=${openDetail}
      onCapture=${() => setRoute({ name: 'capture', project: p } as any)} onBack=${() => setRoute({ name: 'library' })} />`
  }
  if (route.name === 'detail') {
    const n = store.notes.find(x => x.id === route.id)
    if (!n) { setRoute({ name: 'home' }); return html`` }
    return html`<${Detail} note=${n} onUpdate=${(patch: any) => store.update(n.id, patch)} onBack=${() => setRoute({ name: 'home' })} />`
  }
```
Update the `Route` type to let capture carry an optional project:
```ts
type Route = { name: 'home' } | { name: 'capture'; project?: string } | { name: 'library' }
  | { name: 'project'; project: string } | { name: 'detail'; id: string }
```
And in the `capture` branch, pass it through:
```ts
  if (route.name === 'capture')
    return html`
      <${Home} notes=${store.notes} status=${store.status} onToggle=${store.toggle} onOpen=${openDetail}
        onCapture=${() => setRoute({ name: 'capture' })} onLibrary=${() => setRoute({ name: 'library' })} />
      <${Capture} onSave=${store.addTask} onClose=${() => setRoute({ name: 'home' })} defaultProject=${route.project} />`
```

- [ ] **Step 4: Build and verify**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/Project.ts mobile/src/screens/Detail.ts mobile/src/main.ts mobile/www/js/app.js
git commit -m "feat(mobile): Project view + task detail with manual step editing"
```

---

### Task 10: APK build + local-notifications proof + on-device verification

**Files:**
- Create: `mobile/src/notify.ts`
- Modify: `mobile/src/main.ts` (a small "Test reminder" affordance in the token gate / a settings entry)
- Docs: `docs/productivity/mobile-build.md` (append Slice-1 build + proof notes) if it exists; otherwise skip doc edit.

**Interfaces:**
- Produces: `scheduleTestNotification()` from `notify.ts` (uses `@capacitor/local-notifications`).

- [ ] **Step 1: Add the notification helper**

Create `mobile/src/notify.ts`:

```ts
export async function scheduleTestNotification(): Promise<void> {
  const w = window as any
  const LN = w.Capacitor?.Plugins?.LocalNotifications
  if (!LN) return
  await LN.requestPermissions()
  await LN.schedule({
    notifications: [{
      id: Math.floor(Math.random() * 1e6),
      title: 'Odysseus',
      body: 'Test reminder — timers will use this.',
      schedule: { at: new Date(Date.now() + 10_000) },  // 10s out; lock the screen to prove it
    }],
  })
}
```

- [ ] **Step 2: Expose it (temporary proof affordance)**

In `mobile/src/main.ts`, in the `TokenGate` (or add a tiny header button on Home), add a button that calls it. Minimal: add to `TokenGate`'s buttons row:
```ts
import { scheduleTestNotification } from './notify'
// ...inside TokenGate render, after Save button:
html`<button onClick=${() => scheduleTestNotification()}>Test reminder</button>`
```

- [ ] **Step 3: Build the bundle**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.

- [ ] **Step 4: Build the APK**

Run: `bash mobile/build-apk.sh`
Expected: ends with `APK → dist/odysseus.apk (…M)`. (Uses the Android SDK/JDK env in the script.)

- [ ] **Step 5: Verify the bundle is packaged**

Run: `unzip -l dist/odysseus.apk | grep -E 'assets/public/(index.html|js/(app|sync-core).js)'`
Expected: all three present.

- [ ] **Step 6: On-device proof (manual — user)**

1. `adb install -r dist/odysseus.apk`, open the app, paste an `ody_` token (`mobile_sync` profile).
2. **Todo:** capture a task (`pay rent @flat today 9pm !!`) → appears in today with `#flat`, project tag in Library, urgency parsed; toggle done; open a task → add steps; verify it round-trips to Notes on `https://chat.elsiga.ch`.
3. **Offline:** airplane mode → fully close → reopen → tasks present (cold-offline unchanged) → capture offline → back online → syncs.
4. **Notification:** tap **Test reminder**, lock the screen → notification fires within ~10s.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/notify.ts mobile/src/main.ts mobile/www/js/app.js
git commit -m "feat(mobile): local-notifications test-reminder proof + Slice-1 APK"
```

---

## Self-Review

**Spec coverage:**
- Foundation (Preact/HTM + esbuild, task list re-expressed, local-notifications) → Tasks 3, 10. ✓
- 4 additive Note fields → Task 1. ✓
- parseCapture (sync-engine, vitest) → Task 2. ✓
- Home/Today (WHAT-NOW, inert Start, today list + overfull, bucket chips, capture pill, empty state) → Task 6. ✓
- Capture sheet (NL parse highlight, bucket chips, save) → Task 7. ✓
- Library (buckets + projects) → Task 8. ✓
- Project view + task detail / manual step editing → Task 9. ✓
- Repaint-after-awaited-write model → store.ts (Task 6), foundation (Task 3). ✓
- Testing (backend fields, parseCapture, tasks derivations, build, APK, notification) → Tasks 1,2,4,10. ✓
- Non-goals (calendar/focus/chat/iOS/external events) — not built. ✓

**Placeholder scan:** the only "…" strings are intentional loading/route-fallback UI text, replaced by real screens as later tasks land; every code step ships complete code.

**Type consistency:** `NoteRec` (declared in `sync-core.d.ts`, re-exported via `notes.ts`) is used uniformly. `Bucket` is defined in both `parseCapture.ts` and `tasks.ts` as `'today'|'soon'|'someday'` (independent local aliases, identical shape — no cross-import mismatch). `parseCapture` returns `{title,project,bucket,dueTime,urgency,segments}` — consumed exactly so in Capture (Task 7). Store methods `{notes,status,refresh,addTask,toggle,remove,update,syncNow}` match their call sites in Tasks 6–9. `items` step shape `{text,done}` is consistent between Detail (Task 9) and the model.
