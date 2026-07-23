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
