// Token persistence via Capacitor Preferences (app-private storage).
// (Hardening follow-up: swap for an encrypted secure-storage plugin.)
const KEY = 'sync_api_token';

function prefs() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;
}

export async function getToken() {
  const p = prefs();
  if (!p) return null;
  const { value } = await p.get({ key: KEY });
  return value || null;
}

export async function setToken(token) {
  const p = prefs();
  if (!p) return;
  await p.set({ key: KEY, value: token });
}

export async function clearToken() {
  const p = prefs();
  if (!p) return;
  await p.remove({ key: KEY });
}
