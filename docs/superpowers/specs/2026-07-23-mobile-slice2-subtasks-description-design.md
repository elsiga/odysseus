# Mobile Slice 2 — Task Subtasks + Description — Design

**Status:** Approved (2026-07-23)
**Predecessor:** Slice 1 (Foundation + Todo), commits `8b4f347..9fb8666` on `integration` (on-device proof PASSED — sync + notification confirmed).

## Goal

Make subtasks *real* on the mobile task app — checkable, visible, and persisted — plus give each task a freeform **description**. Build on odysseus's **existing** native Note checklist mechanism (`items`, `note_type`, `content`) rather than a parallel model, so the work is almost entirely mobile UI.

## Why this is small

odysseus's backend already has everything and Slice 1 already syncs it:

- **Subtasks** = `Note.items` — JSON `[{text, done}]` (the native Keep-style checklist).
- **Description** = `Note.content` — the note body (Text, nullable).
- **note_type** = `Note.note_type` — `"note"` or `"checklist"`; odysseus's web Notes UI renders a checkable list only when this is `"checklist"`.

All three are in `_CREATE_FIELDS`/`_UPDATE_FIELDS`/`_WIRE_IN_FIELDS` and `note_to_wire`/`note_from_wire`, and `update_note_record` applies `note_type`/`content`/`items` on the sync push path (`routes/note/note_service.py`). Verified: mobile can flip `note_type` note→checklist and set `content` purely through `notesRepo.update` → `/api/sync`. **This slice needs no backend change.**

## Architecture

- **Mobile-only** (Capacitor UI under `mobile/src/`). Web stays untouched — it gets subtask + description parity *for free* because setting `note_type='checklist'` engages odysseus's existing web checklist renderer, and `content` is already the web note body.
- **Web task-FIELD UI is explicitly out of scope** (bucket/urgency/deadline/repeat/project rendered as a real task UI on web). That is a large, dedicated later slice — to be done "at the very end, once tasks are fully fledged on mobile + backend." We do not contort the data model to fit web's current render; the mobile task intention is the source of truth and web catches up later.
- **Repaint model unchanged** from Slice 1: every edit goes through `store.update` (awaited `notesRepo` write → `refresh()` → background `syncNow()`); never `notesRepo.subscribe()`.

## Data model & behavior

- **Subtasks** live in `note.items` as `[{text, done}]`.
- **Description** lives in `note.content` (freeform string). It is *stored* for a future AI tie-in; **no AI use in this slice**. Clearing it writes `""` (not null).
- **note_type is derived** on every subtask write by a pure helper: `deriveNoteType(items) = items.length > 0 ? 'checklist' : 'note'`. Written alongside `items` in the same `store.update` patch, so web rendering stays consistent (a task that loses its last subtask reverts to `'note'`).
- **Parent `done` is independent of subtask completion.** Checking every subtask shows `5/5` but leaves the task active; the user completes the task by tapping its own circle. No auto-complete, no nudge.

## Components

### `mobile/src/subtasks.ts` (new — pure, tested)
- `type Subtask = { text: string; done: boolean }`
- `deriveNoteType(items: Subtask[]): 'note' | 'checklist'`
- `subtaskProgress(items: Subtask[] | null | undefined): { done: number; total: number; ratio: number }` — `ratio` in `[0,1]`, `0` when total is `0`.

These are the only new unit-tested logic; UI stays presentational.

### `mobile/src/screens/Detail.ts` (upgraded — the core of the slice)
Becomes a real task editor:
1. **Editable title** — text input bound to `note.title`; writes through `store.update({ title })` on change/blur.
2. **Description** — multiline `<textarea>` bound to `note.content`; autosaves on blur/change via `store.update({ content })`.
3. **Subtasks** — each row: a **checkbox** toggling `done` (the missing Slice-1 piece), an inline text input editing `text`, and a remove control; plus an "＋ add subtask" row. Every mutation writes `{ items: next, note_type: deriveNoteType(next) }` through `store.update`.
   - **Stable per-subtask keys** (assign an `id` to each subtask row in local component state, keyed off that, not the array index) — fixes the Slice-1 logged focus-flash-on-delete Minor. The persisted `items` shape stays `{text, done}` (ids are view-local only, not written to `note.items`).
4. **Back** returns home (unchanged hub-and-spoke).

Local `useState` seeds from `note.items`/`note.content`/`note.title`; `commit` updates local state and writes through (awaited → repaint), matching Slice 1.

### `TaskRow` (`mobile/src/components.ts`, extended)
When a task has ≥1 subtask, show:
- a **`done/total` count** (e.g. `2/5`) beside the project tag, and
- a **small progress bar** — a thin track with an accent-colored fill at `subtaskProgress().ratio`. Rendered only when `total > 0`; theme-consistent (muted track, `--accent` fill), unobtrusive, no layout shift for subtask-less tasks.

## Testing

- **Unit (vitest, `mobile/src/subtasks.test.ts`):** `deriveNoteType` (empty→`note`, non-empty→`checklist`); `subtaskProgress` (0/0→ratio 0; 2/5→ratio 0.4; all-done→ratio 1).
- **Build:** `node build.mjs` clean; `npx tsc --noEmit` clean.
- **Manual on-device (user):** open a task → add subtasks → check some → row shows `2/5` + a partial progress bar → open odysseus web Notes and confirm the same task renders as a checklist with those items checked and the description as its body → toggle a subtask on mobile and confirm it reflects on web (round-trip).

## Non-goals (later slices)

- Any **AI** use of the description (stored now, wired later).
- **Project entity** / project metadata (project stays a plain string tag).
- **Web task-FIELD UI** (bucket/urgency/deadline/repeat/project on web) — the dedicated end-stage web slice.
- **Deadline / repeat** editing UI on mobile.
- **Auto-complete parent** on all-subtasks-done, and the subtask **peek** on the row (kept as a possible future enhancement).
- Calendar (day/week/month) — remains the next major slice after tasks are fully fledged.
