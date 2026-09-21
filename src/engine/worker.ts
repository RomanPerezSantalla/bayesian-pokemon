/// <reference lib="webworker" />
/**
 * Inference runs off the main thread so tapping never waits on it. The page sends
 * the format once and the battle on every change; the worker replies with belief
 * summaries and matchups (the big hypothesis arrays never leave the worker).
 */
import type {FormatData} from '../data/format';
import {getGen, isDamagingMove} from '../data/dex';
import {computeBeliefs, type MonBelief} from './posterior';
import {
  myMoveInto, oppMoveInto, predictionSnapshot, speedMatchups, speedProfile, type DamageMatchup, type SpeedMatchup,
  type SpeedProfile,
} from './predict';
import type {Battle} from './types';

export type MonSummary = Omit<MonBelief, 'space' | 'post' | 'prior'> & {formeNames: string[]};

export interface Matchups {
  speed: SpeedMatchup[];
  /** Its effective Speed right now. */
  profile: SpeedProfile;
  mine: {slot: number; r: DamageMatchup}[];
  theirs: {slot: number; r: DamageMatchup}[];
  /** Predictions count it as Mega Evolving this turn (its likeliest Mega, and how likely it has one). */
  asMega?: {forme: string; p: number};
  /** Your Pokémon counted as Mega Evolving this turn. */
  myMegas: number[];
}

export type WorkerRequest =
  | {type: 'format'; fmt: FormatData}
  | {type: 'infer'; reqId: number; battle: Battle; focus: number[]};

export interface InferResult {
  type: 'result';
  reqId: number;
  mons: (MonSummary | null)[];
  notes: ReturnType<typeof computeBeliefs>['notes'];
  matchups: Record<number, Matchups>;
  ms: number;
  error?: string;
}

let fmt: FormatData | null = null;

function matchupsFor(battle: Battle, b: MonBelief): Matchups {
  const gen = getGen(fmt!.gen);
  const {snap: live, asMega, myMegas} = predictionSnapshot(gen, battle, battle.live, b);
  const mineActive = live.active.me.filter((s): s is number => s !== null);
  const mySlots = mineActive.length ? mineActive : battle.myTeam.map((_, i) => i).slice(0, 2);
  const mine = mySlots.flatMap(slot => battle.myTeam[slot].moves
    .map(m => ({slot, r: myMoveInto(fmt!, gen, battle, b, slot, m, live)}))
    .filter((x): x is {slot: number; r: DamageMatchup} => !!x.r));
  // Every attack it plausibly has, not just the top few: on turn one nothing is known yet.
  const theirMoves = b.moves.filter(m => m.p >= 0.03 && isDamagingMove(gen, m.name)).slice(0, 10).map(m => m.name);
  const theirs = theirMoves.flatMap(m => mySlots
    .map(slot => ({slot, r: oppMoveInto(fmt!, gen, battle, b, slot, m, live)}))
    .filter((x): x is {slot: number; r: DamageMatchup} => !!x.r));
  const profile = speedProfile(fmt!, gen, battle, b, live);
  return {speed: speedMatchups(fmt!, gen, battle, b, live, profile), profile, mine, theirs, asMega, myMegas};
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'format') {
    fmt = msg.fmt;
    return;
  }
  if (!fmt) return;
  const t0 = performance.now();
  try {
    const res = computeBeliefs(fmt, msg.battle);
    const matchups: Record<number, Matchups> = {};
    for (const slot of new Set(msg.focus)) {
      const b = res.mons[slot];
      if (b) matchups[slot] = matchupsFor(msg.battle, b);
    }
    const mons = res.mons.map(m => {
      if (!m) return null;
      const {space, post: _p, prior: _q, ...rest} = m;
      return {...rest, formeNames: space.formes.map(f => f.species)};
    });
    const out: InferResult = {type: 'result', reqId: msg.reqId, mons, notes: res.notes, matchups, ms: performance.now() - t0};
    (self as unknown as Worker).postMessage(out);
  } catch (err) {
    (self as unknown as Worker).postMessage({type: 'result', reqId: msg.reqId, mons: [], notes: [], matchups: {}, ms: 0, error: String(err)});
  }
};
