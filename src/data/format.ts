import type {GenerationNum} from './dex';

/** [name, probability] */
export type Dist = [string, number][];

/** One compiled usage-stats entry (see scripts/build-data.mjs). */
export interface SpeciesStats {
  usage: number;
  /** Weighted sample size; used to weigh formes that share a preview. */
  weight: number;
  abilities: Dist;
  items: Dist;
  itemsOther: number;
  /** P(move is in the set); sums to ~4. */
  moves: Dist;
  /** [nature, evs (hp..spe), probability] for the most common spreads. */
  spreads: [string, number[], number][];
  spreadsCovered: number;
  /** Per stat: [ev, probability] over all spreads, for modelling the tail. */
  statMarginals: [number, number][][];
  natures: Dist;
  /** P(teammate on the team | this Pokémon on the team). */
  teammates: Dist;
  tera?: Dist;
}

export interface FormatInfo {
  id: string;
  name: string;
  gen: GenerationNum;
  gameType: 'singles' | 'doubles';
  level: number;
  itemClause: boolean;
  bring: number;
  month: string;
  cutoff: number;
  battles: number;
}

export interface FormatData extends FormatInfo {
  species: Record<string, SpeciesStats>;
  /** Team-preview name -> formes that appear under it (e.g. Charizard -> Mega Y, Mega X, base). */
  preview: Record<string, string[]>;
  previewUsage: Record<string, number>;
}

const base = import.meta.env?.BASE_URL ?? '/';
const cache = new Map<string, Promise<FormatData>>();
let indexPromise: Promise<FormatInfo[]> | undefined;

export function loadFormatIndex(): Promise<FormatInfo[]> {
  indexPromise ||= fetch(`${base}data/formats.json`)
    .then(r => {
      if (!r.ok) throw new Error(`formats.json: HTTP ${r.status}`);
      return r.json();
    })
    .then(j => j.formats as FormatInfo[]);
  return indexPromise;
}

export function loadFormat(id: string): Promise<FormatData> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(`${base}data/${id}.json`).then(r => {
      if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
      return r.json() as Promise<FormatData>;
    });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Preview names sorted by usage, for autocomplete. */
export function previewNamesByUsage(fmt: FormatData): string[] {
  return Object.keys(fmt.preview).sort((a, b) => (fmt.previewUsage[b] ?? 0) - (fmt.previewUsage[a] ?? 0));
}
