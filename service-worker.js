// service-worker.js

/**
 * CardCue service worker - provides offline caching for core pages, assets, and icons.
 * Strategies:
 * - Navigations: network-first (fresh releases take effect), fallback to study.html.
 * - Same-origin static assets: stale-while-revalidate.
 * - Selected CDN libs: stale-while-revalidate runtime cache.
 *
 * Versioning:
 * - Cache name includes APP_VERSION from version.js.
 * - Uses skipWaiting + clients.claim + a one-time page reload (wired in shell.js).
 */

// Pull shared version into SW scope (place version.js next to this file).
importScripts('version.js'); // defines self.APP_VERSION, e.g. '1.1.5'

const VERSION = (self.APP_VERSION || 'v0');
const CACHE = `cardcue-${VERSION}`;

/** Precache lists (relative paths so they work at "/" and "/<repo>/") */
const PAGES = [
  './', 'study.html', 'metrics.html', 'editor.html', 'manifest.json'
];
const ASSETS = [
  'styles.css', 'app.js', 'shell.js', 'config.js', 'version.js'
];
const ICONS = [
  'icons/icon-192x192.png', 'icons/icon-512x512.png',
  'icons/icon-192x192-maskable.png', 'icons/icon-512x512-maskable.png',
  'icons/favicon-16x16.png', 'icons/favicon-32x32.png', 'icons/favicon.ico'
];

/** INSTALL: precache & activate immediately */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([...PAGES, ...ASSETS, ...ICONS]))
  );
  self.skipWaiting();
});

/** ACTIVATE: clean old caches, claim clients, notify pages */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
      await self.clients.claim();
      // Tell all open pages which version just activated (shell.js listens)
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'SW_ACTIVATED', version: VERSION });
      }
    })()
  );
});

/** Networking helpers */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const c = await caches.open(CACHE);
    c.put(req, res.clone());
    return res;
  } catch (err) {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return c.match('study.html');
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(CACHE);
  const cached = await c.match(req, { ignoreSearch: true });
  const fetched = fetch(req).then(res => {
    c.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetched;
}

/** FETCH routing */
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // 1) Navigations → network-first
  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request));
    return;
  }

  // 2) Same-origin static → SWR
  if (url.origin === location.origin &&
      /\.(?:css|js|png|ico|svg|json)$/.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 3) CDN libs (MathJax + SheetJS) → SWR runtime cache
  if (/^https:\/\/cdn\.jsdelivr\.net\/npm\/(mathjax@3|xlsx@0\.18\.5)\//.test(url.href)) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Otherwise, let the request pass through
});
