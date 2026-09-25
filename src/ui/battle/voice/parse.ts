/**
 * Reads narrated battle text into events. The narration is mostly the game's own lines, read out
 * as they come, worded as Pokémon Champions writes them ("The opposing Salamence used Draco Meteor!",
 * "A critical hit!", "It doesn't affect the opposing Salamence...", "Charizard and Incineroar's
 * Attack fell!", "Charizard fainted!", "The rain stopped.", "Kim sent out Kingambit!", and the
 * pop-ups: "Salamence's Intimidate") plus HP where it's known ("Charizard 45": yours in HP, theirs in
 * %). Anything it can't place is skipped.
 */
import {allAbilities, allItems, allMoves, toID, type Gen} from '../../../data/dex';
import {megaFormeOf} from '../../../engine/likelihood';
import type {MonSummary} from '../../../engine/worker';
import type {Battle, Boosts, MonRef, SideID, Status} from '../../../engine/types';
import {spokenName} from '../names';
import {fieldAt, statAt, type FieldNews, type SideNews} from './messages';
import {spokenNames} from './preview';
import {COMMON_WORDS, matchAt, norm, numberAt, similarity, squash, type Match, type MatchOptions, type Named} from './text';

export type VoiceEvent =
  | {kind: 'use'; actor: MonRef; move: string}
  /** "…used Dragon Claw on Charizard": who it was aimed at. */
  | {kind: 'target'; mon: MonRef}
  | {kind: 'hp'; mon?: MonRef; value: number}
  | {kind: 'faint'; mon?: MonRef}
  /** "A critical hit!"; in a spread move, "A critical hit on the opposing Kingambit!". */
  | {kind: 'crit'; mon?: MonRef}
  /** "It's super effective on the opposing Kingambit!" (spread moves): it was hit. */
  | {kind: 'effective'; mon: MonRef}
  /** It wasn't hit: "…avoided the attack!", "…'s attack missed!", or `shield`: "…protected itself!". */
  | {kind: 'miss'; mon?: MonRef; shield?: boolean}
  | {kind: 'immune'; mon?: MonRef}
  /** "But it failed!" */
  | {kind: 'fail'}
  /** "The Pokémon was hit 3 times!" */
  | {kind: 'hits'; n: number}
  | {kind: 'status'; mon?: MonRef; status: Status}
  /** Its turn came and it couldn't move: flinched, fully paralyzed, fast asleep, frozen, recharging… */
  | {kind: 'cant'; mon?: MonRef; status?: Status}
  /** Its status ended: "…woke up!", "…'s Lum Berry cured its paralysis!". */
  | {kind: 'cure'; mon?: MonRef}
  /** "…'s Attack rose sharply!": how far each stat went. `limit`: "…won't go any higher!", so it's at ±6. */
  | {kind: 'stat'; mon?: MonRef; boosts: Boosts; limit?: boolean}
  /** Weather, terrain, a room, or one side's Tailwind, screens or hazards starting, carrying on or ending. */
  | {kind: 'field'; news: FieldNews}
  /** End-of-turn damage or healing (sandstorm, burn, poison, Leftovers…): the turn's moves are over. */
  | {kind: 'residual'; mon?: MonRef; sand?: boolean}
  /** "…lost some of its HP!": Life Orb recoil. */
  | {kind: 'recoil'; mon?: MonRef}
  /** An item the game named. `gone`: it's gone now (popped, knocked off, eaten, flung…). */
  | {kind: 'item'; mon?: MonRef; item: string; gone?: boolean; taken?: boolean}
  | {kind: 'ability'; mon: MonRef; ability: string}
  | {kind: 'mega'; mon?: MonRef; suffix?: string}
  /** `voluntary`: "…, come back!", "… withdrew …!": switched out by choice, which happens before a turn's moves. */
  | {kind: 'withdraw'; mon?: MonRef; voluntary?: boolean}
  | {kind: 'sendOut'; mon: MonRef}
  /** "…was dragged out!" (Roar, Dragon Tail, Red Card): in for the one the move hit. */
  | {kind: 'dragged'; mon: MonRef}
  | {kind: 'endTurn'}
  /** "Rillaboom moved first", "… outsped Dragapult": where its move goes in the turn (before or after `other`). */
  | {kind: 'order'; mon: MonRef; place: 'first' | 'last'; other?: MonRef};

export interface ParseEnv {
  battle: Battle;
  gen: Gen;
  mons: (MonSummary | null)[] | undefined;
}

type Phrase = 'crit' | 'faint' | 'miss' | 'missAfter' | 'shield' | 'immune' | 'immuneAfter' | 'recoil' | 'status' | 'sendOut'
  | 'lead' | 'go' | 'withdraw' | 'withdrawAfter' | 'mega' | 'endTurn' | 'first' | 'last' | 'effective' | 'fail' | 'hits' | 'cant'
  | 'cure' | 'residual' | 'knockOff' | 'steal' | 'itemGone' | 'seen' | 'whiteHerb' | 'popped' | 'obtained' | 'dragged' | 'reacting'
  | 'substitute' | 'blewAway' | 'quickDraw' | 'maxAttack' | 'unaffected' | 'unaffectedBy' | 'targetsItem' | 'skip' | 'skipMove'
  | 'skipCount';

/**
 * Pokémon Champions' battle lines (its own English text: see messages.ts) after norm(), longest
 * first so "critical hit" wins over "critical"; and a few things said rather than read ("end turn",
 * "Rillaboom moved first"). `extra`: the status, "sand", or "voluntary" (a switch made at the start
 * of a turn, not in the middle of one).
 */
const PHRASES: [string[], Phrase, string?][] = ([
  // The hit.
  ['critical hit', 'crit'], ['critical', 'crit'], ['crit', 'crit'],
  ['extremely effective', 'effective'], ['super effective', 'effective'], ['not very effective', 'effective'],
  ['mostly ineffective', 'effective'],
  ['fainted', 'faint'], ['faints', 'faint'], ['knocked out', 'faint'], ['ko', 'faint'], ['k o', 'faint'],
  ['a one hit ko', 'skip'], ['one hit ko', 'skip'],
  ['protected itself', 'shield'], ['protected', 'shield'],
  // Hurt through its protection ("It broke through …'s protection!"): not a miss.
  ['couldnt fully protect itself', 'skip'], ['broke through', 'skip'],
  ['avoided the attack', 'miss'], ['avoided', 'miss'], ['missed', 'miss'], ['miss', 'miss'],
  ['the substitute took damage for', 'substitute'], ['substitute took damage for', 'substitute'],
  // "It doesn't affect the opposing Salamence…" names it after; "…is unaffected!" before.
  ['doesnt affect', 'immuneAfter'], ['does not affect', 'immuneAfter'], ['didnt affect', 'immuneAfter'],
  ['no effect', 'immune'], ['unaffected', 'immune'], ['immune', 'immune'],
  ['but it failed to affect', 'missAfter'], ['failed to affect', 'missAfter'],
  // It didn't take: "…cannot be poisoned!", "…is already asleep!", "…stays awake!"; "…is not affected by Spore thanks to its Safety Goggles!".
  ['cannot be poisoned', 'unaffected'], ['cannot be burned', 'unaffected'], ['cannot be paralyzed', 'unaffected'],
  ['cannot be frozen solid', 'unaffected'], ['is already poisoned', 'unaffected'], ['is already burned', 'unaffected'],
  ['is already paralyzed', 'unaffected'], ['is already asleep', 'unaffected'], ['stays awake', 'unaffected'],
  ['stays wide awake', 'unaffected'], ['stayed awake', 'unaffected'], ['is not affected by', 'unaffectedBy'],
  // Lines that only look like something: Burn Up, Magnet Rise, Electrify, Safeguard ending, Perish Song, Fairy Lock, Forewarn.
  ['burned itself out', 'skip'], ['levitated with electromagnetism', 'skip'], ['electromagnetism wore off', 'skip'],
  ['moves have been electrified', 'skip'], ['no longer protected', 'skip'], ['will faint in three turns', 'skip'],
  ['during the next turn', 'skip'], ['one of the moves', 'skip'], ['already has a substitute', 'skip'], ['stockpiled', 'skipCount'],
  ['but it failed', 'fail'], ['it failed', 'fail'], ['does not have enough hp', 'fail'], ['but nothing happened', 'fail'],
  ['pokemon was hit', 'hits'], ['was hit', 'hits'],
  ['lost some of its hp', 'recoil'], ['lost some hp', 'recoil'], ['lost some', 'recoil'],
  // Statuses: given, keeping it from moving, ending.
  ['badly poisoned by the toxic orb', 'residual', 'tox'], ['burned by the flame orb', 'residual', 'brn'],
  ['badly poisoned', 'status', 'tox'], ['poisoned', 'status', 'psn'], ['burned', 'status', 'brn'],
  ['paralyzed', 'status', 'par'], ['fell asleep', 'status', 'slp'], ['was frozen solid', 'status', 'frz'], ['frozen', 'status', 'frz'],
  ['couldnt move because its paralyzed', 'cant', 'par'], ['is fast asleep', 'cant', 'slp'], ['fast asleep', 'cant', 'slp'],
  ['is frozen solid', 'cant', 'frz'],
  ['flinched and couldnt move', 'cant'], ['flinched', 'cant'], ['must recharge', 'cant'], ['lost its focus and couldnt move', 'cant'],
  ['lost its focus', 'cant'], ['hurt itself in its confusion', 'cant'], ['immobilized by love', 'cant'], ['cant use', 'cant'],
  ['cannot use', 'cant'], ['couldnt move', 'cant'], ['cant move', 'cant'], ['cannot move', 'cant'],
  ['woke up', 'cure'], ['woke it up', 'cure'], ['snap fully awake', 'cure'], ['thawed out', 'cure'], ['defrosted it', 'cure'],
  ['was cured of', 'cure'], ['cured its', 'cure'], ['burn was cured', 'cure'], ['status returned to normal', 'cure'],
  // The end of the turn.
  ['buffeted by the sandstorm', 'residual', 'sand'], ['hurt by its burn', 'residual'], ['hurt by its poisoning', 'residual'],
  ['sapped by leech seed', 'residual'], ['is hurt by', 'residual'], ['afflicted by the curse', 'residual'],
  ['perish count fell to', 'residual'],
  // Items coming and going.
  ['knocked off', 'knockOff'], ['corroded', 'knockOff'], ['stole and ate its targets', 'targetsItem'], ['stole', 'steal'],
  ['flung its', 'itemGone'],
  // Quick Claw going off ("…can act faster than normal, thanks to its Quick Claw!"): not the turn order said.
  ['can act faster than normal thanks to its', 'seen'],
  // Frisk ("…found its Leftovers!", "…was frisked, revealing its Leftovers!"), Poltergeist: still held.
  ['found its', 'seen'], ['revealing its', 'seen'], ['attacked by its', 'seen'],
  ['returned its stats to normal using its', 'whiteHerb'],
  ['popped', 'popped'], ['obtained', 'obtained'], ['is reacting to', 'reacting'], ['reacting to', 'reacting'],
  // "…blew away Stealth Rock!", "Quick Draw made … move faster!", "…maxed its Attack!" (Anger Point).
  ['blew away', 'blewAway'], ['quick draw made', 'quickDraw'], ['maxed its attack', 'maxAttack'],
  // "…took the Future Sight attack!", "…took the attack!" (Lightning Rod): no move used.
  ['took the', 'skipMove'],
  // Switching. "…, come back!" and "… withdrew …!" are the switches chosen for a turn, made before its moves.
  ['sent out', 'sendOut'], ['send out', 'sendOut'], ['sends out', 'sendOut'], ['brought out', 'sendOut'], ['brings out', 'sendOut'],
  // Said rather than read: "opponent sent Rillaboom and Corviknight", "I lead with Dragapult".
  ['sent', 'sendOut'], ['sends', 'sendOut'], ['sending', 'sendOut'],
  ['leads with', 'lead'], ['lead with', 'lead'], ['leading with', 'lead'], ['starts with', 'lead'], ['opens with', 'lead'],
  ['leads', 'lead'], ['leading', 'lead'], ['lead', 'lead'],
  ['go for it', 'go'], ['youre in charge', 'go'], ['go', 'go'],
  ['come back', 'withdraw', 'voluntary'], ['went back', 'withdraw'], ['switched out', 'withdraw'],
  ['withdrew', 'withdrawAfter', 'voluntary'],
  ['was dragged out', 'dragged'], ['dragged out', 'dragged'],
  ['mega evolved', 'mega'], ['mega evolves', 'mega'], ['mega evolution', 'mega'], ['mega evolve', 'mega'],
  // Champions has no line between turns: said ("end turn", "next turn"), or worked out (see the narrator).
  ['end turn', 'endTurn'], ['end of turn', 'endTurn'], ['next turn', 'endTurn'], ['new turn', 'endTurn'], ['turn over', 'endTurn'],
  // Turn order, said after the fact: "Rillaboom moved first", "Kingambit outsped Dragapult", "Gholdengo went last".
  ['moved first', 'first'], ['went first', 'first'], ['goes first', 'first'], ['moves first', 'first'], ['was first', 'first'],
  ['attacked first', 'first'], ['moved before', 'first'], ['went before', 'first'], ['outsped', 'first'], ['outspeeds', 'first'],
  ['out sped', 'first'], ['was faster than', 'first'], ['is faster than', 'first'], ['faster than', 'first'], ['was faster', 'first'],
  ['moved last', 'last'], ['went last', 'last'], ['goes last', 'last'], ['moves last', 'last'], ['was last', 'last'],
  ['moved after', 'last'], ['went after', 'last'], ['got outsped by', 'last'], ['was outsped by', 'last'], ['got outsped', 'last'],
  ['was outsped', 'last'], ['was slower than', 'last'], ['is slower than', 'last'], ['slower than', 'last'], ['was slower', 'last'],
] as [string, Phrase, string?][])
  .map(([p, kind, extra]) => [p.split(' '), kind, extra] as [string[], Phrase, string?])
  .sort((a, b) => b[0].length - a[0].length);

const OPPOSING = new Set(['opposing', 'opponent', 'opponents', 'foe', 'foes', 'enemy', 'their', 'theirs', 'they', 'rival', 'wild']);
const MINE = new Set(['i', 'im', 'ill', 'my', 'me', 'mine', 'we', 'our', 'ours']);
/**
 * Pokémon are matched only among the dozen in the battle, so badly heard names can be let through
 * ("carbonite" for Corviknight, "really boom" for Rillaboom), with common words kept out.
 */
const NAMES: MatchOptions = {consonants: true, stop: COMMON_WORDS, prefix: true};
const USED = new Set(['used', 'uses', 'use', 'using']);
const BEFORE_HP = new Set(['at', 'to', 'down', 'is', 'has', 'now', 'on', 'with', 'left', 'hp', 'health']);
const AFTER_HP = new Set(['percent', 'hp', 'left']);

function phraseAt(words: string[], i: number): {kind: Phrase; len: number; extra?: string} | null {
  for (const [p, kind, extra] of PHRASES) {
    if (p.every((w, k) => words[i + k] === w)) return {kind, len: p.length, extra};
  }
  return null;
}

/** "…'s Charizardite Y is reacting to Roman's Omni Ring!": what the trainer's name is followed by. */
const MEGA_GEAR = new Set(['ring', 'bracelet', 'stone', 'band', 'key']);
/** "…blew away Stealth Rock!": the hazards, by the moves' names. */
const HAZARDS: [string[], SideNews][] = [
  [['stealth', 'rock'], 'stealthRock'], [['toxic', 'spikes'], 'toxicSpikes'], [['sticky', 'web'], 'stickyWeb'], [['spikes'], 'spikes'],
];
/** "Wide Guard protected the opposing team!" */
const TEAM_WORDS = new Set(['team', 'teams', 'side']);
const TARGET_WORDS = new Set(['on', 'at', 'into', 'against']);
const NOT_HP_AFTER = new Set(['pp', 'times', 'time', 'turns', 'turn', 'of', 'layers', 'layer', 'stages', 'stage']);

const refOf = (key: string): MonRef => (key.startsWith('me')
  ? {side: 'me', slot: Number(key.slice(2))}
  : {side: 'opp', slot: Number(key.slice(3))});

/** Every Pokémon on a side, by the names narration may use: species, nickname, base species, "Mega X". */
function monNames(env: ParseEnv, side: SideID): (Named<string> & {said: string})[] {
  const out: (Named<string> & {said: string})[] = [];
  const active = env.battle.live.active[side];
  const add = (slot: number, name: string | undefined) => {
    for (const said of name ? spokenNames(name) : []) out.push({key: squash(said), value: `${side}${slot}`, bonus: active.includes(slot) ? 0.04 : 0, said});
  };
  if (side === 'me') {
    env.battle.myTeam.forEach((set, slot) => {
      add(slot, set.species);
      add(slot, set.nickname);
      add(slot, env.gen.species.get(toID(set.species))?.baseSpecies);
      const mega = megaFormeOf(env.gen, set);
      if (mega) add(slot, spokenName(mega));
    });
  } else {
    env.battle.oppPreview.forEach((species, slot) => {
      add(slot, species);
      add(slot, env.gen.species.get(toID(species))?.baseSpecies);
      for (const f of env.mons?.[slot]?.formes ?? []) if (f.p > 0 && /-Mega/.test(f.name)) add(slot, spokenName(f.name));
    });
  }
  return out;
}

/**
 * What can be said in this battle, for the voice model to listen out for: every name of the
 * Pokémon in it, your moves, items and abilities, and theirs as far as they're likely.
 */
export function narrationPhrases(env: ParseEnv): string[] {
  const out = new Set<string>();
  for (const side of ['me', 'opp'] as const) for (const n of monNames(env, side)) out.add(n.said);
  for (const set of env.battle.myTeam) {
    for (const m of set.moves) out.add(m);
    if (set.item) out.add(set.item);
    if (set.ability) out.add(set.ability);
  }
  for (const m of env.mons ?? []) {
    if (!m) continue;
    const likely = <T extends {name: string; p: number}>(xs: T[], min: number) => xs.filter(x => x.p >= min).map(x => x.name);
    for (const x of likely(m.moves, 0.02)) out.add(x);
    for (const x of likely(m.items, 0.05)) out.add(x);
    for (const x of likely(m.abilities, 0.05)) out.add(x);
    for (const a of Object.values(m.megaAbilityOf ?? {})) out.add(a);
  }
  return [...out];
}

const listCache = new WeakMap<Gen, Record<string, Named<string>[]>>();
function every(gen: Gen, what: 'moves' | 'items' | 'abilities'): Named<string>[] {
  let c = listCache.get(gen);
  if (!c) listCache.set(gen, (c = {}));
  if (!c[what]) {
    const names = what === 'moves' ? allMoves(gen) : what === 'items' ? allItems(gen) : allAbilities(gen);
    c[what] = names.map(n => ({key: squash(n), value: n}));
  }
  return c[what];
}

export function parseNarration(text: string, env: ParseEnv): VoiceEvent[] {
  const words = norm(text).split(' ').filter(Boolean);
  const names = {me: monNames(env, 'me'), opp: monNames(env, 'opp')};
  const out: VoiceEvent[] = [];
  let last: MonRef | undefined;
  /** Where the words naming `last` ended: a line straight after is about it ("Salamence, come back!"). */
  let lastEnd = -1;
  /** The word being read. */
  let i = 0;
  /** Whose Pokémon the words so far are about ("opponent…", "I…"): settles a species both sides have. */
  let ctx: SideID | undefined;
  const live = env.battle.live;
  /** Places free on each side (empty, or its Pokémon fainted): a benched Pokémon named there has come in. */
  const room: Record<SideID, number> = {me: 0, opp: 0};
  for (const side of ['me', 'opp'] as const) {
    room[side] = live.active[side].filter(s => s === null || (live.mons[`${side}${s}`]?.hp ?? 1) <= 0).length;
  }
  const benched = (ref: MonRef) => !live.active[ref.side].includes(ref.slot) && (live.mons[`${ref.side}${ref.slot}`]?.hp ?? 1) > 0;
  const nameAt = (at: number, side: SideID) => matchAt(words, at, names[side], 0.6, 0.12, NAMES);
  const same = (a: MonRef, b: MonRef) => a.side === b.side && a.slot === b.slot;
  /** A Pokémon was named: the lines after are about it. */
  const named = (ref: MonRef, end: number) => {
    [last, lastEnd, i] = [ref, end, end];
  };

  /**
   * A Pokémon named at i. The game calls theirs "the opposing X"; without that, a species both
   * sides have is the one of the side being talked about, else yours.
   */
  const monAt = (i: number, prefer?: SideID): {ref: MonRef; len: number; possessive?: boolean} | null => {
    const opposing = OPPOSING.has(words[i - 1] ?? '') || (words[i - 1] === 'the' && OPPOSING.has(words[i - 2] ?? ''));
    const mine = opposing ? null : nameAt(i, 'me');
    const theirs = nameAt(i, 'opp');
    const side = prefer ?? ctx;
    const m = mine && theirs
      ? (mine.score > theirs.score || (mine.score === theirs.score && side !== 'opp') ? mine : theirs)
      : mine ?? theirs;
    return m ? {ref: refOf(m.value), len: m.len, possessive: m.possessive} : null;
  };
  const nextMon = (from: number, span: number, prefer?: SideID) => {
    for (let j = from; j < Math.min(words.length, from + span); j++) {
      const m = monAt(j, prefer);
      if (m) return {...m, at: j};
    }
    return null;
  };
  /** One side's Pokémon only: the game says "Go! X!" for yours and "…sent out X!" for theirs, whatever else is on the field. */
  const sideAt = (at: number, side: SideID) => {
    const m = nameAt(at, side);
    return m ? {ref: refOf(m.value), len: m.len, at} : null;
  };
  const nextOnSide = (from: number, span: number, side: SideID) => {
    for (let j = from; j < Math.min(words.length, from + span); j++) {
      const m = sideAt(j, side);
      if (m) return m;
    }
    return null;
  };
  /** Doubles sends out two at once: "…sent out Salamence and Rillaboom!", "Go! Incineroar and Sneasler!". */
  const sentOut = (m: {ref: MonRef; len: number; at: number}) => {
    out.push({kind: 'sendOut', mon: m.ref});
    room[m.ref.side] = Math.max(0, room[m.ref.side] - 1);
    named(m.ref, m.at + m.len);
    const second = words[i] === 'and' ? sideAt(i + 1, m.ref.side) : null;
    if (second) {
      out.push({kind: 'sendOut', mon: second.ref});
      room[second.ref.side] = Math.max(0, room[second.ref.side] - 1);
      named(second.ref, second.at + second.len);
    }
  };
  const moveAt = (i: number, ref: MonRef) => {
    if (ref.side === 'me') {
      const own = (env.battle.myTeam[ref.slot]?.moves ?? []).map(m => ({key: squash(m), value: m}));
      return matchAt(words, i, own, 0.66, 0.06);
    }
    const likely = (env.mons?.[ref.slot]?.moves ?? []).filter(m => m.p > 0).map(m => ({key: squash(m.name), value: m.name}));
    return matchAt(words, i, likely, 0.7, 0.06) ?? matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03);
  };
  /** The words at `at` spell the name matched (not just sound like it: "has" and Haze). */
  const spelled = (at: number, m: Match<string>) => similarity(squash(words.slice(at, at + m.len).join('')), squash(m.value)) >= 0.95;
  const abilityAt = (i: number, ref: MonRef) => {
    const m = ref.side === 'opp' ? env.mons?.[ref.slot] : undefined;
    const own = ref.side === 'me' ? [env.battle.myTeam[ref.slot]?.ability] : [
      ...(m?.abilities ?? []).filter(a => a.p > 0).map(a => a.name), ...Object.values(m?.megaAbilityOf ?? {}),
    ];
    const cands = own.filter((a): a is string => !!a).map(a => ({key: squash(a), value: a}));
    return matchAt(words, i, cands, 0.75, 0.06) ?? matchAt(words, i, every(env.gen, 'abilities'), 0.86, 0.03);
  };
  const itemAt = (i: number, ref: MonRef) => {
    const own = ref.side === 'me' ? [env.battle.myTeam[ref.slot]?.item]
      : (env.mons?.[ref.slot]?.items ?? []).filter(x => x.p > 0).map(x => x.name);
    const cands = own.filter((x): x is string => !!x).map(x => ({key: squash(x), value: x}));
    return matchAt(words, i, cands, 0.75, 0.06) ?? matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
  };
  /**
   * "The opposing Salamence's Intimidate", "Rillaboom's Sitrus Berry": its ability or item, whichever
   * fits better (the longer when both do: "Damp Rock" over Damp).
   */
  const abilityOrItemAt = (i: number, ref: MonRef): {event: VoiceEvent; len: number} | null => {
    const ab = abilityAt(i, ref);
    const it = itemAt(i, ref);
    if (it && (!ab || it.score > ab.score || (it.score === ab.score && it.len > ab.len))) {
      return {event: {kind: 'item', mon: ref, item: it.value}, len: it.len};
    }
    return ab ? {event: {kind: 'ability', mon: ref, ability: ab.value}, len: ab.len} : null;
  };
  const statEvent = (mon: MonRef, st: {boosts: Boosts; limit?: boolean}) => {
    // "…'s accuracy fell!" isn't tracked, "…was not lowered!" isn't a change: read past them.
    if (Object.keys(st.boosts).length) out.push({kind: 'stat', mon, boosts: st.boosts, limit: st.limit});
  };

  while (i < words.length) {
    if (OPPOSING.has(words[i])) ctx = 'opp';
    else if (MINE.has(words[i])) ctx = 'me';
    const field = fieldAt(words, i);
    if (field) {
      out.push({kind: 'field', news: field.news});
      i += field.len;
      continue;
    }
    const ph = phraseAt(words, i);
    if (ph) {
      /** Straight after a name: the line is about that Pokémon. */
      const afterName = lastEnd === i;
      const start = i;
      i += ph.len;
      switch (ph.kind) {
        case 'crit':
        case 'effective': {
          // "A critical hit on the opposing Kingambit!", "It's super effective on the opposing Kingambit and Salamence!"
          const m = words[i] === 'on' ? nextMon(i + 1, 3) : null;
          if (m) named(m.ref, m.at + m.len);
          if (ph.kind === 'crit') out.push({kind: 'crit', mon: m?.ref});
          else if (m) {
            out.push({kind: 'effective', mon: m.ref});
            const also = words[i] === 'and' || words[i] === 'or' ? nextMon(i + 1, 3) : null;
            if (also) {
              out.push({kind: 'effective', mon: also.ref});
              named(also.ref, also.at + also.len);
            }
          }
          break;
        }
        case 'faint':
          out.push({kind: 'faint', mon: last});
          break;
        case 'miss':
          out.push({kind: 'miss', mon: last});
          break;
        case 'shield': {
          // "…protected itself!", "…is protected by the Psychic Terrain!", "Wide Guard protected the opposing Rillaboom!"
          if (ph.len > 1 || words[i] === 'by') {
            if (last) out.push({kind: 'miss', mon: last, shield: true});
            break;
          }
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'miss', mon: m.ref, shield: true});
          } else if (!words.slice(i, i + 3).some(w => TEAM_WORDS.has(w))) out.push({kind: 'miss', mon: last, shield: true});
          break;
        }
        case 'unaffected':
          if (last) out.push({kind: 'miss', mon: last});
          break;
        case 'unaffectedBy': {
          // "…is not affected by Spore thanks to its Safety Goggles!": the item comes after.
          if (last) out.push({kind: 'immune', mon: last});
          const mv = matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03);
          if (mv) i += mv.len;
          break;
        }
        case 'targetsItem': {
          // Bug Bite, Pluck: the berry of whoever it hit, eaten.
          const it = matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
          if (it) {
            out.push({kind: 'item', item: it.value, gone: true, taken: true});
            i += it.len;
          }
          break;
        }
        case 'missAfter': {
          // "But it failed to affect the opposing Garchomp!"
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'miss', mon: m.ref});
          }
          break;
        }
        case 'substitute': {
          // "The substitute took damage for the opposing Garchomp!": its HP didn't change.
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'miss', mon: m.ref});
          }
          break;
        }
        case 'recoil':
          out.push({kind: 'recoil', mon: last});
          break;
        case 'status': {
          // "…is paralyzed! It can't move!" is its turn lost; "…is paralyzed, so it may be unable to move!" is the status.
          const k = ph.extra === 'par' ? words.slice(i, i + 3).findIndex(w => w === 'cant' || w === 'couldnt' || w === 'cannot') : -1;
          if (k >= 0) {
            i += k + 1;
            if (words[i] === 'move') i++;
            out.push({kind: 'cant', mon: last, status: 'par'});
          } else out.push({kind: 'status', mon: last, status: ph.extra as Status});
          break;
        }
        case 'cant':
          out.push({kind: 'cant', mon: last, status: ph.extra as Status | undefined});
          break;
        case 'cure':
          out.push({kind: 'cure', mon: last});
          break;
        case 'residual': {
          out.push({kind: 'residual', mon: last, sand: ph.extra === 'sand' || undefined});
          if (ph.extra && ph.extra !== 'sand') out.push({kind: 'status', mon: last, status: ph.extra as Status});
          // "…'s perish count fell to 2!", "…is hurt by Fire Spin!"
          const n = words[start] === 'perish' ? numberAt(words, i) : null;
          if (n) i += n.len;
          const by = words[start] === 'is' ? matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03) : null;
          if (by) i += by.len;
          break;
        }
        case 'fail':
          out.push({kind: 'fail'});
          break;
        case 'hits': {
          // "The Pokémon was hit 3 times!"
          const n = numberAt(words, i);
          if (n && n.value >= 1 && n.value <= 10) {
            out.push({kind: 'hits', n: n.value});
            i += n.len;
            if (words[i] === 'times' || words[i] === 'time') i++;
          }
          break;
        }
        case 'immune':
          out.push({kind: 'immune', mon: last});
          break;
        case 'immuneAfter': {
          // "It doesn't affect the opposing Salamence…"
          const m = nextMon(i, 4);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'immune', mon: m.ref});
          } else out.push({kind: 'immune', mon: last});
          break;
        }
        case 'knockOff':
        case 'steal': {
          // "…knocked off the opposing Garchomp's Sitrus Berry!", "…stole Garchomp's Sitrus Berry!"
          const m = nextMon(i, 3);
          const it = m ? itemAt(m.at + m.len, m.ref) : null;
          if (m && it) {
            named(m.ref, m.at + m.len + it.len);
            out.push({kind: 'item', mon: m.ref, item: it.value, gone: true});
          }
          break;
        }
        case 'itemGone':
        case 'seen':
        case 'whiteHerb': {
          // "…flung its Iron Ball!", "…returned its stats to normal using its White Herb!"; "…found its Leftovers!"
          const it = last ? itemAt(i, last) : null;
          if (last && it) {
            out.push({kind: 'item', mon: last, item: it.value, gone: ph.kind !== 'seen'});
            i += it.len;
          }
          break;
        }
        case 'blewAway': {
          // "…blew away Stealth Rock!" (Rapid Spin, Mortal Spin): off its own side.
          const h = HAZARDS.find(([p]) => p.every((w, k) => words[i + k] === w));
          if (h && last) {
            out.push({kind: 'field', news: {what: h[1], value: false, side: last.side}});
            i += h[0].length;
          }
          break;
        }
        case 'quickDraw': {
          // "Quick Draw made the opposing Slowbro move faster!"
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'ability', mon: m.ref, ability: 'Quick Draw'});
          }
          break;
        }
        case 'maxAttack':
          // Anger Point: "…maxed its Attack!"
          if (last) out.push({kind: 'stat', mon: last, boosts: {atk: 1}, limit: true});
          break;
        case 'skipMove': {
          // "…took the Future Sight attack!"
          const mv = matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03);
          if (mv) i += mv.len;
          break;
        }
        case 'popped':
          if (last) out.push({kind: 'item', mon: last, item: 'Air Balloon', gone: true});
          break;
        case 'obtained': {
          // Trick's "…obtained a Choice Scarf." says where an item went, not what it had.
          const j = words[i] === 'a' || words[i] === 'an' ? i + 1 : i;
          const it = matchAt(words, j, every(env.gen, 'items'), 0.8, 0.04);
          if (it) i = j + it.len;
          break;
        }
        case 'reacting': {
          // "…is reacting to Roman's Omni Ring!": the trainer's name isn't a Pokémon.
          const k = words.slice(i, i + 6).findIndex(w => MEGA_GEAR.has(w));
          i = Math.min(words.length, k >= 0 ? i + k + 1 : i + 2);
          break;
        }
        case 'dragged':
          if (last) out.push({kind: 'dragged', mon: last});
          break;
        case 'skip':
          break;
        case 'skipCount': {
          // "…stockpiled 2!": a count, not HP.
          const n = numberAt(words, i);
          if (n) i += n.len;
          break;
        }
        case 'sendOut': {
          // "The opposing trainer sent out Kingambit!" (the game says it only of theirs), "I sent Dragapult".
          const m = nextOnSide(i, 5, ctx ?? 'opp');
          if (m) sentOut(m);
          break;
        }
        case 'lead': {
          // "Opponent leads with Rillaboom and Corviknight", "I lead Dragapult and Arcanine".
          const m = ctx ? nextOnSide(i, 5, ctx) : nextMon(i, 5);
          if (m) sentOut(m);
          break;
        }
        case 'go': {
          // "Go! Garchomp!"
          const m = sideAt(i, 'me');
          if (m) sentOut(m);
          break;
        }
        case 'withdraw':
        case 'withdrawAfter': {
          // "Salamence, come back!", "Garchomp went back to Roman!" are about the one just named;
          // "The opposing trainer withdrew Salamence!", "Come back, Salamence!" name it after.
          const m = ph.kind === 'withdraw' && afterName ? null : nextMon(i, 3);
          if (m) named(m.ref, m.at + m.len);
          const gone = m?.ref ?? last;
          if (gone && live.active[gone.side].includes(gone.slot)) room[gone.side]++;
          out.push({kind: 'withdraw', mon: gone, voluntary: ph.extra === 'voluntary' || undefined});
          // "…went back to Roman!": the trainer's name isn't a Pokémon.
          if (words[i] === 'to') i = Math.min(words.length, i + 2);
          break;
        }
        case 'mega': {
          // "Charizard has Mega Evolved into Mega Charizard Y!"
          let suffix: string | undefined;
          for (let j = i; j < Math.min(words.length, i + 5); j++) {
            if (words[j] === 'x' || words[j] === 'y') {
              suffix = words[j].toUpperCase();
              break;
            }
          }
          out.push({kind: 'mega', mon: last ?? nextMon(i, 5)?.ref, suffix});
          break;
        }
        case 'endTurn':
          out.push({kind: 'endTurn'});
          last = undefined;
          break;
        case 'first':
        case 'last': {
          // Who: the Pokémon just named. Before or after whom, if another comes next ("outsped Dragapult").
          const other = nextMon(i, 3);
          if (other && last && !same(other.ref, last)) i = other.at + other.len;
          if (last) out.push({kind: 'order', mon: last, place: ph.kind, other: other && !same(other.ref, last) ? other.ref : undefined});
          break;
        }
      }
      continue;
    }

    const mon = monAt(i);
    if (mon) {
      named(mon.ref, i + mon.len);
      // "The opposing Garchomp's Attack harshly fell!"
      const st = statAt(words, i);
      if (st) {
        statEvent(mon.ref, st);
        i += st.len;
        continue;
      }
      // Both of a side at once: "Charizard and Incineroar's Attack fell!", "The opposing Salamence and the opposing Kingambit's…"
      const both = words[i] === 'and' ? nextMon(i + 1, 3) : null;
      const st2 = both ? statAt(words, both.at + both.len) : null;
      if (both && st2 && !same(both.ref, mon.ref)) {
        statEvent(mon.ref, st2);
        statEvent(both.ref, st2);
        named(both.ref, both.at + both.len + st2.len);
        continue;
      }
      // "Rillaboom's Psychic Seed" is its item, not the move Psychic.
      const own = mon.possessive ? abilityOrItemAt(i, mon.ref) : null;
      if (own) {
        out.push(own.event);
        i += own.len;
        continue;
      }
      // A line about it comes next ("…protected itself!", "…knocked off…", "…twisted the dimensions!"): not a move.
      if (phraseAt(words, i) || fieldAt(words, i)) continue;
      // "X used Y" (but "X used its Quick Claw" is an item, and "Garchomp's Earthquake was disabled!" no move used).
      let j = i;
      if (USED.has(words[j] ?? '')) j++;
      if (words[j] !== 'its' && words[j] !== 'their' && !(mon.possessive && j === i)) {
        let mv = moveAt(j, mon.ref);
        // With no "used": the move's own name, spelled out ("has" only sounds like Haze).
        if (mv && j === i && (mv.score < 0.9 || !spelled(j, mv))) mv = null;
        // "used" misheard ("Rillaboom mus said Fake Out"): a move said exactly a word or two on still counts.
        for (let k = j + 1; !mv && j === i && k <= i + 2 && k < words.length; k++) {
          if (numberAt(words, k - 1) || monAt(k - 1) || phraseAt(words, k - 1) || COMMON_WORDS.has(words[k - 1])) break;
          const m = moveAt(k, mon.ref);
          if (m && m.score >= 0.9 && spelled(k, m)) [mv, j] = [m, k];
        }
        if (mv) {
          out.push({kind: 'use', actor: mon.ref, move: mv.value});
          i = j + mv.len;
          // "…on Charizard", "…at the opposing Salamence": who it was aimed at.
          const t = TARGET_WORDS.has(words[i] ?? '') ? nextMon(i + 1, 3) : null;
          if (t && !same(t.ref, mon.ref)) {
            out.push({kind: 'target', mon: t.ref});
            named(t.ref, t.at + t.len);
          }
          continue;
        }
      }
      // "Charizard 45", "Charizard at 45", "Charizard down to 45 percent"
      let k = i;
      while (k < i + 3 && BEFORE_HP.has(words[k] ?? '')) k++;
      const num = numberAt(words, k);
      if (num) {
        out.push({kind: 'hp', mon: mon.ref, value: num.value});
        i = k + num.len;
        if (AFTER_HP.has(words[i] ?? '')) i++;
        continue;
      }
      // "The opposing Salamence Intimidate" (the possessive not heard)
      const ab = abilityOrItemAt(i, mon.ref);
      if (ab) {
        out.push(ab.event);
        i += ab.len;
      } else if (benched(mon.ref) && room[mon.ref.side] > 0) {
        // A benched Pokémon named with a place free on its side has come in: the leads said plainly
        // ("opponent Rillaboom and Corviknight"), or who replaced one that fainted.
        out.push({kind: 'sendOut', mon: mon.ref});
        room[mon.ref.side]--;
      }
      continue;
    }

    // "Its Attack rose!"
    if (words[i] === 'its' && last) {
      const st = statAt(words, i + 1);
      if (st) {
        statEvent(last, st);
        i += 1 + st.len;
        continue;
      }
    }

    const item = matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
    if (item) {
      const j = i + item.len;
      // "Occa Berry weakened Flamethrower's power!": held by whoever the move hit, which the move being narrated knows.
      const who = words[j] === 'weakened' ? undefined : last;
      // "…had its Sitrus Berry stolen!"
      out.push({kind: 'item', mon: who, item: item.value, gone: words[j] === 'stolen' || undefined});
      i = j;
      continue;
    }

    const num = numberAt(words, i);
    // A number that counts something else ("…lost 4 PP from Protect!"), or no HP at all ("no one").
    if (num && (NOT_HP_AFTER.has(words[i + num.len] ?? '') || words[i - 1] === 'no')) {
      i += num.len;
      continue;
    }
    if (num) {
      out.push({kind: 'hp', value: num.value});
      i += num.len;
      if (AFTER_HP.has(words[i] ?? '')) i++;
      continue;
    }
    i++;
  }
  return out;
}
