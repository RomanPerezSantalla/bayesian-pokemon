/**
 * The lines Pokémon Champions writes while a turn plays out, besides who used what (parse.ts has
 * those): stat changes, and the field starting and ending. Worded as the game's own text has them
 * (its English battle text, btl_set and btl_std, as dumped in github.com/projectpokemon/champout),
 * after norm(): "The opposing Garchomp's Attack harshly fell!", "Charizard and Incineroar's Attack
 * fell!", "A tailwind started blowing on the opposing side!", "Your side's Reflect wore off!".
 * Champions shows the weather on the field panel, so there's no "Rain continues to fall." line.
 */
import type {BoostID} from '../../../data/dex';
import type {Boosts, FieldCondition, SideID, Terrain, Weather} from '../../../engine/types';

export type SideNews = 'tailwind' | 'reflect' | 'lightScreen' | 'auroraVeil' | 'stealthRock' | 'spikes' | 'toxicSpikes' | 'stickyWeb';

/** What a line says about the field. `upkeep`: it's still going (a sandstorm hurting someone), not starting. */
export type FieldNews =
  | {what: 'weather'; value: Weather | null; upkeep?: boolean}
  | {what: 'terrain'; value: Terrain | null}
  | {what: 'trickRoom' | 'magicRoom' | 'wonderRoom' | 'gravity'; value: boolean}
  | {what: SideNews; value: boolean; side?: SideID};

const weather = (value: Weather | null, upkeep?: boolean): FieldNews => ({what: 'weather', value, upkeep});
const terrain = (value: Terrain | null): FieldNews => ({what: 'terrain', value});
const room = (what: 'trickRoom' | 'magicRoom' | 'wonderRoom' | 'gravity', value: boolean): FieldNews => ({what, value});
const side = (what: SideNews, value: boolean): FieldNews => ({what, value});

/** Where the line names whose side it is: "…blowing on the opposing side!" after, "Your side's Reflect wore off!" before. */
type Whose = 'after' | 'before';

const FIELD_LINES: [string[], FieldNews, Whose?][] = ([
  ['the sunlight turned harsh', weather('Sun')], ['sunlight turned harsh', weather('Sun')],
  ['the harsh sunlight faded', weather(null)], ['harsh sunlight faded', weather(null)], ['the sunlight faded', weather(null)],
  ['it started to rain', weather('Rain')], ['started to rain', weather('Rain')],
  ['the rain stopped', weather(null)], ['rain stopped', weather(null)],
  ['a sandstorm kicked up', weather('Sand')], ['sandstorm kicked up', weather('Sand')],
  ['the sandstorm subsided', weather(null)], ['sandstorm subsided', weather(null)],
  ['it started to snow', weather('Snow')], ['started to snow', weather('Snow')],
  ['the snow stopped', weather(null)], ['snow stopped', weather(null)],

  ['an electric current ran across the battlefield', terrain('Electric')], ['electric current ran across', terrain('Electric')],
  ['the electricity disappeared from the battlefield', terrain(null)], ['electricity disappeared', terrain(null)],
  ['grass grew to cover the battlefield', terrain('Grassy')], ['grass grew to cover', terrain('Grassy')],
  ['the grass disappeared from the battlefield', terrain(null)], ['grass disappeared', terrain(null)],
  ['mist swirled around the battlefield', terrain('Misty')], ['mist swirled around', terrain('Misty')], ['mist swirls around', terrain('Misty')],
  ['the mist disappeared from the battlefield', terrain(null)], ['mist disappeared', terrain(null)],
  ['the battlefield got weird', terrain('Psychic')], ['battlefield got weird', terrain('Psychic')],
  ['the weirdness disappeared from the battlefield', terrain(null)], ['weirdness disappeared', terrain(null)],

  ['twisted the dimensions', room('trickRoom', true)],
  ['the twisted dimensions returned to normal', room('trickRoom', false)], ['dimensions returned to normal', room('trickRoom', false)],
  ['held items lose their effects', room('magicRoom', true)], ['magic room wore off', room('magicRoom', false)],
  ['defense and sp def stats are swapped', room('wonderRoom', true)], ['defense and special defense stats are swapped', room('wonderRoom', true)],
  ['stats are swapped', room('wonderRoom', true)], ['wonder room wore off', room('wonderRoom', false)],
  ['gravity intensified', room('gravity', true)], ['gravity returned to normal', room('gravity', false)],

  ['a tailwind started blowing on', side('tailwind', true), 'after'], ['tailwind started blowing', side('tailwind', true), 'after'],
  ['tailwind petered out', side('tailwind', false), 'before'],
  ['reflect made', side('reflect', true), 'after'], ['reflect wore off', side('reflect', false), 'before'],
  ['light screen made', side('lightScreen', true), 'after'], ['light screen wore off', side('lightScreen', false), 'before'],
  ['aurora veil made', side('auroraVeil', true), 'after'], ['aurora veil wore off', side('auroraVeil', false), 'before'],
  ['pointed stones float in the air on', side('stealthRock', true), 'after'], ['pointed stones float in the air', side('stealthRock', true), 'after'],
  ['pointed stones disappeared from', side('stealthRock', false), 'after'],
  ['toxic spikes were scattered on the ground all around', side('toxicSpikes', true), 'after'],
  ['toxic spikes were scattered', side('toxicSpikes', true), 'after'],
  ['toxic spikes disappeared from the ground around', side('toxicSpikes', false), 'after'],
  ['toxic spikes disappeared', side('toxicSpikes', false), 'after'],
  ['spikes were scattered on the ground all around', side('spikes', true), 'after'], ['spikes were scattered', side('spikes', true), 'after'],
  ['spikes disappeared from the ground around', side('spikes', false), 'after'], ['spikes disappeared', side('spikes', false), 'after'],
  ['a sticky web has been laid out on the ground on', side('stickyWeb', true), 'after'],
  ['sticky web has been laid out', side('stickyWeb', true), 'after'],
  ['sticky web has disappeared from the ground on', side('stickyWeb', false), 'after'],
  ['sticky web has disappeared', side('stickyWeb', false), 'after'],
] as [string, FieldNews, Whose?][])
  .map(([p, news, whose]) => [p.split(' '), news, whose] as [string[], FieldNews, Whose?])
  .sort((a, b) => b[0].length - a[0].length);

const THEIRS = new Set(['opposing', 'opponent', 'opponents', 'foe', 'foes', 'enemy', 'their']);
const OURS = new Set(['your', 'yours', 'my', 'our']);
const TEAM = new Set(['team', 'teams', 'side', 'sides']);

const starts = (words: string[], i: number, p: string[]) => p.every((w, k) => words[i + k] === w);

/** A line about the field at `i`, and the words it took (with whose side it named). */
export function fieldAt(words: string[], i: number): {news: FieldNews; len: number} | null {
  for (const [p, news, whose] of FIELD_LINES) {
    if (!starts(words, i, p)) continue;
    let len = p.length;
    if (!whose) return {news, len};
    let who: SideID | undefined;
    if (whose === 'after') {
      // "…on the opposing side!", "…all around your side!"
      for (let j = i + len; j < Math.min(words.length, i + len + 6); j++) {
        who ??= THEIRS.has(words[j]) ? 'opp' : OURS.has(words[j]) ? 'me' : undefined;
        if (TEAM.has(words[j])) {
          len = j + 1 - i;
          break;
        }
      }
    } else {
      // "The opposing side's tailwind petered out!": the nearest word before that says whose.
      for (let j = i - 1; j >= Math.max(0, i - 3) && !who; j--) who = THEIRS.has(words[j]) ? 'opp' : OURS.has(words[j]) ? 'me' : undefined;
    }
    return {news: {...news, side: who} as FieldNews, len};
  }
  return null;
}

/** Does the field already say so? */
export function fieldAgrees(f: FieldCondition, n: FieldNews): boolean {
  switch (n.what) {
    case 'weather':
      return (f.weather ?? null) === n.value;
    case 'terrain':
      return (f.terrain ?? null) === n.value;
    case 'trickRoom': case 'magicRoom': case 'wonderRoom': case 'gravity':
      return !!f[n.what] === n.value;
    default: {
      if (!n.side) return false;
      const v = f[n.side][n.what];
      return (typeof v === 'number' ? v > 0 : !!v) === n.value;
    }
  }
}

/** How long a condition lasts once it starts, when nothing (a rock, Light Clay) is known to stretch it. */
const LASTS: Partial<Record<string, number>> = {tailwind: 4, reflect: 5, lightScreen: 5, auroraVeil: 5};

/** Make the field say so. A weather that carries on without being tracked has an unknown number of turns left. */
export function applyNews(f: FieldCondition, n: FieldNews) {
  const turns = {...(f.turns ?? {})};
  switch (n.what) {
    case 'weather':
      if (!n.value) delete turns.weather;
      else if (n.value !== f.weather) {
        if (n.upkeep) delete turns.weather;
        else turns.weather = 5;
      }
      f.weather = n.value ?? undefined;
      break;
    case 'terrain':
      if (!n.value) delete turns.terrain;
      else if (n.value !== f.terrain) turns.terrain = 5;
      f.terrain = n.value ?? undefined;
      break;
    case 'trickRoom': case 'magicRoom': case 'wonderRoom': case 'gravity':
      if (!n.value) delete turns[n.what];
      else if (!f[n.what]) turns[n.what] = 5;
      f[n.what] = n.value;
      break;
    default: {
      if (!n.side) break;
      const s = {...f[n.side]};
      const key = `${n.side}.${n.what}`;
      if (n.what === 'spikes' || n.what === 'toxicSpikes') s[n.what] = n.value ? Math.max(1, s[n.what] ?? 0) : 0;
      else {
        if (!n.value) delete turns[key];
        else if (!s[n.what] && LASTS[n.what]) turns[key] = LASTS[n.what]!;
        s[n.what] = n.value;
      }
      f[n.side] = s;
    }
  }
  f.turns = turns;
}

// --- stat changes ------------------------------------------------------------------

const STAT_WORDS: [string[], BoostID[]][] = ([
  ['special attack', ['spa']], ['sp attack', ['spa']], ['sp atk', ['spa']], ['spatk', ['spa']], ['special attacks', ['spa']],
  ['special defense', ['spd']], ['special defence', ['spd']], ['sp defense', ['spd']], ['sp def', ['spd']], ['spdef', ['spd']],
  ['attack', ['atk']], ['defense', ['def']], ['defence', ['def']], ['speed', ['spe']],
  // Not tracked, but still a stat change: read and let go.
  ['accuracy', []], ['evasiveness', []], ['evasion', []],
  ['stats', ['atk', 'def', 'spa', 'spd', 'spe']],
] as [string, BoostID[]][])
  .map(([p, ids]) => [p.split(' '), ids] as [string[], BoostID[]])
  .sort((a, b) => b[0].length - a[0].length);

/** "Attack", "Defense and Sp. Def", "Attack, Sp. Atk, and Speed" (commas are gone after norm()). */
export function statsAt(words: string[], i: number): {stats: BoostID[]; len: number} | null {
  const at = (k: number) => STAT_WORDS.find(([p]) => starts(words, k, p));
  const stats: BoostID[] = [];
  let j = i;
  let hit = at(j);
  while (hit) {
    stats.push(...hit[1]);
    j += hit[0].length;
    const k = words[j] === 'and' ? j + 1 : j;
    hit = at(k);
    if (hit) j = k;
  }
  return j > i ? {stats, len: j - i} : null;
}

/**
 * How far a stat went, in the game's words: "rose sharply" is +2, "harshly fell" −2, "won't go any
 * higher" means it's at +6 already.
 */
const CHANGES: [string[], number, boolean?][] = ([
  ['rose drastically', 3], ['rose sharply', 2], ['rose', 1],
  ['severely fell', -3], ['harshly fell', -2], ['fell', -1],
  ['wont go any higher', 1, true], ['wont go any lower', -1, true],
  // Unchanged: "…'s Attack was not lowered!", "…'s stats were not lowered!" (Clear Body and the like).
  ['was not lowered', 0], ['were not lowered', 0],
  // How the recogniser can hear them.
  ['rows', 1], ['rose sharp', 2], ['harsh fell', -2], ['harshly fall', -2], ['fall', -1], ['felt', -1],
  ['won t go any higher', 1, true], ['won t go any lower', -1, true], ['wont go higher', 1, true], ['wont go lower', -1, true],
] as [string, number, boolean?][])
  .map(([p, by, limit]) => [p.split(' '), by, limit] as [string[], number, boolean?])
  .sort((a, b) => b[0].length - a[0].length);

/**
 * A stat change at `i`, after the Pokémon's name: the stats and how far they went. `limit`: it
 * couldn't go further (so it's at ±6). Empty `boosts`: a line to read past (a stat that isn't
 * tracked, or one that didn't change).
 */
export function statAt(words: string[], i: number): {boosts: Boosts; limit?: boolean; len: number} | null {
  const s = statsAt(words, i);
  if (!s) return null;
  const j = i + s.len;
  const ch = CHANGES.find(([p]) => starts(words, j, p));
  if (!ch) return null;
  const boosts: Boosts = {};
  if (ch[1]) for (const id of s.stats) boosts[id] = ch[1];
  return {boosts, limit: ch[2], len: s.len + ch[0].length};
}
