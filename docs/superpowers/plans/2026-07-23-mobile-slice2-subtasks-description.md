# Mobile Slice 2 — Task Subtasks + Description — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subtasks real on the mobile task app — checkable, visible (row `done/total` + a small progress bar), editable in an upgraded Detail screen — plus a freeform task description, building on odysseus's native Note `items`/`note_type`/`content` fields.

**Architecture:** Mobile-only (Capacitor UI under `mobile/src/`). **Zero backend change** — `content`, `items`, and `note_type` already round-trip through the Slice-1 sync engine and are updatable via `note_service`. Subtasks live in `note.items` (`[{text,done}]`); description in `note.content`; `note_type` is derived (`'checklist'` when ≥1 subtask, else `'note'`) so odysseus's existing web checklist renderer shows them for free. Web is untouched.

**Tech Stack:** TypeScript, Preact + HTM (no JSX), esbuild, Vitest.

## Global Constraints

- **Zero backend change.** Do NOT touch Python, the sync engine internals, or Capacitor native config. Only `mobile/src/**` and `docs/productivity/mobile-build.md`.
- **Repaint model (from Slice 1):** every edit goes through `store.update` (awaited `notesRepo.update` → `refresh()` → background `syncNow()`); NEVER `notesRepo.subscribe()`.
- **note_type is derived, always written with items:** whenever `items` changes, write `{ items, note_type: deriveNoteType(items) }` in the same patch.
- **Subtask persisted shape stays `{text, done}`** — any view-local row `id` used for stable keys must be stripped before writing to `note.items`.
- **Parent `done` is independent** of subtask completion — never auto-toggle `note.done` from subtasks.
- **Description is stored only** (freeform `content`); no AI use this slice. Clearing it writes `""`, not null.
- NO JSX — `html` tagged templates from `./html`. Verification bar for UI tasks = clean `node build.mjs` + clean `npx tsc --noEmit`.
- Stage EXPLICIT paths only — never `git add -A` (untracked `design/` must never be staged; `dist/odysseus.apk` is gitignored — never stage it). `mobile/www/js/app.js` IS the tracked built artifact — rebuild and stage it in UI-task commits.
- Build/test commands: mobile unit `cd mobile && npx vitest run <file>`; mobile bundle `cd mobile && node build.mjs`; typecheck `cd mobile && npx tsc --noEmit`; APK `bash mobile/build-apk.sh` → `dist/odysseus.apk`.

---

### Task 1: Pure subtask logic (`subtasks.ts`) + `NoteRec.note_type`

**Files:**
- Create: `mobile/src/subtasks.ts`
- Test: `mobile/src/subtasks.test.ts` (create)
- Modify: `mobile/src/sync-core.d.ts` (add `note_type` to `NoteRec`)

**Interfaces:**
- Produces:
  ```ts
  export type Subtask = { text: string; done: boolean }
  export function deriveNoteType(items: Subtask[]): 'note' | 'checklist'
  export function subtaskProgress(items: Subtask[] | null | undefined): { done: number; total: number; ratio: number }
  ```
  `ratio` ∈ [0,1], and is `0` when `total` is `0`. Consumed by Detail (Task 2) and TaskRow (Task 3).
- Produces: `NoteRec.note_type?: 'note' | 'checklist'` so `store.update({ note_type })` typechecks.

- [ ] **Step 1: Write the failing test**

Create `mobile/src/subtasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveNoteType, subtaskProgress } from './subtasks'

describe('deriveNoteType', () => {
  it('empty list → note', () => expect(deriveNoteType([])).toBe('note'))
  it('non-empty list → checklist', () =>
    expect(deriveNoteType([{ text: 'a', done: false }])).toBe('checklist'))
})

describe('subtaskProgress', () => {
  it('null and empty → 0/0, ratio 0', () => {
    expect(subtaskProgress(null)).toEqual({ done: 0, total: 0, ratio: 0 })
    expect(subtaskProgress(undefined)).toEqual({ done: 0, total: 0, ratio: 0 })
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0, ratio: 0 })
  })
  it('2 of 5 done → ratio 0.4', () => {
    const items = [
      { text: 'a', done: true }, { text: 'b', done: true },
      { text: 'c', done: false }, { text: 'd', done: false }, { text: 'e', done: false },
    ]
    expect(subtaskProgress(items)).toEqual({ done: 2, total: 5, ratio: 0.4 })
  })
  it('all done → ratio 1', () => {
    expect(subtaskProgress([{ text: 'a', done: true }, { text: 'b', done: true }]))
      .toEqual({ done: 2, total: 2, ratio: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx vitest run src/subtasks.test.ts`
Expected: FAIL — cannot resolve `./subtasks`.

- [ ] **Step 3: Implement `subtasks.ts`**

Create `mobile/src/subtasks.ts`:

```ts
export type Subtask = { text: string; done: boolean }

export function deriveNoteType(items: Subtask[]): 'note' | 'checklist' {
  return items.length > 0 ? 'checklist' : 'note'
}

export function subtaskProgress(
  items: Subtask[] | null | undefined,
): { done: number; total: number; ratio: number } {
  const list = items ?? []
  const total = list.length
  const done = list.filter(s => s.done).length
  return { done, total, ratio: total > 0 ? done / total : 0 }
}
```

- [ ] **Step 4: Add `note_type` to `NoteRec`**

In `mobile/src/sync-core.d.ts`, add `note_type` to the `NoteRec` interface (after `due_date`):

```ts
export interface NoteRec {
  id: string; title?: string; text?: string; content?: string | null;
  items?: Array<{ text: string; done: boolean }> | null;
  done?: boolean; archived?: boolean; bucket?: string; urgency?: number;
  project?: string | null; sort_order?: number; due_date?: string | null;
  note_type?: 'note' | 'checklist';
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && npx vitest run src/subtasks.test.ts`
Expected: PASS (3 describe blocks, all green).
Run: `cd mobile && npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add mobile/src/subtasks.ts mobile/src/subtasks.test.ts mobile/src/sync-core.d.ts
git commit -m "feat(mobile): pure subtask logic (deriveNoteType/subtaskProgress) + NoteRec.note_type"
```

---

### Task 2: Upgrade Detail into a real task editor

**Files:**
- Modify: `mobile/src/screens/Detail.ts` (full rewrite)
- Modify: `mobile/www/js/app.js` (rebuilt artifact)

**Interfaces:**
- Consumes: `deriveNoteType`, `Subtask` (from `../subtasks`); `store.update` via the existing `onUpdate: (patch: Partial<NoteRec>) => void` prop (already wired in `main.ts`).
- Produces: no new exported interface — `Detail`'s prop signature `{ note, onUpdate, onBack }` is unchanged, so `main.ts` needs no edit.

- [ ] **Step 1: Rewrite `Detail.ts`**

Replace `mobile/src/screens/Detail.ts` with:

```ts
import { html, useState } from '../html'
import { theme as T } from '../theme'
import { deriveNoteType, type Subtask } from '../subtasks'
import type { NoteRec } from '../notes'

// View-local rows carry a stable id for keying; ids are NOT persisted to note.items.
type Row = { id: number; text: string; done: boolean }
let _uid = 0
const toRows = (items: Subtask[]): Row[] => items.map(s => ({ id: ++_uid, text: s.text, done: !!s.done }))
const toItems = (rows: Row[]): Subtask[] => rows.map(({ text, done }) => ({ text, done }))

export function Detail({ note, onUpdate, onBack }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void; onBack: () => void }) {
  const [title, setTitle] = useState(note.title || '')
  const [desc, setDesc] = useState(note.content || '')
  const [rows, setRows] = useState<Row[]>(toRows((note.items as Subtask[]) || []))

  // Persist subtasks + derived note_type together (Global Constraint).
  function persist(next: Row[]) {
    const items = toItems(next)
    onUpdate({ items, note_type: deriveNoteType(items) })
  }
  function setAndPersist(next: Row[]) { setRows(next); persist(next) }

  const toggle = (id: number) => setAndPersist(rows.map(r => r.id === id ? { ...r, done: !r.done } : r))
  const remove = (id: number) => setAndPersist(rows.filter(r => r.id !== id))
  const add = () => setAndPersist([...rows, { id: ++_uid, text: '', done: false }])
  const editLocal = (id: number, text: string) => setRows(rows.map(r => r.id === id ? { ...r, text } : r))

  const saveTitle = () => { const t = title.trim(); if (t !== (note.title || '')) onUpdate({ title: t }) }
  const saveDesc = () => { if (desc !== (note.content || '')) onUpdate({ content: desc }) }

  return html`
    <div style=${{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '16px', padding: '26px 20px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px' }}>
        <input value=${title} onInput=${(e: any) => setTitle(e.target.value)} onBlur=${saveTitle}
          placeholder="Task title"
          style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', font: `700 20px ${T.mono}`, color: T.text }} />
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer', marginLeft: '12px', flex: 'none' }}>← back</span>
      </div>

      <textarea value=${desc} onInput=${(e: any) => setDesc(e.target.value)} onBlur=${saveDesc}
        placeholder="Add a description…" rows=${3}
        style=${{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: '12px', padding: '14px',
          font: `400 14px ${T.mono}`, color: T.text2, resize: 'vertical', width: '100%' }}></textarea>

      <div style=${{ font: `400 13px ${T.mono}`, color: T.muted, padding: '0 4px' }}>break it down</div>
      ${rows.map(r => html`
        <div key=${r.id} style=${{ display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 6px 6px 14px',
          background: T.card, border: `1px solid ${T.border}`, borderRadius: '12px' }}>
          <div onClick=${() => toggle(r.id)} style=${{ width: '20px', height: '20px', borderRadius: '6px', flex: 'none', cursor: 'pointer',
            border: `2px solid ${r.done ? T.accent : '#4A5866'}`, background: r.done ? T.accent : 'transparent' }}></div>
          <input value=${r.text} onInput=${(e: any) => editLocal(r.id, e.target.value)} onBlur=${() => persist(rows)}
            placeholder="Subtask"
            style=${{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', font: `400 15px ${T.mono}`,
              color: r.done ? T.muted : T.text, textDecoration: r.done ? 'line-through' : 'none', padding: '10px 0' }} />
          <span onClick=${() => remove(r.id)} style=${{ width: '44px', height: '44px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: T.muted, cursor: 'pointer', font: `400 18px ${T.mono}`, flex: 'none' }}>×</span>
        </div>`)}
      <div onClick=${add} style=${{ padding: '13px 14px', border: `1px dashed ${T.border}`, borderRadius: '12px',
        font: `400 14px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>＋ add a subtask</div>
    </div>`
}
```

Notes for the implementer:
- Subtask **text** edits update local state on `onInput` and persist on `onBlur` (avoids a store write + sync per keystroke). **toggle / remove / add** persist immediately (discrete actions). Title and description also persist on blur.
- `onBlur=${() => persist(rows)}`: `rows` is the current render's closure, kept up to date by `editLocal`'s `setRows`, so blur persists the latest text.
- Stable `r.id` keys replace the Slice-1 index keys — fixes the logged focus-flash-on-delete.

- [ ] **Step 2: Build and typecheck**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`, no unresolved-import errors.
Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/screens/Detail.ts mobile/www/js/app.js
git commit -m "feat(mobile): Detail task editor — editable title, description, checkable subtasks + note_type derive"
```

---

### Task 3: Task row subtask progress (count + small bar)

**Files:**
- Modify: `mobile/src/components.ts` (`TaskRow`)
- Modify: `mobile/www/js/app.js` (rebuilt artifact)

**Interfaces:**
- Consumes: `subtaskProgress` (from `./subtasks`).
- Produces: `TaskRow` prop signature unchanged (`{ note, onToggle, onOpen }`) — callers (Home/Library/Project) need no edit.

- [ ] **Step 1: Add the import**

In `mobile/src/components.ts`, add near the top imports (after the `theme` import):

```ts
import { subtaskProgress } from './subtasks'
```

- [ ] **Step 2: Rewrite `TaskRow` to show progress**

Replace the existing `TaskRow` function in `mobile/src/components.ts` with:

```ts
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
```

(The title + progress now stack in a middle flex column; `onOpen` moved from the title span to that column wrapper. Rows with no subtasks render exactly as before — the progress block is gated on `st > 0`.)

- [ ] **Step 3: Build and typecheck**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.
Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/components.ts mobile/www/js/app.js
git commit -m "feat(mobile): TaskRow subtask progress — done/total count + small progress bar"
```

---

### Task 4: APK build + on-device verification

**Files:**
- Modify: `docs/productivity/mobile-build.md` (append Slice-2 notes)

**Interfaces:** none (build + manual verification).

- [ ] **Step 1: Rebuild the bundle**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.

- [ ] **Step 2: Build the APK**

Run: `bash mobile/build-apk.sh`
Expected: ends with `APK → dist/odysseus.apk (…M)`.

- [ ] **Step 3: Verify the bundle is packaged**

Run: `unzip -l dist/odysseus.apk | grep -E 'assets/public/(index.html|js/(app|sync-core).js)'`
Expected: all three present.

- [ ] **Step 4: Append Slice-2 notes to the build doc**

In `docs/productivity/mobile-build.md`, append a short "Slice 2 — Subtasks + Description" section: the build command (`bash mobile/build-apk.sh`), and the on-device proof steps below marked PENDING (no adb device on the build box).

- [ ] **Step 5: On-device proof (manual — user)**

1. `adb install -r dist/odysseus.apk` (or copy to phone), open, token already saved.
2. Open a task → **edit its title**, **add a description**, **add 3 subtasks**, **check 1** → the row on Home/Library shows `1/3` with a ~33% progress bar; the description persists on reopen.
3. Open odysseus web Notes at `https://chat.elsiga.ch` → the same task renders as a **checklist** with those subtasks (one checked) and the description as its body.
4. Toggle a subtask on mobile → it reflects on web (round-trip); remove all subtasks → the task reverts to a plain note on web (`note_type` back to `note`).

- [ ] **Step 6: Commit**

```bash
git add docs/productivity/mobile-build.md
git commit -m "docs(mobile): Slice-2 subtasks/description build + on-device proof notes"
```

---

## Self-Review

**Spec coverage:**
- Subtasks checkable + editable in Detail (checkbox toggle, inline text, add/remove) → Task 2. ✓
- Description (`content`) freeform, stored for later AI → Task 2. ✓
- `note_type` derived (`checklist` when ≥1 subtask, else `note`), written with items → Tasks 1 (helper) + 2 (usage). ✓
- Editable title in Detail → Task 2. ✓
- Row `done/total` count + small progress bar → Tasks 1 (helper) + 3 (usage). ✓
- Stable per-subtask keys (fix Slice-1 focus-flash) → Task 2. ✓
- Parent `done` independent of subtasks → Task 2 (never toggles `note.done`). ✓
- Zero backend change; web untouched (parity via `note_type`) → Global Constraints; Tasks 1–4 touch only `mobile/**` + the build doc. ✓
- Repaint via `store.update` (awaited), no `subscribe` → Task 2 (uses `onUpdate`), consistent with Slice 1. ✓
- Testing: pure vitest for both derivations (Task 1); build + tsc (Tasks 2–3); APK + on-device roundtrip (Task 4). ✓
- Non-goals (AI use, project entity, web task-field UI, deadline/repeat UI, auto-complete parent, peek) — not built. ✓

**Placeholder scan:** none — every code step ships complete code; the only "…" is intentional placeholder copy in inputs (`Add a description…`) and PENDING on-device steps.

**Type consistency:** `Subtask = {text,done}` defined in `subtasks.ts` (Task 1), consumed by Detail (Task 2) and — via `subtaskProgress` — TaskRow (Task 3). `note_type: 'note' | 'checklist'` added to `NoteRec` (Task 1) so `store.update({ note_type })` typechecks in Detail. `Detail`/`TaskRow` prop signatures are unchanged, so `main.ts` and the row callers need no edits. Persisted `items` shape stays `{text,done}` (view-local `Row.id` stripped by `toItems`).
