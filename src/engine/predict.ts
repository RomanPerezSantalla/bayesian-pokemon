/** Posterior-predictive matchups: "how likely am I to outspeed / KO this thing?" */
import {isDamagingMove, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {finalSpeed, makeField, makeMove, makePokemon, runCalc} from './calc';
import {defaultCondition, hypView, mySpec, oppOrderKey, type Ctx} from './likelihood';
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

export function speedMatchups(fmt: FormatData, gen: Gen, battle: Battle, belief: MonBelief, snap: Snapshot): SpeedMatchup[] {
  const ctx: Ctx = {fmt, gen, battle, spaces: []};
  const {space, post} = belief;
  const ref = {side: 'opp' as const, slot: belief.slot};
  const memo = new Map<string, [number, number]>();
  const dist = new Map<number, number>();
  for (let h = 0; h < space.n; h++) {
    if (post[h] < PRUNE) continue;
    const [, s] = oppOrderKey(ctx, space, h, ref, 'Tackle', snap, memo);
    dist.set(s, (dist.get(s) ?? 0) + post[h]);
  }
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
  /** Percent of the defender's max HP. */
  lo: number;
  mid: number;
  hi: number;
  /** Probability this hit KOs from the defender's current HP. */
  ko: number;
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
  return {move, lo: q(0.05), mid: q(0.5), hi: q(0.95), ko: ko / (total || 1)};
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
      const cur = Math.max(1, Math.round((v.stats[0] * oppCond.hp) / 100));
      const d = makePokemon(gen, v.spec, oppCond, 0, cur);
      const res = runCalc(gen, attacker, d, mv, field);
      let k = 0;
      const rolls: [number, number][] = [];
      for (const [roll, p] of res.dist) {
        rolls.push([(100 * roll) / res.maxHP, p]);
        if (roll >= cur && !(v.item === 'Focus Sash' && cur === res.maxHP && !oppCond.itemGone)) k += p;
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
