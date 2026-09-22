import {afterEach, describe, expect, it, vi} from 'vitest';
import {onRequestGet, type Context} from '../../functions/official/[[path]]';
import {loadOfficial} from './official';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

/** Cloudflare's edge cache, as a map. */
function edgeCache() {
  const saved = new Map<string, Response>();
  vi.stubGlobal('caches', {
    default: {
      match: async (r: Request) => saved.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void saved.set(r.url, res),
    },
  });
  return saved;
}

function call(path: string[], query = '') {
  const waits: Promise<unknown>[] = [];
  const context: Context = {
    request: new Request(`https://analyzer.example/official/${path.join('/')}${query}`),
    params: {path},
    waitUntil: p => void waits.push(p),
  };
  return onRequestGet(context).then(async res => {
    await Promise.all(waits);
    return res;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('the Battle Data function (Cloudflare Pages)', () => {
  it('only forwards the index and dated snapshots', async () => {
    edgeCache();
    const upstream = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', upstream);
    for (const path of [['..', 'secret.json'], ['admin'], ['M6', '22_09_2026', 'Doubles.json', 'x'], ['M6', 'latest', 'Doubles.json']]) {
      expect((await call(path)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fetches once, then serves from the edge cache', async () => {
    const saved = edgeCache();
    const upstream = vi.fn(async () => json({seasons: []}));
    vi.stubGlobal('fetch', upstream);
    const first = await call(['index.json'], '?bust=1');
    expect(first.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await first.json()).toEqual({seasons: []});
    expect(upstream).toHaveBeenCalledWith('https://championsbattledata.com/data/meta/index.json', expect.anything());
    // The query string doesn't make another copy.
    expect([...saved.keys()]).toEqual(['https://analyzer.example/official/index.json']);
    const again = await call(['index.json'], '?bust=2');
    expect(await again.json()).toEqual({seasons: []});
    expect(upstream).toHaveBeenCalledTimes(1);
    const snap = await call(['M6', '22_09_2026', 'Doubles.json']);
    expect(snap.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it("doesn't cache failures", async () => {
    const saved = edgeCache();
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    expect((await call(['index.json'])).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down');
    }));
    expect((await call(['index.json'])).status).toBe(502);
    expect(saved.size).toBe(0);
  });
});

describe('loading the Battle Data', () => {
  const index = {seasons: [{season: 'M6', dates: ['22_09_2026'], formats: ['Doubles', 'Singles']}]};
  const snapshot = {season: 'M6', date: '22_09_2026', format: 'Doubles', pokemon: {}};

  it('goes through the site first', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      return json(url.endsWith('index.json') ? index : snapshot);
    }));
    expect(await loadOfficial('Doubles', {force: true})).toEqual(snapshot);
    expect(seen).toEqual(['/official/index.json', '/official/M6/22_09_2026/Doubles.json']);
  });

  it('falls back to the fan site where the host has no function (its HTML page, or a 404)', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      if (url.startsWith('/official/index')) return new Response('<!doctype html>', {headers: {'content-type': 'text/html'}});
      if (url.startsWith('/official/')) return new Response('Not found', {status: 404});
      return json(url.endsWith('index.json') ? index : snapshot);
    }));
    expect(await loadOfficial('Doubles', {force: true})).toEqual(snapshot);
    expect(seen).toEqual([
      '/official/index.json', 'https://championsbattledata.com/data/meta/index.json',
      '/official/M6/22_09_2026/Doubles.json', 'https://championsbattledata.com/data/meta/M6/22_09_2026/Doubles.json',
    ]);
  });
});
