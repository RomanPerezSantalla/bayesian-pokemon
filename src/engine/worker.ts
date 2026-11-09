/// <reference lib="webworker" />
/**
 * Inference runs off the main thread so tapping never waits on it. The page sends
 * the format once and the battle on every change; the worker replies with belief
 * summaries and matchups (the big hypothesis arrays never leave the worker).
 */
import type {FormatData} from '../data/format';
import {getGen, isDamagingMove, toID} from '../data/dex';
import {computeBeliefs, type MonBelief} from './posterior';
import {
  myMoveInto, oppMoveInto, predictionSnapshot, speedMatchups, speedProfile, type DamageMatchup, type MegaCount, type SpeedMatchup,
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
  /** It can still Mega Evolve: whether predictions count it as doing so this turn, and why. */
  mega?: MegaCount;
  /** Your Pokémon counted as Mega Evolving this turn. */
  myMegas: number[];
  /** Yours on the field that could Mega Evolve this turn, counted or not. */
  myCan: number[];
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

/** Round twice: used right after its partner's, it moves then, at double power. */
const ROUND_AFTER = 'If its partner uses Round first this turn, it moves straight after, at double power';
/** Dragon Darts with two to go at: one dart at each, or both at one when the other's out of reach. */
const ONE_DART = 'One dart at each while both are there';
const BOTH_DARTS = 'Both darts at it: its partner is protected, immune or gone';

function matchupsFor(battle: Battle, b: MonBelief, all: (MonBelief | null)[]): Matchups {
  const gen = getGen(fmt!.gen);
  const {snap: live, mega, myMegas, myCan} = predictionSnapshot(gen, battle, battle.live, b);
  const mineActive = live.active.me.filter((s): s is number => s !== null);
  const mySlots = mineActive.length ? mineActive : battle.myTeam.map((_, i) => i).slice(0, 2);
  const doubles = fmt!.gameType === 'doubles';
  const round = gen.moves.get(toID('Round'))?.basePower ?? 60;
  // Its partner on the field has Round too: its Round may be the second, at double power.
  const myPartnerRounds = (slot: number) => doubles && mineActive.some(s => s !== slot && battle.myTeam[s]?.moves.some(m => toID(m) === 'round'));
  const theirPartnerRounds = doubles && live.active.opp.some(s => s !== null && s !== b.slot
    && (all[s]?.moves.some(m => toID(m.name) === 'round' && m.p >= 0.03) ?? false));
  const twice = (r: DamageMatchup | null): DamageMatchup | null => r && {...r, label: 'Round ×2', note: ROUND_AFTER};
  // Dragon Darts at a side with two out: a dart at each, both at one if the other's out of reach.
  const darts = (m: string, two: boolean) => toID(m) === 'dragondarts' && doubles && two;
  const theirTwo = live.active.opp.filter(s => s !== null).length > 1;
  const myTwo = mineActive.length > 1;
  const one = (r: DamageMatchup | null): DamageMatchup | null => r && {...r, note: ONE_DART};
  const both = (r: DamageMatchup | null): DamageMatchup | null => r && {...r, label: 'Dragon Darts ×2', note: BOTH_DARTS};
  const mine = mySlots.flatMap(slot => battle.myTeam[slot].moves
    .flatMap(m => darts(m, theirTwo) ? [
      {slot, r: one(myMoveInto(fmt!, gen, battle, b, slot, m, live, undefined, 1))},
      {slot, r: both(myMoveInto(fmt!, gen, battle, b, slot, m, live))},
    ] : [
      {slot, r: myMoveInto(fmt!, gen, battle, b, slot, m, live)},
      ...(toID(m) === 'round' && myPartnerRounds(slot) ? [{slot, r: twice(myMoveInto(fmt!, gen, battle, b, slot, m, live, round * 2))}] : []),
    ])
    .filter((x): x is {slot: number; r: DamageMatchup} => !!x.r));
  // Every attack it plausibly has, not just the top few: on turn one nothing is known yet.
  const theirMoves = b.moves.filter(m => m.p >= 0.03 && isDamagingMove(gen, m.name)).slice(0, 10).map(m => m.name);
  const theirs = theirMoves.flatMap(m => mySlots
    .flatMap(slot => darts(m, myTwo) ? [
      {slot, r: one(oppMoveInto(fmt!, gen, battle, b, slot, m, live, undefined, 1))},
      {slot, r: both(oppMoveInto(fmt!, gen, battle, b, slot, m, live))},
    ] : [
      {slot, r: oppMoveInto(fmt!, gen, battle, b, slot, m, live)},
      ...(toID(m) === 'round' && theirPartnerRounds ? [{slot, r: twice(oppMoveInto(fmt!, gen, battle, b, slot, m, live, round * 2))}] : []),
    ])
    .filter((x): x is {slot: number; r: DamageMatchup} => !!x.r));
  const profile = speedProfile(fmt!, gen, battle, b, live);
  return {speed: speedMatchups(fmt!, gen, battle, b, live, profile), profile, mine, theirs, mega, myMegas, myCan};
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
      if (b) matchups[slot] = matchupsFor(msg.battle, b, res.mons);
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
