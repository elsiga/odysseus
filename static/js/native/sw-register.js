// Registers the offline app-shell SW ONLY inside the Capacitor native app.
// Web browsers never reach the register() call (Slice-A spec §9: no web PWA).
if (typeof window !== 'undefined' && window.Capacitor) {
  document.documentElement.classList.add('is-native');
  const markBody = () => document.body && document.body.classList.add('is-native');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markBody);
  else markBody();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw-native.js', { scope: '/' })
      .catch((err) => console.warn('sw-native register failed', err));
  }
}
