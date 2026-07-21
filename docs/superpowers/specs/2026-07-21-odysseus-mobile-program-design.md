# Odysseus Mobile + Ember Task/Calendar Fusion — Program Design

**Date:** 2026-07-21
**Status:** Approved (program level); individual slices to be specced separately
**Owner:** Heike (elsiga)

## 1. Goal

Run the **full odysseus workflow** (chat, agents, research, documents, email, notes,
calendar) on a phone as an installable app, while **keeping the odysseus web app working
and extending it** with a tight, interactive **task / Pomodoro / calendar-scheduling layer**
inspired by the `ember` project. Add **Honcho** as a user-model "brain" in the odysseus
backend. Prefer first-party (non-MCP) agent tooling and DeepSeek-class models.

## 2. Key findings that shaped this design

Two codebases were surveyed (`../odysseus`, `../ember`). The important reframing:

- **Ember's "tighter calendar integration" is not built** — it exists only as a design doc
  (`ember/ai-assistant-expansion-plan.md`). No calendar code (no Google, CalDAV, OAuth, sync).
- **The working calendar is in odysseus**: two-way **CalDAV sync** (`src/caldav_sync.py`),
  full event CRUD, `.ics`, RRULE recurrence, exposed to the agent as a **native Python
  function tool `manage_calendar`, not MCP**.
- **Neither project uses LangChain** — both deliberately avoided it. odysseus is a
  provider-agnostic raw `httpx` client (`src/llm_core.py`); ember uses the Vercel AI SDK.
  **Both already support DeepSeek + tool-calling.** No LangChain is needed or wanted.
- The agent's past "calendar via MCP" pain is a symptom of MCP + three **overlapping
  reminder mechanisms** (note `due_date` vs. calendar `reminder_minutes` vs. `ScheduledTask`),
  which confuse smaller models. First-party tools already sidestep MCP.
- odysseus has **no mobile app** but ships a mobile-responsive **PWA** and a `companion/`
  LAN pairing bridge + `ody_` bearer tokens explicitly meant for phone clients.
- Ember's genuinely reusable pieces are **framework-agnostic pure TypeScript**: the
  focus-timer state machine, quick-add parser, and local-first sync logic — plus a
  Capacitor **native notification plugin**.

## 3. Foundation decision

**Build on the odysseus backend; deliver the UI as odysseus's own frontend wrapped in
Capacitor.**

- Keep odysseus's Python/FastAPI backend as-is (agent loop, auth, CalDAV calendar,
  scheduling, MCP). Rewriting it in TypeScript was considered and rejected — it re-builds
  the exact thing we want to avoid rebuilding.
- Build the new task/Pomodoro/calendar features **into odysseus's own web frontend**
  (`static/js/`) so the **web app is extended, not forked**.
- The **mobile app is the same frontend wrapped in Capacitor** pointing at the backend over
  a Cloudflare Tunnel — one codebase, web + mobile, no second frontend to maintain.
- Reuse ember's **logic** (framework-agnostic TS), not its React components; render in
  odysseus's existing vanilla-ES-module style. (Whether a small embedded React "island" is
  used for the task screens is a Slice 2 design decision, deferred.)

### Reuse map

| Capability | Source | Action |
| --- | --- | --- |
| Agent loop, auth, multi-provider LLM (DeepSeek incl.) | odysseus | Keep |
| Calendar + CalDAV two-way sync | odysseus | Keep, extend |
| Todo/checklist model (`Note`), scheduling (`ScheduledTask`) | odysseus | Extend |
| Native agent tools (`manage_calendar`, `manage_notes`) | odysseus | Extend |
| Focus-timer state machine, quick-add parser, sync logic | ember | Port (logic only) |
| Capacitor native notification plugin | ember | Vendor |
| Calendar integration design | ember plan | Reference only (odysseus already has real one) |

## 4. Architecture & access

- **Transport:** Cloudflare Tunnel (outbound-only `cloudflared`, no exposed ports); one
  stable HTTPS URL serves both the laptop web app and the phone app.
- **Auth:** odysseus's existing auth. Web = session cookie; mobile app = `ody_` **bearer
  token** stored in device **secure storage** (Keychain/Keystore), not plain Preferences.
  Token is a password-equivalent, revocable via the `ApiToken` table if the phone is lost.
- **Hardening:** TOTP 2FA enabled; strong admin password; optional Cloudflare WAF
  rate-limit on the login route. Known trade-off: Cloudflare terminates TLS at its edge.

## 5. Fork & upstream strategy

- Fork = `origin` (elsiga/odysseus); `upstream` = odysseus-dev/odysseus. All work on the
  long-lived `integration` branch (default branch of the fork).
- **Weekly auto-merge** via `.github/workflows/sync-upstream.yml`: clean merges of
  `upstream/dev` are pushed automatically; conflicts fail the job and email for manual
  resolution.
- **Minimize merge pain by minimizing edits to odysseus "hot files."** Conflicts come
  almost entirely from four touchpoints; keep changes there to one-line hooks and put all
  logic in new files:
  - `app.py` — router registration (one-line `include_router`)
  - `core/database.py` — models + hand-rolled `_migrate_add_*` migrations
  - `src/tool_schemas.py` / tool registry — agent-tool registration
  - `static/index.html` / `static/app.js` — frontend module wiring
- **Upstream generic improvements** (e.g. reminder-model cleanup) back to odysseus to
  shrink the fork's delta.
- **Ember reference material stays out of git** (gitignored `reference/` or left in
  `../ember`) to avoid polluting merges and mixing licenses.

## 6. Slice decomposition (each gets its own spec → plan → build)

1. **Mobile shell** — Capacitor-wrap the odysseus frontend, point at the tunnel URL, token
   auth, install on phone. Vendor ember's Capacitor notification plugin (for later use).
   Unblocks everything; fastest path to the full workflow on-device.
2. **Task / Pomodoro / calendar layer** (the bulk; lands in web + mobile) — extend
   `Note` / `ScheduledTask` / `CalendarEvent` + native agent tools (new files, one-line
   hooks); port ember's focus-timer, todo UX, quick-add, and task→calendar scheduling into
   `static/js/`; wire native notifications.
3. **Reminder untangling** — collapse the three overlapping reminder mechanisms so
   DeepSeek-class models stop fumbling calendar ops; upstream the generic parts.
4. **Honcho user-model brain** — backend integration into odysseus's memory layer.

## 7. Risks & watch-outs

- **Hand-rolled SQLite migrations** (no Alembic) in `core/database.py` — additive columns
  via the existing `_migrate_add_*` pattern; a conflict-prone hot file.
- **Reminder overlap** already confuses the agent — Slice 3 must not be skipped.
- **Vanilla-JS vs React island** for the task UI — decide in Slice 2; affects reuse effort.
- **Offline behavior**: user accepts sync-when-connected; full local-first (ember's CRDT
  engine) is *not* in scope initially — revisit only if needed.
- **Cloudflare edge TLS termination** — accepted trade-off vs. the convenience of a public
  URL for laptop + phone.

## 8. Out of scope / YAGNI (initially)

- Rewriting the odysseus backend in TypeScript.
- Full local-first offline CRDT sync.
- Google Calendar API integration (odysseus's CalDAV already covers the need).
- MCP-based calendar/task tooling (native tools are preferred).
- Cloudflare Access outer auth layer (odysseus auth + TOTP deemed sufficient).
