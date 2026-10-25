// Service Worker: Push-Nachrichten empfangen und die App-Hülle für schnellen Start zwischenspeichern
const CACHE = 'kb-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'lib.js', 'chart.js', 'manifest.webmanifest', 'icons/icon-192.png', 'vendor/supabase.js',
  'fonts/barlow-400.woff2', 'fonts/barlow-500.woff2', 'fonts/barlow-600.woff2', 'fonts/barlow-sc-500.woff2', 'fonts/barlow-sc-600.woff2', 'fonts/barlow-sc-700.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Eigene Dateien: erst Netz, bei Ausfall Zwischenspeicher. Datenbank-Anfragen werden nie zwischengespeichert.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Kaufberater', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kaufberater', {
    body: d.body || '', tag: d.tag, renotify: d.level === 'instant', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: { url: d.url || './', shopUrl: d.shopUrl },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
