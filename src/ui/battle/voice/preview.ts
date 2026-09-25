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
import {COMMON_WORDS, matchAt, norm, rankAt, squash, type MatchOptions, type Named} from './text';

/** What's been picked so far: their preview names, and your team slots in pick order (null: not said yet). */
export interface Picks {
  theirs: string[];
  mine: number[] | null;
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
  unsure: Unsure[];
  /** A line from the battle itself was heard: it has started. */
  battle: boolean;
  /** Whose Pokémon were being said at the end ("mine…"), to carry on into the next phrase. */
  side: Side | null;
}

export type Side = 'theirs' | 'mine';

/**
 * How the recogniser has heard some names in real tests. Among every Pokémon in the format there's
 * no telling these apart by sound ("carbonite" is as close to Scrafty as to Corviknight).
 */
const HEARD_AS: Record<string, string[]> = {
  Corviknight: ['carbonite', 'curvonite', 'corby night', 'curvy night'],
  Rillaboom: ['really boom', 'relay boom', 'villa boom', 'relabum'],
  Gholdengo: ['gardenia', 'gardeno', 'golden go'],
  Pidgeot: ['idiot', 'pidgeotto'],
  Dragapult: ['dragon ball', 'dragon pult'],
  Milotic: ['celtic'],
  Altaria: ['alitalia'],
};

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

/** What can be said at team preview, for the voice model to listen out for: every Pokémon here by name, and yours. */
export function previewPhrases(env: PreviewEnv): string[] {
  const out = new Set<string>();
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
const MINE = new Set(['mine', 'my', 'me', 'i', 'im', 'ill', 'we', 'our', 'bringing', 'bring', 'brought', 'picking', 'pick', 'picked', 'leading']);
const UNDO = [['undo'], ['scratch', 'that'], ['not', 'that'], ['remove', 'that'], ['delete', 'that']];
const CLEAR = [['clear'], ['start', 'over'], ['reset']];
const BATTLE = [['sent'], ['sends'], ['send', 'out'], ['what', 'will'], ['start', 'battle'], ['start', 'the', 'battle'], ['lets', 'battle']];

const phraseAt = (words: string[], i: number, list: string[][]) => list.find(p => p.every((w, k) => words[i + k] === w));

/** `side`: whose Pokémon the phrase before was about, if it was just now ("I brought…" then a pause). */
export function readPreview(text: string, picks: Picks, env: PreviewEnv, side: Side | null = null): PreviewRead {
  const words = norm(text).split(' ').filter(Boolean);
  const theirs = [...picks.theirs];
  let mine = picks.mine ? [...picks.mine] : null;
  const said: string[] = [];
  const unsure: Unsure[] = [];
  let battle = false;
  // Theirs until their six are in, then yours; "mine…" / "theirs…" say otherwise.
  const current = () => side ?? (theirs.length < 6 ? 'theirs' : 'mine');
  const mineNames = myNames(env);
  const mineLabel = (slot: number) => env.team[slot]?.nickname || env.team[slot]?.species || '?';

  let i = 0;
  while (i < words.length) {
    const w = words[i];
    let p: string[] | undefined;
    if ((p = phraseAt(words, i, BATTLE)) || (w === 'go' && matchAt(words, i + 1, mineNames))) {
      battle = true;
      break;
    }
    if ((p = phraseAt(words, i, UNDO))) {
      if (current() === 'theirs' && theirs.length) said.push(`took back ${theirs.pop()}`);
      else if (current() === 'mine' && mine?.length) said.push(`took back your ${mineLabel(mine.pop()!)}`);
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
    if (THEIRS.has(w)) {
      side = 'theirs';
      i++;
      continue;
    }
    if (MINE.has(w)) {
      side = 'mine';
      i++;
      continue;
    }
    if (current() === 'theirs') {
      const cands = theirNames(env.fmt);
      const m = matchAt(words, i, cands, 0.72, 0.08, THEIRS_OPTS);
      if (m) {
        if (!theirs.includes(m.value) && theirs.length < 6) {
          theirs.push(m.value);
          said.push(m.value);
        }
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
      const m = matchAt(words, i, mineNames, 0.6, 0.12, MINE_OPTS);
      if (m) {
        mine ??= [];
        if (!mine.includes(m.value) && mine.length < env.bring) {
          mine.push(m.value);
          said.push(`your ${mineLabel(m.value)}`);
        }
        i += m.len;
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
  return {picks: {theirs, mine}, said, unsure, battle, side};
}
