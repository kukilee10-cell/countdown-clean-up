/* Rotation — offline service worker
   Caches the app shell so the app opens without a connection after first load.
   Strategy:
     - HTML navigations: network-first, fall back to cached index.html
     - Same-origin static assets (css/js/img/manifest/icons): stale-while-revalidate
     - Google Fonts (css + font files): cache-first with background refresh
     - Everything else (Spotify deep links, external APIs): passthrough
*/
const VERSION = 'rotation-offline-v1';
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const FONT_CACHE  = `fonts-${VERSION}`;

const SHELL_URLS = [
  './',
  './index.html',
  './styles.css?v=rotation-travel-qol-2026-07-17a',
  './app.js?v=rotation-travel-qol-2026-07-17a',
  './manifest.json',
  './favicon.ico',
  './favicon-16.png',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Use no-cache so we always grab fresh copies on install
      Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => ![SHELL_CACHE, ASSET_CACHE, FONT_CACHE].includes(n))
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isHTMLRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isFontRequest(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

async function networkFirstHTML(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put('./index.html', fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match('./index.html') || await cache.match('./');
    if (cached) return cached;
    return new Response('<h1>Offline</h1>', { headers: { 'content-type': 'text/html' } });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // HTML navigations
  if (isHTMLRequest(request)) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  // Google Fonts
  if (isFontRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // Same-origin static assets
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }

  // Everything else: passthrough (Spotify links etc.)
});