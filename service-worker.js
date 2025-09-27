// service-worker.js

/**
 * CardCue service worker - provides offline caching for core pages, assets, and icons.
 * Strategy:
 * - HTML navigations: network-first to pick up fresh releases.
 * - Same-origin static assets: stale-while-revalidate for fast responses with background refresh.
 * Versioning:
 * - The cache name is derived from APP_VERSION in version.js to keep SW + app in sync.
 */

// Pull the shared version constant into the SW scope.
// Make sure version.js sits next to this file (or adjust the path).
importScripts('version.js'); // defines self.APP_VERSION, e.g. '1.1.0-alpha'

const VERSION = (self.APP_VERSION || 'v0');
const CACHE = `cardcue-${VERSION}`;

/**
 * Lists of assets to pre-cache during install.
 * Use relative paths to ensure same-origin matching regardless of hosting path.
 */
const PAGES = [
  './', 'study.html', 'metrics.html', 'editor.html', 'manifest.json'
];
const ASSETS = [
  'styles.css', 'app.js', 'shell.js', 'config.js', 'version.js' // include version file too
];
const ICONS = [
  'icons/icon-192x192.png', 'icons/icon-512x512.png',
  'icons/icon-192x192-maskable.png', 'icons/icon-512x512-maskable.png',
  'icons/favicon-16x16.png', 'icons/favicon-32x32.png', 'icons/favicon.ico'
];

/**
 * Handles the install event.
 * Pre-caches core pages and assets, then activates the new worker immediately.
 *
 * @param {ExtendableEvent} e - Service worker install event.
 * @returns {void}
 */
function handleInstall(e) {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([...PAGES, ...ASSETS, ...ICONS]))
  );
  self.skipWaiting();
}

/**
 * Handles the activate event.
 * Removes old versioned caches and takes control of open clients.
 *
 * @param {ExtendableEvent} e - Service worker activate event.
 * @returns {void}
 */
function handleActivate(e) {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
}

/**
 * Fetches from the network first, updates the cache on success, and
 * falls back to the cache if offline. For navigation requests, falls back
 * to the study page when no cached response exists.
 *
 * @param {Request} req - The original request.
 * @returns {Promise<Response>} A network or cached response.
 */
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

/**
 * Responds with a cached result when available while revalidating in the background.
 * If no cached result is available, resolves with the network response if possible.
 *
 * @param {Request} req - The original request.
 * @returns {Promise<Response>} A cached response or a network response.
 */
async function staleWhileRevalidate(req) {
  const c = await caches.open(CACHE);
  const cached = await c.match(req, { ignoreSearch: true });
  const fetched = fetch(req).then(res => {
    c.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetched;
}

/**
 * Handles fetch events.
 * - Navigations: network-first.
 * - Same-origin static assets (css, js, images, icons, json, svg): stale-while-revalidate.
 * - Everything else: default browser handling.
 *
 * @param {FetchEvent} e - Service worker fetch event.
 * @returns {void}
 */

function handleFetch(e) {
  const { request } = e;
  const url = new URL(request.url);

  // 1) Navigations: network-first
  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request));
    return;
  }

  // 2) Same-origin static: SWR
  if (url.origin === location.origin &&
      /\.(?:css|js|png|ico|svg|json)$/.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 3) CDN libs (MathJax + SheetJS) — SWR runtime cache
  if (/^https:\/\/cdn\.jsdelivr\.net\/npm\/(mathjax@3|xlsx@0\.18\.5)\//.test(url.href)) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }
}

self.addEventListener('install', handleInstall);
self.addEventListener('activate', handleActivate);
self.addEventListener('fetch', handleFetch);
