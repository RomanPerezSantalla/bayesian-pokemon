import {Generations, calcStat, toID, type GenerationNum} from '@smogon/calc';

export {toID};
export type {GenerationNum};
export type Gen = ReturnType<typeof Generations.get>;

export const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export type StatID = (typeof STAT_IDS)[number];
export type BoostID = Exclude<StatID, 'hp'>;
export const STAT_LABELS: Record<StatID, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
};

const gens = new Map<number, Gen>();
export function getGen(num: GenerationNum): Gen {
  let gen = gens.get(num);
  if (!gen) {
    gen = Generations.get(num);
    if (num === 0) completeChampionsMoves(gen);
    gens.set(num, gen);
  }
  return gen;
}

/**
 * @smogon/calc 0.12's Champions data has 86 moves with no category. The 75 status moves among them
 * are fine (a move with no category and no power is a status move here), but the 11 attacking ones
 * have no type, contact or hit count either, so the calc deals 0 with them: Metal Claw, and ten no
 * Pokémon in Champions can learn (Anchor Shot, Bolt Beak, Triple Dive…) that are in its list all
 * the same. They're filled in from the calc's own gen 9 data, which has them whole, keeping
 * Champions' changes (Anchor Shot's 90 power).
 */
function completeChampionsMoves(gen: Gen) {
  const sv = Generations.get(9);
  for (const m of gen.moves) {
    if (m.type) continue;
    const full = sv.moves.get(m.id);
    if (!full) continue;
    const rec = m as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(full)) if (rec[k] === undefined) rec[k] = structuredClone(v);
    rec.flags = {...full.flags, ...m.flags};
  }
}

/** Champions (gen 0 in @smogon/calc) uses Stat Points instead of EVs. */
export const usesStatPoints = (gen: Gen) => gen.num === 0;
export const evCap = (gen: Gen) => (usesStatPoints(gen) ? 32 : 252);
export const evBudget = (gen: Gen) => (usesStatPoints(gen) ? 66 : 510);

export function species(gen: Gen, name: string) {
  return gen.species.get(toID(name));
}

export function move(gen: Gen, name: string) {
  return gen.moves.get(toID(name));
}

export function isStatusMove(gen: Gen, name: string) {
  const m = move(gen, name);
  if (!m) return false;
  return m.category === 'Status' || (!m.category && !m.basePower);
}

export function isDamagingMove(gen: Gen, name: string) {
  const m = move(gen, name);
  return !!m && !isStatusMove(gen, name);
}

export function isSpreadMove(gen: Gen, name: string) {
  const t = move(gen, name)?.target;
  return t === 'allAdjacentFoes' || t === 'allAdjacent';
}

export function natureMods(gen: Gen, nature: string): [StatID | undefined, StatID | undefined] {
  const n = gen.natures.get(toID(nature));
  if (!n || n.plus === n.minus) return [undefined, undefined];
  return [n.plus as StatID, n.minus as StatID];
}

/** Final (unboosted) stats for a species with a nature and EVs / Stat Points. */
export function computeStats(
  gen: Gen,
  speciesName: string,
  nature: string,
  evs: ArrayLike<number>,
  level: number,
  ivs?: ArrayLike<number>,
): number[] {
  const sp = species(gen, speciesName);
  if (!sp) return [0, 0, 0, 0, 0, 0];
  return STAT_IDS.map((stat, i) =>
    calcStat(gen, stat, sp.baseStats[stat], ivs ? ivs[i] : 31, evs[i], level, nature),
  );
}

let sortedCache = new Map<string, string[]>();
function sortedNames(gen: Gen, kind: 'species' | 'moves' | 'items' | 'abilities'): string[] {
  const key = `${gen.num}:${kind}`;
  let names = sortedCache.get(key);
  if (!names) {
    names = [];
    for (const rec of gen[kind] as Iterable<{name: string}>) names.push(rec.name);
    names.sort();
    sortedCache.set(key, names);
  }
  return names;
}
export const allSpecies = (gen: Gen) => sortedNames(gen, 'species');
export const allMoves = (gen: Gen) => sortedNames(gen, 'moves');
export const allItems = (gen: Gen) => sortedNames(gen, 'items');
export const allAbilities = (gen: Gen) => sortedNames(gen, 'abilities');

export const NATURES = [
  'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle', 'Hardy', 'Hasty', 'Impish', 'Jolly',
  'Lax', 'Lonely', 'Mild', 'Modest', 'Naive', 'Naughty', 'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
];

export const TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy', 'Stellar',
];

/** Showdown sprite URL (hotlinked, with graceful fallback in the UI). */
export function spriteUrl(gen: Gen, speciesName: string) {
  const sp = species(gen, speciesName);
  const name = sp?.name ?? speciesName;
  const base = sp?.baseSpecies;
  const id = base && name.startsWith(`${base}-`)
    ? `${toID(base)}-${toID(name.slice(base.length + 1))}`
    : toID(name);
  return `https://play.pokemonshowdown.com/sprites/gen5/${id}.png`;
}
