/**
 * What each species can learn (public/data/learnsets.json, from scripts/build-data.mjs), for checking
 * what the voice reader heard. Fetched the first time it's needed.
 */
import {toID} from './dex';

export type Learns = (species: string, move: string) => boolean;

interface Table {
  moves: string[];
  species: Record<string, number[]>;
}

const base = import.meta.env?.BASE_URL ?? '/';
let loading: Promise<Learns | null> | null = null;

/** Whether a species can learn a move; null if the table couldn't be had (then it isn't checked). */
export function loadLearnsets(): Promise<Learns | null> {
  loading ??= fetch(`${base}data/learnsets.json`)
    .then(r => (r.ok ? (r.json() as Promise<Table>) : null))
    .then(t => {
      if (!t) return null;
      const index = new Map(t.moves.map((m, i) => [m, i]));
      const sets = new Map(Object.entries(t.species).map(([k, v]) => [k, new Set(v)]));
      return (species: string, move: string) => {
        const i = index.get(toID(move));
        return i !== undefined && !!sets.get(toID(species))?.has(i);
      };
    })
    .catch(() => null);
  return loading;
}
