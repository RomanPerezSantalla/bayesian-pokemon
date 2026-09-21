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
  preMegaAbility?: string;
  /** Abilities the pre-Mega forme might show before evolving. */
  preMegaAbilities?: string[];
  prior: number;
  items: string[];
  itemP: number[];
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

const TAIL_SAMPLES = 48;
const GENERIC_MASS = 0.02;
const MIN_TAIL_MASS = 0.04;
const MAX_ITEMS = 24;
/** Tempering for the naive-Bayes teammate update (teammates are correlated). */
const TEAMMATE_ALPHA = 0.5;

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

function withExtras(list: [string, number][], extras: string[], extraMass: number): [string, number][] {
  const out = list.slice();
  const known = new Set(out.map(([n]) => toID(n)));
  for (const e of extras) {
    if (!known.has(toID(e))) {
      out.push([e, extraMass]);
      known.add(toID(e));
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
    if (evs.reduce((a, b) => a + b, 0) > budget) continue;
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

function formePriors(fmt: FormatData, formes: string[], teammates: string[]): number[] {
  const logp = formes.map(f => Math.log(fmt.species[f]?.weight ?? 1));
  if (formes.length > 1) {
    formes.forEach((f, idx) => {
      const tm = new Map(fmt.species[f]?.teammates ?? []);
      for (const t of teammates) {
        const group = fmt.preview[t] ?? [t];
        const p = group.reduce((s, g) => s + (tm.get(g) ?? 0), 0);
        logp[idx] += TEAMMATE_ALPHA * Math.log(Math.max(p, 0.003));
      }
    });
  }
  const max = Math.max(...logp);
  const w = logp.map(x => Math.exp(x - max));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / total);
}

const spaceCache = new Map<string, MonSpace>();

export function buildMonSpace(
  fmt: FormatData,
  gen: Gen,
  preview: string,
  teammates: string[],
  extras: SpaceExtras,
): MonSpace {
  const key = JSON.stringify([fmt.id, fmt.month, preview, [...teammates].sort(), extras]);
  const hit = spaceCache.get(key);
  if (hit) return hit;

  const formeNames = fmt.preview[preview] ?? [preview];
  const priors = formePriors(fmt, formeNames, teammates);
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
      itemList = withExtras(itemList, extras.items, Math.max(0.01, other));
    }
    const [items, itemP] = normalized(itemList);

    const dexAbilities = Object.values(dex.abilities ?? {}) as string[];
    let abilityList: [string, number][] = sd?.abilities.length
      ? sd.abilities.slice()
      : dexAbilities.map(a => [a, 1] as [string, number]);
    if (!isMega) abilityList = withExtras(abilityList, extras.abilities, 0.01);
    const [abilities, abilityP] = normalized(abilityList);

    const {spreads, probs, kinds} = buildSpreads(gen, sd, `${fmt.id}:${name}`);
    const stats = spreads.map(s => computeStats(gen, dex.name, s.nature, s.evs, fmt.level));
    const preStats = preMega ? spreads.map(s => computeStats(gen, preMega, s.nature, s.evs, fmt.level)) : undefined;

    let preMegaAbilities: string[] | undefined;
    if (preMega) {
      const baseStats = fmt.species[preMega];
      const baseDex = dexSpecies(gen, preMega);
      preMegaAbilities = [
        ...(baseStats?.abilities.map(([a]) => a) ?? []),
        ...(Object.values(baseDex?.abilities ?? {}) as string[]),
      ].filter((a, i, arr) => arr.indexOf(a) === i);
    }

    const moves = buildMoveModel(sd?.moves ?? [], m => isStatusMove(gen, m), extras.moves);
    fitToItems(moves, items, itemP);

    formes.push({
      species: dex.name,
      preMega,
      preMegaAbility: preMegaAbilities?.[0],
      preMegaAbilities,
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
