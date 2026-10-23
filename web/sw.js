// The service worker: makes the app installable ("Add to home screen") and quick to reopen.
//   - The app itself (HTML, JS, CSS, runtime-config.js): network first, revalidated every time so a
//     new deploy shows up at once; the cached copy is used only when the network fails.
//   - Timetable files in dated build folders (data/<YYYYMMDD_HHMMSS>/…) never change: cache first.
//     Only the two newest builds are kept.
//   - MapLibre and three.js from unpkg are pinned to exact versions, and Google's font files never
//     change at a given address: cache first.
//   - Everything else goes straight to the network and is never cached: the live API, map tiles,
//     radar and weather.
const SHELL = 'bt3d-shell-v1';
const DATA = 'bt3d-data-v1';
const LIBS = 'bt3d-libs-v1';
const BUILD = /\/data\/(\d{8}_\d{6})\//;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, LIBS]);
    for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/api/')) return; // the dev server's live API
    if (BUILD.test(url.pathname)) event.respondWith(cacheFirst(request, DATA, pruneBuilds));
    else event.respondWith(networkFirst(request));
  } else if (url.hostname === 'unpkg.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, LIBS));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' }));
    if (response.ok) await cache.put(stripSearch(request), response.clone());
    return response;
  } catch (err) {
    // Offline: the cached copy, ignoring the query string (deep links like ?stop=0210 share index.html).
    const cached = await cache.match(stripSearch(request)) ?? (request.mode === 'navigate' ? await cache.match(new URL('./', self.location).href) : null);
    if (cached) return cached;
    throw err;
  }
}

// Pages (and runtime-config.js?v=…) are cached under their address without the query string.
const stripSearch = request => {
  const url = new URL(request.url);
  url.search = '';
  return url.href;
};

async function cacheFirst(request, name, afterPut = null) {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (afterPut) afterPut(cache);
  }
  return response;
}

// Keeps the files of the two newest timetable builds and drops older ones.
async function pruneBuilds(cache) {
  const requests = await cache.keys();
  const builds = [...new Set(requests.map(r => r.url.match(BUILD)?.[1]).filter(Boolean))].sort();
  const keep = new Set(builds.slice(-2));
  for (const r of requests) {
    if (!keep.has(r.url.match(BUILD)?.[1])) await cache.delete(r);
  }
}
