/* GOGO Fleet service worker
 *  - makes the app installable and gives it an offline shell
 *  - lets the app show notifications (reg.showNotification) — previously these never fired
 *    because no service worker was registered
 *  - NEVER caches API, Supabase, Stripe or any cross-origin request
 *
 * NOTE: server-sent push (notifications while the app is closed) additionally needs VAPID keys,
 * a push_subscriptions table and a sender function. The 'push' handler below is ready for that.
 */
const VERSION = 'gogo-v1';
const STATIC = ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // leave everything else alone

  // Pages: network first so owners always get the latest app; fall back to cache when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // Icons / manifest: cache first, refresh in the background.
  if (STATIC.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const refresh = fetch(req).then((res) => {
          caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        });
        return hit || refresh;
      })
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'GOGO Fleet', body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'GOGO Fleet', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/app.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.includes('/app'));
      return open ? open.focus() : self.clients.openWindow(target);
    })
  );
});
