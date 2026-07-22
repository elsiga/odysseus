// Capacitor-only app-shell service worker. Registered ONLY inside the native
// app (see sw-register.js). Runtime-caches navigation + static assets so cold
// launches work offline; /api/* is passed through to the network (the Slice-A
// IndexedDB outbox owns offline writes).
const SHELL = 'ody-native-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // ignore cross-origin
  if (url.pathname.startsWith('/api/')) return;       // API → network (offline layer handles)

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        if (net && net.ok && !net.redirected) {
          (await caches.open(SHELL)).put(req, net.clone());
        }
        return net;
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match(req)) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // static assets: stale-while-revalidate
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(req);
    const network = fetch(req).then((net) => {
      if (net && net.ok) cache.put(req, net.clone());
      return net;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
