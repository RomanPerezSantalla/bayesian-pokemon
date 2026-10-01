/**
 * Builds the prior hypothesis space for one opponent Pokémon from usage stats.
 *
 * A hypothesis is (forme, spread, item, ability). Formes matter because team
 * preview only shows the base species: a "Charizard" is usually Mega Y, rarely
 * Mega X, almost never a plain Charizard. Spreads are the most common ones from
 * the stats plus sampled "tail" spreads and a few generic templates so unusual
 * builds are never assigned zero probability.
 */
import {
  computeStats, evBudget, evCap, isStatusMove, species as dexSpecies, toID, usesStatPoints, type Gen,
} from '../data/dex';
import type {FormatData, SpeciesStats} from '../data/format';
import LEGAL_ABILITIES from '../data/abilities.gen.json';
import {buildMoveModel, fitToItems, type MoveModel} from './moveset';
import {hashString, mulberry32, sampleIndex} from './rng';

export const OTHER_ITEM = '(other)';
export const NO_ITEM = '(none)';

export interface Spread {
  nature: string;
  evs: number[];
}

export interface FormeSpace {
  /** Battle forme, e.g. Charizard-Mega-Y. */
  species: string;
  /** Species before Mega Evolution, if this is a Mega forme. */
  preMega?: string;
  /** A Mega's own ability (there is exactly one per Mega), in effect once it evolves. */
  megaAbility?: string;
  prior: number;
  items: string[];
  itemP: number[];
  /** The ability it enters battle with: for a Mega forme, the pre-Mega one (the uncertain part). */
  abilities: string[];
  abilityP: number[];
  spreads: Spread[];
  spreadP: number[];
  /** 'head' from stats, 'tail' sampled from per-stat marginals, 'generic' template. */
  spreadKind: ('head' | 'tail' | 'generic')[];
  /** Per spread, stats of the battle forme. */
  stats: number[][];
  /** Per spread, stats before Mega Evolution. */
  preStats?: number[][];
  moves: MoveModel;
  tera?: [string, number][];
  fromStats: boolean;
}

export interface MonSpace {
  /** Stable identity, used to cache likelihoods computed against this space. */
  key: string;
  preview: string;
  formes: FormeSpace[];
  n: number;
  f: Uint8Array;
  s: Uint16Array;
  i: Uint8Array;
  a: Uint8Array;
  logPrior: Float64Array;
}

export interface SpaceExtras {
  items: string[];
  abilities: string[];
  moves: string[];
}

const TAIL_SAMPLES = 96;
const GENERIC_MASS = 0.02;
const MIN_TAIL_MASS = 0.04;
const MAX_ITEMS = 24;
/** A terrain seed goes off in its terrain: what sets it, by ability or by move. */
const SEEDS: Record<string, {ability: string; move: string}> = {
  'Psychic Seed': {ability: 'Psychic Surge', move: 'Psychic Terrain'},
  'Grassy Seed': {ability: 'Grassy Surge', move: 'Grassy Terrain'},
  'Electric Seed': {ability: 'Electric Surge', move: 'Electric Terrain'},
  'Misty Seed': {ability: 'Misty Surge', move: 'Misty Terrain'},
};
/** A seed with no setter of its terrain on its own team (only the opponent's terrain to go off in): this share of its usage. */
const SEED_ALONE = 0.05;
/** Most a seed gets even beside its terrain's setter. */
const SEED_MAX = 0.85;
/** At most this much for all seeds together. */
const SEEDS_MAX = 0.95;

// Generic spreads in Stat Point units; scaled to EVs for other gens.
const TEMPLATES: [number[], string[]][] = [
  [[2, 32, 0, 0, 0, 32], ['Jolly', 'Adamant']],
  [[2, 0, 0, 32, 0, 32], ['Timid', 'Modest']],
  [[32, 32, 2, 0, 0, 0], ['Adamant', 'Brave']],
  [[32, 0, 2, 32, 0, 0], ['Modest', 'Quiet']],
  [[32, 0, 32, 0, 2, 0], ['Bold', 'Impish', 'Relaxed']],
  [[32, 0, 2, 0, 32, 0], ['Calm', 'Careful', 'Sassy']],
  [[32, 16, 9, 0, 9, 0], ['Adamant', 'Careful', 'Impish']],
  [[32, 0, 9, 16, 9, 0], ['Modest', 'Calm', 'Bold']],
  [[32, 0, 16, 0, 16, 2], ['Bold', 'Calm', 'Hardy']],
];

function templateEvs(gen: Gen, sp: number[]) {
  return usesStatPoints(gen) ? sp : sp.map(v => Math.min(252, v * 8));
}

const formatItemCache = new WeakMap<FormatData, [string, number][]>();
/** Usage-weighted item distribution across the whole format: fallback for unseen species. */
function formatItemPrior(fmt: FormatData, gen: Gen): [string, number][] {
  let out = formatItemCache.get(fmt);
  if (!out) {
    const acc = new Map<string, number>();
    for (const sd of Object.values(fmt.species)) {
      for (const [item, p] of sd.items) {
        const rec = gen.items.get(toID(item));
        if (!rec?.megaStone) acc.set(item, (acc.get(item) ?? 0) + p * sd.usage);
      }
    }
    const total = [...acc.values()].reduce((a, b) => a + b, 0) || 1;
    out = [...acc.entries()].map(([k, v]) => [k, v / total] as [string, number])
      .sort((a, b) => b[1] - a[1]).slice(0, MAX_ITEMS);
    formatItemCache.set(fmt, out);
  }
  return out;
}

function normalized(list: [string, number][]): [string[], number[]] {
  const total = list.reduce((s, [, p]) => s + p, 0) || 1;
  return [list.map(([n]) => n), list.map(([, p]) => p / total)];
}

/** Makes each of `extras` possible, with at least `extraMass` (before normalizing). */
function withExtras(list: [string, number][], extras: string[], extraMass: number): [string, number][] {
  const out = list.map(([n, p]) => [n, p] as [string, number]);
  const at = new Map(out.map(([n], i) => [toID(n), i]));
  for (const e of extras) {
    const i = at.get(toID(e));
    if (i === undefined) {
      at.set(toID(e), out.length);
      out.push([e, extraMass]);
    } else if (out[i][1] < extraMass) {
      out[i][1] = extraMass;
    }
  }
  return out;
}

function sampleTail(gen: Gen, sd: SpeciesStats, seed: string, count: number): Spread[] {
  const rng = mulberry32(hashString(seed));
  const cap = evCap(gen);
  const budget = evBudget(gen);
  const natW = sd.natures.map(([, p]) => p);
  const natT = natW.reduce((a, b) => a + b, 0);
  const statW = sd.statMarginals.map(m => m.map(([, p]) => p));
  const statT = statW.map(w => w.reduce((a, b) => a + b, 0));
  const out: Spread[] = [];
  for (let tries = 0; out.length < count && tries < count * 30; tries++) {
    if (!natT || statT.some(t => !t)) break;
    const nature = sd.natures[sampleIndex(natW, natT, rng())][0];
    const evs = sd.statMarginals.map((m, i) => Math.min(cap, m[sampleIndex(statW[i], statT[i], rng())][0]));
    let left = budget - evs.reduce((a, b) => a + b, 0);
    if (left < 0) continue;
    // Real spreads spend the whole budget: leftover goes to HP, then to what's already invested.
    const order = [0, 1, 2, 3, 4, 5].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : evs[b] - evs[a]));
    for (const i of order) {
      if (left <= 0) break;
      const add = Math.min(cap - evs[i], left);
      evs[i] += add;
      left -= add;
    }
    out.push({nature, evs});
  }
  return out;
}

function buildSpreads(gen: Gen, sd: SpeciesStats | undefined, seed: string) {
  const spreads: Spread[] = [];
  const probs: number[] = [];
  const kinds: FormeSpace['spreadKind'] = [];
  const index = new Map<string, number>();
  const add = (s: Spread, p: number, kind: 'head' | 'tail' | 'generic') => {
    const key = `${s.nature}:${s.evs.join('/')}`;
    const at = index.get(key);
    if (at !== undefined) {
      probs[at] += p;
      return;
    }
    index.set(key, spreads.length);
    spreads.push(s);
    probs.push(p);
    kinds.push(kind);
  };

  const generic: Spread[] = [];
  for (const [sp, natures] of TEMPLATES) for (const nature of natures) generic.push({nature, evs: templateEvs(gen, sp)});

  if (!sd || !sd.spreads.length) {
    for (const s of generic) add(s, 1 / generic.length, 'generic');
    return {spreads, probs, kinds};
  }
  const covered = Math.min(sd.spreadsCovered, 1);
  const tailMass = Math.max(1 - covered, MIN_TAIL_MASS);
  const headMass = 1 - tailMass - GENERIC_MASS;
  for (const [nature, evs, p] of sd.spreads) add({nature, evs}, (p / covered) * headMass, 'head');
  const tail = sampleTail(gen, sd, seed, TAIL_SAMPLES);
  for (const s of tail) add(s, tailMass / tail.length, 'tail');
  for (const s of generic) add(s, GENERIC_MASS / generic.length, 'generic');
  return {spreads, probs, kinds};
}

/**
 * How likely each forme is: its share of the species as the in-game data has it (the Mega Stones
 * held). Not tilted by teammates: only Showdown splits teammates by forme, and Showdown players,
 * whose teams cost nothing to build, experiment far more than the Switch ladder does.
 */
function formePriors(fmt: FormatData, formes: string[]): number[] {
  const w = formes.map(f => fmt.species[f]?.weight ?? 1);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  return w.map(x => x / total);
}

/** How likely a Pokémon (by preview name, over its formes) is to set the terrain a seed needs. */
function setsTerrain(fmt: FormatData, name: string, seed: string): number {
  const {ability, move} = SEEDS[seed];
  let total = 0;
  let weights = 0;
  for (const f of fmt.preview[name] ?? [name]) {
    const sd = fmt.species[f];
    if (!sd) continue;
    const pa = sd.abilities.find(([a]) => a === ability)?.[1] ?? 0;
    const pm = sd.moves.find(([m]) => m === move)?.[1] ?? 0;
    total += sd.weight * Math.min(1, pa + pm);
    weights += sd.weight;
  }
  return weights ? total / weights : 0;
}

/**
 * A terrain seed is worth holding only with that terrain's setter on the team: Sneasler's Psychic
 * Seed goes with an Indeedee, its Grassy Seed with a Rillaboom. The usage stats mix teams that have a
 * setter with teams that don't; how often its team has one (q) comes from its usual partners. With a
 * setter on this team the seed is as likely as among the teams that have one (its usage over q, as
 * far as SEED_MAX); without one, next to never. The other items share what's left as usual.
 */
function seedsForTeam(fmt: FormatData, forme: string, preview: string, teammates: string[], list: [string, number][]): [string, number][] {
  if (!list.some(([n]) => SEEDS[n])) return list;
  const [names, probs] = normalized(list);
  const sd = fmt.species[forme];
  const partners = sd?.partners?.length ? sd.partners : sd?.teammates ?? [];
  const seeds = new Map<string, number>();
  names.forEach((seed, k) => {
    if (!SEEDS[seed]) return;
    const m = probs[k];
    const self = setsTerrain(fmt, preview, seed);
    let usual = 1 - self;
    for (const [t, p] of partners) usual *= 1 - p * setsTerrain(fmt, t, seed);
    const q = Math.max(1 - usual, m / SEED_MAX, 0.02);
    let here = 1 - self;
    for (const t of teammates) here *= 1 - setsTerrain(fmt, t, seed);
    const withSetter = Math.min(SEED_MAX, (m * (1 - SEED_ALONE * (1 - q))) / q);
    seeds.set(seed, (1 - here) * withSetter + here * SEED_ALONE * m);
  });
  const total = [...seeds.values()].reduce((a, b) => a + b, 0);
  const scale = total > SEEDS_MAX ? SEEDS_MAX / total : 1;
  const rest = names.reduce((s, n, k) => s + (SEEDS[n] ? 0 : probs[k]), 0);
  const restScale = rest > 0 ? (1 - total * scale) / rest : 0;
  return names.map((n, k) => [n, SEEDS[n] ? seeds.get(n)! * scale : probs[k] * restScale]);
}

const spaceCache = new Map<string, MonSpace>();

export function buildMonSpace(
  fmt: FormatData,
  gen: Gen,
  preview: string,
  teammates: string[],
  extras: SpaceExtras,
): MonSpace {
  const key = JSON.stringify([fmt.id, fmt.sources.official?.date, fmt.sources.structure.month, preview, [...teammates].sort(), extras]);
  const hit = spaceCache.get(key);
  if (hit) return hit;

  const formeNames = fmt.preview[preview] ?? [preview];
  const priors = formePriors(fmt, formeNames);
  const formes: FormeSpace[] = [];

  formeNames.forEach((name, idx) => {
    const dex = dexSpecies(gen, name);
    if (!dex) return;
    const sd = fmt.species[name];
    const isMega = /-Mega/.test(dex.name) && !!dex.baseSpecies;
    const preMega = isMega ? dex.baseSpecies : undefined;

    const rawItems = sd ? sd.items.slice(0, MAX_ITEMS) : formatItemPrior(fmt, gen);
    let itemList: [string, number][] = rawItems.slice();
    if (!isMega) {
      const other = sd ? sd.itemsOther : 0.1;
      if (other > 0.002) itemList.push([OTHER_ITEM, other]);
      itemList = seedsForTeam(fmt, name, preview, teammates, itemList);
      itemList = withExtras(itemList, extras.items, Math.max(0.01, other));
    }
    const [items, itemP] = normalized(itemList);

    // The uncertain ability is the one it enters with (pre-Mega for a Mega forme); a Mega's
    // own ability is fixed. Every legal entry ability stays possible at a small floor, so a
    // surprise ability banner is evidence rather than a contradiction.
    const megaAbility = isMega ? (Object.values(dex.abilities ?? {})[0] as string | undefined) : undefined;
    const entrySpecies = preMega ?? dex.name;
    const legal = (LEGAL_ABILITIES as Record<string, string[]>)[toID(entrySpecies)]
      ?? (Object.values(dexSpecies(gen, entrySpecies)?.abilities ?? {}) as string[]);
    const isLegal = (a: string) => !legal.length || legal.includes(a);
    let abilityList: [string, number][] = (sd?.abilities ?? []).filter(([a]) => a !== megaAbility && isLegal(a));
    if (!abilityList.length && preMega) abilityList = (fmt.species[preMega]?.abilities ?? []).filter(([a]) => isLegal(a));
    if (!abilityList.length) abilityList = legal.map(a => [a, 1] as [string, number]);
    abilityList = withExtras(abilityList, extras.abilities.filter(a => a !== megaAbility && isLegal(a)), 0.01);
    abilityList = withExtras(abilityList, legal, 0.003);
    const [abilities, abilityP] = normalized(abilityList);

    const {spreads, probs, kinds} = buildSpreads(gen, sd, `${fmt.id}:${name}`);
    const stats = spreads.map(s => computeStats(gen, dex.name, s.nature, s.evs, fmt.level));
    const preStats = preMega ? spreads.map(s => computeStats(gen, preMega, s.nature, s.evs, fmt.level)) : undefined;

    const moves = buildMoveModel(sd?.moves ?? [], m => isStatusMove(gen, m), extras.moves);
    fitToItems(moves, items, itemP);

    formes.push({
      species: dex.name,
      preMega,
      megaAbility,
      prior: priors[idx],
      items, itemP,
      abilities, abilityP,
      spreads, spreadP: probs, spreadKind: kinds,
      stats, preStats,
      moves,
      tera: sd?.tera,
      fromStats: !!sd,
    });
  });

  const total = formes.reduce((s, f) => s + f.prior, 0) || 1;
  for (const f of formes) f.prior /= total;

  let n = 0;
  for (const f of formes) n += f.spreads.length * f.items.length * f.abilities.length;
  const space: MonSpace = {
    key,
    preview,
    formes,
    n,
    f: new Uint8Array(n),
    s: new Uint16Array(n),
    i: new Uint8Array(n),
    a: new Uint8Array(n),
    logPrior: new Float64Array(n),
  };
  let h = 0;
  formes.forEach((f, fi) => {
    const lf = Math.log(f.prior);
    for (let s = 0; s < f.spreads.length; s++) {
      const ls = lf + Math.log(f.spreadP[s]);
      for (let i = 0; i < f.items.length; i++) {
        const li = ls + Math.log(f.itemP[i]);
        for (let a = 0; a < f.abilities.length; a++) {
          space.f[h] = fi;
          space.s[h] = s;
          space.i[h] = i;
          space.a[h] = a;
          space.logPrior[h] = li + Math.log(f.abilityP[a]);
          h++;
        }
      }
    }
  });
  if (spaceCache.size > 64) spaceCache.clear();
  spaceCache.set(key, space);
  return space;
}
