import { createSyncClient } from './engine'

// COOKIE AUTH ADAPTATION (Slice 1): ember's client.ts wires getToken to
// getAccessToken() (an OIDC user manager). Slice 1 has no bearer-token auth —
// the browser is authenticated via a same-origin session cookie sent
// automatically with every request — so getToken always resolves null and
// engine.ts's api() omits the Authorization header in that case.
export const syncClient = createSyncClient({
  apiBase: import.meta.env.VITE_API_BASE ?? '/api/sync',
  getToken: async () => null,
})
