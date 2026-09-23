// Offline support: the app shell and data are cached so a battle can be tracked
// with a flaky connection. Hashed build assets are cache-first; the page and data
// files are network-first with a cached fallback. The official ladder data is left
// alone: src/data/official.ts keeps its own copy of the latest snapshot (v1 kept
// every day's snapshot here, forever; changing the name clears it). So is the voice
// model, downloaded only if voice is turned on (its own cache, voice-model-v1).
const CACHE = 'battle-analyzer-v2';
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
  if (url.hostname === 'championsbattledata.com' || (sameOrigin && url.pathname.includes('/official/'))) return;
  // The voice model keeps its own copy (src/speech/store.ts): 150 MB isn't stored twice.
  if (sameOrigin && url.pathname.includes('/voice/')) return;
  if (sameOrigin && url.pathname.includes('/assets/')) return event.respondWith(cacheFirst(request));
  if (url.hostname === 'play.pokemonshowdown.com') return event.respondWith(cacheFirst(request));
  if (sameOrigin) return event.respondWith(networkFirst(request));
});
