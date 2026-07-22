# Slice B (Path B) — Thin Offline Shell + Bearer Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Capacitor Android app that bundles its own minimal task shell (loads with zero network → true cold-offline) and syncs the Notes/todo domain to `https://chat.elsiga.ch` using a scoped bearer token.

**Architecture:** Drop `server.url`; the WebView loads a dedicated bundled shell from `https://localhost` (`androidScheme: 'https'`, local `webDir`). Data is local-first via the Slice-A `notesRepo` + Dexie/IndexedDB outbox; the sync engine pushes/pulls against `/api/sync/*` cross-origin with an `Authorization: Bearer ody_…` token stored on-device. The backend gains a scope-aware bearer path on the sync routes only — `require_user` and web/cookie security are untouched.

**Tech Stack:** Capacitor 6 (`@capacitor/core`/`android`/`cli`/`preferences`), build-less vanilla-JS shell, the committed esbuild bundle `static/js/productivity/sync-core.js` (source `sync-engine/src`, vitest), FastAPI + the existing `ApiToken` system, pytest (house `asyncio.run` pattern, no pytest-asyncio).

**Design doc:** `docs/superpowers/specs/2026-07-22-slice-b-path-b-offline-shell-design.md`.

## Global Constraints

- **Web stays byte-for-byte unchanged.** No change to `require_user`, cookie auth, CSRF, or the web frontend. The sync engine's same-origin/no-header default path MUST be preserved. — spec §Security, §Global constraints.
- **Only sync gets bearer.** Add the scope-aware path to `/api/sync/*` only; never bearer-enable `/api/notes` and never modify `require_user`. — spec §Components.
- **Token scoped to sync only** — the mobile token carries `sync:read`/`sync:write`, never admin/chat/email. — spec §Security.
- **APK** builds on this Linux box → `dist/odysseus.apk` (gitignored). `mobile/{node_modules,android}`, `dist/`, and the copied `mobile/www/js/sync-core.js` are gitignored. — spec §Global constraints.
- **Do NOT `git add -A`** — stage explicit paths only (the untracked `design/` folder must never be staged). — carried from Slice A/B1.
- **Backend tests:** run the SPECIFIC test file, never the whole `tests/` dir (it hangs on heavy imports). — carried from Slice A.
- **Bundle drift:** after any `sync-engine/src` change, regenerate `static/js/productivity/sync-core.js` via `npm --prefix sync-engine run build` and commit it; drift-check committed == fresh build. — carried from Slice A.
- **JDK for the APK build:** the host's default `java` is a JRE (no `jlink`); the build needs a full JDK. `mobile/build-apk.sh` already defaults `JAVA_HOME=/home/elsiga/jdks/jdk-17.0.19+10`. — carried from B1.

---

## Task 1: Backend — `sync:*` scopes + scope-aware bearer owner on `/api/sync`

**Files:**
- Modify: `routes/api_token_routes.py` (add `sync:read`/`sync:write` to `ALLOWED_SCOPES` + a profile)
- Modify: `routes/sync_routes.py` (hoist owner resolution to module level; scope-gate it)
- Test: `tests/test_sync_bearer_owner.py` (create)

**Interfaces:**
- Consumes: `request.state.api_token` / `api_token_scopes` / `api_token_owner` (set by `AuthMiddleware` in `app.py` for a valid `Bearer ody_…` — already implemented); `require_user` from `src.auth_helpers`; `FALLBACK_OWNER`.
- Produces (module-level in `routes/sync_routes.py`, importable for tests):
  - `SYNC_READ_SCOPES = {"sync:read", "sync:write"}`, `SYNC_WRITE_SCOPES = {"sync:write"}`
  - `bearer_owner(request, required: set[str]) -> str | None` — the token owner if this is an API-token request (raising `HTTPException(403)` on missing scope / missing owner), else `None`.
  - `sync_owner(request, required: set[str]) -> str` — `bearer_owner(...)` if non-None, else the cookie/anonymous owner (`require_user` or `FALLBACK_OWNER`).

- [ ] **Step 1: Write the failing unit test**

```python
# tests/test_sync_bearer_owner.py
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from routes.sync_routes import (
    bearer_owner, SYNC_READ_SCOPES, SYNC_WRITE_SCOPES,
)


def _req(**state):
    return SimpleNamespace(state=SimpleNamespace(**state))


def test_bearer_owner_none_when_not_token():
    # Cookie/session request → not a token → helper returns None (caller falls back)
    assert bearer_owner(_req(api_token=False), SYNC_WRITE_SCOPES) is None


def test_bearer_owner_returns_owner_with_matching_scope():
    r = _req(api_token=True, api_token_scopes=["sync:write"], api_token_owner="alice")
    assert bearer_owner(r, SYNC_WRITE_SCOPES) == "alice"


def test_bearer_owner_read_scope_satisfies_read_requirement():
    r = _req(api_token=True, api_token_scopes=["sync:read"], api_token_owner="alice")
    assert bearer_owner(r, SYNC_READ_SCOPES) == "alice"


def test_bearer_owner_403_when_scope_missing():
    r = _req(api_token=True, api_token_scopes=["sync:read"], api_token_owner="alice")
    with pytest.raises(HTTPException) as ei:
        bearer_owner(r, SYNC_WRITE_SCOPES)
    assert ei.value.status_code == 403


def test_bearer_owner_403_when_no_owner():
    r = _req(api_token=True, api_token_scopes=["sync:write"], api_token_owner=None)
    with pytest.raises(HTTPException) as ei:
        bearer_owner(r, SYNC_WRITE_SCOPES)
    assert ei.value.status_code == 403


def test_write_scope_is_subset_of_read():
    # A write-capable token can also pull (read).
    assert SYNC_WRITE_SCOPES.issubset(SYNC_READ_SCOPES)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_sync_bearer_owner.py -q`
Expected: FAIL — `ImportError` (`bearer_owner` / scope constants not defined yet).

- [ ] **Step 3: Add the sync scopes in `routes/api_token_routes.py`**

In the `ALLOWED_SCOPES` set (currently ending `"cookbook:read", "cookbook:launch",`), add two entries:

```python
    "cookbook:read",
    "cookbook:launch",
    "sync:read",
    "sync:write",
}
```

And add a profile to `TOKEN_PROFILES` (after the `"codex_email_drafts"` entry):

```python
    "mobile_sync": ["sync:read", "sync:write"],
```

- [ ] **Step 4: Hoist + scope-gate owner resolution in `routes/sync_routes.py`**

Replace the imports/constants region and the nested `_owner` with module-level, scope-aware helpers. The file currently defines `_owner` *inside* `setup_sync_routes()`; move the logic out so it is importable and testable.

Add near the top (after `from src.sync.pull import pull_changes` and the existing `FALLBACK_OWNER` line), the `HTTPException` is already imported:

```python
SYNC_READ_SCOPES = {"sync:read", "sync:write"}
SYNC_WRITE_SCOPES = {"sync:write"}


def bearer_owner(request: Request, required: set[str]) -> str | None:
    """Owner for an API-token (Bearer) request, or None if this isn't one.

    Raises 403 if the token lacks a required scope or has no owner.
    """
    if not getattr(request.state, "api_token", False):
        return None
    scopes = set(getattr(request.state, "api_token_scopes", []) or [])
    if not scopes.intersection(required):
        raise HTTPException(403, f"API token missing required scope: {' or '.join(sorted(required))}")
    owner = getattr(request.state, "api_token_owner", None)
    if not owner:
        raise HTTPException(403, "API token has no owner")
    return owner


def sync_owner(request: Request, required: set[str]) -> str:
    """Resolve the data owner for a sync request (bearer token OR cookie/anon)."""
    bearer = bearer_owner(request, required)
    if bearer is not None:
        return bearer
    user = require_user(request)
    return user if user else FALLBACK_OWNER
```

Then inside `setup_sync_routes()`, **delete** the nested `def _owner(request): ...` and update the three handlers to pass the scope set:

```python
    @router.get("/ping")
    async def ping(request: Request):
        return {"ok": True, "user": sync_owner(request, SYNC_READ_SCOPES)}

    @router.post("/push")
    async def push(request: Request):
        owner = sync_owner(request, SYNC_WRITE_SCOPES)
        body = await request.json()
        ...

    @router.get("/pull")
    async def pull(request: Request, cursor: int = 0, limit: int = 500):
        owner = sync_owner(request, SYNC_READ_SCOPES)
        limit = max(1, min(limit, 500))
        ...
```

(Leave the rest of each handler body — `apply_push` / `pull_changes` / error mapping — exactly as-is.)

- [ ] **Step 5: Run the new test + confirm cookie-path parity**

Run: `python -m pytest tests/test_sync_bearer_owner.py -q`
Expected: PASS (6 passed).
Run: `python -m pytest tests/test_sync_routes.py -q`
Expected: PASS — the existing cookie-session push/pull behavior is unchanged (parity). If this file was renamed/removed during Slice A, run the current sync-route test file instead and note which one.
Run: `python -c "import app"`
Expected: no error (imports resolve after the refactor).

- [ ] **Step 6: Document the CORS origin (deploy step — not code)**

The mobile WebView origin is `https://localhost`. For cross-origin fetches to succeed, it must be in `ALLOWED_ORIGINS`. This is runtime config (`.env`), not committed code. Add a note to the report and (in Task 6's doc update) to `docs/productivity/mobile-build.md`:

> Add `https://localhost` to `ALLOWED_ORIGINS` in `.env` (comma-separated) and restart odysseus, so the app's cross-origin `/api/sync` calls are CORS-allowed.

Do NOT edit `.env` here (it is deploy config, gitignored); just record the requirement.

- [ ] **Step 7: Commit**

```bash
git add routes/api_token_routes.py routes/sync_routes.py tests/test_sync_bearer_owner.py
git commit -m "feat(sync): scope-aware bearer auth on /api/sync (sync:read/sync:write scopes)"
```

---

## Task 2: Sync-engine — `authHeader` seam + rebuild the bundle

**Files:**
- Modify: `sync-engine/src/engine.ts` (add an `authHeader` option, merge into requests)
- Modify: `sync-engine/src/engine.test.ts` (add coverage)
- Regenerate (commit): `static/js/productivity/sync-core.js`

**Interfaces:**
- Consumes: the existing `createSyncClient(opts)` with `apiBase?` and `fetchFn?`.
- Produces: `createSyncClient({ apiBase?, fetchFn?, authHeader? })` where `authHeader?: () => Record<string, string>` supplies request headers (e.g. `{ Authorization: 'Bearer ody_…' }`) merged into every `/push` and `/pull` call. When `authHeader` is absent, behavior is byte-for-byte the web path (no extra header).

- [ ] **Step 1: Write the failing test**

Add to `sync-engine/src/engine.test.ts` (keep existing tests):

```ts
import { describe, it, expect } from 'vitest'
import { createSyncClient } from './engine'
import { db } from './db'

describe('authHeader + apiBase seam', () => {
  it('sends Authorization and hits the absolute base URL on pull', async () => {
    await db.meta.put({ key: 'cursor', value: 0 })
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
      return { ok: true, json: async () => ({ changes: [], cursor: 0, hasMore: false }) }
    }) as any
    const client = createSyncClient({
      apiBase: 'https://chat.elsiga.ch/api/sync',
      fetchFn,
      authHeader: () => ({ Authorization: 'Bearer ody_test' }),
    })
    await client.syncOnce()
    const pull = calls.find((c) => c.url.includes('/pull'))!
    expect(pull.url.startsWith('https://chat.elsiga.ch/api/sync/pull')).toBe(true)
    expect(pull.headers.Authorization).toBe('Bearer ody_test')
  })

  it('omits Authorization when no authHeader is given (web path unchanged)', async () => {
    await db.meta.put({ key: 'cursor', value: 0 })
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
      return { ok: true, json: async () => ({ changes: [], cursor: 0, hasMore: false }) }
    }) as any
    const client = createSyncClient({ fetchFn })
    await client.syncOnce()
    const pull = calls.find((c) => c.url.includes('/pull'))!
    expect(pull.url.startsWith('/api/sync/pull')).toBe(true)
    expect(pull.headers.Authorization).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sync-engine test -- engine.test.ts`
Expected: FAIL on the first new case — `Authorization` is `undefined` (no seam yet).

- [ ] **Step 3: Implement the seam in `sync-engine/src/engine.ts`**

Extend the options type and the `api()` helper. Change the signature line:

```ts
export function createSyncClient(opts: { apiBase?: string; fetchFn?: typeof fetch; authHeader?: () => Record<string, string> } = {}): SyncClient {
  const apiBase = opts.apiBase ?? '/api/sync'
  const fetchFn = opts.fetchFn ?? ((i: any, init?: any) => fetch(i, init))
  const authHeader = opts.authHeader
```

And rewrite `api()` to merge the auth headers (auth first so explicit per-call headers can override):

```ts
  async function api(path: string, init?: RequestInit): Promise<any> {
    const extra = authHeader ? authHeader() : {}
    const headers = { ...extra, ...(init?.headers as Record<string, string> | undefined) }
    const res = await fetchFn(`${apiBase}${path}`, { credentials: 'same-origin', ...init, headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix sync-engine test`
Expected: PASS — the two new cases plus all existing engine/notesRepo tests remain green.

- [ ] **Step 5: Rebuild the committed bundle + drift check**

Run:
```bash
npm --prefix sync-engine run build
git diff --stat static/js/productivity/sync-core.js   # should show the regenerated bundle changed
```
Expected: `sync-core.js` regenerates. Confirm no *other* tracked file changed unexpectedly.

- [ ] **Step 6: Commit**

```bash
git add sync-engine/src/engine.ts sync-engine/src/engine.test.ts static/js/productivity/sync-core.js
git commit -m "feat(sync-engine): authHeader seam for cross-origin bearer sync + rebuild bundle"
```

---

## Task 3: Capacitor config → local bundle + Preferences plugin

**Files:**
- Modify: `mobile/capacitor.config.ts` (remove `server.url`; `androidScheme: 'https'`)
- Modify: `mobile/package.json` (add `@capacitor/preferences`)
- Regenerated (gitignored): `mobile/android/` (via `cap sync`); tracked: `mobile/package-lock.json`

**Interfaces:**
- Consumes: Node 24 + npm; Android SDK at `ANDROID_HOME=/home/elsiga/Android/Sdk`.
- Produces: a Capacitor project that loads the LOCAL `www/` bundle (no remote URL) and has the Preferences plugin available at runtime as `window.Capacitor.Plugins.Preferences`.

- [ ] **Step 1: Rewrite `mobile/capacitor.config.ts`**

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ch.elsiga.odysseus',
  appName: 'Odysseus',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
};

export default config;
```

- [ ] **Step 2: Add the Preferences dependency to `mobile/package.json`**

In `dependencies`, add `@capacitor/preferences` alongside the existing `@capacitor/core`/`@capacitor/android`:

```json
  "dependencies": {
    "@capacitor/core": "^6.1.2",
    "@capacitor/android": "^6.1.2",
    "@capacitor/preferences": "^6.0.2"
  },
```

- [ ] **Step 3: Install + sync**

Run:
```bash
npm --prefix mobile install
cd mobile && npx cap sync android && cd ..
```
Expected: `npm install` resolves Preferences; `cap sync` reports `Sync finished` and lists the `@capacitor/preferences` plugin. If sync errors on the SDK, ensure `ANDROID_HOME` is exported and report the exact error (do not guess).

- [ ] **Step 4: Verify the config no longer points remote**

Run:
```bash
grep -n "chat.elsiga.ch\|url" mobile/android/app/src/main/assets/capacitor.config.json || echo "no remote url (good)"
grep -n "Preferences" mobile/android/app/src/main/assets/capacitor.plugins.json 2>/dev/null || grep -rn "preferences" mobile/android/app/src/main/assets/ | head
```
Expected: NO `server.url` / `chat.elsiga.ch` in the synced config; the Preferences plugin appears in the synced plugins.

- [ ] **Step 5: Commit (config + package files only — NOT android/ or node_modules)**

```bash
git add mobile/capacitor.config.ts mobile/package.json mobile/package-lock.json
git status --short   # confirm ONLY those 3 files staged (+ untracked design/)
git commit -m "feat(native): local-bundle Capacitor config + @capacitor/preferences (drop server.url)"
```

---

## Task 4: The thin offline shell (`mobile/www/`)

**Files:**
- Create: `mobile/www/index.html`
- Create: `mobile/www/js/app.js`
- Create: `mobile/www/js/token.js`
- Modify: `.gitignore` (ignore the copied `mobile/www/js/sync-core.js`)

**Interfaces:**
- Consumes: `notesRepo` + `createSyncClient` from `./sync-core.js` (copied from `static/js/productivity/sync-core.js` at build time — Task 6); `window.Capacitor.Plugins.Preferences`.
- Produces: a self-contained offline shell that boots from the bundle, stores a pasted `ody_` token, renders a task list from `notesRepo`, and syncs via bearer.

Note: `mobile/www/js/sync-core.js` is the copied bundle (gitignored, produced by the build script in Task 6). The shell imports it by relative path; it is present at build/run time.

- [ ] **Step 1: Write `mobile/www/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Odysseus Tasks</title>
  <style>
    :root { --bg:#171E28; --panel:#1E2733; --fg:#A9CBDC; --muted:#5C7080; --red:#FF6B5E; --line:#2A3644; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font-family:'Fira Code',ui-monospace,monospace;
           padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
    header { padding:16px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
    header h1 { font-size:16px; margin:0; letter-spacing:.05em; }
    #settings-btn { background:none; border:1px solid var(--line); color:var(--muted); border-radius:6px; padding:4px 8px; }
    main { padding:12px 16px 96px; }
    .task { display:flex; align-items:center; gap:10px; padding:12px; border:1px solid var(--line);
            border-radius:8px; margin-bottom:8px; background:var(--panel); }
    .task input[type=checkbox] { width:20px; height:20px; accent-color:var(--red); }
    .task span { flex:1; }
    .task.done span { color:var(--muted); text-decoration:line-through; }
    .task button { background:none; border:none; color:var(--muted); font-size:18px; }
    #composer { position:fixed; left:0; right:0; bottom:0; display:flex; gap:8px; padding:12px 16px;
                background:var(--bg); border-top:1px solid var(--line); }
    #composer input { flex:1; background:var(--panel); border:1px solid var(--line); color:var(--fg);
                      border-radius:8px; padding:12px; font:inherit; }
    #composer button { background:var(--red); color:var(--bg); border:none; border-radius:8px; padding:0 16px; font:inherit; }
    #token-panel { padding:24px 16px; }
    #token-panel textarea { width:100%; height:80px; background:var(--panel); color:var(--fg);
                            border:1px solid var(--line); border-radius:8px; padding:12px; font:inherit; }
    #token-panel button { margin-top:12px; background:var(--red); color:var(--bg); border:none;
                          border-radius:8px; padding:12px 16px; font:inherit; }
    .hidden { display:none !important; }
    #status { font-size:11px; color:var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>ODYSSEUS · TASKS</h1>
    <div><span id="status"></span> <button id="settings-btn">⚙</button></div>
  </header>

  <section id="token-panel" class="hidden">
    <p>Paste your sync API token (<code>ody_…</code>). Mint it in odysseus admin → API tokens with the <code>mobile_sync</code> profile.</p>
    <textarea id="token-input" placeholder="ody_…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
    <button id="token-save">Save token</button>
  </section>

  <main id="app" class="hidden">
    <div id="list"></div>
  </main>

  <div id="composer" class="hidden">
    <input id="new-task" placeholder="New task…" autocapitalize="sentences">
    <button id="add-btn">Add</button>
  </div>

  <script type="module" src="./js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `mobile/www/js/token.js`**

```js
// Token persistence via Capacitor Preferences (app-private storage).
// (Hardening follow-up: swap for an encrypted secure-storage plugin.)
const KEY = 'sync_api_token';

function prefs() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;
}

export async function getToken() {
  const p = prefs();
  if (!p) return null;
  const { value } = await p.get({ key: KEY });
  return value || null;
}

export async function setToken(token) {
  const p = prefs();
  if (!p) return;
  await p.set({ key: KEY, value: token });
}

export async function clearToken() {
  const p = prefs();
  if (!p) return;
  await p.remove({ key: KEY });
}
```

- [ ] **Step 3: Write `mobile/www/js/app.js`**

```js
import { notesRepo, createSyncClient } from './sync-core.js';
import { getToken, setToken, clearToken } from './token.js';

const API_BASE = 'https://chat.elsiga.ch/api/sync';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
let client = null;

function setStatus(t) { statusEl.textContent = t; }

async function renderList() {
  const notes = await notesRepo.list();
  const active = notes.filter((n) => !n.archived);
  active.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const list = el('list');
  list.innerHTML = '';
  for (const n of active) {
    const row = document.createElement('div');
    row.className = 'task' + (n.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!n.done;
    cb.addEventListener('change', async () => {
      await notesRepo.update(n.id, { done: cb.checked });
      void client?.syncOnce();
    });
    const label = document.createElement('span');
    label.textContent = n.title || n.text || '(untitled)';
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await notesRepo.remove(n.id);
      void client?.syncOnce();
    });
    row.append(cb, label, del);
    list.appendChild(row);
  }
}

async function addTask() {
  const input = el('new-task');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await notesRepo.create({ title, done: false });
  void client?.syncOnce();
}

function showApp() {
  el('token-panel').classList.add('hidden');
  el('app').classList.remove('hidden');
  el('composer').classList.remove('hidden');
}

function showTokenPanel() {
  el('app').classList.add('hidden');
  el('composer').classList.add('hidden');
  el('token-panel').classList.remove('hidden');
}

async function boot() {
  el('add-btn').addEventListener('click', addTask);
  el('new-task').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
  el('settings-btn').addEventListener('click', showTokenPanel);
  el('token-save').addEventListener('click', async () => {
    const t = el('token-input').value.trim();
    if (!t.startsWith('ody_')) { setStatus('bad token'); return; }
    await setToken(t);
    el('token-input').value = '';
    await start();
  });

  // notesRepo drives the UI; re-render on any local change.
  notesRepo.subscribe(() => { void renderList(); });

  await start();
}

async function start() {
  const token = await getToken();
  await renderList();               // always render local data first (works offline)
  if (!token) { showTokenPanel(); setStatus('no token'); return; }
  showApp();
  client = createSyncClient({
    apiBase: API_BASE,
    authHeader: () => ({ Authorization: `Bearer ${token}` }),
  });
  client.start();
  setStatus('syncing');
}

boot();
```

- [ ] **Step 4: Gitignore the copied bundle**

Append to `.gitignore` (under the existing Slice-B block):

```
mobile/www/js/sync-core.js
```

- [ ] **Step 5: Syntax-check the shell JS**

Run:
```bash
node --check mobile/www/js/token.js && echo "token.js ok"
node --check mobile/www/js/app.js && echo "app.js ok"
```
Expected: both print `ok` (valid syntax; imports are not resolved by `--check`, which is fine).

- [ ] **Step 6: Commit (shell sources only; NOT the copied bundle)**

```bash
git add mobile/www/index.html mobile/www/js/app.js mobile/www/js/token.js .gitignore
git status --short   # confirm no sync-core.js, no design/, no android/
git commit -m "feat(native): thin offline task shell (bundled webDir over notesRepo + bearer sync)"
```

---

## Task 5: Remove the B1 service-worker machinery

**Files:**
- Delete: `static/sw-native.js`, `static/js/native/sw-register.js`, `tests/test_sw_native_route.py`
- Modify: `app.py` (remove the `GET /sw-native.js` route + its `AUTH_EXEMPT_EXACT` entry)
- Modify: `static/index.html` (remove the sw-register `<script>` tag)

**Interfaces:** none produced; this removes now-moot code (a local bundle needs no shell-caching SW).

- [ ] **Step 1: Delete the SW files + its test**

```bash
git rm static/sw-native.js static/js/native/sw-register.js tests/test_sw_native_route.py
```
(If `static/js/native/` is now empty, that's fine — leave or remove the empty dir; Task 4 uses `mobile/www/js/`, not `static/js/native/`.)

- [ ] **Step 2: Remove the route + auth exemption in `app.py`**

Remove the `/sw-native.js` string from the `AUTH_EXEMPT_EXACT` set, and delete the `@app.get("/sw-native.js" …)` route function (added in B1 Task 1). Find them with:

```bash
grep -n "sw-native" app.py
```
Delete both the `AUTH_EXEMPT_EXACT` membership line and the entire route handler (`@app.get("/sw-native.js", …)` through its `return FileResponse(...)`).

- [ ] **Step 3: Remove the register script tag from `static/index.html`**

Delete this line (B1 added it in `<head>`):

```html
    <script type="module" src="/static/js/native/sw-register.js"></script>
```

- [ ] **Step 4: Verify no references remain + app imports**

Run:
```bash
grep -rn "sw-native\|sw-register" app.py static/index.html && echo "STILL REFERENCED (fix)" || echo "clean"
python -c "import app" && echo "import app ok"
```
Expected: `clean`; `import app ok`.

- [ ] **Step 5: Commit**

```bash
git add -u app.py static/index.html static/sw-native.js static/js/native/sw-register.js tests/test_sw_native_route.py
git commit -m "chore(native): remove B1 service-worker (superseded by local-bundle cold-offline)"
```
(`git add -u` stages the deletions + modifications of tracked files only — it will not sweep untracked `design/`. Verify with `git status --short` before committing.)

---

## Task 6: APK build (with bundle copy) + on-device cold-offline proof

**Files:**
- Modify: `mobile/build-apk.sh` (copy the sync bundle into `www/js/` before `cap sync`)
- Modify: `docs/productivity/mobile-build.md` (Path-B build/install/token/CORS + proof result)

**Interfaces:** Consumes Tasks 1-5; produces `dist/odysseus.apk` and the recorded acceptance result.

- [ ] **Step 1: Add the bundle-copy step to `mobile/build-apk.sh`**

After the `export JAVA_HOME=…` / `export PATH=…` lines and before `npm install`, insert:

```bash
# Copy the committed local-first sync bundle into the webDir so the shell is self-contained.
mkdir -p www/js
cp ../static/js/productivity/sync-core.js www/js/sync-core.js
```

- [ ] **Step 2: Build the APK**

Run:
```bash
./mobile/build-apk.sh
```
Expected: `cap sync` copies `www/` (now including `js/sync-core.js`), Gradle prints `BUILD SUCCESSFUL`, and the script prints `APK → dist/odysseus.apk`. If Gradle fails, capture the exact error and report BLOCKED (do not fabricate an APK).

- [ ] **Step 3: Verify the bundle is inside the APK**

Run:
```bash
test -f dist/odysseus.apk && echo "apk present"
unzip -l dist/odysseus.apk | grep -E "assets/public/js/(sync-core|app)\.js|assets/public/index.html" | head
```
Expected: `apk present`; the listing shows the bundled `index.html` and `js/app.js` + `js/sync-core.js` under `assets/public/`.

- [ ] **Step 4: Update `docs/productivity/mobile-build.md`**

Replace the file's body with the Path-B instructions (build, install, **mint+paste token**, **ALLOWED_ORIGINS**, first-run):

```markdown
# Odysseus Android app (Slice B, Path B) — build & install

The Android app bundles its own offline task shell (loads with no network) and
syncs the Notes/todo domain to `https://chat.elsiga.ch/api/sync` using a scoped
bearer token. Built on the Linux server.

## Build the APK
```
./mobile/build-apk.sh        # → dist/odysseus.apk
```
Requires a full JDK 17 (not just a JRE); the script defaults
`JAVA_HOME=/home/elsiga/jdks/jdk-17.0.19+10` (override via `JAVA_HOME`).
`mobile/{android,node_modules}`, `mobile/www/js/sync-core.js`, and `dist/` are gitignored.

## Server config (one-time)
Add the app origin to `ALLOWED_ORIGINS` in `.env` so its cross-origin sync calls
are CORS-allowed, then restart odysseus:
```
ALLOWED_ORIGINS=…existing…,https://localhost
```

## Mint a sync token
In odysseus admin → API tokens, mint a token with the `mobile_sync` profile
(scopes `sync:read`, `sync:write`). Copy the `ody_…` value once.

## Install + first run
```
adb install -r dist/odysseus.apk
```
Open the app → ⚙ → paste the `ody_…` token → Save. Tasks load and sync.
The token is stored in app-private storage; revoke it server-side any time.
```

- [ ] **Step 5: On-device cold-offline proof (manual — the Path-B success criterion)**

Requires a device/emulator on `adb`. Steps:
1. `adb install -r dist/odysseus.apk`; open the app; paste the token; confirm tasks load and a new task syncs (check web at `chat.elsiga.ch`).
2. Enable **airplane mode**. Create/toggle a task — it renders instantly (local-first).
3. **Fully close** the app (swipe from recents). **Still offline, reopen it.**
   Expected: **the shell loads** (not `ERR_NAME_NOT_RESOLVED`) and the offline task is present. ← the criterion that failed under `server.url`.
4. Disable airplane mode → within seconds the outbox drains → confirm the change on web.

- [ ] **Step 6: Record the result + commit**

Add a `## Cold-offline proof (result)` section to `docs/productivity/mobile-build.md` with pass/fail, device/emulator used, and any caveats. Then:

```bash
git add mobile/build-apk.sh docs/productivity/mobile-build.md
git commit -m "build(native): copy sync bundle into webDir + Path-B build docs & cold-offline result"
```

**If cold-offline still fails** (shell doesn't load offline): STOP and report — do not hack around it. A local-bundle app that can't cold-start offline points to a Capacitor/WebView packaging problem to diagnose (bundle not copied, wrong `androidScheme`, JS import failure), not a spec pivot.

---

## Self-Review (coverage vs spec)

- Spec §Architecture (drop server.url, local webDir, androidScheme https): Task 3. ✅
- Spec §Components → dedicated shell (`mobile/www/`): Task 4. ✅
- Spec §Components → sync-engine auth+baseUrl seam + rebuild bundle: Task 2. ✅
- Spec §Components → scope-aware bearer sync + `sync:*` scopes + CORS origin: Task 1 (CORS = documented deploy step, Task 1 Step 6 + Task 6 doc). ✅
- Spec §Components "Removed" (all B1 SW machinery incl. test): Task 5. ✅
- Spec §Data flow → local-first cold boot + bearer sync + token entry: Task 4 (`start()` renders local first, then syncs) + Task 6 proof. ✅
- Spec §Security → reuse ApiToken, sync-only scope, secure-ish storage: Task 1 (scopes) + Task 4 (Preferences) + Task 6 (mint/paste/revoke doc). ✅
- Spec §Testing → backend scope unit tests + parity; engine authHeader tests; on-device proof: Tasks 1, 2, 6. ✅
- Spec §"carries forward from B1": Tasks 3/6 keep scaffold + build-apk.sh (+ JDK fix). ✅
- Note (verified during planning, not a gap): `notesRepo.list` reads Dexie (`db.notes.toArray()`), so the mobile app never calls `/api/notes` — only `/api/sync` needs bearer. Matches spec §Data flow. ✅
