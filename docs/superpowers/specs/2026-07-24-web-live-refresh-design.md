# Web Live-Refresh — Design

**Date:** 2026-07-24
**Status:** Approved (pending spec review)
**Scope:** Sync engine (`sync-engine/src/`) + web notes UI (`static/js/notes.js`) + the committed web bundle. Mobile opt-in deferred.

## Problem

The web notes UI does not repaint when a remote sync pull brings in a change made elsewhere (another device, the mobile app). The user must press Ctrl+R to see it.

**Root cause (revised from the project memory's assumption that the web simply lacks a repaint hook):** `static/js/notes.js:5357` wires repaint through `notesRepo.subscribe()`, which registers Dexie `creating`/`updating`/`deleting` hooks. Those hooks fire **pre-commit** — inside the write transaction. When the engine's `applyChange` writes a pulled change, the subscribe callback re-reads via `_fetchNotes()` and sees **stale** (pre-commit) data, so it paints the old state. This is the same defect fixed on mobile in commit `afd0f84` (mobile dropped `subscribe` and repaints imperatively after each awaited write); the web never received that fix.

The sync engine is a **shared bundle** consumed by both web and mobile. Mobile repaints by awaiting `syncOnce()` after local writes, but its 60-second interval pull does not repaint either — the same idle-remote gap the memory flagged as "revisit if multi-device." A fix at the engine level closes both.

## Goals

- A remote change appears in the open web notes panel without a manual reload, within one sync interval (≤60s), or immediately when a sync is already in flight.
- No wasted repaints: an idle pull that applies nothing must not trigger a re-render.
- A background pull must not disrupt an in-progress edit on the web.

## Non-goals

- Wiring mobile's `store.ts` to the new hook (deferred to the next mobile slice, where an APK build is already in flight — it is a ~2-line opt-in, `onChanged: refresh`).
- Any change to the per-record LWW / conflict rules, push behavior, the outbox, or the reminder loop.
- Real-time push (websockets/SSE). The existing 60s interval + in-flight sync is the delivery mechanism.

## Architecture

Three components, in dependency order.

### 1. Sync engine — `sync-engine/src/engine.ts`

The fix lives here so both clients can consume it.

- `createSyncClient`'s options gain an optional `onChanged?: () => void`. Optional keeps the change backward-compatible: mobile's existing `createSyncClient({ apiBase, authHeader })` call is unaffected and continues to behave exactly as today.
- `applyChange` currently returns `void`. It changes to report whether it **actually wrote** to `db.notes`. It writes in two cases (a `put` for an upsert, a `delete` for a delete) and skips in three (`local?._dirty === 1` pending local edit; `ch.rev <= local._baseRev` echo/stale; a delete whose local row is absent or dirty). "Wrote" = true only on the two write paths.
- `pullOnce` tracks whether any `applyChange` in the pull reported a write. After the pull loop finishes — at which point every awaited `put`/`delete` has committed — it calls `onChanged()` **once** if and only if at least one change was applied. It is never called on an empty page or an all-echo page.
- `onChanged` fires only from the pull path. Local writes are pushed via `pushOnce` and never flow through `applyChange`, so the web's existing imperative repaint remains the single trigger for local echo; `onChanged` is strictly the remote-change signal.

The committed web bundle `static/js/productivity/sync-core.js` is regenerated from source (`npm --prefix sync-engine run build`).

### 2. Web UI — `static/js/notes.js`

- Pass `onChanged` into `createSyncClient`. The handler re-reads the local store (`_fetchNotes()`) and re-renders, gated on the panel being open (`_open`).
- **Remove** the `notesRepo.subscribe()` block. Local mutations already repaint imperatively (optimistic `_renderNotes()` on the local array plus `_fetchNotes().then(_renderNotes)` after the server write, on the create/save/delete/toggle/reorder paths), so local echo does not depend on `subscribe`. A verification pass over every `notesRepo` mutation call site in the file confirms each is followed by an imperative repaint; any path found relying solely on `subscribe` gets an explicit repaint added.
- **In-progress-edit guard:** when `onChanged` fires while a note is being edited (`_editingId != null`), refresh `_notes` but skip the DOM rebuild, deferring the paint to the next natural render. A full `_renderNotes()` tears down and rebuilds the panel body, so painting mid-edit would disrupt the open editor (focus/caret). The old stale `subscribe` never needed this guard because it painted no new content; the corrected hook surfaces the need.

### 3. Verification

- **Unit (vitest, `sync-engine`):** `onChanged` fires after a pull that applies ≥1 change; does NOT fire on an empty pull or an all-echo/stale pull; fires once per pull, not once per change.
- **Manual (web):** two sessions (web + mobile, or two browser tabs on `https://chat.elsiga.ch`). Edit a note in one; within ≤60s it appears in the other's open panel with no reload. While editing a note on web, trigger a remote change to a different note — the open editor is not disrupted, and the change appears once the edit ends.

## Risks

- **Removing `subscribe` regresses local echo on some path** the audit misses. Mitigated by the explicit per-call-site verification pass; the imperative repaints are already present on the main paths.
- **Edit-guard deferral leaves a stale paint** if no natural render follows the edit. Mitigated because ending an edit (save or cancel) itself calls `_renderNotes()`, which reads the already-refreshed `_notes`.
