// App shell cache so the app opens without internet. Bump VERSION on every release.
const VERSION = 'v17';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/db.js', './js/logic.js', './js/i18n.js', './js/config.js', './js/holidays.js', './manifest.webmanifest', './icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const cacheable = u.origin === location.origin || ['www.gstatic.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.host);
  if (!cacheable) return; // Firestore / Auth / Gemini traffic goes straight to the network
  // Network first for our own files (so updates arrive), cache first for library CDNs.
  if (u.origin === location.origin) {
    // no-cache: always ask the server for a fresh copy instead of a stale browser cache.
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => { const c = r.clone(); caches.open(VERSION).then((ca) => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const c = r.clone(); caches.open(VERSION).then((ca) => ca.put(e.request, c)); return r; })));
  }
});
