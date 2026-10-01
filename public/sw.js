// Offline support: the app shell and data are cached so a battle can be tracked
// with a flaky connection. Hashed build assets are cache-first; the page and data
// files are network-first with a cached fallback. The official ladder data is left
// alone: src/data/official.ts keeps its own copy of the latest snapshot (v1 kept
// every day's snapshot here, forever; changing the name clears it). So is the voice
// model, downloaded only if voice is turned on (its own cache, voice-model-v1), and
// anything under /llm/ (the language model's test page and files: hundreds of MB).
// v3: the page is cross-origin isolated now ("credentialless"), which won't take the
// sprites v2 kept, fetched with cookies; they're fetched again without.
const CACHE = 'battle-analyzer-v3';
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

/** `credentialless`: fetched without cookies (the Showdown sprites), as the isolated page asks for them. */
async function cacheFirst(request, credentialless = false) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const res = await (credentialless ? fetch(request.url, {mode: 'no-cors', credentials: 'omit'}) : fetch(request));
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
  if (sameOrigin && (url.pathname.includes('/voice/') || url.pathname.includes('/llm/'))) return;
  if (sameOrigin && url.pathname.includes('/assets/')) return event.respondWith(cacheFirst(request));
  if (url.hostname === 'play.pokemonshowdown.com') return event.respondWith(cacheFirst(request, true));
  if (sameOrigin) return event.respondWith(networkFirst(request));
});
