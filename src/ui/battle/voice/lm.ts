/**
 * The language model's side of voice (a fine-tuned FunctionGemma 270M): what it's shown, and what its
 * answer is taken to mean. It's shown the battle (who's out: *, and Mega) or team preview, what the
 * phrase before did ("before"), and the phrase. It answers one action per line:
 *
 *   use me:Lopunny Fake Out > opp:Bellibolt     hp opp:Bellibolt 84      switch opp:Froslass > opp:Incineroar
 *   in opp:Froslass    out opp:Froslass    drag opp:X    mega me:Lopunny [X]    ability opp:Incineroar Intimidate
 *   item opp:Bellibolt Sitrus Berry [gone]    stat opp:Kingambit atk +2 | max    unchanged me:Lopunny atk
 *   cant opp:X [par]    status opp:X brn    cure opp:X    faint opp:X    crit [opp:X]    miss [opp:X]
 *   protect opp:X    immune [opp:X]    fail    hits 3    endturn    first me:X [opp:Y]    last me:X [opp:Y]
 *   field rain | field tailwind opp | field trickroom end
 *   undo: what the phrase before did was wrong, so it's taken back (the right version follows)
 *   team preview: add opp:X    remove opp:X | me:X    bring me:X    clear opp | me    start
 *   none
 *
 * The model interprets; the rules stay the app's. Every line is checked against what can be (a
 * Pokémon on the field or the team, a move, ability or item it can have, a field effect there is) and
 * anything else is dropped, never guessed at.
 */
import LEGAL_ABILITIES from '../../../data/abilities.gen.json';
import {toID, type BoostID, type Gen} from '../../../data/dex';
import type {FormatData} from '../../../data/format';
import {megaFormeOf} from '../../../engine/likelihood';
import type {Battle, Boosts, MonRef, SideID, Status} from '../../../engine/types';
import type {FieldNews, SideNews} from './messages';
import type {VoiceEvent} from './parse';
import {addTheirs, type Picks, type PreviewEnv, type PreviewRead, type Side} from './preview';
import {norm, similarity, squash} from './text';

// --- what it's shown ------------------------------------------------------------------------------

export interface Shown {
  name: string;
  out?: boolean;
  mega?: boolean;
}

const listed = (label: string, names: readonly string[]) => `${label}:${names.length ? ` ${names.join(', ')}` : ''}`;
const beforeLine = (before: readonly string[]) => (before.length ? `\nbefore: ${before.join(' | ')}` : '');

/** The battle: yours (as brought) and theirs, the ones out first (*), Mega marked. */
export function battleContext(me: readonly Shown[], opp: readonly Shown[], before: readonly string[] = []): string {
  const side = (ms: readonly Shown[]) =>
    [...ms.filter(m => m.out), ...ms.filter(m => !m.out)].map(m => `${m.name}${m.out ? '*' : ''}${m.mega ? ' Mega' : ''}`);
  return `${listed('me', side(me))}\n${listed('opp', side(opp))}${beforeLine(before)}`;
}

/** Both sides of a battle as the model is shown them, the ones out in the order they stand. */
export function battleShown(b: Battle): {me: Shown[]; opp: Shown[]} {
  const side = (s: SideID): Shown[] => {
    const all = s === 'me' ? (b.brought ?? b.myTeam.map((_, i) => i)) : b.oppPreview.map((_, i) => i);
    const out = b.live.active[s].filter((x): x is number => x !== null && all.includes(x));
    return [...out, ...all.filter(x => !out.includes(x))].map(slot => ({
      name: s === 'me' ? b.myTeam[slot].species : b.oppPreview[slot],
      out: out.includes(slot),
      mega: !!b.live.mons[`${s}${slot}`]?.mega,
    }));
  };
  return {me: side('me'), opp: side('opp')};
}

/** Team preview: your six, the ones you've picked to bring (in order: the first are your leads), theirs so far. */
export function previewContext(team: readonly string[], bring: number, picked: readonly string[], theirs: readonly string[], before: readonly string[] = []): string {
  return `team preview\n${listed('me', team)}\n${listed(`bring ${bring}`, picked)}\n${listed('opp', theirs)}${beforeLine(before)}`;
}

/** The whole input, in FunctionGemma's chat format. */
export const modelInput = (context: string, said: string) => `<start_of_turn>user\n${context}\nsaid: ${said}<end_of_turn>\n<start_of_turn>model\n`;

// --- what its answer means ------------------------------------------------------------------------

/** What's known to check a line against. */
export interface Known {
  gen: Gen;
  fmt?: FormatData;
  /** Whether a species can learn a move. Without it, only that the move exists is checked (for theirs). */
  learns?: (species: string, move: string) => boolean;
  /** Your Pokémon's max HP (yours are said in HP, theirs in %). */
  maxHp?: (ref: MonRef) => number;
}

export interface Dropped {
  line: string;
  why: string;
}

export interface BattleAnswer {
  /** Take back what the phrase before did, first. */
  undo: boolean;
  events: VoiceEvent[];
  /** The lines kept, names as the app has them: "before" next time. */
  lines: string[];
  dropped: Dropped[];
}

const BOOSTS = new Set<string>(['atk', 'def', 'spa', 'spd', 'spe']);
const STATUSES = new Set<string>(['brn', 'par', 'psn', 'tox', 'slp', 'frz']);
const CANT = new Set<string>(['par', 'slp', 'frz']);
const WEATHER: Record<string, FieldNews> = {
  rain: {what: 'weather', value: 'Rain'}, sun: {what: 'weather', value: 'Sun'}, sand: {what: 'weather', value: 'Sand'},
  snow: {what: 'weather', value: 'Snow'},
};
const TERRAIN: Record<string, FieldNews> = {
  electric: {what: 'terrain', value: 'Electric'}, grassy: {what: 'terrain', value: 'Grassy'},
  psychic: {what: 'terrain', value: 'Psychic'}, misty: {what: 'terrain', value: 'Misty'},
};
const ROOMS: Record<string, 'trickRoom' | 'magicRoom' | 'wonderRoom' | 'gravity'> = {
  trickroom: 'trickRoom', magicroom: 'magicRoom', wonderroom: 'wonderRoom', gravity: 'gravity',
};
const SIDES: Record<string, SideNews> = {
  tailwind: 'tailwind', reflect: 'reflect', lightscreen: 'lightScreen', auroraveil: 'auroraVeil',
  stealthrock: 'stealthRock', spikes: 'spikes', toxicspikes: 'toxicSpikes', stickyweb: 'stickyWeb',
};
const PREVIEW_VERBS = new Set(['add', 'remove', 'bring', 'clear', 'start']);

/** "rain", "tailwind opp", "trickroom end", "weather end": the narrator's field news, or why not. */
function fieldNews(words: string[]): FieldNews | string {
  const [what, ...rest] = words;
  const end = rest.at(-1) === 'end';
  const side = rest[0] === 'me' || rest[0] === 'opp' ? rest[0] : undefined;
  if (rest.length > (end ? 1 : 0) + (side ? 1 : 0)) return 'unreadable';
  if (what === 'weather' || WEATHER[what]) {
    if (side) return 'weather has no side';
    if (end) return {what: 'weather', value: null};
    return what === 'weather' ? 'which weather?' : WEATHER[what];
  }
  if (what === 'terrain' || TERRAIN[what]) {
    if (side) return 'terrain has no side';
    if (end) return {what: 'terrain', value: null};
    return what === 'terrain' ? 'which terrain?' : TERRAIN[what];
  }
  if (ROOMS[what]) return side ? `${what} has no side` : {what: ROOMS[what], value: !end};
  if (SIDES[what]) return {what: SIDES[what], value: !end, side};
  return `no field effect ${what}`;
}

/** Their formes at this preview name (Charizard: Charizard, -Mega-X, -Mega-Y): the ladder's, and its Megas from the dex. */
function formesOf(known: Known, preview: string): string[] {
  const megas = (known.gen.species.get(toID(preview))?.otherFormes ?? []).filter(f => /-Mega/.test(f));
  return [...new Set([...(known.fmt?.preview[preview] ?? [preview]), ...megas])];
}

const idIn = (list: readonly string[] | undefined, name: string) => !!list?.some(x => toID(x) === toID(name));

/** A name as the app has it, or why it can't be. */
type Checked = {name: string} | {why: string};

/** A move a Pokémon can use: yours, one of its set; theirs, one it can learn or has been seen with. */
function moveFor(b: Battle, known: Known, ref: MonRef, raw: string): Checked {
  const move = known.gen.moves.get(toID(raw));
  if (!move || move.name === '(No Move)') return {why: `no move ${raw}`};
  if (move.name === 'Struggle') return {name: move.name};
  if (ref.side === 'me') {
    const set = b.myTeam[ref.slot];
    return idIn(set.moves, move.name) ? {name: move.name} : {why: `your ${set.species} doesn't have ${move.name}`};
  }
  const name = b.oppPreview[ref.slot];
  const formes = formesOf(known, name);
  const seen = formes.some(f => known.fmt?.species[f]?.moves.some(([m]) => toID(m) === move.id));
  if (seen || !known.learns || formes.some(f => known.learns!(f, move.name))) return {name: move.name};
  return {why: `${name} can't learn ${move.name}`};
}

/** An ability a Pokémon can have: any of its formes' (a Mega's too), or one it's been seen with. */
function abilityFor(b: Battle, known: Known, ref: MonRef, raw: string): Checked {
  const ability = known.gen.abilities.get(toID(raw));
  if (!ability) return {why: `no ability ${raw}`};
  const formes = ref.side === 'me'
    ? [b.myTeam[ref.slot].species, megaFormeOf(known.gen, b.myTeam[ref.slot])].filter((x): x is string => !!x)
    : formesOf(known, b.oppPreview[ref.slot]);
  // Every legal one (the calc's Champions data has only the first).
  const legal = (f: string) => (LEGAL_ABILITIES as Record<string, string[]>)[toID(f)] ?? Object.values(known.gen.species.get(toID(f))?.abilities ?? {}) as string[];
  const has = formes.some(f => legal(f).some(a => toID(a) === ability.id) || known.fmt?.species[f]?.abilities.some(([a]) => toID(a) === ability.id));
  if (has || (ref.side === 'me' && toID(b.myTeam[ref.slot].ability ?? '') === ability.id)) return {name: ability.name};
  return {why: `${formes[0]} can't have ${ability.name}`};
}

/** An item a Pokémon can hold: yours, the one it holds; theirs, any here (a Mega Stone, only its own). */
function itemFor(b: Battle, known: Known, ref: MonRef | undefined, raw: string): Checked {
  const item = known.gen.items.get(toID(raw));
  if (!item) return {why: `no item ${raw}`};
  if (!ref) return {name: item.name};
  if (ref.side === 'me') {
    const set = b.myTeam[ref.slot];
    return toID(set.item ?? '') === item.id ? {name: item.name} : {why: `your ${set.species} holds ${set.item ?? 'nothing'}`};
  }
  const stone = item.megaStone as Record<string, string> | undefined;
  const formes = formesOf(known, b.oppPreview[ref.slot]);
  if (stone && !Object.values(stone).some(m => idIn(formes, m))) return {why: `${item.name} isn't ${b.oppPreview[ref.slot]}'s`};
  return {name: item.name};
}

/** Whether it can Mega Evolve (and into X or Y, when said). */
function megaFor(b: Battle, known: Known, ref: MonRef, suffix: string | undefined): string | undefined {
  const megas = ref.side === 'me'
    ? [megaFormeOf(known.gen, b.myTeam[ref.slot]), b.myTeam[ref.slot].species].filter((f): f is string => !!f && /-Mega/.test(f))
    : formesOf(known, b.oppPreview[ref.slot]).filter(f => /-Mega/.test(f));
  const name = ref.side === 'me' ? b.myTeam[ref.slot].species : b.oppPreview[ref.slot];
  if (!megas.length) return `${name} can't Mega Evolve`;
  if (suffix && !megas.some(f => f.endsWith(`-${suffix}`))) return `${name} has no Mega ${suffix}`;
  return undefined;
}

/** How alike a name the model wrote must be to one there is to be taken as it ("Annihilate": Annihilape). */
const CLOSE = 0.8;

/** The one name `said` is very close to, if one clearly is (the model now and then copies a name a letter off). */
function closest<T>(said: string, options: readonly {name: string; value: T}[]): T | undefined {
  const s = squash(said);
  const scored = options.map(o => ({o, score: similarity(s, squash(o.name))})).sort((x, y) => y.score - x.score);
  const [best, next] = scored;
  return best && best.score >= CLOSE && (!next || best.score - next.score >= 0.05) ? best.o.value : undefined;
}

/**
 * The Pokémon a line starts with ("me:Mr. Rime …"): the longest name that fits, among yours brought
 * and their preview (or one very close to it), and what follows it.
 */
function takeRef(b: Battle, s: string): {ref: MonRef; name: string; rest: string} | string {
  const m = /^(me|opp):/.exec(s);
  if (!m) return 'no Pokémon';
  const side = m[1] as SideID;
  const body = s.slice(m[0].length);
  const slots = side === 'me' ? (b.brought ?? b.myTeam.map((_, i) => i)) : b.oppPreview.map((_, i) => i);
  const nameOf = (slot: number) => (side === 'me' ? b.myTeam[slot].species : b.oppPreview[slot]);
  let best: {slot: number; len: number} | undefined;
  for (const slot of slots) {
    const name = nameOf(slot);
    const at = body.slice(0, name.length);
    const next = body[name.length];
    if (at.toLowerCase() === name.toLowerCase() && (next === undefined || next === ' ') && name.length > (best?.len ?? -1)) best = {slot, len: name.length};
  }
  if (!best) {
    // One very close to a name there, taking as many words as that name has.
    const words = body.split(' ');
    const [top, second] = slots.map(k => {
      const said = words.slice(0, nameOf(k).split(' ').length).join(' ');
      return {k, len: said.length, score: similarity(squash(said), squash(nameOf(k)))};
    }).sort((x, y) => y.score - x.score);
    if (top && top.score >= CLOSE && (!second || top.score - second.score >= 0.05)) best = {slot: top.k, len: top.len};
  }
  if (!best) return `no ${side === 'me' ? 'Pokémon of yours' : 'Pokémon of theirs'} called ${body.split(' ')[0]}`;
  return {ref: {side, slot: best.slot}, name: `${side}:${nameOf(best.slot)}`, rest: body.slice(best.len).trim()};
}

type LineRead = {events: VoiceEvent[]; line: string} | 'undo' | string;

/** One line of a battle answer: its events and the line as kept, or why it's dropped. */
function battleLine(b: Battle, known: Known, raw: string): LineRead {
  const line = raw.replace(/\s+/g, ' ').trim();
  const sp = line.indexOf(' ');
  const verb = sp < 0 ? line : line.slice(0, sp);
  const args = sp < 0 ? '' : line.slice(sp + 1);
  const words = args.split(' ').filter(Boolean);
  const kept = (events: VoiceEvent[], text: string) => ({events, line: text});
  /** A Pokémon then nothing ("faint opp:X"), or nothing at all when it may be left out ("crit"). */
  const alone = (optional: boolean): {ref?: MonRef; name?: string} | string => {
    if (!args) return optional ? {} : 'whose?';
    const r = takeRef(b, args);
    if (typeof r === 'string') return r;
    return r.rest ? 'unreadable' : r;
  };
  switch (verb) {
    case 'undo': return args ? 'unreadable' : 'undo';
    case 'use': {
      const a = takeRef(b, args);
      if (typeof a === 'string') return a;
      const [moveRaw, targetRaw] = a.rest.split(/\s*>\s*/);
      if (!moveRaw) return 'which move?';
      const mv = moveFor(b, known, a.ref, moveRaw);
      let actor = a;
      if ('why' in mv) {
        // An ability taken for a move ("Incineroar Intimidate"): the ability, if it's one it can have.
        const ab = targetRaw === undefined && known.gen.abilities.get(toID(moveRaw)) ? abilityFor(b, known, a.ref, moveRaw) : undefined;
        if (ab && !('why' in ab)) return kept([{kind: 'ability', mon: a.ref, ability: ab.name}], `ability ${a.name} ${ab.name}`);
        // A move said with the wrong Pokémon (its name misheard, or not said): the one on the field that has it.
        const who = known.gen.moves.get(toID(moveRaw)) ? moveUser(b, known, a.ref, moveRaw) : undefined;
        if (!who) return mv.why;
        actor = {ref: who, name: refName(b, who), rest: a.rest};
      }
      const move = 'why' in mv ? known.gen.moves.get(toID(moveRaw))!.name : mv.name;
      if (targetRaw === undefined) return kept([{kind: 'use', actor: actor.ref, move}], `use ${actor.name} ${move}`);
      const t = takeRef(b, targetRaw);
      if (typeof t === 'string') return t;
      if (t.rest) return 'unreadable';
      return kept([{kind: 'use', actor: actor.ref, move}, {kind: 'target', mon: t.ref}], `use ${actor.name} ${move} > ${t.name}`);
    }
    case 'hp': {
      const v = Number(words.at(-1));
      if (!Number.isInteger(v) || v < 0) return 'no HP';
      if (words.length === 2 && words[0] === '?') return v <= 999 ? kept([{kind: 'hp', value: v}], `hp ? ${v}`) : 'too much HP';
      const r = takeRef(b, args.slice(0, args.lastIndexOf(' ')));
      if (typeof r === 'string') return r;
      if (r.rest) return 'unreadable';
      const max = r.ref.side === 'opp' ? 100 : known.maxHp?.(r.ref) ?? 999;
      if (v > max) return `${r.name} has at most ${max}`;
      return kept([{kind: 'hp', mon: r.ref, value: v}], `hp ${r.name} ${v}`);
    }
    case 'switch': {
      const [x, y] = args.split(/\s*>\s*/);
      const a = takeRef(b, x ?? '');
      const c = takeRef(b, y ?? '');
      if (typeof a === 'string') return a;
      if (typeof c === 'string') return c;
      if (a.rest || c.rest) return 'unreadable';
      if (a.ref.side !== c.ref.side) return 'a switch is on one side';
      if (a.ref.slot === c.ref.slot) return 'switched for itself';
      return kept([{kind: 'withdraw', mon: a.ref, voluntary: true}, {kind: 'sendOut', mon: c.ref}], `switch ${a.name} > ${c.name}`);
    }
    case 'in': case 'out': case 'drag': case 'cure': {
      const r = alone(false);
      if (typeof r === 'string') return r;
      const mon = r.ref!;
      const ev: VoiceEvent = verb === 'in' ? {kind: 'sendOut', mon} : verb === 'out' ? {kind: 'withdraw', mon, voluntary: true}
        : verb === 'drag' ? {kind: 'dragged', mon} : {kind: 'cure', mon};
      return kept([ev], `${verb} ${r.name}`);
    }
    case 'faint': case 'crit': case 'miss': case 'protect': case 'immune': {
      const r = alone(verb !== 'protect');
      if (typeof r === 'string') return r;
      const mon = r.ref;
      const ev: VoiceEvent = verb === 'faint' ? {kind: 'faint', mon} : verb === 'crit' ? {kind: 'crit', mon}
        : verb === 'miss' ? {kind: 'miss', mon} : verb === 'protect' ? {kind: 'miss', mon, shield: true} : {kind: 'immune', mon};
      return kept([ev], r.name ? `${verb} ${r.name}` : verb);
    }
    case 'mega': {
      const r = takeRef(b, args);
      if (typeof r === 'string') return r;
      const suffix = r.rest.toUpperCase() || undefined;
      if (suffix && suffix !== 'X' && suffix !== 'Y') return 'unreadable';
      const no = megaFor(b, known, r.ref, suffix);
      if (no) return no;
      return kept([{kind: 'mega', mon: r.ref, suffix}], `mega ${r.name}${suffix ? ` ${suffix}` : ''}`);
    }
    case 'ability': {
      const r = takeRef(b, args);
      if (typeof r === 'string') return r;
      if (!r.rest) return 'which ability?';
      const ab = abilityFor(b, known, r.ref, r.rest);
      if ('why' in ab) {
        // A move taken for an ability ("Bellibolt Parabolic Charge"): the move, if it's one it can use.
        const mv = known.gen.moves.get(toID(r.rest)) ? moveFor(b, known, r.ref, r.rest) : undefined;
        if (mv && !('why' in mv)) return kept([{kind: 'use', actor: r.ref, move: mv.name}], `use ${r.name} ${mv.name}`);
        return ab.why;
      }
      return kept([{kind: 'ability', mon: r.ref, ability: ab.name}], `ability ${r.name} ${ab.name}`);
    }
    case 'item': {
      const unknown = args.startsWith('? ');
      const r = unknown ? {ref: undefined, name: '?', rest: args.slice(2)} : takeRef(b, args);
      if (typeof r === 'string') return r;
      const gone = / gone$/.test(r.rest);
      const raw = r.rest.replace(/ gone$/, '');
      if (!raw) return 'which item?';
      const it = itemFor(b, known, r.ref, raw);
      if ('why' in it) return it.why;
      return kept([{kind: 'item', mon: r.ref, item: it.name, gone: gone || undefined}], `item ${r.name} ${it.name}${gone ? ' gone' : ''}`);
    }
    case 'stat': case 'unchanged': {
      const r = takeRef(b, args);
      if (typeof r === 'string') return r;
      const [stat, by, more] = r.rest.split(' ');
      if (!BOOSTS.has(stat)) return `no stat ${stat ?? ''}`.trim();
      if (verb === 'unchanged') return by ? 'unreadable' : kept([{kind: 'unchanged', mon: r.ref, stats: [stat as BoostID]}], `unchanged ${r.name} ${stat}`);
      if (more) return 'unreadable';
      const limit = by === 'max' || by === 'min';
      const n = limit ? (by === 'max' ? 1 : -1) : Number(by);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 6) return `a stat goes up or down 1 to 6, not ${by}`;
      const boosts: Boosts = {[stat]: n};
      return kept([{kind: 'stat', mon: r.ref, boosts, limit: limit || undefined}], `stat ${r.name} ${stat} ${limit ? by : n > 0 ? `+${n}` : n}`);
    }
    case 'status': case 'cant': {
      const r = takeRef(b, args);
      if (typeof r === 'string') return r;
      const st = r.rest;
      if (verb === 'status' ? !STATUSES.has(st) : st && !CANT.has(st)) return `no status ${st}`.trim();
      const ev: VoiceEvent = verb === 'status' ? {kind: 'status', mon: r.ref, status: st as Status} : {kind: 'cant', mon: r.ref, status: (st || undefined) as Status | undefined};
      return kept([ev], `${verb} ${r.name}${st ? ` ${st}` : ''}`);
    }
    case 'first': case 'last': {
      const a = takeRef(b, args);
      if (typeof a === 'string') return a;
      if (!a.rest) return kept([{kind: 'order', mon: a.ref, place: verb}], `${verb} ${a.name}`);
      const o = takeRef(b, a.rest);
      if (typeof o === 'string') return o;
      if (o.rest) return 'unreadable';
      return kept([{kind: 'order', mon: a.ref, place: verb, other: o.ref}], `${verb} ${a.name} ${o.name}`);
    }
    case 'hits': {
      const n = Number(args);
      return Number.isInteger(n) && n >= 1 && n <= 10 ? kept([{kind: 'hits', n}], `hits ${n}`) : 'no number of hits';
    }
    case 'fail': return args ? 'unreadable' : kept([{kind: 'fail'}], 'fail');
    case 'endturn': return args ? 'unreadable' : kept([{kind: 'endTurn'}], 'endturn');
    case 'field': {
      const news = fieldNews(words);
      return typeof news === 'string' ? news : kept([{kind: 'field', news}], `field ${words.join(' ')}`);
    }
  }
  return PREVIEW_VERBS.has(verb) ? 'that’s for team preview' : 'unreadable';
}

/**
 * An ability named on its own ("Intimidate.", as a Pokémon comes in): the one Pokémon on the field that can
 * have it, as an answer line, for when the model made nothing of it. Null if none or several can.
 */
export function abilityHeard(b: Battle, known: Known, said: string): string | null {
  const found = longestMention(said, known.gen.abilities);
  return found ? abilityOwnerLine(b, known, found) : null;
}

/** The longest of these names said in the phrase, as a whole run of words. */
function longestMention(said: string, names: Iterable<{name: string}>): string | undefined {
  const text = ` ${norm(said)} `;
  let found: string | undefined;
  for (const x of names) {
    const n = norm(x.name);
    if (n && text.includes(` ${n} `) && n.length > (found ? norm(found).length : 0)) found = x.name;
  }
  return found;
}

const onField = (b: Battle): MonRef[] =>
  (['me', 'opp'] as const).flatMap(side => b.live.active[side].filter((x): x is number => x !== null).map(slot => ({side, slot})));
const refName = (b: Battle, ref: MonRef) => `${ref.side}:${ref.side === 'me' ? b.myTeam[ref.slot].species : b.oppPreview[ref.slot]}`;

/**
 * Who on the field can have used a move said with one who can't: one of yours whose set has it (known for sure),
 * else the only one who can. Undefined if it can't be told.
 */
function moveUser(b: Battle, known: Known, not: MonRef, move: string): MonRef | undefined {
  const can = onField(b).filter(r => !(r.side === not.side && r.slot === not.slot) && !('why' in moveFor(b, known, r, move)));
  const mine = can.filter(r => r.side === 'me');
  return mine.length === 1 ? mine[0] : can.length === 1 ? can[0] : undefined;
}

/** An ability's line for the one Pokémon on the field that can have it; null if none or several can. */
function abilityOwnerLine(b: Battle, known: Known, ability: string): string | null {
  const owners = onField(b).filter(ref => !('why' in abilityFor(b, known, ref, ability)));
  return owners.length === 1 ? `ability ${refName(b, owners[0])} ${ability}` : null;
}

/**
 * Abilities and items named in the phrase that the model's lines (`lines`, those kept) leave out ("Bellibolt 84,
 * Electromorphosis activated": the HP read, the ability not): an ability for the one Pokémon on the field that can
 * have it, an item as the narrator places it (a berry: the one just hit). Not Mega Stones ("Lopunnite" is Lopunny
 * misheard).
 */
export function mentionsLeftOut(b: Battle, known: Known, said: string, lines: readonly string[]): string[] {
  const covered = ` ${norm(lines.join(' '))} `;
  const out: string[] = [];
  const ability = longestMention(said, known.gen.abilities);
  const owner = ability && !covered.includes(` ${norm(ability)} `) ? abilityOwnerLine(b, known, ability) : null;
  if (owner) out.push(owner);
  const item = longestMention(said, [...known.gen.items].filter(i => !i.megaStone));
  if (item && !covered.includes(` ${norm(item)} `)) out.push(`item ? ${item}`);
  return out;
}

/**
 * Whether the phrase has words for a line that ends the turn or takes the phrase before back: the model reads
 * "turn" in "from last turn…" as the end of one, and "yeah, forty nine" as a correction, with confidence.
 */
export function saidSo(line: string, said: string): boolean {
  const t = norm(said);
  if (line === 'endturn') return /\bturns?\b/.test(t) && /\b(end\w*|next|new|over|done|finish\w*|thats|that s|that the)\b/.test(t);
  if (line === 'undo') {
    return /\b(no|not|nope|wrong|scratch|undo|sorry|meant|mean|actually|oops|delete|cancel|remove|back|mind|bad|correction|wait|instead|forget|didnt|wasnt|isnt|doesnt|it was)\b/.test(t);
  }
  return true;
}

/** "Yes", "yeah", "correct", "do it"… (a few words at most): taking what was offered to tap. */
export const yesSaid = (said: string) => {
  const t = norm(said);
  return /^(yes|yeah|yep|yup|correct|thats right|that is right|confirm|do it|sure)\b/.test(t) && t.split(' ').length <= 5;
};

/** "Start the battle", however it's heard ("start butter", "let's battle"), at team preview. */
export const startSaid = (said: string) => /\b(start\w*|begin\w*|lets (battle|start|begin))\b/.test(norm(said));

/** A battle answer: what to take back, the events to hand the narrator, and what was dropped and why. */
export function readBattleAnswer(b: Battle, known: Known, answer: string): BattleAnswer {
  const res: BattleAnswer = {undo: false, events: [], lines: [], dropped: []};
  const lines = answer.split('\n').map(l => l.trim()).filter(l => l && l !== 'none');
  lines.forEach((line, k) => {
    const r = battleLine(b, known, line);
    if (r === 'undo') {
      if (k === 0) res.undo = true;
      else res.dropped.push({line, why: 'undo comes first'});
    } else if (typeof r === 'string') res.dropped.push({line, why: r});
    else {
      res.events.push(...r.events);
      res.lines.push(r.line);
    }
  });
  return res;
}

// --- team preview ---------------------------------------------------------------------------------

export type PreviewOp =
  | {kind: 'add'; name: string}
  | {kind: 'remove'; side: 'theirs'; name: string}
  | {kind: 'remove'; side: 'mine'; slot: number}
  | {kind: 'bring'; slot: number}
  | {kind: 'clear'; side: Side}
  | {kind: 'start'};

export interface PreviewAnswer {
  ops: PreviewOp[];
  lines: string[];
  dropped: Dropped[];
}

const speciesId = (gen: Gen, name: string) => {
  const sp = gen.species.get(toID(name));
  return sp ? toID(sp.baseSpecies ?? sp.name) : toID(name);
};

/** A name as one of this format's preview names ("Charizard-Mega-Y": Charizard), or the one it's very close to. */
function previewName(env: PreviewEnv, raw: string): string | undefined {
  const id = toID(raw);
  const names = Object.keys(env.fmt.preview);
  return names.find(n => toID(n) === id) ?? names.find(n => env.fmt.preview[n].some(f => toID(f) === id))
    ?? closest(raw, names.map(n => ({name: n, value: n})));
}

/** One of your six by the name the model gives it (species, its base, or nickname), or the one it's very close to. */
function teamSlot(env: PreviewEnv, raw: string): number | undefined {
  const id = toID(raw);
  const k = env.team.findIndex(s => toID(s.species) === id || toID(s.nickname ?? '') === id);
  if (k >= 0) return k;
  const j = env.team.findIndex(s => speciesId(env.gen, s.species) === id);
  return j >= 0 ? j : closest(raw, env.team.map((s, slot) => ({name: s.species, value: slot})));
}

/** A team-preview answer, checked against the format's Pokémon, your team and what's been picked. */
export function readPreviewAnswer(env: PreviewEnv, picks: Picks, answer: string): PreviewAnswer {
  const res: PreviewAnswer = {ops: [], lines: [], dropped: []};
  const theirs = [...picks.theirs];
  const mine = [...(picks.mine ?? [])];
  for (const raw of answer.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && l !== 'none')) {
    const [verb, arg = '', ...more] = raw.split(' ');
    const m = /^(me|opp):(.+)$/.exec([arg, ...more].join(' '));
    const drop = (why: string) => res.dropped.push({line: raw, why});
    const keep = (op: PreviewOp, line: string) => {
      res.ops.push(op);
      res.lines.push(line);
    };
    if (verb === 'start' && !arg) keep({kind: 'start'}, 'start');
    else if (verb === 'clear' && (arg === 'opp' || arg === 'me') && !more.length) {
      keep({kind: 'clear', side: arg === 'opp' ? 'theirs' : 'mine'}, raw);
      if (arg === 'opp') theirs.length = 0;
      else mine.length = 0;
    } else if ((verb === 'add' || verb === 'remove' || verb === 'bring') && m) {
      const [, side, name] = m;
      if (side === 'opp' && verb !== 'bring') {
        const n = previewName(env, name);
        if (!n) drop(`no ${name} here`);
        else if (verb === 'add') {
          keep({kind: 'add', name: n}, `add opp:${n}`);
          theirs.push(n);
        } else {
          // "Goodra" takes back their Goodra-Hisui too: one of each species.
          const had = theirs.find(t => t === n) ?? theirs.find(t => speciesId(env.gen, t) === speciesId(env.gen, n));
          if (!had) drop(`${n} isn't in their team`);
          else {
            keep({kind: 'remove', side: 'theirs', name: had}, `remove opp:${had}`);
            theirs.splice(theirs.indexOf(had), 1);
          }
        }
      } else if (side === 'me' && verb !== 'add') {
        const slot = teamSlot(env, name);
        if (slot === undefined) drop(`no ${name} in your team`);
        else if (verb === 'bring') {
          keep({kind: 'bring', slot}, `bring me:${env.team[slot].species}`);
          mine.push(slot);
        } else if (!mine.includes(slot)) drop(`your ${env.team[slot].species} isn't picked`);
        else {
          keep({kind: 'remove', side: 'mine', slot}, `remove me:${env.team[slot].species}`);
          mine.splice(mine.indexOf(slot), 1);
        }
      } else drop(verb === 'bring' ? 'you bring yours' : 'you add theirs');
    } else drop(PREVIEW_VERBS.has(verb) || verb === 'undo' ? 'unreadable' : 'that’s for the battle');
  }
  return res;
}

/** The picks after an answer, and what it did, as the rules' reading gives it (for the same screen). */
export function applyPreview(env: PreviewEnv, picks: Picks, ops: readonly PreviewOp[]): PreviewRead {
  let theirs = [...picks.theirs];
  let mine = picks.mine ? [...picks.mine] : null;
  let last = picks.last;
  const said: string[] = [];
  const notes: string[] = [];
  let battle = false;
  const label = (slot: number) => env.team[slot]?.nickname || env.team[slot]?.species || '?';
  for (const op of ops) {
    switch (op.kind) {
      case 'add': {
        const r = addTheirs(theirs, op.name, env.gen);
        theirs = r.theirs;
        if (r.said) {
          said.push(r.said);
          last = 'theirs';
        }
        if (r.note) notes.push(r.note);
        break;
      }
      case 'remove':
        if (op.side === 'theirs') {
          theirs = theirs.filter(t => t !== op.name);
          said.push(`took back ${op.name}`);
        } else if (mine) {
          mine = mine.filter(s => s !== op.slot);
          said.push(`took back your ${label(op.slot)}`);
        }
        break;
      case 'bring':
        mine ??= [];
        if (mine.includes(op.slot)) notes.push(`your ${label(op.slot)} is in already`);
        else if (mine.length >= env.bring) notes.push(`your ${env.bring} are in already, not ${label(op.slot)}`);
        else {
          mine.push(op.slot);
          said.push(`your ${label(op.slot)}`);
          last = 'mine';
        }
        break;
      case 'clear':
        if (op.side === 'theirs') theirs = [];
        else mine = [];
        said.push(op.side === 'theirs' ? 'cleared theirs' : 'cleared yours');
        break;
      case 'start':
        battle = true;
        break;
    }
  }
  return {picks: {theirs, mine, last}, said, notes, unsure: [], battle, side: null};
}
