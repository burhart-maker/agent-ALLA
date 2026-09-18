// Agent ALLA — service worker.
//
// Purpose: make the site installable and make it open instantly (and at
// least render offline) once installed. It is deliberately conservative:
//
//   * Navigations are NETWORK-FIRST. A redeploy must never leave someone
//     staring at a cached old build — the cache is only the fallback for
//     when the network fails.
//   * /api/chat is never touched. It is a POST and it streams; the worker
//     passes anything that isn't a same-origin GET straight through.
//   * Static assets are stale-while-revalidate: instant from cache, then
//     quietly refreshed in the background for next time.
//
// Bump CACHE_VERSION whenever the precached shell changes.
const CACHE_VERSION = "alla-v3";
const SHELL_CACHE = CACHE_VERSION + "-shell";
const RUNTIME_CACHE = CACHE_VERSION + "-runtime";

// The minimum needed to render the page with its globe when offline.
const SHELL = [
  "/",
  "/assets/globe/index.js",
  "/assets/globe/style.css",
  "/assets/globe/renderer.bundle.js",
  "/assets/logo-sphere.svg",
  "/assets/pwa/icon-192.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails the whole install if any single entry 404s, which would
      // leave the site with no worker at all — so each entry is tolerated
      // individually instead.
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "alla:skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network first, cached shell only as a fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("/"))
        )
    );
    return;
  }

  // Everything else same-origin: serve from cache, refresh behind the scenes.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
