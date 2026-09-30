// Service worker: caches the app shell so the drill opens instantly (and
// offline, from the last sync), and turns Web Push messages from the Mac
// into native notifications.
'use strict';
// Bumped to v2 for the recall-practice release: learn.js joined the shell,
// and a shell that is missing one of its scripts fails to launch offline.
const CACHE = 'mandarin-v2';
const SHELL = ['./', './index.html', './srs.js', './learn.js', './config.json',
               './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))
              .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // Drop superseded shell caches only. Nothing here may touch localStorage,
  // the learn.* log, its outbox, or any progress export -- a cache cleanup
  // that deleted learning records would be the worst possible bug in an
  // update path.
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
        .filter(n => n.startsWith('mandarin-') && n !== CACHE)
        .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Network-first for the shell so updates land, cache as fallback for offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;      // GitHub API goes straight out
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Mandarin', {
    body: data.body || '',
    icon: './icon-180.png',
    badge: './icon-180.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(e.notification.data.url || './');
  }));
});
