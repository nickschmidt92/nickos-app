// NickOS service worker — offline cache for the shell.
// Bump CACHE_VERSION on every deploy to invalidate old caches.
const CACHE_VERSION = 'nickos-v17';
// The versioned script urls must match index.html and cloud-sync.js. The query makes a new page
// fetch its own scripts: the old service worker's cache-first copy could pair it with old code.
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './cloud-sync.js?v=17', './v2-sync.js?v=17', './merge-by-id.js', './firebase-config.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for navigations (so edits show up), cache fallback when offline.
// Cache-first for other same-origin GETs.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      });
    })
  );
});
