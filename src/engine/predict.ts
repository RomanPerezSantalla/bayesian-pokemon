/** Posterior-predictive matchups: "how likely am I to outspeed / KO this thing?" */
import {isDamagingMove, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {finalSpeed, makeField, makeMove, makePokemon, runCalc} from './calc';
import {defaultCondition, hpCandidates, hypView, mySpec, oppOrderKey, type Ctx} from './likelihood';
import type {MonBelief} from './posterior';
import type {Battle, Snapshot} from './types';

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
  /** Percent of the defender's max HP (95% range over rolls and its possible sets). */
  lo: number;
  mid: number;
  hi: number;
  /** Probability this hit KOs from the defender's current HP. */
  ko: number;
  /** A would-be KO that Focus Sash stops. */
  sash?: boolean;
}

function summarize(move: string, points: [pct: number, w: number][], ko: number, total: number): DamageMatchup {
  points.sort((a, b) => a[0] - b[0]);
  const q = (x: number) => {
    let c = 0;
    for (const [v, w] of points) {
      c += w;
      if (c >= x * total) return v;
    }
    return points.length ? points[points.length - 1][0] : 0;
  };
  return {move, lo: q(0.025), mid: q(0.5), hi: q(0.975), ko: ko / (total || 1)};
}

/** My move into this opponent, integrating over what it might be. */
export function myMoveInto(
  fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, mySlot: number, move: string, snap: Snapshot,
): DamageMatchup | null {
  if (!isDamagingMove(gen, move)) return null;
  const set = battle.myTeam[mySlot];
  const myCond = snap.mons[`me${mySlot}`] ?? defaultCondition(1);
  const oppCond = snap.mons[`opp${belief.slot}`] ?? defaultCondition(100);
  const attacker = makePokemon(gen, mySpec(gen, fmt, set, myCond), myCond);
  const field = makeField(fmt.gameType, snap.field, 'me');
  const mv = makeMove(gen, move, {targets: fmt.gameType === 'doubles' ? 2 : 1});
  const {space, post} = belief;
  const memo = new Map<string, {rolls: [number, number][]; ko: number}>();
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
      const candidates = hpCandidates(oppCond.hp, v.stats[0], battle.settings, oppCond.hpEstimated);
      const d = makePokemon(gen, v.spec, oppCond, 0, candidates[Math.floor(candidates.length / 2)]);
      const res = runCalc(gen, attacker, d, mv, field);
      const sash = v.item === 'Focus Sash' && !oppCond.itemGone;
      let k = 0;
      const rolls: [number, number][] = [];
      for (const [roll, p] of res.dist) {
        rolls.push([(100 * roll) / res.maxHP, p]);
        const kos = candidates.filter(hp => roll >= hp && !(sash && hp === res.maxHP)).length;
        k += (p * kos) / candidates.length;
      }
      m = {rolls, ko: k};
      memo.set(key, m);
    }
    for (const [pct, p] of m.rolls) points.push([pct, p * post[h]]);
    ko += m.ko * post[h];
    total += post[h];
  }
  return summarize(move, points, ko, total);
}

/** An opponent's (possible) move into my Pokémon. */
export function oppMoveInto(
  fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, mySlot: number, move: string, snap: Snapshot,
): DamageMatchup | null {
  if (!isDamagingMove(gen, move)) return null;
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
  const mv = makeMove(gen, move, {targets: fmt.gameType === 'doubles' ? 2 : 1});
  const {space, post} = belief;
  const memo = new Map<string, {rolls: [number, number][]; ko: number}>();
  const points: [number, number][] = [];
  let ko = 0;
  let total = 0;
  for (let h = 0; h < space.n; h++) {
    if (post[h] < PRUNE) continue;
    const v = hypView(fmt, space, h, oppCond);
    const key = `${space.f[h]}|${v.pre}|${v.stats.join('/')}|${v.item}|${v.ability}`;
    let m = memo.get(key);
    if (!m) {
      const a = makePokemon(gen, v.spec, oppCond, 0, Math.max(1, Math.round((v.stats[0] * oppCond.hp) / 100)));
      const res = runCalc(gen, a, defender, mv, field);
      let k = 0;
      const rolls: [number, number][] = [];
      for (const [roll, p] of res.dist) {
        rolls.push([(100 * roll) / myMax, p]);
        if (roll >= cur && !sash) k += p;
        if (roll >= cur && sash) sashSaves = true;
      }
      m = {rolls, ko: k};
      memo.set(key, m);
    }
    for (const [pct, p] of m.rolls) points.push([pct, p * post[h]]);
    ko += m.ko * post[h];
    total += post[h];
  }
  return {...summarize(move, points, ko, total), sash: sashSaves || undefined};
}
