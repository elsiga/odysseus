# Odysseus Offline-First Productivity App + Ember Fusion — Program Design

**Date:** 2026-07-21
**Status:** Approved (program level); individual slices specced separately
**Owner:** Heike (elsiga)

## 1. Goal

Add an **offline-first productivity layer** on top of odysseus — tasks, calendar, and
Pomodoro first; **email drafting and document create/edit** later — that works offline and
**syncs to the odysseus backend when online**. Keep the **odysseus web app working and
extend it** with these same features, and deliver them on **Android** as an installable app.
Reach the rest of the odysseus workflow (live chat, research, sending/receiving mail) online.
Later, add **Honcho** as a user-model brain in odysseus. Prefer first-party (non-MCP) agent
tooling and DeepSeek-class models.

**Single backend, always: odysseus, extended as needed. No second backend is ever run.**

## 2. Key findings that shaped this design

Two codebases were surveyed (`odysseus`, `../ember`). The important reframing:

- **Ember's "tighter calendar integration" is not built** — it's only a design doc
  (`../ember/ai-assistant-expansion-plan.md`). No calendar code exists there.
- **The working calendar is in odysseus**: two-way **CalDAV sync** (`src/caldav_sync.py`),
  full event CRUD, `.ics`, RRULE recurrence, exposed to the agent as a **native Python
  function tool `manage_calendar`, not MCP**.
- **Neither project uses LangChain** — both avoided it deliberately. odysseus is a
  provider-agnostic raw `httpx` client (`src/llm_core.py`); ember uses the Vercel AI SDK.
  **Both already support DeepSeek + tool-calling.** No LangChain is needed.
- The agent's past "calendar via MCP" pain is a symptom of MCP + three **overlapping
  reminder mechanisms** (note `due_date` vs. calendar `reminder_minutes` vs. `ScheduledTask`),
  which confuse smaller models. First-party tools already sidestep MCP.
- **Ember's genuine crown jewels are its local-first machinery**: a framework-agnostic
  **HLC/outbox sync engine** (`../ember/packages/shared` + `apps/web/src/sync`) and a
  **pure-state-machine focus/Pomodoro timer** (`apps/web/src/features/focus`). Both are
  React/Vite/TypeScript — the **same stack we'll build the new SPA in, so ember code is
  reused directly, not just referenced.**

## 3. Foundation decision

**Build a new local-first SPA, served by odysseus, bundled into an Android app. One backend.**

- Keep odysseus's Python/FastAPI backend as the sole backend; extend it with **new files +
  one-line hooks** as features need (sync endpoints, agent tools, Honcho).
- Build the productivity layer as a **new local-first SPA** (React + Vite, reusing ember's
  sync engine + focus timer + components). It owns a **local store** (IndexedDB in the
  browser) and **syncs to odysseus** when online.
- **odysseus serves the SPA** at a route → the **web app gains** these features, offline-
  capable as a **PWA** (service worker + IndexedDB). Same-origin in the browser, so it uses
  the normal **cookie/TOTP session** — no token, no CORS.
- The **same SPA is bundled into a Capacitor app (Android first)**. Bundled ⇒ it loads from
  a local origin (cross-origin to `chat.elsiga.ch`), so there it authenticates with the
  **`ody_` bearer token** in secure storage, and odysseus's `ALLOWED_ORIGINS` must include
  the Capacitor origin. A small **auth adapter** lets the one codebase use cookie-session in
  the browser and token in the app. iOS is possible later (Heike's MacBook + Xcode).
- **Online-only odysseus features** (live chat, research, full mail send/receive, existing
  document views) are reached by **linking out to the existing odysseus web UI** — not
  reimplemented.
- **Sync is the backbone.** A generic local-store ↔ odysseus reconcile (pull/push, LWW on
  timestamps), with a clean seam to add domains. Tasks/calendar are its first tenants;
  email drafts and documents are added later — that is the "option 3 → option 1" path.

### Reuse map

| Capability | Source | Action |
| --- | --- | --- |
| Agent loop, auth, multi-provider LLM (DeepSeek incl.) | odysseus | Keep |
| Calendar + CalDAV two-way sync; email; documents; research | odysseus | Keep, extend |
| Todo/checklist (`Note`), scheduling (`ScheduledTask`), calendar (`CalendarEvent`) | odysseus | Extend + expose via sync API |
| Native agent tools (`manage_calendar`, `manage_notes`) | odysseus | Extend |
| **HLC/outbox local-first sync engine** | ember | **Reuse/port into the SPA** |
| **Focus/Pomodoro state machine** | ember | **Reuse/port into the SPA** |
| Todo UX, quick-add parser, React components | ember | Reuse where useful |
| Ember's server / Postgres / auth | ember | **Not used** (single backend = odysseus) |

## 4. Architecture & access

- **SPA:** React + Vite, local-first (IndexedDB), served by odysseus at a route and bundled
  into Capacitor. PWA service worker for browser offline.
- **Sync:** new odysseus **sync-friendly endpoints** (pull changes since a cursor/timestamp;
  push with LWW conflict resolution) over the domains' existing tables. Client sync loop
  ported from ember.
- **Transport:** Cloudflare Tunnel (`cloudflared` container in `docker-compose.override.yml`,
  gitignored) → `chat.elsiga.ch` → `http://odysseus:7000`. No host ports exposed. Serves
  both the laptop web app and the phone app.
- **Auth:** browser SPA = cookie/TOTP session (same-origin). Bundled app = `ody_` bearer
  token in device secure storage (Keychain/Keystore), revocable via the `ApiToken` table.
  Embedded odysseus web view (for online-only features) logs in normally.
- **Hardening:** TOTP on; strong admin password; `SECURE_COOKIES=true` once HTTPS is live;
  `ALLOWED_ORIGINS` includes the Capacitor origin; optional Cloudflare WAF login rate-limit.
  Known trade-off: Cloudflare terminates TLS at its edge.

## 5. Fork & upstream strategy

- Fork = `origin` (elsiga/odysseus); `upstream` = odysseus-dev/odysseus. Work on the
  long-lived `integration` branch (the fork's default branch).
- **Weekly auto-merge** via `.github/workflows/sync-upstream.yml`: clean merges pushed
  automatically; conflicts fail the job and email for manual resolution.
- **Minimize edits to odysseus "hot files"; put logic in new files.** Conflict-prone
  touchpoints, kept to one-line hooks:
  - `app.py` — router registration + serving the SPA route
  - `core/database.py` — additive columns via the existing `_migrate_add_*` pattern
  - `src/tool_schemas.py` / tool registry — agent-tool registration
- The **SPA lives in its own new subtree** in the fork (e.g. `webapp/`); the Capacitor
  project in another (e.g. `mobile/`). Both are new files — no upstream-merge surface.
- `docker-compose.override.yml`, `.env`, `data/` stay local/gitignored.
- **Upstream generic improvements** (e.g. reminder-model cleanup, sync endpoints if welcome)
  back to odysseus to shrink the fork's delta.
- **Ember stays at `../ember`, read-only** — code is ported in, never vendored, to avoid
  polluting merges and mixing licenses.

## 6. Slice decomposition (each gets its own spec → plan → build)

Order reflects "option 3 now → option 1 later," easiest sync first:

1. **SPA + sync foundation + tasks (offline)** — scaffold the local-first SPA (React/Vite,
   ember sync engine), add odysseus sync endpoints for the `Note` domain, serve the SPA from
   odysseus as a browser PWA. Thinnest vertical that proves the full local-first ↔ odysseus
   loop end-to-end. Web-first (no native build yet).
2. **Calendar + Pomodoro in the SPA** — extend sync to `CalendarEvent`; port ember's focus
   timer; task→calendar scheduling.
3. **Capacitor Android packaging** — bundle the SPA, `ody_` token auth + CORS, native
   notifications (ember's plugin), link-out to the odysseus web workspace. Installable app.
4. **Email drafts (offline)** — new sync domain: draft locally, push to odysseus, send when
   online.
5. **Document create/edit (offline)** — the hard one, but eased by odysseus's design.
   odysseus documents are already **last-write-wins with full version history**
   (`PUT /api/document/{doc_id}` overwrites `current_content` but appends a `DocumentVersion`;
   restorable via `/restore/{num}`). Single-user, so start with **per-document LWW on sync**
   and let overwritten edits fall into that existing version history as the "conflict copy"
   — no new conflict machinery. CRDT/OT only if it ever bites.
6. **Reminder untangling** — collapse the three overlapping reminder mechanisms so
   DeepSeek-class models stop fumbling calendar ops; upstream the generic parts.
7. **Honcho user-model brain** — backend integration into odysseus's memory layer.

## 7. Risks & watch-outs

- **Sync against CRUD endpoints** — odysseus's APIs are CRUD, not delta-sync; Slice 1 must
  add a sync-friendly contract (change cursor + LWW). This is the core new engineering.
- **Document text conflicts (Slice 5)** — freeform text isn't safely LWW; pick a policy
  explicitly, don't hand-wave. Hardest offline domain; sequenced last of the offline set.
- **Two auth contexts** — cookie (browser SPA) vs. `ody_` token (bundled app); one auth
  adapter, tested both ways. CORS/`ALLOWED_ORIGINS` must include the Capacitor origin.
- **Hand-rolled SQLite migrations** (no Alembic) in `core/database.py` — additive only.
- **Reminder overlap** already confuses the agent — Slice 6 must not be skipped.
- **PWA offline caching correctness** — service-worker versioning/update flow needs care.
- **Native builds run on the Mac**, code + backend live on this Linux server (SSH) — the
  build/deploy loop crosses machines; keep the SPA browser-testable to minimize native cycles.

## 8. Out of scope / YAGNI (initially)

- A second backend of any kind (ember-server, separate sync server). Odysseus only.
- Rewriting the odysseus backend in TypeScript.
- Full CRDT/OT for documents up front — start with a simpler conflict policy (Slice 5).
- iOS as the lead platform — Android first; iOS is a later add on the Mac.
- MCP-based calendar/task tooling (native tools preferred).
- Cloudflare Access outer auth layer (odysseus auth + TOTP deemed sufficient).
