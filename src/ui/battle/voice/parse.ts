/**
 * Reads narrated battle text into events. The narration is mostly the game's own lines ("The
 * opposing Salamence used Draco Meteor!", "A critical hit!", "It doesn't affect the opposing
 * Salamence…", "Charizard fainted!", "The opposing trainer sent out Kingambit!") plus HP where
 * it's known ("Charizard 45": yours in HP, theirs in %). Anything it can't place is skipped.
 */
import {allAbilities, allItems, allMoves, toID, type Gen} from '../../../data/dex';
import {megaFormeOf} from '../../../engine/likelihood';
import type {MonSummary} from '../../../engine/worker';
import type {Battle, MonRef, SideID, Status} from '../../../engine/types';
import {spokenName} from '../names';
import {spokenNames} from './preview';
import {COMMON_WORDS, matchAt, norm, numberAt, squash, type MatchOptions, type Named} from './text';

export type VoiceEvent =
  | {kind: 'use'; actor: MonRef; move: string}
  | {kind: 'hp'; mon?: MonRef; value: number}
  | {kind: 'faint'; mon?: MonRef}
  | {kind: 'crit'}
  | {kind: 'miss'; mon?: MonRef}
  | {kind: 'immune'; mon?: MonRef}
  | {kind: 'status'; mon?: MonRef; status: Status}
  /** "…lost some of its HP!": Life Orb recoil. */
  | {kind: 'recoil'; mon?: MonRef}
  | {kind: 'item'; mon?: MonRef; item: string}
  | {kind: 'ability'; mon: MonRef; ability: string}
  | {kind: 'mega'; mon?: MonRef; suffix?: string}
  | {kind: 'withdraw'; mon?: MonRef}
  | {kind: 'sendOut'; mon: MonRef}
  | {kind: 'endTurn'};

export interface ParseEnv {
  battle: Battle;
  gen: Gen;
  mons: (MonSummary | null)[] | undefined;
}

type Phrase = 'crit' | 'faint' | 'miss' | 'immune' | 'recoil' | 'status' | 'sendOut' | 'lead' | 'go' | 'withdraw' | 'mega' | 'endTurn';

/** Game-text phrases, longest first so "critical hit" wins over "critical". */
const PHRASES: [string[], Phrase, Status?][] = ([
  ['critical hit', 'crit'], ['critical', 'crit'], ['crit', 'crit'],
  ['fainted', 'faint'], ['faints', 'faint'], ['knocked out', 'faint'], ['ko', 'faint'], ['k o', 'faint'],
  ['protected itself', 'miss'], ['protected', 'miss'], ['avoided the attack', 'miss'], ['avoided', 'miss'],
  ['missed', 'miss'], ['miss', 'miss'],
  ['doesnt affect', 'immune'], ['does not affect', 'immune'], ['didnt affect', 'immune'], ['no effect', 'immune'],
  ['unaffected', 'immune'], ['immune', 'immune'],
  ['lost some of its hp', 'recoil'], ['lost some hp', 'recoil'], ['lost some', 'recoil'],
  ['badly poisoned', 'status', 'tox'], ['poisoned', 'status', 'psn'], ['burned', 'status', 'brn'],
  ['paralyzed', 'status', 'par'], ['fell asleep', 'status', 'slp'], ['frozen', 'status', 'frz'],
  ['sent out', 'sendOut'], ['send out', 'sendOut'], ['sends out', 'sendOut'], ['brought out', 'sendOut'], ['brings out', 'sendOut'],
  // Said rather than read: "opponent sent Rillaboom and Corviknight", "I lead with Dragapult".
  ['sent', 'sendOut'], ['sends', 'sendOut'], ['sending', 'sendOut'],
  ['leads with', 'lead'], ['lead with', 'lead'], ['leading with', 'lead'], ['starts with', 'lead'], ['opens with', 'lead'],
  ['leads', 'lead'], ['leading', 'lead'], ['lead', 'lead'],
  ['go for it', 'go'], ['youre in charge', 'go'], ['go', 'go'],
  ['come back', 'withdraw'], ['went back', 'withdraw'], ['withdrew', 'withdraw'], ['switched out', 'withdraw'],
  ['mega evolved', 'mega'], ['mega evolves', 'mega'], ['mega evolution', 'mega'], ['mega evolve', 'mega'],
  ['end turn', 'endTurn'], ['end of turn', 'endTurn'], ['next turn', 'endTurn'], ['new turn', 'endTurn'],
  ['turn over', 'endTurn'], ['what will', 'endTurn'],
] as [string, Phrase, Status?][])
  .map(([p, kind, st]) => [p.split(' '), kind, st] as [string[], Phrase, Status?])
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

function phraseAt(words: string[], i: number): {kind: Phrase; len: number; status?: Status} | null {
  for (const [p, kind, status] of PHRASES) {
    if (p.every((w, k) => words[i + k] === w)) return {kind, len: p.length, status};
  }
  return null;
}

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

  /**
   * A Pokémon named at i. The game calls theirs "the opposing X"; without that, a species both
   * sides have is the one of the side being talked about, else yours.
   */
  const monAt = (i: number, prefer?: SideID): {ref: MonRef; len: number} | null => {
    const opposing = OPPOSING.has(words[i - 1] ?? '') || (words[i - 1] === 'the' && OPPOSING.has(words[i - 2] ?? ''));
    const mine = opposing ? null : nameAt(i, 'me');
    const theirs = nameAt(i, 'opp');
    const side = prefer ?? ctx;
    const m = mine && theirs
      ? (mine.score > theirs.score || (mine.score === theirs.score && side !== 'opp') ? mine : theirs)
      : mine ?? theirs;
    return m ? {ref: refOf(m.value), len: m.len} : null;
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
    [last, i] = [m.ref, m.at + m.len];
    const second = words[i] === 'and' ? sideAt(i + 1, m.ref.side) : null;
    if (second) {
      out.push({kind: 'sendOut', mon: second.ref});
      room[second.ref.side] = Math.max(0, room[second.ref.side] - 1);
      [last, i] = [second.ref, second.at + second.len];
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
  const abilityAt = (i: number, ref: MonRef) => {
    const m = ref.side === 'opp' ? env.mons?.[ref.slot] : undefined;
    const own = ref.side === 'me' ? [env.battle.myTeam[ref.slot]?.ability] : [
      ...(m?.abilities ?? []).filter(a => a.p > 0).map(a => a.name), ...Object.values(m?.megaAbilityOf ?? {}),
    ];
    const cands = own.filter((a): a is string => !!a).map(a => ({key: squash(a), value: a}));
    return matchAt(words, i, cands, 0.75, 0.06) ?? matchAt(words, i, every(env.gen, 'abilities'), 0.86, 0.03);
  };

  while (i < words.length) {
    if (OPPOSING.has(words[i])) ctx = 'opp';
    else if (MINE.has(words[i])) ctx = 'me';
    const ph = phraseAt(words, i);
    if (ph) {
      i += ph.len;
      switch (ph.kind) {
        case 'crit':
          out.push({kind: 'crit'});
          break;
        case 'faint':
          out.push({kind: 'faint', mon: last});
          break;
        case 'miss':
          out.push({kind: 'miss', mon: last});
          break;
        case 'recoil':
          out.push({kind: 'recoil', mon: last});
          break;
        case 'status':
          out.push({kind: 'status', mon: last, status: ph.status!});
          break;
        case 'immune': {
          // "It doesn't affect the opposing Salamence…"
          const m = nextMon(i, 4);
          if (m) {
            [last, i] = [m.ref, m.at + m.len];
            out.push({kind: 'immune', mon: m.ref});
          } else out.push({kind: 'immune', mon: last});
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
        case 'withdraw': {
          // "Come back, Salamence!" / "Salamence, come back!" / "withdrew Salamence"
          const m = nextMon(i, 3);
          if (m) [last, i] = [m.ref, m.at + m.len];
          const gone = m?.ref ?? last;
          if (gone && live.active[gone.side].includes(gone.slot)) room[gone.side]++;
          out.push({kind: 'withdraw', mon: gone});
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
      }
      continue;
    }

    const mon = monAt(i);
    if (mon) {
      [last, i] = [mon.ref, i + mon.len];
      // "X used Y" (but "X used its Quick Claw" is an item).
      let j = i;
      if (USED.has(words[j] ?? '')) j++;
      if (words[j] !== 'its' && words[j] !== 'their') {
        let mv = moveAt(j, mon.ref);
        if (mv && j === i && mv.score < 0.9) mv = null;
        // "used" misheard ("Rillaboom mus said Fake Out"): a move said exactly a word or two on still counts.
        for (let k = j + 1; !mv && j === i && k <= i + 2 && k < words.length; k++) {
          if (numberAt(words, k - 1) || monAt(k - 1)) break;
          const m = moveAt(k, mon.ref);
          if (m && m.score >= 0.9) [mv, j] = [m, k];
        }
        if (mv) {
          out.push({kind: 'use', actor: mon.ref, move: mv.value});
          i = j + mv.len;
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
      // "The opposing Salamence's Intimidate"
      const ab = abilityAt(i, mon.ref);
      if (ab) {
        out.push({kind: 'ability', mon: mon.ref, ability: ab.value});
        i += ab.len;
      } else if (benched(mon.ref) && room[mon.ref.side] > 0) {
        // A benched Pokémon named with a place free on its side has come in: the leads said plainly
        // ("opponent Rillaboom and Corviknight"), or who replaced one that fainted.
        out.push({kind: 'sendOut', mon: mon.ref});
        room[mon.ref.side]--;
      }
      continue;
    }

    const item = matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
    if (item) {
      // "The Occa Berry weakened the damage to the opposing X": the Pokémon comes after.
      let m = last;
      if (!m || words.slice(i + item.len, i + item.len + 2).includes('weakened')) m = nextMon(i + item.len, 7)?.ref ?? m;
      out.push({kind: 'item', mon: m, item: item.value});
      i += item.len;
      continue;
    }

    const num = numberAt(words, i);
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
