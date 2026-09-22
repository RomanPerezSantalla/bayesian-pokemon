/**
 * The in-game ranked Battle Data, as mirrored daily by championsbattledata.com
 * (a fan project: https://github.com/Gheist23/pokemonbattledata). Fetched live
 * from the browser and cached, so the app keeps working offline mid-battle with
 * the last snapshot it saw. On Cloudflare Pages it comes through this site's own
 * /official/ (functions/official), cached at the edge for every visitor; on any
 * other host, or if that fails, straight from the fan site (CORS is open).
 */
export type OfficialFormat = 'Doubles' | 'Singles';

export interface OfficialEntry {
  /** Usage rank in the format. */
  position: number;
  /** [name, %, rank] */
  move: [string, number, number][];
  held_item: [string, number, number][];
  ability: [string, number, number][];
  /** [nature, %, raised stat, lowered stat, rank] */
  stat_alignment: [string, number, string, string, number][];
  /** [%, hp, atk, def, spa, spd, spe, rank] */
  stat_points: number[][];
  /** [name, rank] */
  teammate: [string, number][];
}

export interface OfficialSnapshot {
  season: string;
  date: string;
  format: OfficialFormat;
  pokemon: Record<string, OfficialEntry>;
}

const SOURCES = [`${import.meta.env?.BASE_URL ?? '/'}official`, 'https://championsbattledata.com/data/meta'];
const CACHE = 'official-battle-data';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function cacheGet(key: string): Promise<{at: number; data: OfficialSnapshot} | null> {
  try {
    if (typeof caches !== 'undefined') {
      const res = await (await caches.open(CACHE)).match(key);
      if (res) return res.json();
    }
    const raw = localStorage.getItem(`${CACHE}:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function cachePut(key: string, value: {at: number; data: OfficialSnapshot}) {
  const body = JSON.stringify(value);
  try {
    if (typeof caches !== 'undefined') {
      await (await caches.open(CACHE)).put(key, new Response(body, {headers: {'Content-Type': 'application/json'}}));
      return;
    }
    localStorage.setItem(`${CACHE}:${key}`, body);
  } catch {
    // Storage full or blocked: we just refetch next time.
  }
}

/** From the first source that answers with JSON (a host without the function may send its HTML page). */
async function getJSON<T>(path: string): Promise<T> {
  let last: unknown;
  for (const base of SOURCES) {
    try {
      const res = await fetch(`${base}/${path}`);
      if (!res.ok) throw new Error(`official data: HTTP ${res.status}`);
      if (!/json/i.test(res.headers.get('content-type') ?? '')) throw new Error('official data: not JSON');
      return (await res.json()) as T;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function fetchLatest(format: OfficialFormat): Promise<OfficialSnapshot> {
  const index = await getJSON<{seasons: {season: string; dates: string[]; formats: string[]}[]}>('index.json');
  // Seasons are listed newest first; dates within a season too.
  const season = index.seasons.find(s => s.dates.length && s.formats.includes(format));
  if (!season) throw new Error('no dated season in the official data index');
  return getJSON<OfficialSnapshot>(`${season.season}/${season.dates[0]}/${format}.json`);
}

/** Latest official snapshot, or the cached one if offline; null if never fetched. */
export async function loadOfficial(format: OfficialFormat, opts: {force?: boolean} = {}): Promise<OfficialSnapshot | null> {
  const key = `/official/${format}`;
  const cached = await cacheGet(key);
  if (cached && !opts.force && Date.now() - cached.at < MAX_AGE_MS) return cached.data;
  try {
    const data = await fetchLatest(format);
    await cachePut(key, {at: Date.now(), data});
    return data;
  } catch (err) {
    console.warn('Official battle data unavailable, using cache:', err);
    return cached?.data ?? null;
  }
}

/** "21_09_2026" -> "2026-09-21" */
export const officialDate = (d: string) => d.split('_').reverse().join('-');
