/* Service worker — build __BUILD__ */
const CACHE = 'fixed-costs';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const NAV_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(STATIC).catch(() => {});
      const res = await fetch('/', { cache: 'no-store' }).catch(() => null);
      if (res && res.ok) await cache.put('/', res);
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the build id or any API — straight to the network.
  if (url.pathname === '/version.json' || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Network first for pages; keep the last good copy of "/" for offline.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await withTimeout(fetch(req, { cache: 'no-store' }), NAV_TIMEOUT);
          if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) await cache.put('/', res.clone());
          return res;
        } catch (e) {
          const cached = await cache.match('/');
          if (cached) return cached;
          throw e;
        }
      })(),
    );
    return;
  }

  if (STATIC.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(url.pathname);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(url.pathname, res.clone());
        return res;
      }),
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ type: 'navigate', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// Ready for a push server later: show whatever it sends.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'קבועים', {
      body: data.body || '', lang: 'he', dir: 'rtl', icon: '/icons/icon-192.png', data: { url: data.url || '/' },
    }),
  );
});
