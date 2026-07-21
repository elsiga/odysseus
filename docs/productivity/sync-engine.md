# Productivity sync engine (Slice A)

**Source:** `sync-engine/src/` (TypeScript). **Committed build output:** `static/js/productivity/sync-core.js` (a single ESM bundle with Dexie inlined). odysseus's runtime has no build step — the bundle is loaded as a plain module by `static/js/notes.js`.

## Regenerate the bundle
```
npm --prefix sync-engine install   # first time
npm --prefix sync-engine test      # engine unit tests (vitest)
npm --prefix sync-engine run build # → static/js/productivity/sync-core.js (commit the result)
```
The build output is committed; CI (or a pre-merge check) runs `npm --prefix sync-engine run build && git diff --exit-code static/js/productivity/sync-core.js` to catch source/artifact drift.

## Architecture
Per-record last-write-wins over odysseus's native `notes` table (tie-break by client `editedAt`). Backend: `sync_change_log` + `Note` mapper listeners + `/api/sync/pull|push` routed through the note CRUD service (`routes/note/note_service.py`). Client: Dexie store + outbox + `notesRepo`; `notes.js` reads/writes the repo. See `docs/superpowers/specs/2026-07-21-odysseus-native-offline-productivity-design.md`.
