/**
 * Who a move is logged against, from what it targets in the games: nobody (Protect, Tailwind,
 * Stealth Rock), your partner (Helping Hand), everyone it hits at once (Earthquake, Growl), or one
 * the player picks (Tackle in Doubles).
 */
import {isStatusMove, move as dexMove, type Gen} from '../../data/dex';
import {moveFx} from '../../engine/moves';
import type {MonRef} from '../../engine/types';

/** Targets that are no one in particular: the user, a side, the whole field. */
const NO_TARGET = new Set(['self', 'allySide', 'allyTeam', 'all', 'allies', 'adjacentAllyOrSelf', 'foeSide']);

export type TargetPlan =
  /** Logged straight away: a status move and whoever it affects. */
  | {kind: 'log'; targets: MonRef[]}
  /** An attack on these, each getting a row for its HP. */
  | {kind: 'hits'; targets: MonRef[]}
  /** Ask who. */
  | {kind: 'pick'};

export function moveTarget(gen: Gen, move: string): string {
  const m = dexMove(gen, move);
  return moveFx(move).tg ?? (m as {target?: string} | undefined)?.target ?? 'normal';
}

/** Hits whose number varies (Bullet Seed 2–5), as the choices to offer; none when it's fixed. */
export function hitChoices(move: string): number[] {
  const mh = moveFx(move).mh;
  return mh ? Array.from({length: mh[1] - mh[0] + 1}, (_, i) => mh[0] + i).filter(n => n > 1) : [];
}

export function targetPlan(gen: Gen, move: string, foes: MonRef[], allies: MonRef[]): TargetPlan {
  const target = moveTarget(gen, move);
  const around = [...foes, ...allies];
  if (isStatusMove(gen, move)) {
    if (NO_TARGET.has(target) || target === 'randomNormal') return {kind: 'log', targets: []};
    if (target === 'adjacentAlly') return {kind: 'log', targets: allies};
    if (target === 'allAdjacentFoes') return {kind: 'log', targets: foes};
    // Teeter Dance: everyone around, the partner too.
    if (target === 'allAdjacent') return {kind: 'log', targets: around};
    // The one foe there is, else ask (the list has the partner too, for Heal Pulse or Decorate).
    return foes.length <= 1 ? {kind: 'log', targets: foes} : {kind: 'pick'};
  }
  if (target === 'allAdjacentFoes') return {kind: 'hits', targets: foes};
  if (target === 'allAdjacent') return {kind: 'hits', targets: around};
  return foes.length <= 1 ? {kind: 'hits', targets: foes} : {kind: 'pick'};
}
