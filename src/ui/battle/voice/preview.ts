/**
 * Team preview by voice: their six as you see them ("Rillaboom, Sneasler, Salamence…"), then yours
 * in the order you pick them on the Switch, which gives the ones you bring and your leads. Their
 * names are matched against every Pokémon in the format (not just a few on the field, as in a
 * battle), so formes get their spoken names ("Alolan Ninetales", "Wash Rotom") and usage breaks
 * near-ties. A battle line ("…sent out…", "Go! …") means the battle has started.
 */
import type {Gen} from '../../../data/dex';
import type {FormatData} from '../../../data/format';
import type {PokemonSet} from '../../../data/paste';
import {toID} from '../../../data/dex';
import {HEARD_AS} from './heard';
import {COMMON_WORDS, matchAt, norm, rankAt, squash, type MatchOptions, type Named} from './text';

/** What's been picked so far: their preview names, and your team slots in pick order (null: not said yet). */
export interface Picks {
  theirs: string[];
  mine: number[] | null;
  /** Whose was picked last, for "scratch that" in a later phrase. */
  last?: Side;
}

export interface PreviewEnv {
  fmt: FormatData;
  gen: Gen;
  team: PokemonSet[];
  /** How many of yours are brought (4 in Doubles, 3 in Singles). */
  bring: number;
}

/** Words heard that are probably one of a few Pokémon: offered to tap rather than guessed. */
export interface Unsure {
  heard: string;
  side: 'theirs' | 'mine';
  /** Preview names (theirs) or team slots (mine), likeliest first. */
  options: (string | number)[];
}

export interface PreviewRead {
  picks: Picks;
  /** What each part of the phrase did, for the screen. */
  said: string[];
  /** Pokémon heard that changed nothing, and why ("Froslass is in already"). */
  notes: string[];
  unsure: Unsure[];
  /** A line from the battle itself was heard: it has started. */
  battle: boolean;
  /**
   * Whose Pokémon were being said at the end, when the phrase said so ("mine…") or named one of
   * them: to carry on into the next phrase. Null otherwise, so a side said once doesn't stick.
   */
  side: Side | null;
}

export type Side = 'theirs' | 'mine';


/** Your six: few enough to let badly heard names through ("dragon ball" for Dragapult). */
const MINE_OPTS: MatchOptions = {consonants: true, stop: COMMON_WORDS, prefix: true};
/** Every Pokémon in the format: only close matches, the rest offered to tap. */
const THEIRS_OPTS: MatchOptions = {stop: COMMON_WORDS};

const REGION: Record<string, [string, string]> = {
  Alola: ['alolan', 'alola'], Galar: ['galarian', 'galar'], Hisui: ['hisuian', 'hisui'], Paldea: ['paldean', 'paldea'],
};
const GENDER: Record<string, string[]> = {F: ['female'], M: ['male']};

/** The ways a preview name can be said: "Ninetales-Alola" is "Alolan Ninetales" or "Ninetales Alola". */
export function spokenNames(name: string): string[] {
  const [base, ...rest] = name.split('-');
  // "Kommo-o": the dash is part of the name.
  if (!rest.length || rest.every(r => r.length === 1 && !GENDER[r])) return [name];
  const words = rest.map(r => REGION[r] ?? GENDER[r] ?? [r.toLowerCase()]);
  // Nobody says "Basculegion F" (and written so it's a letter off plain Basculegion); "Ninetales Alola", yes.
  const out = new Set(rest.some(r => GENDER[r]) ? [] : [name]);
  out.add(`${words.map(w => w[0]).join(' ')} ${base}`);
  out.add(`${base} ${words.map(w => w[w.length - 1]).join(' ')}`);
  // "Aqua Tauros" for Tauros-Paldea-Aqua: the last part alone, either side.
  const last = words[words.length - 1];
  for (const w of last) {
    out.add(`${w} ${base}`);
    out.add(`${base} ${w}`);
  }
  return [...out];
}

const theirCache = new WeakMap<FormatData, Named<string>[]>();

/** Every Pokémon at this format's team preview, by every way of saying it, the more used a little ahead. */
function theirNames(fmt: FormatData): Named<string>[] {
  let c = theirCache.get(fmt);
  if (c) return c;
  const names = Object.keys(fmt.preview);
  const top = Math.max(...names.map(n => fmt.previewUsage[n] ?? 0), 1e-9);
  const byBase = new Map<string, string[]>();
  for (const n of names) {
    const base = n.split('-')[0];
    if (base !== n) byBase.set(base, [...(byBase.get(base) ?? []), n]);
  }
  const bonus = (n: string) => 0.03 * Math.sqrt((fmt.previewUsage[n] ?? 0) / top);
  // A Pokémon with a female forme too (Indeedee, Basculegion) is said plain for both: the plain name
  // goes to the one used more here, and the other needs "female" / "male".
  const plainFor = new Map<string, string>();
  for (const n of names) {
    const [base, suffix, ...more] = n.split('-');
    if (!more.length && GENDER[suffix] && names.includes(base)) {
      plainFor.set(base, (fmt.previewUsage[n] ?? 0) > (fmt.previewUsage[base] ?? 0) ? n : base);
    }
  }
  c = names.flatMap(n => {
    const said = plainFor.has(n) ? [`male ${n}`, ...(plainFor.get(n) === n ? [n] : [])] : spokenNames(n);
    return [...said, ...(HEARD_AS[n] ?? [])].map(s => ({key: squash(s), value: n, bonus: bonus(n)}));
  });
  for (const [base, n] of plainFor) if (n !== base) c.push({key: squash(base), value: n, bonus: bonus(n)});
  // A forme that's the only one of its kind here goes by the plain name too (Floette for Floette-Eternal).
  for (const [base, formes] of byBase) {
    if (formes.length === 1 && !names.includes(base)) c.push({key: squash(base), value: formes[0], bonus: bonus(formes[0])});
  }
  theirCache.set(fmt, c);
  return c;
}

/**
 * Commands the voice model listens out for as well ("No, not that" came out "No, nothing I").
 * Not "clear", "reset", "mine" or "theirs": short words, which it found in lines without them.
 */
const COMMANDS_HEARD = ['not that', 'scratch that', 'remove that', 'delete that'];

/** What can be said at team preview, for the voice model to listen out for: every Pokémon here by name, and yours. */
export function previewPhrases(env: PreviewEnv): string[] {
  const out = new Set<string>(COMMANDS_HEARD);
  for (const n of Object.keys(env.fmt.preview)) for (const s of spokenNames(n)) out.add(s);
  for (const set of env.team) {
    const base = env.gen.species.get(toID(set.species))?.baseSpecies;
    for (const n of [set.species, set.nickname, base]) if (n) for (const s of spokenNames(n)) out.add(s);
  }
  // Indeedee-F and the like are said plain.
  for (const s of [...out]) {
    const plain = s.replace(/^(?:female|male) | (?:female|male)$/i, '');
    if (plain !== s) out.add(plain);
  }
  return [...out];
}

function myNames(env: PreviewEnv): Named<number>[] {
  return env.team.flatMap((set, slot) => {
    const base = env.gen.species.get(toID(set.species))?.baseSpecies;
    return [set.species, set.nickname, base]
      .filter((n): n is string => !!n)
      .flatMap(n => spokenNames(n))
      .map(n => ({key: squash(n), value: slot}));
  });
}

const THEIRS = new Set(['theirs', 'their', 'they', 'opponent', 'opponents', 'opposing', 'enemy', 'foe', 'versus', 'vs', 'against']);
// Not "I" or "me" on their own: the recogniser hears them in anything ("An I' Froslass").
const MINE = new Set(['mine', 'my', 'our', 'ours', 'bringing', 'bring', 'brought', 'picking', 'pick', 'picked', 'leading']);
const UNDO = [['undo'], ['scratch', 'that'], ['not', 'that'], ['remove', 'that'], ['delete', 'that']];
const CLEAR = [['clear'], ['start', 'over'], ['reset']];
const BATTLE = [['sent'], ['sends'], ['send', 'out'], ['what', 'will'], ['start', 'battle'], ['start', 'the', 'battle'], ['lets', 'battle']];

const phraseAt = (words: string[], i: number, list: string[][]) => list.find(p => p.every((w, k) => words[i + k] === w));

/** The species a Pokémon is a forme of ("Goodra-Hisui", "Metagross-Mega": Goodra, Metagross), as an ID. */
function speciesOf(gen: Gen, name: string): string {
  const sp = gen.species.get(toID(name));
  return sp ? toID(sp.baseSpecies ?? sp.name) : toID(name);
}

/**
 * Their picks with `name` added. Another forme of one already there replaces it, never joins it: a
 * team has one of each species (Species Clause), so "Goodra", then "Hisuian Goodra", or the other
 * way round, is going back on it. The one said last goes last, for "scratch that".
 */
export function addTheirs(theirs: readonly string[], name: string, gen: Gen): {theirs: string[]; said?: string; note?: string} {
  if (theirs.includes(name)) return {theirs: [...theirs], note: `${name} is in already`};
  const k = theirs.findIndex(t => speciesOf(gen, t) === speciesOf(gen, name));
  if (k >= 0) return {theirs: [...theirs.filter((_, j) => j !== k), name], said: `${theirs[k]} → ${name}`};
  if (theirs.length >= 6) return {theirs: [...theirs], note: `their six are in already, not ${name}`};
  return {theirs: [...theirs, name], said: name};
}

/** `side`: whose Pokémon the phrase before was about, if it was just now ("I brought…" then a pause). */
export function readPreview(text: string, picks: Picks, env: PreviewEnv, side: Side | null = null): PreviewRead {
  const words = norm(text).split(' ').filter(Boolean);
  let theirs = [...picks.theirs];
  let mine = picks.mine ? [...picks.mine] : null;
  let last = picks.last;
  const said: string[] = [];
  const notes: string[] = [];
  const unsure: Unsure[] = [];
  let battle = false;
  /** A side said in this phrase, and whether it was said or used (a Pokémon named on it). */
  let told = false;
  let meant = false;
  // Theirs until their six are in, then yours; "mine…" / "theirs…" say otherwise.
  const current = () => side ?? (theirs.length < 6 ? 'theirs' : 'mine');
  const cands = theirNames(env.fmt);
  const mineNames = myNames(env);
  const mineLabel = (slot: number) => env.team[slot]?.nickname || env.team[slot]?.species || '?';
  // Your slot for a species ("Metagross" at preview is your Metagross-Mega).
  const mySlot = new Map<string, number>();
  env.team.forEach((set, slot) => {
    const s = speciesOf(env.gen, set.species);
    if (!mySlot.has(s)) mySlot.set(s, slot);
  });
  const takeTheirs = (name: string) => {
    const r = addTheirs(theirs, name, env.gen);
    theirs = r.theirs;
    if (r.said) {
      said.push(r.said);
      last = 'theirs';
    }
    if (r.note) notes.push(r.note);
  };
  const takeMine = (slot: number) => {
    mine ??= [];
    if (mine.includes(slot)) notes.push(`your ${mineLabel(slot)} is in already`);
    else if (mine.length >= env.bring) notes.push(`your ${env.bring} are in already, not ${mineLabel(slot)}`);
    else {
      mine.push(slot);
      said.push(`your ${mineLabel(slot)}`);
      last = 'mine';
    }
  };

  let i = 0;
  while (i < words.length) {
    const w = words[i];
    let p: string[] | undefined;
    if ((p = phraseAt(words, i, BATTLE)) || (w === 'go' && matchAt(words, i + 1, mineNames))) {
      battle = true;
      break;
    }
    if ((p = phraseAt(words, i, UNDO))) {
      // The last one picked, whichever side, unless this phrase said whose.
      const from = told ? current() : last ?? current();
      if (from === 'theirs' && theirs.length) said.push(`took back ${theirs.pop()}`);
      else if (from === 'mine' && mine?.length) said.push(`took back your ${mineLabel(mine.pop()!)}`);
      i += p.length;
      continue;
    }
    if ((p = phraseAt(words, i, CLEAR))) {
      if (current() === 'theirs') theirs.length = 0;
      else mine = [];
      said.push(current() === 'theirs' ? 'cleared theirs' : 'cleared yours');
      i += p.length;
      continue;
    }
    if (THEIRS.has(w) || MINE.has(w)) {
      side = THEIRS.has(w) ? 'theirs' : 'mine';
      told = meant = true;
      i++;
      continue;
    }
    if (current() === 'theirs') {
      const m = matchAt(words, i, cands, 0.72, 0.08, THEIRS_OPTS);
      if (m) {
        takeTheirs(m.value);
        if (side) meant = true;
        i += m.len;
        continue;
      }
      // Not sure: the likeliest few, ranked by sound as well, to tap.
      const ranked = rankAt(words, i, cands, {...THEIRS_OPTS, consonants: true}).filter(r => !theirs.includes(r.value));
      if (ranked[0] && ranked[0].score >= 0.62) {
        const top = ranked[0];
        unsure.push({heard: words.slice(i, i + top.len).join(' '), side: 'theirs', options: ranked.filter(r => r.score >= top.score - 0.15).slice(0, 3).map(r => r.value)});
        i += top.len;
        continue;
      }
    } else {
      const t = matchAt(words, i, cands, 0.72, 0.08, THEIRS_OPTS);
      const m = matchAt(words, i, mineNames, 0.6, 0.12, MINE_OPTS);
      const slot = t ? mySlot.get(speciesOf(env.gen, t.value)) : undefined;
      // A Pokémon that isn't on your team can only be theirs, "mine…" or not: "annihilate" is
      // Annihilape, not a stretch for your Indeedee.
      if (t && slot === undefined && (!m || t.score > m.score)) {
        takeTheirs(t.value);
        i += t.len;
        continue;
      }
      if (m || (t && slot !== undefined)) {
        takeMine(m ? m.value : slot!);
        if (side) meant = true;
        i += m ? m.len : t!.len;
        continue;
      }
      const ranked = rankAt(words, i, mineNames, MINE_OPTS).filter(r => !(mine ?? []).includes(r.value));
      if (ranked[0] && ranked[0].score >= 0.5) {
        const top = ranked[0];
        unsure.push({heard: words.slice(i, i + top.len).join(' '), side: 'mine', options: ranked.filter(r => r.score >= top.score - 0.15).slice(0, 3).map(r => r.value)});
        i += top.len;
        continue;
      }
    }
    i++;
  }
  return {picks: {theirs, mine, last}, said, notes, unsure, battle, side: meant ? side : null};
}
