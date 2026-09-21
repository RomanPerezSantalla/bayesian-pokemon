/**
 * Predicted move order on the field (same-priority moves): the order strip shows it, and after
 * each logged move the sheet opens on whoever is predicted to go next.
 */
import type {InferResult} from '../../engine/worker';
import {sameMon, type Battle, type MonRef} from '../../engine/types';
import {stillToMove} from './actions';

export interface Runner {
  ref: MonRef;
  dist: [number, number][];
  lo: number;
  hi: number;
  mid: number;
}

/** P(a moves before b) for independent speed distributions. */
export function pBefore(a: Runner, b: Runner, trickRoom: boolean) {
  let p = 0;
  for (const [x, px] of a.dist) {
    for (const [y, py] of b.dist) {
      if (x === y) p += 0.5 * px * py;
      else if (trickRoom ? x < y : x > y) p += px * py;
    }
  }
  return p;
}

/** Everyone on the field, ordered by who's more likely to move first, pair by pair (not by a single guess). */
export function predictedOrder(battle: Battle, result: InferResult | null): Runner[] {
  const anyMatchup = result ? Object.values(result.matchups)[0] : undefined;
  if (!result || !anyMatchup) return [];
  const runners: Runner[] = [];
  for (const slot of battle.live.active.me) {
    if (slot === null || (battle.live.mons[`me${slot}`]?.hp ?? 1) <= 0) continue;
    const s = anyMatchup.speed.find(x => x.mySlot === slot);
    if (s) runners.push({ref: {side: 'me', slot}, dist: [[s.mySpeed, 1]], lo: s.mySpeed, hi: s.mySpeed, mid: s.mySpeed});
  }
  for (const slot of battle.live.active.opp) {
    if (slot === null || (battle.live.mons[`opp${slot}`]?.hp ?? 1) <= 0) continue;
    const prof = result.matchups[slot]?.profile;
    if (prof) runners.push({ref: {side: 'opp', slot}, dist: prof.dist, lo: prof.lo, hi: prof.hi, mid: prof.mode});
  }
  const tr = battle.live.field.trickRoom;
  const sorted: Runner[] = [];
  for (const r of runners) {
    let i = 0;
    while (i < sorted.length && pBefore(sorted[i], r, tr) >= 0.5) i++;
    sorted.splice(i, 0, r);
  }
  return sorted;
}

/** Who still has to move this turn, likeliest next first (anyone without a speed estimate goes last). */
export function nextToMove(battle: Battle, result: InferResult | null): MonRef[] {
  const left = stillToMove(battle);
  const order = predictedOrder(battle, result).map(r => r.ref);
  const rank = (r: MonRef) => {
    const i = order.findIndex(o => sameMon(o, r));
    return i < 0 ? order.length : i;
  };
  return left.sort((a, b) => rank(a) - rank(b));
}
