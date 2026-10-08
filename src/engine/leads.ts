/**
 * Which two of their six players lead with, and which two they bring in the back once their leads are out, from
 * Showdown's public Champions VGC replays (scripts/build-leads.mjs counts them into public/data/leads-doubles.json).
 *
 * Each species has its own rates, shrunk toward the average where it was seen little: how often it leads when it's
 * in the six, and how often it's in the back when it's in the six and didn't lead. Pairs that lead together (or go
 * in the back together) more or less often than their rates say carry a lift, and so does a lead with what it's
 * brought with. The lifts are observed counts over the counts the rates alone expected, shrunk toward 1. Counts are
 * weighed so that each player's team counts once however many games it played (a few players play most games, and
 * one player's habits say little about the next one's).
 *
 * No imports: the build script loads this file as it is.
 */

export interface LeadTable {
  /** Where it was counted from. */
  source: {formats: string[]; battles?: number; sides: number; complete: number; from: string; to: string};
  /**
   * Per species (its id): [sides with it in the six, sides it led, complete sides with it in the six and not leading,
   * of those, sides it was in the back].
   */
  species: Record<string, [number, number, number, number]>;
  /** Per pair ("a|b", ids sorted): [led together, expected by the rates, in the back together, expected]. */
  pairs: Record<string, [number, number, number, number]>;
  /** Per lead and one brought with it ("a>b"): [b in the back with a leading, expected]. */
  links: Record<string, [number, number]>;
  /** Formes counted as another (see leadName), by id: "vivillonpokeball": "vivillon". */
  aliases: Record<string, string>;
  /** How hard rates and lifts are shrunk (PRIOR_SIDES, LIFT_PAD), as the build found best on players held out. */
  tuning?: {prior: number; pad: number};
  /** How the model did on players held out (the build's cross-validation): the lead pair in its top 5, and so on. */
  checked?: {leadTop1: number; leadTop5: number; backTop1: number; backTop2: number};
}

export interface PairOdds {
  /** The two, as given. */
  pair: [string, string];
  p: number;
}

/** Sides at the average rate each species' own count is weighed against (unless the table says). */
const PRIOR_SIDES = 10;
/** Counts a lift's observed and expected are padded with, toward 1 (unless the table says). */
const LIFT_PAD = 3;

export const leadId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** What leadName needs of a species (@pkmn/dex's have it; the calc's list only the first ability). */
export interface LeadSpecies {
  name: string;
  baseSpecies?: string;
  types: readonly string[];
  baseStats: Readonly<Record<string, number>>;
  abilities: Readonly<Record<string, string | undefined>>;
}

/**
 * The name a species is counted under: a forme no different in battle from its regular one (Vivillon's patterns,
 * Maushold-Four, Sinistcha-Masterpiece) as that one, so they're counted together; one the dex doesn't have
 * (Alcremie-Lemon-Cream) as the nearest it has. Formes that play differently (Meowstic-F, Rotom-Wash) stay apart.
 */
export function leadName(get: (name: string) => LeadSpecies | undefined, name: string): string {
  let sp = get(name);
  for (let n = name; !sp && n.includes('-'); ) sp = get((n = n.slice(0, n.lastIndexOf('-'))));
  if (!sp) return name;
  const base = sp.baseSpecies && sp.baseSpecies !== sp.name ? get(sp.baseSpecies) : undefined;
  const same = (a: object, b: object) => JSON.stringify(Object.values(a)) === JSON.stringify(Object.values(b));
  return base && same(sp.types, base.types) && same(sp.baseStats, base.baseStats) && same(sp.abilities, base.abilities)
    ? base.name
    : sp.name;
}

const pairKey =(a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** The id a species is counted under in this table. */
const idIn = (t: LeadTable, name: string) => t.aliases[leadId(name)] ?? leadId(name);
function lift(t: LeadTable, seen = 0, expected = 0): number {
  const pad = t.tuning?.pad ?? LIFT_PAD;
  return (seen + pad) / (expected + pad);
}

/** How often it leads when it's in the six (two of six: a third, before any count). */
export function leadRate(t: LeadTable, name: string): number {
  const s = t.species[idIn(t, name)];
  const prior = t.tuning?.prior ?? PRIOR_SIDES;
  return ((s?.[1] ?? 0) + prior / 3) / ((s?.[0] ?? 0) + prior);
}

/** How often it's in the back when it's in the six and didn't lead (two of four: a half, before any count). */
export function backRate(t: LeadTable, name: string): number {
  const s = t.species[idIn(t, name)];
  const prior = t.tuning?.prior ?? PRIOR_SIDES;
  return ((s?.[3] ?? 0) + prior / 2) / ((s?.[2] ?? 0) + prior);
}

/** Every pair of these, each with its weight, normalized to odds, likeliest first. */
function normalize(pairs: {pair: [string, string]; w: number}[]): PairOdds[] {
  const total = pairs.reduce((s, x) => s + x.w, 0) || 1;
  return pairs.map(x => ({pair: x.pair, p: x.w / total})).sort((a, b) => b.p - a.p);
}

function pairsOf(names: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) out.push([names[i], names[j]]);
  return out;
}

/** The rates alone: each pair's weight before any lift (what the build script expects the lifts against). */
export function leadOddsByRates(t: LeadTable, six: readonly string[]): PairOdds[] {
  return normalize(pairsOf(six).map(pair => ({pair, w: leadRate(t, pair[0]) * leadRate(t, pair[1])})));
}

export function backOddsByRates(t: LeadTable, rest: readonly string[]): PairOdds[] {
  return normalize(pairsOf(rest).map(pair => ({pair, w: backRate(t, pair[0]) * backRate(t, pair[1])})));
}

/** The 15 pairs of their six they can lead with, likeliest first. */
export function leadOdds(t: LeadTable, six: readonly string[]): PairOdds[] {
  return normalize(pairsOf(six).map(pair => {
    const p = t.pairs[pairKey(idIn(t, pair[0]), idIn(t, pair[1]))];
    return {pair, w: leadRate(t, pair[0]) * leadRate(t, pair[1]) * lift(t, p?.[0], p?.[1])};
  }));
}

/**
 * The two they brought in the back, of the four that didn't lead, likeliest first; `seen`: any of those that have come
 * in already (one seen: the other is one of the three left).
 */
export function backOdds(t: LeadTable, six: readonly string[], leads: readonly string[], seen: readonly string[] = []): PairOdds[] {
  const rest = six.filter(n => !leads.includes(n));
  const linked = (name: string) => leads.reduce((w, lead) => {
    const l = t.links[`${idIn(t, lead)}>${idIn(t, name)}`];
    return w * lift(t, l?.[0], l?.[1]);
  }, 1);
  return normalize(pairsOf(rest).filter(pair => seen.every(s => pair.includes(s))).map(pair => {
    const p = t.pairs[pairKey(idIn(t, pair[0]), idIn(t, pair[1]))];
    return {pair, w: backRate(t, pair[0]) * backRate(t, pair[1]) * lift(t, p?.[2], p?.[3]) * linked(pair[0]) * linked(pair[1])};
  }));
}

/** Each one's chance to be in the pair, from pair odds. */
export function eachOdds(odds: readonly PairOdds[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const {pair, p} of odds) for (const n of pair) out.set(n, (out.get(n) ?? 0) + p);
  return out;
}
