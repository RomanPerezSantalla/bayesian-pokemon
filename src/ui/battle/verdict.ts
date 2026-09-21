/** Short readings of a damage matchup and a speed matchup, for badges and chips. */
import type {DamageMatchup, SpeedMatchup} from '../../engine/predict';
import {pct} from '../format';

/** "38–45%": the damage range as the calc community writes it. */
export function dmgRange(lo: number, hi: number): string {
  if (hi <= 0) return 'immune';
  const a = Math.round(lo);
  const b = Math.round(hi);
  return a === b ? `${a}%` : `${a}–${b}%`;
}

export interface HitVerdict {
  text: string;
  cls: string;
  title?: string;
  /** Four hits or more: barely matters this turn. */
  weak?: boolean;
}

/**
 * What a hit means from the target's HP right now: its KO chance, or else how many such
 * hits it takes (2HKO, 2–3HKO…), read off the 95% damage range. `cur` is in % of max HP.
 */
export function hitVerdict(r: DamageMatchup, cur: number): HitVerdict {
  if (r.hi <= 0) return {text: 'immune', cls: 'none', weak: true};
  if (r.ko >= 0.995) return {text: 'KO', cls: 'sure'};
  if (r.ko > 0.005) return {text: `KO ${pct(r.ko)}`, cls: r.ko >= 0.5 ? 'likely' : 'maybe'};
  if (r.sash) return {text: 'Sash', cls: 'maybe', title: 'Would KO, but your Focus Sash holds'};
  const fewest = Math.max(2, Math.ceil(cur / r.hi));
  const most = r.lo > 0 ? Math.ceil(cur / r.lo) : Infinity;
  const cls = fewest === 2 ? 'hits close' : 'hits';
  const title = 'Hits to KO from its HP now, ignoring recovery';
  const weak = fewest >= 4;
  if (fewest >= 5) return {text: '5+HKO', cls, title, weak};
  if (most <= fewest) return {text: `${fewest}HKO`, cls, title, weak};
  if (most === fewest + 1) return {text: `${fewest}–${most}HKO`, cls, title, weak};
  return {text: `${fewest}+HKO`, cls, title, weak};
}

/** Who moves first, yours or theirs (same-priority moves), named so there's no "it" to decode. */
export function speedVerdict(
  s: SpeedMatchup | undefined, trickRoom: boolean, names: {mine: string; opp: string},
): {text: string; cls: string} | null {
  if (!s) return null;
  // Under Trick Room the slower one moves first.
  const theyFirst = trickRoom ? 1 - s.pFaster - s.pTie : s.pFaster;
  if (theyFirst >= 1) return {text: `${names.opp} moves first`, cls: 'bad'};
  if (theyFirst + s.pTie <= 0) return {text: `${names.mine} moves first`, cls: 'good'};
  const pThem = theyFirst + s.pTie / 2;
  return pThem >= 0.5
    ? {text: `${names.opp} first ${pct(pThem)}`, cls: 'warn'}
    : {text: `${names.mine} first ${pct(1 - pThem)}`, cls: 'warn'};
}

/** "×2", "×½", "×0"; nothing for neutral. */
export function effText(eff: number): string {
  if (eff === 1) return '';
  if (eff === 0.5) return '×½';
  if (eff === 0.25) return '×¼';
  return `×${eff}`;
}
