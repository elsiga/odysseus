# Mobile — Android Back Navigation — Design

**Date:** 2026-07-24
**Status:** Approved (pending spec review)
**Scope:** Mobile only (`mobile/**`). One native change: add the `@capacitor/app` plugin.

## Problem

Pressing Android's back button closes the app from any screen instead of navigating back. `MainActivity` is a bare `BridgeActivity` with no back override, and `@capacitor/app` is not installed — so nothing intercepts the press and Android's default `finish()` ends the activity.

Capacitor's own bridge confirms the plugin is the required hook:

```js
// native-bridge.js:278-287
// Add a dummy listener so Capacitor doesn't do the default back button action
if (!cap.Plugins?.App) { win.console.warn('App plugin not installed'); }
else { cap.Plugins.App.addListener('backButton', () => {}); }
```

This also rules out a zero-dependency workaround: pushing `history` entries would not help, because with no override the WebView's history is never consulted before the activity finishes.

A second, related defect: `Detail`'s back is hardcoded to Home (`main.ts:49`), so a task opened from Library or Project returns to Home rather than where it was opened from. The router keeps a single `Route`, not a history, so it cannot express "where I came from."

## Goals

- Android back navigates within the app, landing exactly where the user came from.
- Back at the root does not close the app on a single press.
- Remove the on-screen back affordances, which exist only because the static prototype had no real back action.

## Non-goals

No route persistence across cold start, no deep links, no exit toast, no predictive-back animation, no broader header restyle, and no changes to sync, `store.ts`, or Detail's editing logic.

## Architecture

Three pieces, following the established pattern of pure logic in a tested module with thin wiring at the edges (as in `tasks.ts` and `subtasks.ts`).

### `mobile/src/nav.ts` (new, pure, tested)

Owns the stack rules and nothing else. `Route` moves here from `main.ts` so the type and the rules governing it live together.

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
```

- `routeKey` yields a stable identity including parameters, so `project:foo` ≠ `project:bar` and `detail:123` ≠ `detail:456`.
- `pushRoute` **unwinds to an existing entry** when the target is already in the stack, otherwise appends. This keeps the stack shallow under the hub-and-spoke navigation pattern: Home is always one press away, never five.
- `popRoute` removes the last entry; at the root (length 1) it returns the stack unchanged.
- `shouldExit` takes `now` as an argument so the 2-second window is testable without fake timers.

### `mobile/src/backButton.ts` (new, thin)

The only file that imports Capacitor. Registers `App.addListener('backButton', handler)` inside a `useEffect` and removes the listener on cleanup. Isolating the native call keeps `nav.ts` pure and Node-testable and keeps `main.ts` free of plugin imports.

### `mobile/src/main.ts` (modified)

`useState<Route>` becomes `useState<Route[]>([{ name: 'home' }])`, with `current = stack[stack.length - 1]`. Every `setRoute({...})` becomes `navigate(...)`; the hardware back handler calls the same `back()`. One mechanism serves all navigation.

## Behavior

**Non-root screens.** Back pops one entry, landing exactly where the user came from.

```
[home]
  tap Library   → [home, library]
  tap a project → [home, library, project:foo]
  tap a task    → [home, library, project:foo, detail:123]
  BACK          → [home, library, project:foo]
  BACK          → [home, library]
  BACK          → [home]
```

**Root (Home).** Silent double-tap to exit: the first press records a timestamp and does nothing visible; a second press within 2s calls `App.exitApp()`. No toast, by explicit decision.

*Known trade-off:* with no feedback, the first press reads as the app ignoring the user. Accepted for now; a subtle cue can be added later without changing the model.

**Capture.** Remains an overlay with Home rendered beneath it. It is a pushed route, so back pops the sheet. Its own close control stays — it is a bottom sheet, not a screen.

**TokenGate.** Returns early, before the router, so back there hits root behavior and double-tap exits. No extra code.

## UI changes

Delete the back `<span>` from `Library.ts:23` (`← home`), `Project.ts:14` (`← back`), and `Detail.ts:36` (`← back`), and drop the now-unused `onBack` prop from all three component signatures.

The prototype (`design/Tasks + Calendar Prototype.dc.html` lines 109, 148, 177) does show these links, but only because a static mock has no hardware back to rely on. They are a mock affordance, not a design element; removing them is faithful to the design intent. Navigation becomes hardware-back only.

Headers keep their existing left-hand content. Detail's editable title input reclaims the freed width.

*Noted, deliberately deferred:* Project and Detail lack the prototype's small muted kicker above the title (lines 147, 176). A real gap, but it belongs to a UI-polish pass, not this slice.

## Incidental fixes

Two existing defects sit in code this slice rewrites, and are fixed rather than carried forward:

1. `Detail`'s hardcoded return-to-Home (`main.ts:49`) becomes `back()`.
2. The Slice-1 Minor where a missing note calls `setRoute` *during render* (`main.ts:48`). With a stack this anti-pattern would merely relocate, so it is resolved properly.

## Testing

**`mobile/src/nav.test.ts`** (pure, vitest):
- push a new route appends
- navigating to a route already in the stack unwinds to it rather than duplicating
- pop removes the last entry
- pop at root is a no-op
- `routeKey` distinguishes `project:foo` from `project:bar`, and `detail:123` from `detail:456`
- `shouldExit` boundaries just under and just over 2s

**Build:** `node build.mjs` and `npx tsc --noEmit` both clean.

**Native verification (explicit step, not an assumption):** `@capacitor/app` must be registered by `npx cap sync android`. If that step is skipped the listener silently never fires and back still closes the app. Confirm the plugin appears in the synced Android project before building the APK.

**On-device proof (manual):** Home → Library → Project → task; three back presses retrace exactly that path; one back on Home does nothing; a second within 2s exits.

## Risks

- **Plugin not registered.** The failure mode is silent — mitigated by the explicit sync-verification step above.
- **Native change.** First since Slice 1 added local-notifications; requires an APK rebuild to test at all.
