/**
 * Battles started from team preview as the screen reader sees it (src/screen/preview.ts): their six, the team of
 * yours whose names are on screen, then the four you picked. Nothing to tap: the battle opens while you choose, and
 * the game's first lines take it from there, leads included (yours too, so your entry abilities meet theirs).
 * Team preview missed (capturing started late, the page reloaded): the battle opens at the first "… sent out …!",
 * with theirs added as they're named (see narration/misread.ts).
 */
import {allSpecies, getGen, species as dexSpecies, toID, writtenName, type Gen} from '../data/dex';
import {loadFormat, loadFormatIndex, type FormatData, type FormatInfo} from '../data/format';
import {createBattle} from '../engine/battle';
import type {Battle} from '../engine/types';
import type {IconGuess} from '../screen/preview';
import {onReadings, type Reading} from '../screen/reader';
import {alike} from '../screen/vision';
import {similarity, squash} from './battle/narration/text';
import {useStore, type SavedTeam} from '../state/store';
import {testLog} from '../testlog';
import {toPreviewName} from './picks';

type Preview = Extract<Reading, {kind: 'preview'}>;

/** Where Setup keeps the format last played. */
export const LAST_FORMAT = 'bayesian-battle:last-format';
/** How much the ladder's usage counts against an icon's fit: a species used e times as much makes up this much. */
const PRIOR = 0.015;
/** Usage below this share of the most used species' counts as this (a species never seen on the ladder still can be). */
const RAREST = 0.001;
/** A guess this much better than the next species' is sure. */
const SURE_BY = 0.08;
/** A name read on screen this alike to a Pokémon's (nickname or species) is taken as it. */
const NAME_LIKE = 0.75;
/** Choosing and standing by take three minutes at most: a team preview later than that is another battle's. */
const PREVIEW_MS = 3 * 60_000;

/** One of their six as read: the likeliest species, whether it stood out, and the others it might be. */
export interface TheirGuess {
  name: string;
  sure: boolean;
  alts: string[];
}

/**
 * The team-preview name for a species the icons were matched to: as the format's data lists it ("Aegislash" for
 * Aegislash-Shield), a forme that differs in looks only as its species (Vivillon-Fancy is Vivillon), else as it is.
 */
export function previewNameOf(fmt: FormatData, gen: Gen, species: string): string {
  const listed = toPreviewName(fmt, gen, species, {prefix: false});
  if (listed && fmt.preview[listed]) return listed;
  const sp = dexSpecies(gen, species);
  const base = sp?.baseSpecies ? dexSpecies(gen, sp.baseSpecies) : undefined;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (sp && base && fmt.preview[base.name] && same(sp.types, base.types) && same(sp.baseStats, base.baseStats) && same(sp.abilities, base.abilities)) {
    return base.name;
  }
  return listed ?? species;
}

/**
 * Their six from the icons' guesses: each slot's likeliest species, the ladder's usage breaking near ties, one of
 * each species (Species Clause: the surest slots choose first).
 */
export function chooseTheirs(theirs: IconGuess[][], nameOf: (species: string) => string, usage: (name: string) => number): TheirGuess[] {
  const options = theirs.map(guesses => {
    const byName = new Map<string, number>();
    for (const g of guesses) {
      const name = nameOf(g.name);
      const score = g.cost - PRIOR * Math.log(Math.max(RAREST, usage(name)));
      if (!byName.has(name) || score < byName.get(name)!) byName.set(name, score);
    }
    return [...byName.entries()].map(([name, score]) => ({name, score})).sort((a, b) => a.score - b.score);
  });
  const margin = (k: number) => (options[k][1]?.score ?? Infinity) - (options[k][0]?.score ?? Infinity);
  const order = options.map((_, k) => k).sort((a, b) => margin(b) - margin(a));
  const taken = new Set<string>();
  const out: TheirGuess[] = theirs.map(() => ({name: '', sure: false, alts: []}));
  for (const k of order) {
    const left = options[k].filter(o => !taken.has(toID(o.name)));
    const best = left[0];
    if (!best) continue;
    taken.add(toID(best.name));
    out[k] = {
      name: best.name,
      sure: (left[1]?.score ?? Infinity) - best.score >= SURE_BY,
      alts: options[k].filter(o => o.name !== best.name).slice(0, 4).map(o => o.name),
    };
  }
  return out;
}

/**
 * The saved team whose Pokémon the names read on screen are (a nickname in another alphabet can't be read: most of
 * them is enough), and which of its Pokémon each place on screen is. The game lists a Mega or a regional forme by its
 * species' name ("Garchomp" for Garchomp-Mega-Z, "Arcanine" for Arcanine-Hisui).
 */
export function teamFor(teams: readonly SavedTeam[], names: readonly string[], gen: Gen): {team: SavedTeam; order: number[]} | null {
  let best: {team: SavedTeam; order: number[]; hits: number} | null = null;
  for (const team of teams) {
    const order: number[] = names.map(() => -1);
    const free = new Set(team.sets.map((_, i) => i));
    let hits = 0;
    names.forEach((read, k) => {
      let pick: {i: number; score: number} | null = null;
      for (const i of free) {
        const set = team.sets[i];
        const shown = [set.nickname, set.species, writtenName(gen, set.species)];
        const score = Math.max(...shown.filter((n): n is string => !!n).map(n => alike(read, n)));
        if (!pick || score > pick.score) pick = {i, score};
      }
      if (pick && pick.score >= NAME_LIKE) {
        order[k] = pick.i;
        free.delete(pick.i);
        hits++;
      }
    });
    // Those not read: the ones left, in order.
    const rest = [...free];
    for (let k = 0; k < order.length; k++) if (order[k] < 0) order[k] = rest.shift() ?? -1;
    if (hits >= Math.min(3, names.length) && (!best || hits > best.hits)) best = {team, order, hits};
  }
  return best && {team: best.team, order: best.order};
}

/** The team's Pokémon brought, from each place's number on the standby screen (none: not brought). */
export function broughtFrom(picks: readonly (number | null)[], order: readonly number[]): number[] {
  return picks.map((p, k) => ({p, i: order[k] ?? k})).filter(x => x.p !== null && x.i >= 0).map(x => x.i).sort((a, b) => a - b);
}

/** The format the header names ("Double Battle", "Single Battle"), else the one last played. */
export function formatFor(header: string, formats: readonly FormatInfo[], fallback: string): string {
  const type = /single/i.test(header) ? 'singles' : /double/i.test(header) ? 'doubles' : null;
  const last = formats.find(f => f.id === fallback);
  if (!type || last?.gameType === type) return last?.id ?? fallback;
  return formats.find(f => f.gameType === type)?.id ?? fallback;
}

function lastFormat(): string {
  try {
    return localStorage.getItem(LAST_FORMAT) ?? 'champions-doubles';
  } catch {
    return 'champions-doubles';
  }
}

/** The battle made from the team preview last seen: updated as more is read, until it's under way. */
let made: {id: string; at: number; theirs: string[]; teamId: string; order: number[]} | null = null;
/** No battle under way on screen: none yet, or the last one has ended. */
let over = true;
/** When the battle's text was last read. */
let lastLine = 0;
/** No text for this long: whatever was under way is over (its end missed), and team preview can start the next. */
const QUIET_MS = 2 * 60_000;

const ENDED = /has ended due to|you lost to|you defeated|won the battle/i;

/**
 * The species a "… sent out X and Y!" line names (theirs: yours are "Go! …!"), titles off ("Sneasler the Rank
 * Master"); null if it isn't one, or a name isn't any species. `species`: the names to match against, `written`: as
 * the game writes each ("Floette" for Floette-Eternal).
 */
export function sentOut(text: string, species: readonly string[], written: (species: string) => string = s => s): string[] | null {
  const m = /^(.+?) sent out (.+?)!*$/i.exec(text.trim());
  if (!m) return null;
  const names = m[2].split(/\s+and\s+/i).map(n => n.replace(/\s+the\s+.*$/i, '').trim()).filter(Boolean);
  const out: string[] = [];
  for (const n of names) {
    let best: {name: string; score: number} | null = null;
    for (const s of species) {
      const score = similarity(squash(n), squash(written(s)));
      if (!best || score > best.score) best = {name: s, score};
    }
    if (!best || best.score < 0.8) return null;
    out.push(best.name);
  }
  return out.length ? out : null;
}

/** Species that can be sent out: no Megas (they're sent out as themselves), a species' own forme before its others. */
const sendable = (gen: Gen) => allSpecies(gen).filter(n => !/-(Mega|Gmax)/.test(n))
  .sort((a, b) => Number(!!gen.species.get(toID(a))?.baseSpecies) - Number(!!gen.species.get(toID(b))?.baseSpecies));

/** Battles made from team preview, from now on (while the reader reads). */
export function startAutoBattles(): () => void {
  let queue = Promise.resolve();
  return onReadings((items, at) => {
    for (const r of items) {
      if (r.kind === 'preview') queue = queue.then(() => take(r, at)).catch(err => testLog('screen-preview', {error: String(err)}));
      else if (r.kind === 'message') queue = queue.then(() => lateStart(r.text, at)).catch(err => testLog('screen-preview', {error: String(err)}));
    }
  });
}

/**
 * A battle's text with none under way (team preview not seen): the battle opens at the first "… sent out …!" with the
 * ones it names, as many of theirs as are known so far.
 */
async function lateStart(text: string, at: number) {
  lastLine = at;
  if (ENDED.test(text)) {
    over = true;
    return;
  }
  if (!over || !/ sent out /i.test(text)) return;
  const st = useStore.getState();
  if (!st.teams.length) return;
  const fmt = await loadFormat(lastFormat());
  const gen = getGen(fmt.gen);
  const named = sentOut(text, sendable(gen), s => writtenName(gen, s));
  if (!named) return;
  const theirs = named.map(s => previewNameOf(fmt, gen, s));
  const team = st.teams.find(t => t.id === made?.teamId) ?? st.teams[0];
  const b = createBattle(fmt, team.sets, theirs, label(theirs));
  made = {id: b.id, at, theirs, teamId: team.id, order: team.sets.map((_, i) => i)};
  over = false;
  st.addBattle(b);
  st.setView({page: 'battle', battleId: b.id});
  testLog('screen-preview', {late: b.id, format: fmt.id, theirs, team: team.name});
}

async function take(r: Preview, at: number) {
  const st = useStore.getState();
  if (!st.teams.length) return;
  const fmt = await loadFormat(formatFor(r.header, await loadFormatIndex(), lastFormat()));
  const gen = getGen(fmt.gen);
  const most = Math.max(...Object.values(fmt.previewUsage), 1e-9);
  const theirs = chooseTheirs(r.theirs, s => previewNameOf(fmt, gen, s), n => (fmt.previewUsage[n] ?? 0) / most);
  if (theirs.some(t => !t.name)) return;
  const six = theirs.map(t => t.name);
  const read = theirs.map(({alts, sure}) => ({alts, sure}));

  const cur = st.current;
  const differ = made ? six.filter((n, k) => n !== made!.theirs[k]).length : 6;
  // The same team preview (choosing, then standing by): the battle made from it, if nothing's logged in it yet.
  const open = made && at - made.at < PREVIEW_MS && cur?.id === made.id && cur.formatId === fmt.id && differ < 3
    && !cur.events.some(e => e.kind === 'action') ? cur : null;
  // Standing by, never seen choosing, in the middle of a battle: not team preview (the info screen on a Pokémon, one
  // crimson panel, once passed for it and opened a battle against six it made up).
  if (!open && !over && r.screen === 'standby' && at - lastLine < QUIET_MS) {
    testLog('screen-preview', {ignored: r.screen, why: 'a battle under way'});
    return;
  }
  const found = r.names ? teamFor(st.teams, r.names, gen) : null;
  const byId = (id?: string) => st.teams.find(t => t.id === id);
  // The team the names on screen are; standing by (no names shown), the one already taken; else the last one.
  const team = (open ? byId(made?.teamId) : found?.team) ?? byId(made?.teamId) ?? st.teams[0];
  const order = found?.order ?? (made && team.id === made.teamId ? made.order : team.sets.map((_, i) => i));
  const brought = r.picks ? broughtFrom(r.picks, order) : undefined;

  if (open && made) {
    // The same team preview, read again or standing by: what's new goes in (their six only while nothing's logged).
    const id = made.id;
    made = {...made, at, theirs: six, teamId: team.id, order};
    over = false;
    st.updateBattle(id, b => {
      const next: Battle = {...b, oppPreview: six, oppRead: read, label: label(six)};
      if (brought?.length) next.brought = brought;
      return next;
    });
    testLog('screen-preview', {updated: id, screen: r.screen, theirs: six, team: team.name, brought});
    return;
  }
  const b: Battle = {...createBattle(fmt, team.sets, six, label(six)), oppRead: read};
  if (brought?.length) b.brought = brought;
  made = {id: b.id, at, theirs: six, teamId: team.id, order};
  over = false;
  st.addBattle(b);
  st.setView({page: 'battle', battleId: b.id});
  testLog('screen-preview', {made: b.id, screen: r.screen, format: fmt.id, theirs: six, read, team: team.name, brought});
}

const label = (six: string[]) => `vs ${six.slice(0, 3).join(', ')}`;
