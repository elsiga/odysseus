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
