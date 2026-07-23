# Mobile — Android Back Navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Android's back button navigate within the app — landing exactly where the user came from — instead of closing it, and remove the on-screen back affordances that only existed because the static prototype had no hardware back.

**Architecture:** A pure, tested navigation-stack module (`nav.ts`) holds all the rules; a thin hook (`backButton.ts`) is the only file that touches Capacitor; `main.ts` swaps its single `Route` for a `Route[]` stack and routes both hardware back and all in-app navigation through one mechanism. Requires the `@capacitor/app` plugin, which is a native change.

**Tech Stack:** TypeScript, Preact + HTM (no JSX), esbuild, Vitest, Capacitor 6.

Design: `docs/superpowers/specs/2026-07-24-mobile-android-back-navigation-design.md`

## Global Constraints

- **Mobile only.** Touch only `mobile/**` and `docs/productivity/mobile-build.md`. Do NOT touch Python, `sync-engine/`, `static/`, or `store.ts`.
- **Do NOT change** sync behavior, `store.ts`, or Detail's editing/persist logic. This slice is navigation only.
- **NO JSX** — `html` tagged templates from `../html`. Hooks come from `./html` (it re-exports `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`).
- **Only `backButton.ts` may import from `@capacitor/app`.** `nav.ts` stays pure and Node-testable; `main.ts` imports the native bits through `backButton.ts`.
- **No `setState` during render.** The existing `main.ts:48` missing-note path violates this and is fixed in Task 2.
- **`mobile/www/js/app.js` IS the tracked built artifact** — rebuild and stage it in any task that changes `mobile/src/**`.
- Stage EXPLICIT paths only — never `git add -A`. The untracked `design/` directory must never be staged; `dist/odysseus.apk` is gitignored and must never be staged.
- Build/test: unit `cd mobile && npx vitest run <file>`; bundle `cd mobile && node build.mjs`; typecheck `cd mobile && npx tsc --noEmit`; APK `bash mobile/build-apk.sh`.

---

### Task 1: Pure navigation stack (`nav.ts`)

**Files:**
- Create: `mobile/src/nav.ts`
- Test: `mobile/src/nav.test.ts` (create)

**Interfaces:**
- Produces (consumed by `main.ts` in Task 2):
  ```ts
  export type Route =
    | { name: 'home' }
    | { name: 'capture'; project?: string }
    | { name: 'library' }
    | { name: 'project'; project: string }
    | { name: 'detail'; id: string }
  export function routeKey(r: Route): string
  export function pushRoute(stack: Route[], r: Route): Route[]
  export function popRoute(stack: Route[]): Route[]
  export function shouldExit(lastBackAt: number, now: number): boolean
  export const EXIT_WINDOW_MS: number
  ```
- `Route` is MOVED here from `main.ts` (where it is currently declared at line 12); Task 2 deletes the old declaration and imports it from here.

- [ ] **Step 1: Write the failing test**

Create `mobile/src/nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { routeKey, pushRoute, popRoute, shouldExit, EXIT_WINDOW_MS, type Route } from './nav'

const home: Route = { name: 'home' }
const library: Route = { name: 'library' }

describe('routeKey', () => {
  it('distinguishes projects by name', () => {
    expect(routeKey({ name: 'project', project: 'foo' }))
      .not.toBe(routeKey({ name: 'project', project: 'bar' }))
  })
  it('distinguishes details by id', () => {
    expect(routeKey({ name: 'detail', id: '123' }))
      .not.toBe(routeKey({ name: 'detail', id: '456' }))
  })
  it('is stable for the same route', () => {
    expect(routeKey({ name: 'project', project: 'foo' }))
      .toBe(routeKey({ name: 'project', project: 'foo' }))
  })
})

describe('pushRoute', () => {
  it('appends a route not already in the stack', () => {
    expect(pushRoute([home], library)).toEqual([home, library])
  })
  it('unwinds to an existing entry instead of duplicating', () => {
    const stack: Route[] = [home, library, { name: 'project', project: 'foo' }]
    expect(pushRoute(stack, home)).toEqual([home])
  })
  it('unwinds to a middle entry, dropping everything above it', () => {
    const stack: Route[] = [home, library, { name: 'detail', id: '1' }]
    expect(pushRoute(stack, library)).toEqual([home, library])
  })
  it('treats different params as different routes', () => {
    const stack: Route[] = [home, { name: 'project', project: 'foo' }]
    expect(pushRoute(stack, { name: 'project', project: 'bar' }))
      .toEqual([home, { name: 'project', project: 'foo' }, { name: 'project', project: 'bar' }])
  })
  it('does not mutate the input stack', () => {
    const stack: Route[] = [home]
    pushRoute(stack, library)
    expect(stack).toEqual([home])
  })
})

describe('popRoute', () => {
  it('removes the last entry', () => {
    expect(popRoute([home, library])).toEqual([home])
  })
  it('is a no-op at the root', () => {
    expect(popRoute([home])).toEqual([home])
  })
})

describe('shouldExit', () => {
  it('is false on a first press (no prior back)', () => {
    expect(shouldExit(0, 1_000_000)).toBe(false)
  })
  it('is true just inside the window', () => {
    const now = 1_000_000
    expect(shouldExit(now - (EXIT_WINDOW_MS - 1), now)).toBe(true)
  })
  it('is false just outside the window', () => {
    const now = 1_000_000
    expect(shouldExit(now - (EXIT_WINDOW_MS + 1), now)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx vitest run src/nav.test.ts`
Expected: FAIL — cannot resolve `./nav`.

- [ ] **Step 3: Implement `nav.ts`**

Create `mobile/src/nav.ts`:

```ts
// Navigation stack rules. Pure and dependency-free so it can be tested in
// Node; all Capacitor/native concerns live in backButton.ts.

export type Route =
  | { name: 'home' }
  | { name: 'capture'; project?: string }
  | { name: 'library' }
  | { name: 'project'; project: string }
  | { name: 'detail'; id: string }

/** Stable identity for a route, including its parameters. */
export function routeKey(r: Route): string {
  switch (r.name) {
    case 'capture': return `capture:${r.project ?? ''}`
    case 'project': return `project:${r.project}`
    case 'detail': return `detail:${r.id}`
    default: return r.name
  }
}

/**
 * Navigate to `r`. If it is already in the stack, unwind to it rather than
 * pushing a duplicate — this keeps the stack shallow under hub-and-spoke
 * navigation, so Home is always one back press away, never five.
 */
export function pushRoute(stack: Route[], r: Route): Route[] {
  const key = routeKey(r)
  const at = stack.findIndex(s => routeKey(s) === key)
  return at >= 0 ? stack.slice(0, at + 1) : [...stack, r]
}

/** Pop one entry. At the root the stack is returned unchanged. */
export function popRoute(stack: Route[]): Route[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack
}

export const EXIT_WINDOW_MS = 2000

/**
 * Double-tap-to-exit at the root. `now` is injected so the window is testable
 * without fake timers. A `lastBackAt` of 0 (no prior press) is far outside the
 * window, so a first press never exits.
 */
export function shouldExit(lastBackAt: number, now: number): boolean {
  return now - lastBackAt < EXIT_WINDOW_MS
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx vitest run src/nav.test.ts`
Expected: PASS — 13 tests green, output pristine.

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/nav.ts mobile/src/nav.test.ts
git commit -m "feat(mobile): pure navigation stack (pushRoute/popRoute/shouldExit)"
```

---

### Task 2: Wire hardware back + remove on-screen back affordances

This task changes the plugin manifest, adds the native hook, converts the router to a stack, and strips the three back affordances **together**, because splitting them would leave a commit where the on-screen back is gone but the hardware back does not yet work — stranding the user on Library/Project/Detail with no way out.

**Files:**
- Modify: `mobile/package.json` (add `@capacitor/app`)
- Create: `mobile/src/backButton.ts`
- Modify: `mobile/src/main.ts`
- Modify: `mobile/src/screens/Library.ts`
- Modify: `mobile/src/screens/Project.ts`
- Modify: `mobile/src/screens/Detail.ts`
- Modify: `mobile/www/js/app.js` (rebuilt artifact)

**Interfaces:**
- Consumes: `pushRoute`, `popRoute`, `shouldExit`, `type Route` (from `./nav`, Task 1).
- Produces: `useBackButton(handler: () => void): void` and `exitApp(): void` from `mobile/src/backButton.ts`.
- `Library`, `Project`, and `Detail` all LOSE their `onBack` prop. Their remaining prop signatures are otherwise unchanged.

- [ ] **Step 1: Add the `@capacitor/app` dependency**

Run: `cd mobile && npm install @capacitor/app@^6.0.0`
Expected: `package.json` gains `"@capacitor/app": "^6.0.0"` under `dependencies`, and `node_modules/@capacitor/app` exists.

Verify: `cd mobile && ls node_modules/@capacitor/app/package.json`
Expected: the file exists.

- [ ] **Step 2: Create `backButton.ts`**

Create `mobile/src/backButton.ts`:

```ts
import { App } from '@capacitor/app'
import { useEffect, useRef } from './html'

/**
 * Register the Android hardware back handler exactly once.
 *
 * The handler is read through a ref rather than captured in the effect, so the
 * listener is registered a single time yet always invokes the CURRENT render's
 * closure (which is what sees up-to-date stack state). Registering with
 * `[handler]` instead would tear down and re-add the native listener on every
 * render.
 */
export function useBackButton(handler: () => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    let remove: (() => void) | undefined
    let cancelled = false
    void App.addListener('backButton', () => ref.current()).then(h => {
      // The component may have unmounted while addListener was still pending.
      if (cancelled) void h.remove()
      else remove = () => { void h.remove() }
    })
    return () => { cancelled = true; remove?.() }
  }, [])
}

/** Close the app. Only called at the root, on a confirmed double-tap. */
export function exitApp(): void {
  void App.exitApp()
}
```

- [ ] **Step 3: Convert `main.ts` to a navigation stack**

Replace `mobile/src/main.ts` with:

```ts
import { html, render, useState, useRef } from './html'
import { useNotesStore } from './store'
import { getToken, setToken } from './token'
import { Home } from './screens/Home'
import { Capture } from './screens/Capture'
import { Library } from './screens/Library'
import { Project } from './screens/Project'
import { Detail } from './screens/Detail'
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
  const navigate = (r: Route) => setStack(s => pushRoute(s, r))

  // Back: pop one entry, or at the root require a second press within
  // EXIT_WINDOW_MS to exit. No toast, by design decision.
  function back() {
    if (stack.length > 1) { setStack(s => popRoute(s)); return }
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
      onTestReminder=${scheduleTestNotification} />`
  if (route.name === 'capture')
    return html`
      <${Home} notes=${store.notes} status=${store.status} onToggle=${store.toggle} onOpen=${openDetail}
        onCapture=${() => navigate({ name: 'capture' })} onLibrary=${() => navigate({ name: 'library' })}
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
```

Note the removals: the local `type Route` declaration (now imported from `./nav`), the `onBack` props passed to `Library`/`Project`/`Detail`, and the `setRoute`-during-render on the missing-note path.

- [ ] **Step 4: Remove the back affordance from `Library.ts`**

In `mobile/src/screens/Library.ts`, change the signature (lines 7-9) from:

```ts
export function Library({ notes, onToggle, onOpen, onOpenProject, onBack }:
  { notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onOpenProject: (name: string) => void; onBack: () => void }) {
```

to:

```ts
export function Library({ notes, onToggle, onOpen, onOpenProject }:
  { notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onOpenProject: (name: string) => void }) {
```

And DELETE this line (line 23):

```ts
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>← home</span>
```

Leave the surrounding header `<div>` and the `Library` title span exactly as they are.

- [ ] **Step 5: Remove the back affordance from `Project.ts`**

In `mobile/src/screens/Project.ts`, change the signature (lines 6-8) from:

```ts
export function Project({ project, notes, onToggle, onOpen, onCapture, onBack }:
  { project: string; notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void; onBack: () => void }) {
```

to:

```ts
export function Project({ project, notes, onToggle, onOpen, onCapture }:
  { project: string; notes: NoteRec[]; onToggle: (n: NoteRec) => void; onOpen: (n: NoteRec) => void;
    onCapture: () => void }) {
```

And DELETE this line (line 14):

```ts
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer' }}>← back</span>
```

- [ ] **Step 6: Remove the back affordance from `Detail.ts`**

In `mobile/src/screens/Detail.ts`, change the signature (lines 6-7) from:

```ts
export function Detail({ note, onUpdate, onBack }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void; onBack: () => void }) {
```

to:

```ts
export function Detail({ note, onUpdate }:
  { note: NoteRec; onUpdate: (patch: Partial<NoteRec>) => void }) {
```

And DELETE this line (line 36):

```ts
        <span onClick=${onBack} style=${{ font: `400 13px ${T.mono}`, color: T.muted, cursor: 'pointer', marginLeft: '12px', flex: 'none' }}>← back</span>
```

The title `<input>` (which already has `flex: 1`) reclaims the freed width. Change NOTHING else in this file — the persist/subtask logic is out of scope.

- [ ] **Step 7: Build and typecheck**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`, no unresolved-import errors.

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

Run: `cd mobile && npx vitest run`
Expected: all suites pass (tasks, subtasks, nav) — nothing regressed.

- [ ] **Step 8: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/src/backButton.ts \
        mobile/src/main.ts mobile/src/screens/Library.ts mobile/src/screens/Project.ts \
        mobile/src/screens/Detail.ts mobile/www/js/app.js
git commit -m "feat(mobile): Android hardware back navigation via nav stack; drop on-screen back affordances"
```

---

### Task 3: Native sync, APK build, and verification

**Files:**
- Modify: `docs/productivity/mobile-build.md` (append back-navigation notes)
- Generated (NOT committed): `mobile/android/**`, `dist/odysseus.apk`

**Interfaces:** none (build + manual verification).

- [ ] **Step 1: Sync the plugin into the Android project**

Run: `cd mobile && npx cap sync android`
Expected: completes without error and reports `@capacitor/app` among the found plugins.

- [ ] **Step 2: Verify the plugin is actually registered**

This is the slice's highest-risk step: if the plugin is not registered the listener silently never fires and back still closes the app, with no error anywhere.

Run:
```bash
cd mobile && grep -n "capacitor-app" android/capacitor.settings.gradle && \
  grep -n "@capacitor/app" android/app/src/main/assets/capacitor.plugins.json
```
Expected: BOTH greps match — `capacitor.settings.gradle` includes the `:capacitor-app` project, and `capacitor.plugins.json` contains an entry whose `pkg` is `@capacitor/app` (classpath `com.capacitorjs.plugins.app.AppPlugin`).

If either is missing, STOP and report — do not proceed to the APK build.

- [ ] **Step 3: Rebuild the bundle and the APK**

Run: `cd mobile && node build.mjs`
Expected: `built www/js/app.js`.

Run: `bash mobile/build-apk.sh`
Expected: ends with `APK → dist/odysseus.apk (…M)`.

- [ ] **Step 4: Verify the bundle is packaged**

Run: `unzip -l dist/odysseus.apk | grep -E 'assets/public/(index.html|js/(app|sync-core).js)'`
Expected: all three present.

- [ ] **Step 5: Append back-navigation notes to the build doc**

In `docs/productivity/mobile-build.md`, append a short "Android back navigation" section matching the file's existing tone and structure: that back now pops the in-app navigation stack, that Home requires a silent double-press within 2s to exit (no toast, by design), that the on-screen `← back` affordances were removed because the hardware button replaces them, and that `@capacitor/app` must be registered by `npx cap sync android` (with the two grep checks from Step 2 as the verification). Mark the on-device proof below as PENDING.

- [ ] **Step 6: On-device proof (manual — user)**

1. `adb install -r dist/odysseus.apk`, open the app.
2. Home → Library → open a project → open a task. Press back three times: it should retrace **task → project → library → home**, NOT jump to Home.
3. On Home, press back once: nothing happens. Press back again within 2 seconds: the app exits.
4. On Home, press back once, wait 3 seconds, press once more: the app does NOT exit (the window lapsed).
5. Open the capture sheet, press back: the sheet closes and Home remains.

- [ ] **Step 7: Commit**

```bash
git add docs/productivity/mobile-build.md
git commit -m "docs(mobile): Android back navigation build + on-device proof notes"
```

---

## Self-Review

**Spec coverage:**
- `nav.ts` with `routeKey`/`pushRoute`/`popRoute`/`shouldExit`, `Route` moved from `main.ts` → Task 1. ✓
- Unwind-to-existing-entry rather than duplicate-push → Task 1 (`pushRoute`) + tests. ✓
- `backButton.ts` as the sole Capacitor importer, listener registered once via ref → Task 2 Step 2. ✓
- `main.ts` single `Route` → `Route[]` stack; all `setRoute` become `navigate` → Task 2 Step 3. ✓
- Root double-tap-to-exit, 2s, no toast → Task 1 (`shouldExit`) + Task 2 (`back()`). ✓
- Capture pops via back; keeps its own close control (`onClose=${back}`) → Task 2 Step 3. ✓
- TokenGate needs no code (returns before the router; back hits root behavior) → Task 2 Step 3, verified by hook ordering. ✓
- Remove `← home`/`← back` from Library/Project/Detail and drop `onBack` → Task 2 Steps 4-6. ✓
- Incidental fix: Detail's hardcoded return-to-Home → Task 2 Step 3 (now `back()`). ✓
- Incidental fix: `setState` during render on missing note → Task 2 Step 3 (fallback render). ✓
- `@capacitor/app` dependency + `cap sync` + explicit registration verification → Task 2 Step 1, Task 3 Steps 1-2. ✓
- Tests for push/unwind/pop/root-no-op/routeKey params/shouldExit boundaries → Task 1 Step 1. ✓
- Build + tsc clean; APK + bundle packaging; on-device proof → Tasks 2-3. ✓
- Non-goals (route persistence, deep links, toast, predictive-back, header restyle, sync/store/Detail-logic changes) — not built. ✓

**Placeholder scan:** none. Every code step ships complete code; the only ellipses are the pre-existing `…` placeholder strings in `main.ts`'s loading states and the `Add a description…` copy left untouched in `Detail.ts`.

**Type consistency:** `Route` is defined once in `nav.ts` (Task 1) and imported by `main.ts` (Task 2) — the old local declaration is explicitly deleted. `pushRoute`/`popRoute` take and return `Route[]`, matching `useState<Route[]>`. `shouldExit(lastBackAt: number, now: number)` matches the `useRef(0)` + `Date.now()` call site. `useBackButton(handler: () => void)` matches `back()`'s `(): void` signature. `exitApp(): void` matches its call site. The three screens lose exactly the `onBack` prop, and `main.ts` correspondingly stops passing it — both sides change in the same task, so `tsc --noEmit` in Task 2 Step 7 is the gate that proves they agree.
