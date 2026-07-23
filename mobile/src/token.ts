const KEY = 'sync_api_token'
function prefs(): any {
  const w = window as any
  return (w.Capacitor && w.Capacitor.Plugins && w.Capacitor.Plugins.Preferences) || null
}
export async function getToken(): Promise<string | null> {
  const p = prefs(); if (!p) return null
  const { value } = await p.get({ key: KEY }); return value || null
}
export async function setToken(token: string): Promise<void> {
  const p = prefs(); if (!p) return; await p.set({ key: KEY, value: token })
}
export async function clearToken(): Promise<void> {
  const p = prefs(); if (!p) return; await p.remove({ key: KEY })
}
