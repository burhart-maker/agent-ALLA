// Minimal service worker — just enough for install-to-home-screen
// eligibility. Not a full offline cache strategy (the chat needs the
// network anyway) — add real caching later if it becomes useful.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // no-op: pass everything through to network
