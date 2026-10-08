/** Posterior-predictive matchups: "how likely am I to outspeed / KO this thing?" */
import {isDamagingMove, toID, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {finalSpeed, makeField, makeMove, makePokemon, runCalc} from './calc';
import {defaultCondition, hpCandidates, hypView, megaFormeOf, mySpec, oppOrderKey, takenTimes, type Ctx} from './likelihood';
import {DAMAGE_NOT_FROM_STATS} from './moves';
import {powerFromHistory} from './power';
import {WEATHER_ABILITY} from './state';
import type {MonBelief} from './posterior';
import {sameMon, type Battle, type MonRef, type Snapshot} from './types';

/** An opponent that can still Mega Evolve, and whether predictions count it as doing so this turn. */
export interface MegaCount {
  /** Its likeliest Mega. */
  forme: string;
  /** How likely it holds a Mega Stone at all. */
  p: number;
  counted: boolean;
  /** The turn it moved without Mega Evolving, though its side still could. */
  passed?: number;
  /** Counted the way you said, not the way it would be. */
  chosen?: boolean;
}

export interface PredictionField {
  snap: Snapshot;
  /** This opponent, if it can still Mega Evolve. */
  mega?: MegaCount;
  /** Yours counted as Mega Evolving. */
  myMegas: number[];
  /** Yours on the field that could Mega Evolve this turn, counted or not. */
  myCan: number[];
}

/**
 * The turn this Pokémon moved without Mega Evolving though its side still could have, if it did
 * and hasn't since: Mega Evolution comes before a turn's moves, so it chose not to then (keeping
 * it for another, or for later).
 */
export function passedUpMega(battle: Battle, ref: MonRef): number | undefined {
  let used = false;
  let passed: number | undefined;
  for (const e of battle.events) {
    if (e.kind === 'reveal' && e.what === 'forme' && !e.negate && e.mon.side === ref.side) {
      if (sameMon(e.mon, ref)) return undefined;
      used = true;
    } else if (e.kind === 'action' && !used && passed === undefined && sameMon(e.actor, ref)) passed = e.turn;
  }
  return passed;
}

/**
 * The field predictions are made on. A Pokémon that can still Mega Evolve is counted as
 * evolving: it happens before anyone moves, so its Mega's stats, ability and Speed are what this
 * turn's hits and turn order come from (a weather-setting Mega brings its weather). Not once it
 * has let a turn go by without it (the stone may be kept for another, or it has none), nor once
 * its side has used its one Mega. Of yours on the field only one can: the first that hasn't let a
 * turn go by. `battle.megaPlan` says otherwise where you did.
 */
export function predictionSnapshot(gen: Gen, battle: Battle, snap: Snapshot, belief: MonBelief): PredictionField {
  const out = structuredClone(snap);
  const plan = battle.megaPlan ?? {};
  const usedBy = (side: 'me' | 'opp') => Object.entries(snap.mons).some(([k, c]) => k.startsWith(side) && c.mega);
  const setWeather = (ability: string | undefined) => {
    const w = ability ? WEATHER_ABILITY[ability] : undefined;
    if (w) out.field = {...out.field, weather: w};
  };

  let mega: MegaCount | undefined;
  const cond = out.mons[`opp${belief.slot}`];
  const megas = belief.formes.filter(f => f.p > 0 && belief.megaAbilityOf[f.name]).sort((a, b) => b.p - a.p);
  if (cond && !cond.mega && !usedBy('opp') && megas.length) {
    const passed = passedUpMega(battle, {side: 'opp', slot: belief.slot});
    const chosen = plan.opp?.[belief.slot];
    const counted = chosen ?? passed === undefined;
    mega = {forme: megas[0].name, p: megas.reduce((t, f) => t + f.p, 0), counted, passed, chosen: chosen !== undefined || undefined};
    if (counted) {
      cond.mega = true;
      if (megas[0].p > 0.5) setWeather(belief.megaAbilityOf[megas[0].name]);
    }
  }

  const myMegas: number[] = [];
  const myCan: number[] = [];
  if (!usedBy('me')) {
    const can = (slot: number) => {
      const c = out.mons[`me${slot}`];
      return !!c && !c.mega && c.hp > 0 && !!megaFormeOf(gen, battle.myTeam[slot]);
    };
    const fresh = (slot: number) => passedUpMega(battle, {side: 'me', slot}) === undefined;
    myCan.push(...out.active.me.filter((s): s is number => s !== null && can(s)));
    const pick = plan.me !== undefined ? plan.me : myCan.find(fresh) ?? null;
    battle.myTeam.forEach((set, slot) => {
      // On the bench, each as if it came in and did (for its Speed against this one), unless you said.
      const counted = myCan.includes(slot) || plan.me !== undefined ? slot === pick : fresh(slot);
      if (!can(slot) || !counted) return;
      out.mons[`me${slot}`].mega = true;
      myMegas.push(slot);
      // Only one on the field changes the weather now.
      const forme = megaFormeOf(gen, set)!;
      if (out.active.me.includes(slot)) setWeather(Object.values(gen.species.get(toID(forme))?.abilities ?? {})[0] as string | undefined);
    });
  }
  return {snap: out, mega, myMegas, myCan};
}

/** Hypotheses below this posterior mass are skipped in predictions. */
const PRUNE = 1e-5;

export interface SpeedMatchup {
  mySlot: number;
  mySpeed: number;
  pFaster: number;
  pTie: number;
}

/** An opponent's effective Speed right now (boosts, Tailwind, Scarf, paralysis…): distribution and 95% range. */
export interface SpeedProfile {
  dist: [speed: number, p: number][];
  lo: number;
  hi: number;
  mode: number;
}

export function speedProfile(fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, snap: Snapshot): SpeedProfile {
  const ctx: Ctx = {fmt, gen, battle, spaces: []};
  const {space, post} = belief;
  const ref = {side: 'opp' as const, slot: belief.slot};
  const memo = new Map<string, [number, number]>();
  const m = new Map<number, number>();
  let total = 0;
  for (let h = 0; h < space.n; h++) {
    if (post[h] < PRUNE) continue;
    const [, s] = oppOrderKey(ctx, space, h, ref, 'Tackle', snap, memo);
    m.set(s, (m.get(s) ?? 0) + post[h]);
    total += post[h];
  }
  const dist = [...m.entries()].map(([v, p]) => [v, p / (total || 1)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const q = (x: number) => {
    let c = 0;
    for (const [v, p] of dist) if ((c += p) >= x) return v;
    return dist[dist.length - 1]?.[0] ?? 0;
  };
  let mode = dist[0]?.[0] ?? 0;
  let best = -1;
  for (const [v, p] of dist) if (p > best) [best, mode] = [p, v];
  return {dist, lo: q(0.025), hi: q(0.975), mode};
}

export function speedMatchups(
  fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, snap: Snapshot, profile = speedProfile(fmt, gen, battle, belief, snap),
): SpeedMatchup[] {
  const dist = new Map(profile.dist);
  return battle.myTeam.map((set, mySlot) => {
    const cond = snap.mons[`me${mySlot}`];
    const mon = makePokemon(gen, mySpec(gen, fmt, set, cond), cond);
    const mySpeed = finalSpeed(gen, mon, makeField(fmt.gameType, snap.field, 'me'));
    let pFaster = 0;
    let pTie = 0;
    let total = 0;
    for (const [s, p] of dist) {
      total += p;
      if (s > mySpeed) pFaster += p;
      else if (s === mySpeed) pTie += p;
    }
    return {mySlot, mySpeed, pFaster: pFaster / (total || 1), pTie: pTie / (total || 1)};
  });
}

export interface DamageMatchup {
  move: string;
  /** Its type as it lands (Aerilate, Weather Ball…) and the type multiplier (0 when immune), most likely case. */
  type: string;
  eff: number;
  /** Percent of the defender's max HP (95% range over rolls and its possible sets). */
  lo: number;
  mid: number;
  hi: number;
  /** Probability this hit KOs from the defender's current HP. */
  ko: number;
  /** A would-be KO that Focus Sash stops. */
  sash?: boolean;
}

/** The likeliest (type, multiplier) of a move over the hypotheses, weighted by posterior. */
function modal(kinds: Map<string, number>): {type: string; eff: number} {
  let best = '';
  let w = -1;
  for (const [k, v] of kinds) if (v > w) [best, w] = [k, v];
  const [type, eff] = best.split('|');
  return {type: type ?? '', eff: eff === undefined ? 1 : Number(eff)};
}

function summarize(move: string, points: [pct: number, w: number][], ko: number, total: number, kinds: Map<string, number>): DamageMatchup {
  points.sort((a, b) => a[0] - b[0]);
  const q = (x: number) => {
    let c = 0;
    for (const [v, w] of points) {
      c += w;
      if (c >= x * total) return v;
    }
    return points.length ? points[points.length - 1][0] : 0;
  };
  return {move, ...modal(kinds), lo: q(0.025), mid: q(0.5), hi: q(0.975), ko: ko / (total || 1)};
}

/** My move into this opponent, integrating over what it might be. */
export function myMoveInto(
  fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, mySlot: number, move: string, snap: Snapshot,
): DamageMatchup | null {
  if (!isDamagingMove(gen, move) || DAMAGE_NOT_FROM_STATS.has(toID(move))) return null;
  const set = battle.myTeam[mySlot];
  const myCond = snap.mons[`me${mySlot}`] ?? defaultCondition(1);
  const oppCond = snap.mons[`opp${belief.slot}`] ?? defaultCondition(100);
  // Attacking, an Aegislash is in its Blade forme (Stance Change).
  const attacker = makePokemon(gen, mySpec(gen, fmt, set, myCond), {...myCond, blade: true});
  const field = makeField(fmt.gameType, snap.field, 'me');
  const bp = powerFromHistory(gen, battle, {side: 'me', slot: mySlot}, move, undefined, {side: 'opp', slot: belief.slot});
  const mv = makeMove(gen, move, {targets: fmt.gameType === 'doubles' ? 2 : 1, bp});
  const {space, post} = belief;
  const memo = new Map<string, {rolls: [number, number][]; ko: number; kind: string}>();
  const kinds = new Map<string, number>();
  const points: [number, number][] = [];
  let ko = 0;
  let total = 0;
  for (let h = 0; h < space.n; h++) {
    if (post[h] < PRUNE) continue;
    const v = hypView(fmt, space, h, oppCond);
    const key = `${space.f[h]}|${v.pre}|${v.stats.join('/')}|${v.item}|${v.ability}`;
    let m = memo.get(key);
    if (!m) {
      // Every true HP that reads as the % on screen is equally possible.
      const candidates = hpCandidates(oppCond.hp, v.stats[0], battle.settings, oppCond.hpEstimated || oppCond.hpUnknown);
      const d = makePokemon(gen, v.spec, oppCond, 0, candidates[Math.floor(candidates.length / 2)]);
      const res = runCalc(gen, attacker, d, mv, field, takenTimes(oppCond));
      const sash = v.item === 'Focus Sash' && !oppCond.itemGone;
      let k = 0;
      const rolls: [number, number][] = [];
      for (const [roll, p] of res.dist) {
        rolls.push([(100 * roll) / res.maxHP, p]);
        const kos = candidates.filter(hp => roll >= hp && !(sash && hp === res.maxHP)).length;
        k += (p * kos) / candidates.length;
      }
      // Immune (by type or ability) reads as ×0 whatever the chart says.
      const eff = [...res.dist.keys()].every(d => d <= 0) ? 0 : res.effectiveness;
      m = {rolls, ko: k, kind: `${res.moveType}|${eff}`};
      memo.set(key, m);
    }
    kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + post[h]);
    for (const [pct, p] of m.rolls) points.push([pct, p * post[h]]);
    ko += m.ko * post[h];
    total += post[h];
  }
  return summarize(move, points, ko, total, kinds);
}

/** An opponent's (possible) move into my Pokémon. */
export function oppMoveInto(
  fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, mySlot: number, move: string, snap: Snapshot,
): DamageMatchup | null {
  if (!isDamagingMove(gen, move) || DAMAGE_NOT_FROM_STATS.has(toID(move))) return null;
  const set = battle.myTeam[mySlot];
  const myCond = snap.mons[`me${mySlot}`] ?? defaultCondition(1);
  const oppCond = snap.mons[`opp${belief.slot}`] ?? defaultCondition(100);
  const spec = mySpec(gen, fmt, set, myCond);
  const defender = makePokemon(gen, spec, myCond, 0, myCond.hp || undefined);
  const myMax = defender.maxHP();
  const cur = myCond.hp || myMax;
  const sash = !myCond.itemGone && set.item === 'Focus Sash' && cur === myMax;
  let sashSaves = false;
  const field = makeField(fmt.gameType, snap.field, 'opp');
  const bp = powerFromHistory(gen, battle, {side: 'opp', slot: belief.slot}, move, undefined, {side: 'me', slot: mySlot});
  const mv = makeMove(gen, move, {targets: fmt.gameType === 'doubles' ? 2 : 1, bp});
  const {space, post} = belief;
  const memo = new Map<string, {rolls: [number, number][]; ko: number; kind: string}>();
  const kinds = new Map<string, number>();
  const points: [number, number][] = [];
  let ko = 0;
  let total = 0;
  for (let h = 0; h < space.n; h++) {
    if (post[h] < PRUNE) continue;
    const v = hypView(fmt, space, h, oppCond);
    const key = `${space.f[h]}|${v.pre}|${v.stats.join('/')}|${v.item}|${v.ability}`;
    let m = memo.get(key);
    if (!m) {
      const a = makePokemon(gen, v.spec, {...oppCond, blade: true}, 0, Math.max(1, Math.round((v.stats[0] * oppCond.hp) / 100)));
      const res = runCalc(gen, a, defender, mv, field, takenTimes(myCond));
      let k = 0;
      const rolls: [number, number][] = [];
      for (const [roll, p] of res.dist) {
        rolls.push([(100 * roll) / myMax, p]);
        if (roll >= cur && !sash) k += p;
        if (roll >= cur && sash) sashSaves = true;
      }
      // Immune (by type or ability) reads as ×0 whatever the chart says.
      const eff = [...res.dist.keys()].every(d => d <= 0) ? 0 : res.effectiveness;
      m = {rolls, ko: k, kind: `${res.moveType}|${eff}`};
      memo.set(key, m);
    }
    kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + post[h]);
    for (const [pct, p] of m.rolls) points.push([pct, p * post[h]]);
    ko += m.ko * post[h];
    total += post[h];
  }
  return {...summarize(move, points, ko, total, kinds), sash: sashSaves || undefined};
}
