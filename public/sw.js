// Offline support: the app shell and data are cached so a battle can be tracked
// with a flaky connection. Hashed build assets are cache-first; the page, data
// files and the official ladder snapshot are network-first with a cached fallback.
const CACHE = 'battle-analyzer-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './data/formats.json',
  './data/structure-doubles.json', './data/structure-singles.json', './icons/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key.startsWith('battle-analyzer-')) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, {ignoreSearch: true});
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && url.pathname.includes('/assets/')) return event.respondWith(cacheFirst(request));
  if (url.hostname === 'play.pokemonshowdown.com') return event.respondWith(cacheFirst(request));
  if (sameOrigin || url.hostname === 'championsbattledata.com') return event.respondWith(networkFirst(request));
});
