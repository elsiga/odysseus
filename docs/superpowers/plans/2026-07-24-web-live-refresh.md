# Web Live-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web notes panel repaint when a remote sync pull brings in a change made elsewhere, without a manual reload, by adding a post-pull `onChanged` hook to the shared sync engine and wiring the web UI to it in place of the fragile pre-commit `subscribe`.

**Architecture:** The engine (`sync-engine/src/engine.ts`) gains an optional `onChanged` callback that fires once per pull, after the writes commit, only when ≥1 change was actually applied. The committed web bundle is regenerated. `static/js/notes.js` wires `onChanged` to a gated refresh+render and drops `notesRepo.subscribe()`, with a guard that defers the repaint while a note is being edited.

**Tech Stack:** TypeScript, esbuild, Vitest, `fake-indexeddb`; vanilla ES-module web UI (no build step for `notes.js` itself).

Design: `docs/superpowers/specs/2026-07-24-web-live-refresh-design.md`

## Global Constraints

- **Backward-compatible engine change.** `onChanged` is OPTIONAL. Mobile's existing `createSyncClient({ apiBase, authHeader })` call must be unaffected — do NOT touch `mobile/`.
- **`onChanged` is remote-only.** It fires solely from the pull path (`pullOnce`/`applyChange`). Local writes go through `pushOnce` and must NOT trigger it — the web's imperative repaint stays the single trigger for local echo.
- **Fire once per pull, only on real change.** Never on an empty page or an all-echo/stale page. Not once per change — once per `pullOnce` call that applied ≥1 write.
- **Do NOT change** the per-record LWW / conflict rules, `pushOnce`, the outbox, `applyChange`'s existing skip conditions, or the reminder loop.
- **Regenerate the committed bundle** `static/js/productivity/sync-core.js` from source with `npm --prefix sync-engine run build` — never hand-edit it. It is a tracked artifact and must be committed with the engine change.
- **`static/` is baked into the Docker image** (not volume-mounted), so seeing the change on `https://chat.elsiga.ch` requires a container rebuild (`docker compose up -d --build`) — a deploy step, called out in the manual proof, not something to automate here.
- Stage EXPLICIT paths only — never `git add -A` (the untracked `design/` directory must never be staged).
- Build/test: engine unit `cd sync-engine && npx vitest run src/engine.test.ts`; engine build `npm --prefix sync-engine run build`; engine typecheck `cd sync-engine && npx tsc --noEmit`.

---

### Task 1: Engine `onChanged` post-pull hook + regenerate bundle

**Files:**
- Modify: `sync-engine/src/engine.ts`
- Test: `sync-engine/src/engine.test.ts` (append cases)
- Regenerate: `static/js/productivity/sync-core.js` (built artifact)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createSyncClient` accepts `onChanged?: () => void` in its options object. Fired once after any `pullOnce` that applied ≥1 change, post-commit. Consumed by `notes.js` in Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `sync-engine/src/engine.test.ts` (inside the existing `describe('engine', ...)` block, after the last case). These reuse the file's existing `fakeServer()` helper and `syncedUpsert` import:

```ts
  it('fires onChanged once after a pull that applies a remote change', async () => {
    const server = fakeServer()
    // seed the server with a note via a first client
    const c1 = createSyncClient({ fetchFn: server as any })
    await syncedUpsert({ id: 'r1', title: 'from-other-device' })
    await c1.syncOnce()
    // fresh client (cursor 0) with a spy — it will pull r1 on first sync
    await db.notes.clear(); await db.outbox.clear(); await db.meta.clear()
    let calls = 0
    const c2 = createSyncClient({ fetchFn: server as any, onChanged: () => { calls++ } })
    await c2.syncOnce()
    expect(await db.notes.get('r1')).toBeTruthy()
    expect(calls).toBe(1)
  })

  it('does NOT fire onChanged when the pull applies nothing (empty)', async () => {
    const server = fakeServer()
    let calls = 0
    const c = createSyncClient({ fetchFn: server as any, onChanged: () => { calls++ } })
    await c.syncOnce()   // nothing on the server → empty pull
    expect(calls).toBe(0)
  })

  it('does NOT fire onChanged on an all-echo pull (our own just-pushed write)', async () => {
    const server = fakeServer()
    let calls = 0
    const c = createSyncClient({ fetchFn: server as any, onChanged: () => { calls++ } })
    await syncedUpsert({ id: 'mine', title: 'local' })
    await c.syncOnce()   // pushes 'mine', then pulls it back as an echo → applyChange skips it
    expect(await db.notes.get('mine')).toBeTruthy()
    expect(calls).toBe(0)
  })

  it('fires onChanged once, not once per change, for a multi-change pull', async () => {
    const server = fakeServer()
    const c1 = createSyncClient({ fetchFn: server as any })
    await syncedUpsert({ id: 'm1', title: 'a' })
    await syncedUpsert({ id: 'm2', title: 'b' })
    await syncedUpsert({ id: 'm3', title: 'c' })
    await c1.syncOnce()
    await db.notes.clear(); await db.outbox.clear(); await db.meta.clear()
    let calls = 0
    const c2 = createSyncClient({ fetchFn: server as any, onChanged: () => { calls++ } })
    await c2.syncOnce()
    expect((await db.notes.toArray()).length).toBe(3)
    expect(calls).toBe(1)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sync-engine && npx vitest run src/engine.test.ts`
Expected: the four new cases FAIL — `onChanged` is not an accepted option, so `calls` stays `0` where `1` is expected (and the empty/echo cases pass vacuously). At least the "fires once after a pull" and "multi-change" cases must be red.

- [ ] **Step 3: Add the `onChanged` option**

In `sync-engine/src/engine.ts`, extend the options type and capture it. Change line 15-18 from:

```ts
export function createSyncClient(opts: { apiBase?: string; fetchFn?: typeof fetch; authHeader?: () => Record<string, string> } = {}): SyncClient {
  const apiBase = opts.apiBase ?? '/api/sync'
  const fetchFn = opts.fetchFn ?? ((i: any, init?: any) => fetch(i, init))
  const authHeader = opts.authHeader
```

to:

```ts
export function createSyncClient(opts: { apiBase?: string; fetchFn?: typeof fetch; authHeader?: () => Record<string, string>; onChanged?: () => void } = {}): SyncClient {
  const apiBase = opts.apiBase ?? '/api/sync'
  const fetchFn = opts.fetchFn ?? ((i: any, init?: any) => fetch(i, init))
  const authHeader = opts.authHeader
  const onChanged = opts.onChanged
```

- [ ] **Step 4: Make `applyChange` report whether it wrote**

In `sync-engine/src/engine.ts`, change `applyChange` (lines 64-73) to return a `boolean` — `true` only on the two write paths, `false` on every skip:

```ts
  async function applyChange(ch: any): Promise<boolean> {
    const local = await db.notes.get(ch.id)
    if (ch.op === 'delete') {
      if (!local || local._dirty === 0) { await db.notes.delete(ch.id); return true }
      return false
    }
    if (local?._dirty === 1) return false            // pending local edit — resolve via push
    if (local && ch.rev <= local._baseRev) return false  // own echo / stale
    await db.notes.put({ ...ch.record, _dirty: 0, _baseRev: ch.rev, _editedAt: ch.record.updated_at ?? new Date(0).toISOString() })
    return true
  }
```

(Note: the delete branch previously returned without deleting when `local` existed and was dirty; that path now correctly returns `false`. Behavior is otherwise unchanged — only the return value is added.)

- [ ] **Step 5: Fire `onChanged` once per pull when something applied**

In `sync-engine/src/engine.ts`, change `pullOnce` (lines 75-83) to track whether any change applied and fire the callback after the loop:

```ts
  async function pullOnce(): Promise<void> {
    let applied = false
    for (;;) {
      const cursor = await getCursor()
      const page = await api(`/pull?cursor=${cursor}&limit=500`)
      for (const ch of page.changes) { if (await applyChange(ch)) applied = true }
      await db.meta.put({ key: 'cursor', value: page.cursor })
      if (!page.hasMore) break
    }
    if (applied) onChanged?.()
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sync-engine && npx vitest run src/engine.test.ts`
Expected: PASS — all cases green (the four new + every pre-existing engine test), output pristine.

Run: `cd sync-engine && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Regenerate the committed web bundle**

Run: `npm --prefix sync-engine run build`
Expected: prints `built static/js/productivity/sync-core.js`.

Verify the option made it into the bundle:
Run: `grep -c "onChanged" static/js/productivity/sync-core.js`
Expected: ≥ 1.

- [ ] **Step 8: Commit**

```bash
git add sync-engine/src/engine.ts sync-engine/src/engine.test.ts static/js/productivity/sync-core.js
git commit -m "feat(sync): onChanged post-pull hook — fires once per pull when a remote change applies"
```

---

### Task 2: Wire the web UI to `onChanged`; remove the pre-commit `subscribe`

**Files:**
- Modify: `static/js/notes.js`

**Interfaces:**
- Consumes: `createSyncClient({ ..., onChanged })` from Task 1 (via the regenerated bundle).
- Produces: no new exported interface.

- [ ] **Step 1: Audit local mutation repaint coverage**

Before removing `subscribe`, confirm local echo does not depend on it. In `static/js/notes.js`, list every call site that mutates through `notesRepo` (`_saveNote`, `_patchNote`, `_deleteNoteApi`, `_reorderNotesApi`, and the `_undoArchive` path) and confirm each is followed by an imperative repaint — either an optimistic `_renderNotes()` on the local `_notes` array or a `_fetchNotes().then(_renderNotes)` / `await _fetchNotes(); _renderNotes()` after the awaited write.

Record the finding in the task report. If ANY local mutation path reaches the DOM only via `subscribe` (no imperative repaint), add an explicit `_renderNotes()` (or `_fetchNotes().then(_renderNotes)`) to that path in this step and note it. If all paths already repaint imperatively (expected — the create/save/delete/toggle/reorder/undo paths call `_renderNotes` directly), make no code change in this step.

- [ ] **Step 2: Replace the `subscribe` block with the `onChanged` wiring**

In `static/js/notes.js`, replace the boot block (currently lines 5355-5359):

```js
  const _syncClient = createSyncClient({ apiBase: '/api/sync' });
  _syncClient.start();
  notesRepo.subscribe(() => {
    _fetchNotes().then(() => { if (_open) _renderNotes(); });
  });
```

with:

```js
  // Repaint on remote pulls via the engine's post-pull hook (fires once per
  // pull, only when a remote change actually applied). Replaces the old
  // notesRepo.subscribe(), whose Dexie hooks fired PRE-COMMIT so the re-read
  // saw stale data (same bug fixed on mobile in afd0f84). Local echo repaints
  // imperatively at each mutation site, so it does not depend on this hook.
  const _syncClient = createSyncClient({
    apiBase: '/api/sync',
    onChanged: () => {
      // Always refresh the local cache; defer the DOM rebuild while a note is
      // being edited so a background pull can't tear down the open editor.
      // Ending the edit (save/cancel) calls _renderNotes() itself, painting
      // the already-refreshed data.
      _fetchNotes().then(() => { if (_open && _editingId === null) _renderNotes(); });
    },
  });
  _syncClient.start();
```

Note the two behavior changes from the old block: the trigger is the engine hook (post-commit, real changes) instead of the pre-commit Dexie hooks, and the render is additionally gated on `_editingId === null`.

- [ ] **Step 3: Confirm `subscribe` is fully removed and nothing else references it**

Run: `grep -n "notesRepo.subscribe\|\.subscribe(" static/js/notes.js`
Expected: no matches.

Run: `grep -n "_editingId\|_open\b" static/js/notes.js | head`
Expected: both symbols exist (the `onChanged` handler references real module-scoped variables — `_editingId` declared at line ~20, `_open` used as the panel-open flag).

- [ ] **Step 4: Syntax-check the module**

Run: `node --check static/js/notes.js`
Expected: no output (valid syntax).

- [ ] **Step 5: Commit**

```bash
git add static/js/notes.js
git commit -m "fix(web): live-refresh notes on remote pull via engine onChanged; drop pre-commit subscribe"
```

- [ ] **Step 6: Manual proof (user)**

Deploy note: `static/` is baked into the Docker image, so rebuild the container first — `docker compose up -d --build` — then hard-reload once to load the new `notes.js` + bundle.

1. Open the notes panel on `https://chat.elsiga.ch` in a browser AND on a second surface (the mobile app, or a second browser/tab).
2. Create or edit a note on the second surface. Within ≤60s (or immediately if a sync is already mid-flight) it appears in the first browser's open panel **with no reload**.
3. Delete a note on the second surface → it disappears from the first within the same window.
4. On the first browser, open a note for editing and start typing; trigger a remote change to a DIFFERENT note on the second surface. The open editor is NOT torn down mid-type; the remote change shows once you save or cancel the edit.

---

## Self-Review

**Spec coverage:**
- Engine `onChanged` option, optional/backward-compatible → Task 1 Steps 3. ✓
- `applyChange` reports whether it wrote → Task 1 Step 4. ✓
- Fire once per pull, post-commit, only when ≥1 applied; never on empty/all-echo → Task 1 Step 5 + tests (empty, all-echo, multi-change-once) Step 1. ✓
- Remote-only (never from `pushOnce`/local) → `onChanged` called solely inside `pullOnce`; the all-echo test asserts a locally-pushed write does not fire it. ✓
- Regenerate + commit the web bundle → Task 1 Steps 7-8. ✓
- Web wires `onChanged` to gated refresh+render → Task 2 Step 2. ✓
- Remove the pre-commit `subscribe` → Task 2 Step 2-3. ✓
- Local-echo audit guarding the removal → Task 2 Step 1. ✓
- In-progress-edit guard (`_editingId === null`) → Task 2 Step 2. ✓
- Manual two-session proof + edit-not-disrupted + deploy/rebuild note → Task 2 Step 6. ✓
- Non-goals (mobile wiring, conflict rules, push, outbox, reminders) — untouched; `mobile/` not in any file list. ✓

**Placeholder scan:** none. Every code step ships complete code; every command has an expected result.

**Type consistency:** `onChanged?: () => void` is added to the options object in Task 1 Step 3 and consumed in Task 2 Step 2 with a `() => void` handler. `applyChange` becomes `Promise<boolean>` (Step 4) and its two callers are the `for` loop in `pullOnce` (Step 5, uses the boolean) — no other caller exists. `onChanged?.()` optional-call matches the optional field. The web handler references `_fetchNotes`, `_renderNotes`, `_open`, `_editingId`, all pre-existing module symbols in `notes.js` (confirmed in Task 2 Step 3).
