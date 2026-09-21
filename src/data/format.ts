import type {GenerationNum} from './dex';
import {fuse, type Structure} from './fuse';
import {loadOfficial, type OfficialFormat} from './official';

/** [name, probability] */
export type Dist = [string, number][];

/** Usage distribution for one forme (see scripts/build-data.mjs and fuse.ts). */
export interface SpeciesStats {
  usage: number;
  /** Relative weight; used to weigh formes that share a preview. */
  weight: number;
  abilities: Dist;
  items: Dist;
  itemsOther: number;
  /** P(move is in the set); sums to ~4. */
  moves: Dist;
  /** [alignment, stat points (hp..spe), probability] for the most common spreads. */
  spreads: [string, number[], number][];
  spreadsCovered: number;
  /** Per stat: [points, probability], for modelling the tail. */
  statMarginals: [number, number][][];
  natures: Dist;
  /** P(teammate on the team | this Pokémon on the team). */
  teammates: Dist;
  tera?: Dist;
}

export interface FormatInfo {
  id: string;
  name: string;
  official: OfficialFormat;
  gen: GenerationNum;
  gameType: 'singles' | 'doubles';
  level: number;
  itemClause: boolean;
  /** Pokémon brought from the six shown at team preview. */
  bring: number;
  structure: {smogonId: string; month: string; cutoff: number; battles: number};
}

export interface FormatData extends FormatInfo {
  species: Record<string, SpeciesStats>;
  /** Team-preview name -> formes that appear under it (e.g. Charizard -> Mega Y, Mega X, base). */
  preview: Record<string, string[]>;
  previewUsage: Record<string, number>;
  sources: {
    official: {season: string; date: string} | null;
    structure: FormatInfo['structure'];
  };
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
    p = (async () => {
      const info = (await loadFormatIndex()).find(f => f.id === id);
      if (!info) throw new Error(`Unknown format ${id}`);
      const [structure, official] = await Promise.all([
        fetch(`${base}data/structure-${info.gameType}.json`).then(r => {
          if (!r.ok) throw new Error(`structure data: HTTP ${r.status}`);
          return r.json() as Promise<Structure>;
        }),
        loadOfficial(info.official),
      ]);
      return fuse(info, structure, official);
    })();
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Preview names sorted by usage, for pickers. */
export function previewNamesByUsage(fmt: FormatData): string[] {
  return Object.keys(fmt.preview).sort((a, b) => (fmt.previewUsage[b] ?? 0) - (fmt.previewUsage[a] ?? 0));
}
