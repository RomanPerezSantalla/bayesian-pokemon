/**
 * Cloudflare Pages Function at /official/*: the in-game Battle Data from championsbattledata.com
 * (a one-person fan project), cached at Cloudflare's edge. The app asks here first, so the fan site
 * gets about one request per Cloudflare location per hour instead of one per visitor, and a hiccup
 * there doesn't reach anyone. Only runs on Cloudflare Pages; on any other host the app goes to the
 * fan site directly (src/data/official.ts).
 */

const UPSTREAM = 'https://championsbattledata.com/data/meta/';
/** The index gains a date every day; a dated snapshot never changes. */
const INDEX_TTL = 60 * 60;
const SNAPSHOT_TTL = 24 * 60 * 60;
/** index.json, or season/date/format (M6/22_09_2026/Doubles.json): nothing else goes upstream. */
const PATHS = /^(?:index\.json|[A-Za-z0-9_-]{1,32}\/\d{2}_\d{2}_\d{4}\/(?:Doubles|Singles)\.json)$/;

export interface Context {
  request: Request;
  params: {path?: string | string[]};
  waitUntil(promise: Promise<unknown>): void;
}

const fail = (status: number, text: string) => new Response(text, {status, headers: {'cache-control': 'no-store'}});

export async function onRequestGet(context: Context): Promise<Response> {
  const path = ([] as string[]).concat(context.params.path ?? []).join('/');
  if (!PATHS.test(path)) return fail(404, 'Not found');
  // Keyed without the query string, so nothing can multiply the copies.
  const key = new Request(`${new URL(context.request.url).origin}/official/${path}`);
  const cache = (caches as unknown as {default: Cache}).default;
  const hit = await cache.match(key);
  if (hit) return hit;
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM + path, {headers: {accept: 'application/json'}});
  } catch {
    return fail(502, 'Battle Data unreachable');
  }
  if (!upstream.ok) return fail(502, `Battle Data unavailable (HTTP ${upstream.status})`);
  const ttl = path === 'index.json' ? INDEX_TTL : SNAPSHOT_TTL;
  const res = new Response(upstream.body, {
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}`},
  });
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}
