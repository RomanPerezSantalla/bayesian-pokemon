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
import {matchAt, norm, numberAt, squash, type Named} from './text';

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

type Phrase = 'crit' | 'faint' | 'miss' | 'immune' | 'recoil' | 'status' | 'sendOut' | 'go' | 'withdraw' | 'mega' | 'endTurn';

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
  ['sent out', 'sendOut'], ['send out', 'sendOut'], ['sends out', 'sendOut'],
  ['go for it', 'go'], ['youre in charge', 'go'], ['go', 'go'],
  ['come back', 'withdraw'], ['went back', 'withdraw'], ['withdrew', 'withdraw'], ['switched out', 'withdraw'],
  ['mega evolved', 'mega'], ['mega evolves', 'mega'], ['mega evolution', 'mega'], ['mega evolve', 'mega'],
  ['end turn', 'endTurn'], ['end of turn', 'endTurn'], ['next turn', 'endTurn'], ['new turn', 'endTurn'],
  ['turn over', 'endTurn'], ['what will', 'endTurn'],
] as [string, Phrase, Status?][])
  .map(([p, kind, st]) => [p.split(' '), kind, st] as [string[], Phrase, Status?])
  .sort((a, b) => b[0].length - a[0].length);

const OPPOSING = new Set(['opposing', 'opponent', 'opponents', 'foe', 'foes', 'enemy', 'their', 'rival', 'wild']);
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
function monNames(env: ParseEnv, side: SideID): Named<string>[] {
  const out: Named<string>[] = [];
  const active = env.battle.live.active[side];
  const add = (slot: number, name: string | undefined) => {
    if (name) out.push({key: squash(name), value: `${side}${slot}`, bonus: active.includes(slot) ? 0.04 : 0});
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
      for (const f of env.mons?.[slot]?.formes ?? []) if (f.p > 0 && /-Mega/.test(f.name)) add(slot, spokenName(f.name));
    });
  }
  return out;
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

  /** A Pokémon named at i. The game calls theirs "the opposing X"; without it, a species both sides have is yours. */
  const monAt = (i: number, prefer?: SideID): {ref: MonRef; len: number} | null => {
    const opposing = OPPOSING.has(words[i - 1] ?? '') || (words[i - 1] === 'the' && OPPOSING.has(words[i - 2] ?? ''));
    const mine = opposing ? null : matchAt(words, i, names.me);
    const theirs = matchAt(words, i, names.opp);
    const m = mine && theirs
      ? (mine.score > theirs.score || (mine.score === theirs.score && prefer !== 'opp') ? mine : theirs)
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

  let i = 0;
  while (i < words.length) {
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
          const m = nextMon(i, 5, 'opp');
          if (m) {
            [last, i] = [m.ref, m.at + m.len];
            out.push({kind: 'sendOut', mon: m.ref});
          }
          break;
        }
        case 'go': {
          // "Go! Garchomp!"
          const m = monAt(i, 'me');
          if (m && m.ref.side === 'me') {
            [last, i] = [m.ref, i + m.len];
            out.push({kind: 'sendOut', mon: m.ref});
          }
          break;
        }
        case 'withdraw': {
          // "Come back, Salamence!" / "Salamence, come back!" / "withdrew Salamence"
          const m = nextMon(i, 3);
          if (m) [last, i] = [m.ref, m.at + m.len];
          out.push({kind: 'withdraw', mon: m?.ref ?? last});
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
        const mv = moveAt(j, mon.ref);
        if (mv && (j > i || mv.score >= 0.9)) {
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
