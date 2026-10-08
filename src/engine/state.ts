/**
 * The live battle state, advanced automatically from what's logged so the user
 * only types what the game actually showed: HP, crits, messages.
 *
 * Everything here is bookkeeping, not inference: stat stages from moves, statuses,
 * weather/terrain/Tailwind/Trick Room/screens with their turn counters, switch-in
 * abilities, berries, end-of-turn residuals.
 */
import LEGAL_ABILITIES from '../data/abilities.gen.json';
import {move as dexMove, toID, type BoostID, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {makePokemon, typeEffectiveness} from './calc';
import {megaFormeOf, mySpec} from './likelihood';
import {reactionEffect, SEEDS} from './abilities';
import {BINDS, EXPOSES, moveFx, RISES_BEFORE_HIT, SPINS, type MoveFx} from './moves';
import {
  monKey, type ActionEvent, type Battle, type Boosts, type CheckEvent, type FieldCondition, type MonCondition, type MonRef, type SideCondition,
  type SideID, type Snapshot, type Status, type Weather,
} from './types';

export interface StateCtx {
  fmt: FormatData;
  gen: Gen;
  battle: Battle;
  /** Most likely ability of an opponent and how sure we are. */
  oppAbility(slot: number, mega: boolean): {name: string; p: number} | undefined;
  /** The opponent's item if it's certain. */
  oppItem(slot: number): string | undefined;
}

const clone = (s: Snapshot): Snapshot => structuredClone(s);
/** A Pokémon's condition without these (what goes when it leaves the field, or wears off). */
const without = (c: MonCondition, ...keys: ('types' | 'exposed' | 'odd' | 'blade' | 'bound' | 'seeded' | 'salted')[]): MonCondition => {
  const out = {...c};
  for (const k of keys) delete out[k];
  return out;
};
const clamp6 = (v: number) => Math.max(-6, Math.min(6, v));
const foe = (side: SideID): SideID => (side === 'me' ? 'opp' : 'me');

const WEATHER: Record<string, Weather> = {sun: 'Sun', rain: 'Rain', sand: 'Sand', snow: 'Snow'};
export const WEATHER_ABILITY: Record<string, Weather> = {Drought: 'Sun', Drizzle: 'Rain', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'};
export const TERRAIN_ABILITY: Record<string, FieldCondition['terrain']> = {
  'Electric Surge': 'Electric', 'Grassy Surge': 'Grassy', 'Psychic Surge': 'Psychic', 'Misty Surge': 'Misty',
};
const IGNORES_INTIMIDATE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Mirror Armor']);
const BLOCKS_DROPS = new Set(['Clear Body', 'White Smoke', 'Full Metal Body']);

/** Ability we act on automatically: mine always, theirs only once it's certain (never from usage odds alone). */
function knownAbility(ctx: StateCtx, live: Snapshot, ref: MonRef): string | undefined {
  const c = live.mons[monKey(ref)];
  if (ref.side === 'me') {
    const set = ctx.battle.myTeam[ref.slot];
    return set ? mySpec(ctx.gen, ctx.fmt, set, c).ability : undefined;
  }
  const a = ctx.oppAbility(ref.slot, !!c?.mega);
  return a && a.p >= 1 ? a.name : undefined;
}

function knownItem(ctx: StateCtx, live: Snapshot, ref: MonRef): string | undefined {
  const c = live.mons[monKey(ref)];
  if (c?.itemGone) return undefined;
  return ref.side === 'me' ? ctx.battle.myTeam[ref.slot]?.item : ctx.oppItem(ref.slot);
}

/** Whether it has, or for all that's known may have, this ability (theirs: any it can legally have, until one is sure). */
function mayHaveAbility(ctx: StateCtx, live: Snapshot, ref: MonRef, name: string): boolean {
  const c = live.mons[monKey(ref)];
  if (ref.side === 'me') return knownAbility(ctx, live, ref) === name;
  const known = ctx.oppAbility(ref.slot, !!c?.mega);
  if (known && known.p >= 1) return known.name === name;
  const preview = ctx.battle.oppPreview[ref.slot];
  const formes = ctx.fmt.preview[preview] ?? [preview];
  return formes.some(f => ((LEGAL_ABILITIES as Record<string, string[]>)[toID(f)]
    ?? Object.values(ctx.gen.species.get(toID(f))?.abilities ?? {}) as string[]).includes(name));
}

export function maxHPOf(ctx: StateCtx, live: Snapshot, ref: MonRef): number {
  if (ref.side === 'opp') return 100;
  const set = ctx.battle.myTeam[ref.slot];
  return set ? makePokemon(ctx.gen, mySpec(ctx.gen, ctx.fmt, set, live.mons[monKey(ref)])).maxHP() : 100;
}

/**
 * A stat change as it lands on this Pokémon, where its ability is known: Contrary turns it round, Simple doubles it (a
 * Mega Staraptor's Close Combat raises its defences).
 */
function asItLands(ctx: StateCtx, live: Snapshot, ref: MonRef, boosts: Boosts): Boosts {
  const a = knownAbility(ctx, live, ref);
  if (a !== 'Contrary' && a !== 'Simple') return boosts;
  return Object.fromEntries(Object.entries(boosts).map(([k, v]) => [k, a === 'Contrary' ? -(v ?? 0) : 2 * (v ?? 0)]));
}

/** Stat changes from an opponent's move or ability, with the reactions we can see coming. */
function dropStats(ctx: StateCtx, live: Snapshot, ref: MonRef, change: Boosts) {
  const c = live.mons[monKey(ref)];
  if (!c || c.hp <= 0) return;
  const ability = knownAbility(ctx, live, ref);
  const boosts = asItLands(ctx, live, ref, change);
  const lowering = Object.values(boosts).some(v => (v ?? 0) < 0);
  if (lowering && ability && BLOCKS_DROPS.has(ability)) return;
  if (lowering && knownItem(ctx, live, ref) === 'Clear Amulet') return;
  const next = {...c.boosts};
  for (const [k, v] of Object.entries(boosts) as [BoostID, number][]) next[k] = clamp6((next[k] ?? 0) + v);
  if (lowering && ability === 'Defiant') next.atk = clamp6((next.atk ?? 0) + 2);
  if (lowering && ability === 'Competitive') next.spa = clamp6((next.spa ?? 0) + 2);
  live.mons[monKey(ref)] = {...c, boosts: next};
}

/** A reaction (Defiant, Clear Amulet, White Herb…) to a drop that has already been applied. */
function applyReaction(live: Snapshot, ref: MonRef, name: string, drop: Boosts) {
  const {boosts, itemGone} = reactionEffect(name, drop);
  addStages(live, ref, boosts);
  const c = live.mons[monKey(ref)];
  if (c && itemGone) live.mons[monKey(ref)] = {...c, itemGone: true};
}

/** Stages added as they are (the game said so, or a reaction that answers a change already made). */
function addStages(live: Snapshot, ref: MonRef, boosts: Boosts) {
  const c = live.mons[monKey(ref)];
  if (!c || c.hp <= 0) return;
  const next = {...c.boosts};
  for (const [k, v] of Object.entries(boosts) as [BoostID, number][]) next[k] = clamp6((next[k] ?? 0) + v);
  live.mons[monKey(ref)] = {...c, boosts: next};
}

/** Its own stat changes (a move's, an item's), as they land on it (see asItLands). */
function raiseStats(ctx: StateCtx, live: Snapshot, ref: MonRef, boosts: Boosts) {
  addStages(live, ref, asItLands(ctx, live, ref, boosts));
}

function setTimed(field: FieldCondition, key: string, turns: number) {
  field.turns = {...(field.turns ?? {}), [key]: turns};
}

/** The rock that makes the setter's weather last 8 turns instead of 5. */
export const WEATHER_ROCK: Partial<Record<Weather, string>> = {Sun: 'Heat Rock', Rain: 'Damp Rock', Sand: 'Smooth Rock', Snow: 'Icy Rock'};

/**
 * Who set a timed effect, for the item that would make it last 8 turns: one of theirs with an item not known may be
 * holding it, so the effect stays up past its 5th turn until the game says it's over (applyEndTurn); anyone else's
 * lasts as its item says.
 */
function noteSetter(ctx: StateCtx, live: Snapshot, key: string, setter: MonRef | undefined, stretcher: string | undefined) {
  const f = live.field;
  const may = {...(f.mayLast ?? {})};
  delete may[key];
  const c = setter && live.mons[monKey(setter)];
  if (setter?.side === 'opp' && stretcher && c && !c.itemGone && knownItem(ctx, live, setter) === undefined) {
    may[key] = {slot: setter.slot, item: stretcher};
  }
  f.mayLast = may;
}

/** The timers of these effects gone, and what may have stretched them. */
function untime(f: FieldCondition, keys: string[]) {
  for (const k of keys) {
    delete f.turns?.[k];
    delete f.mayLast?.[k];
  }
}

/** Into the same weather (or terrain), it fails: its timer carries on (Pelipper back into its own rain). */
function setWeather(ctx: StateCtx, live: Snapshot, w: Weather, setter?: MonRef) {
  const f = live.field;
  if (f.weather === w) return;
  const item = setter && knownItem(ctx, live, setter);
  f.weather = w;
  setTimed(f, 'weather', item && WEATHER_ROCK[w] === item ? 8 : 5);
  noteSetter(ctx, live, 'weather', setter, WEATHER_ROCK[w]);
}

function setTerrain(ctx: StateCtx, live: Snapshot, t: FieldCondition['terrain'], setter?: MonRef) {
  const f = live.field;
  if (f.terrain === t) return;
  const item = setter && knownItem(ctx, live, setter);
  f.terrain = t;
  setTimed(f, 'terrain', item === 'Terrain Extender' ? 8 : 5);
  noteSetter(ctx, live, 'terrain', setter, 'Terrain Extender');
}

/** A room (Trick Room, Magic Room, Wonder Room): used again while it's up, it ends. */
function toggleRoom(f: FieldCondition, key: 'trickRoom' | 'magicRoom' | 'wonderRoom') {
  f[key] = !f[key];
  if (f[key]) setTimed(f, key, 5);
  else delete f.turns?.[key];
}

const SCREENS = ['reflect', 'lightScreen', 'auroraVeil'] as const;

function clearHazards(f: FieldCondition, side: SideID) {
  f[side] = {...f[side], stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false};
}

function applyFieldEffects(ctx: StateCtx, live: Snapshot, actor: MonRef, fx: MoveFx, landed: boolean) {
  const f = live.field;
  const side = actor.side;
  const item = knownItem(ctx, live, actor);
  if (fx.w) setWeather(ctx, live, WEATHER[fx.w], actor);
  if (fx.tr) setTerrain(ctx, live, (fx.tr.charAt(0).toUpperCase() + fx.tr.slice(1)) as FieldCondition['terrain'], actor);
  if (fx.pw === 'trickroom') toggleRoom(f, 'trickRoom');
  if (fx.pw === 'magicroom') toggleRoom(f, 'magicRoom');
  if (fx.pw === 'wonderroom') toggleRoom(f, 'wonderRoom');
  if (fx.pw === 'gravity') {
    f.gravity = true;
    setTimed(f, 'gravity', 5);
  }
  if (fx.sc) {
    const key = fx.sc === 'lightscreen' ? 'lightScreen' : fx.sc === 'auroraveil' ? 'auroraVeil' : fx.sc;
    f[side] = {...f[side], [key]: true};
    setTimed(f, `${side}.${key}`, fx.sc === 'tailwind' ? 4 : item === 'Light Clay' ? 8 : 5);
    noteSetter(ctx, live, `${side}.${key}`, actor, fx.sc === 'tailwind' ? undefined : 'Light Clay');
  }
  const foeSide = foe(side);
  if (fx.hz === 'stealthrock') f[foeSide] = {...f[foeSide], stealthRock: true};
  if (fx.hz === 'stickyweb') f[foeSide] = {...f[foeSide], stickyWeb: true};
  if (fx.hz === 'spikes') f[foeSide] = {...f[foeSide], spikes: Math.min(3, (f[foeSide].spikes ?? 0) + 1)};
  if (fx.hz === 'toxicspikes') f[foeSide] = {...f[foeSide], toxicSpikes: Math.min(2, (f[foeSide].toxicSpikes ?? 0) + 1)};
  if (fx.clr === 'self' && landed) clearHazards(f, side);
  if (fx.clr === 'all') for (const s of ['me', 'opp'] as const) clearHazards(f, s);
  if (fx.clr === 'defog') {
    for (const s of ['me', 'opp'] as const) clearHazards(f, s);
    f[foeSide] = {...f[foeSide], reflect: false, lightScreen: false, auroraVeil: false};
    untime(f, [...SCREENS.map(k => `${foeSide}.${k}`), 'terrain']);
    f.terrain = undefined;
  }
  if (fx.clr === 'swap') {
    // Court Change: each side's conditions, and their timers, go to the other side.
    const other = (key: string) => {
      const [s, cond] = key.split('.');
      return cond && (s === 'me' || s === 'opp') ? `${foe(s)}.${cond}` : key;
    };
    f.turns = Object.fromEntries(Object.entries(f.turns ?? {}).map(([key, left]) => [other(key), left]));
    f.mayLast = Object.fromEntries(Object.entries(f.mayLast ?? {}).map(([key, m]) => [other(key), m]));
    [f.me, f.opp] = [f.opp, f.me];
  }
}

function switchInAbility(ctx: StateCtx, live: Snapshot, ref: MonRef, ability: string | undefined) {
  if (!ability) return;
  const w = WEATHER_ABILITY[ability];
  if (w) setWeather(ctx, live, w, ref);
  const t = TERRAIN_ABILITY[ability];
  if (t) setTerrain(ctx, live, t, ref);
  if (ability === 'Intimidate') applyIntimidate(ctx, live, ref, 1);
}

/** On the ground, for all that's known (not a Flying type, no Levitate or Air Balloon): terrain reaches it. */
export function grounded(ctx: StateCtx, live: Snapshot, ref: MonRef): boolean {
  return !typesOf(ctx, live, ref).includes('Flying') && knownAbility(ctx, live, ref) !== 'Levitate' && knownItem(ctx, live, ref) !== 'Air Balloon';
}

/**
 * The targets a move goes for, as it's used now: Expanding Force hits both foes in Psychic Terrain when its user is on
 * the ground (5 Oct: its second target's HP was taken as a reading, and the hit on it went unread).
 */
export function targetNow(ctx: StateCtx, live: Snapshot, actor: MonRef, move: string): string {
  const target = moveFx(move).tg ?? dexMove(ctx.gen, move)?.target ?? 'normal';
  return toID(move) === 'expandingforce' && live.field.terrain === 'Psychic' && grounded(ctx, live, actor) ? 'allAdjacentFoes' : target;
}

/** Its types: as a move or an ability changed them, else its species' (as a Mega once it has evolved, where that's known). */
export function typesOf(ctx: StateCtx, live: Snapshot, ref: MonRef): string[] {
  const c = live.mons[monKey(ref)];
  if (c?.types) return [...c.types];
  const species = ref.side === 'me'
    ? mySpec(ctx.gen, ctx.fmt, ctx.battle.myTeam[ref.slot], c).species
    : ctx.battle.oppPreview[ref.slot];
  return [...(ctx.gen.species.get(toID(species))?.types ?? [])];
}

/** Berries that cure a status as soon as it's inflicted. */
export const CURES: Record<string, Status[]> = {
  'Lum Berry': ['brn', 'par', 'psn', 'tox', 'slp', 'frz'], 'Cheri Berry': ['par'], 'Chesto Berry': ['slp'],
  'Pecha Berry': ['psn', 'tox'], 'Rawst Berry': ['brn'], 'Aspear Berry': ['frz'],
};

/** A status inflicted: none if it already has one, cured straight away by a berry it's known to hold. */
function giveStatus(ctx: StateCtx, live: Snapshot, ref: MonRef, status: Status | undefined) {
  const c = live.mons[monKey(ref)];
  if (!status || !c || c.hp <= 0 || c.status) return;
  const item = knownItem(ctx, live, ref);
  if (item && CURES[item]?.includes(status)) c.itemGone = true;
  else c.status = status;
}

/** HP lost as a fraction of its max: exact for mine, an estimate of the % for theirs. */
function loseHP(ctx: StateCtx, live: Snapshot, ref: MonRef, frac: number, round: (x: number) => number = Math.floor) {
  const c = live.mons[monKey(ref)];
  if (!c || c.hp <= 0) return;
  if (ref.side === 'me') c.hp = Math.max(0, c.hp - round(maxHPOf(ctx, live, ref) * frac));
  else {
    c.hp = Math.max(0, Math.round(c.hp - 100 * frac));
    c.hpEstimated = true;
  }
}

/** Off the ground: Flying, Levitate or an Air Balloon ("maybe": an ability or item of theirs not known yet could lift it). */
function airborne(ctx: StateCtx, live: Snapshot, ref: MonRef): 'yes' | 'no' | 'maybe' {
  const types = typesOf(ctx, live, ref);
  const ability = knownAbility(ctx, live, ref);
  const item = knownItem(ctx, live, ref);
  if (types.includes('Flying') || ability === 'Levitate' || item === 'Air Balloon') return 'yes';
  if (ref.side === 'me') return 'no';
  const preview = ctx.battle.oppPreview[ref.slot];
  const formes = ctx.fmt.preview[preview] ?? [preview];
  const levitate = !ability && formes.some(f => (Object.values(ctx.gen.species.get(toID(f))?.abilities ?? {}) as string[]).includes('Levitate'));
  const balloon = !item && formes.some(f => (ctx.fmt.species[f]?.items ?? []).some(([n]) => n === 'Air Balloon'));
  return levitate || balloon ? 'maybe' : 'no';
}

/**
 * Entry hazards on the way in. There are no Heavy-Duty Boots in Champions, so they're certain from
 * types, except for what an unknown ability or item of theirs could change (Magic Guard, Levitate,
 * an Air Balloon): then its HP is left unknown until it's read, rather than guessed.
 */
function entryHazards(ctx: StateCtx, live: Snapshot, ref: MonRef) {
  const side: SideCondition = live.field[ref.side];
  const c = live.mons[monKey(ref)];
  if (!c || c.hp <= 0 || (!side.stealthRock && !side.spikes && !side.toxicSpikes && !side.stickyWeb)) return;
  const ability = knownAbility(ctx, live, ref);
  const preview = ctx.battle.oppPreview[ref.slot];
  const maybeGuard = ref.side === 'opp' && !ability
    && (ctx.fmt.preview[preview] ?? [preview]).some(f => (ctx.fmt.species[f]?.abilities ?? []).some(([n]) => n === 'Magic Guard'));
  const air = airborne(ctx, live, ref);
  const types = typesOf(ctx, live, ref);
  let frac = 0;
  if (side.stealthRock) frac += typeEffectiveness(ctx.gen, 'Rock', types) / 8;
  if (side.spikes && air !== 'yes') frac += [0, 1 / 8, 1 / 6, 1 / 4][Math.min(3, side.spikes)];
  if (frac && ability !== 'Magic Guard') {
    if (maybeGuard || (side.spikes && air === 'maybe')) c.hpUnknown = true;
    else loseHP(ctx, live, ref, frac);
  }
  if (air !== 'no') return;
  if (side.toxicSpikes) {
    // A grounded Poison type soaks them up.
    if (types.includes('Poison')) live.field[ref.side] = {...side, toxicSpikes: 0};
    else if (!types.includes('Steel')) giveStatus(ctx, live, ref, side.toxicSpikes >= 2 ? 'tox' : 'psn');
  }
  if (side.stickyWeb) dropStats(ctx, live, ref, {spe: -1});
}

/** Knock Off, Thief, Bug Bite: the target's item taken, as far as it's known there was one to take. */
function takeItem(ctx: StateCtx, live: Snapshot, ev: ActionEvent, fx: MoveFx, target: MonRef) {
  if (!fx.it || fx.it === 'fling' || ev.failed) return;
  const c = live.mons[monKey(target)];
  if (!c || c.itemGone) return;
  // A Mega Stone can't be taken from the Pokémon it's for.
  const set = target.side === 'me' ? ctx.battle.myTeam[target.slot] : undefined;
  if ((set && megaFormeOf(ctx.gen, set)) || (target.side === 'opp' && c.mega)) return;
  if (fx.it === 'knock') c.itemGone = true;
  if (fx.it === 'steal') {
    // Only a thief with nothing in hand takes it (known for mine).
    const thief = ev.actor.side === 'me' ? ctx.battle.myTeam[ev.actor.slot] : undefined;
    if (thief && (!thief.item || live.mons[monKey(ev.actor)]?.itemGone)) c.itemGone = true;
  }
  if (fx.it === 'eat' && /Berry$/.test(knownItem(ctx, live, target) ?? '')) c.itemGone = true;
}

/** Stat stages set, copied, reset or swapped by the move (Belly Drum, Haze, Psych Up…). */
function stageOps(ctx: StateCtx, live: Snapshot, ev: ActionEvent, op: NonNullable<MoveFx['bo']>) {
  const actor = live.mons[monKey(ev.actor)];
  if (!actor) return;
  const target = ev.targetRefs?.[0] ?? ev.hits.find(h => !h.noEffect)?.target;
  const t = target ? live.mons[monKey(target)] : undefined;
  const swap = (keys: ('atk' | 'def' | 'spa' | 'spd')[]) => {
    if (!t) return;
    const a = {...actor.boosts};
    const b = {...t.boosts};
    for (const k of keys) [a[k], b[k]] = [b[k], a[k]];
    actor.boosts = a;
    t.boosts = b;
  };
  if (op === 'max') actor.boosts = {...actor.boosts, atk: 6};
  if (op === 'curse') {
    if (typesOf(ctx, live, ev.actor).includes('Ghost')) loseHP(ctx, live, ev.actor, 1 / 2);
    else raiseStats(ctx, live, ev.actor, {atk: 1, def: 1, spe: -1});
  }
  if (op === 'haze') {
    for (const s of ['me', 'opp'] as const) {
      for (const slot of live.active[s]) if (slot !== null && live.mons[`${s}${slot}`]) live.mons[`${s}${slot}`].boosts = {};
    }
  }
  if (op === 'clear') for (const h of ev.hits) if (!h.noEffect && live.mons[monKey(h.target)]) live.mons[monKey(h.target)].boosts = {};
  if (op === 'copy' && t) actor.boosts = {...t.boosts};
  if (op === 'invert' && t) t.boosts = Object.fromEntries(Object.entries(t.boosts).map(([k, v]) => [k, -(v ?? 0)]));
  if (op === 'swapdef') swap(['def', 'spd']);
  if (op === 'swapatk') swap(['atk', 'spa']);
}

/** How HP costs are rounded, as the games do it (the rest round down). */
const COST_ROUND: Record<string, (x: number) => number> = {shedtail: Math.ceil, mindblown: Math.round, steelbeam: Math.round, chloroblast: Math.round};

/** What an Intimidate does to one target, with the reactions we can see coming. */
function intimidateDelta(ctx: StateCtx, live: Snapshot, target: MonRef): Boosts {
  const c = live.mons[monKey(target)];
  if (!c || c.hp <= 0) return {};
  const a = knownAbility(ctx, live, target);
  if ((a && IGNORES_INTIMIDATE.has(a)) || knownItem(ctx, live, target) === 'Clear Amulet') return {};
  if (a === 'Guard Dog' || a === 'Contrary') return {atk: 1};
  if (a === 'Simple') return {atk: -2};
  const d: Boosts = {atk: a === 'Defiant' ? 1 : -1};
  if (a === 'Competitive') d.spa = 2;
  if (a === 'Rattled') d.spe = 1;
  return d;
}

/** Intimidate from `source` on the opposing Pokémon; sign -1 takes it back. */
function applyIntimidate(ctx: StateCtx, live: Snapshot, source: MonRef, sign: 1 | -1) {
  for (const slot of live.active[foe(source.side)]) {
    if (slot === null) continue;
    const target = {side: foe(source.side), slot};
    const d = intimidateDelta(ctx, live, target);
    addStages(live, target, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (v ?? 0) * sign])));
  }
}

/** Carry a logged action's consequences into the live state. */
export function applyAction(ctx: StateCtx, live: Snapshot, ev: ActionEvent): Snapshot {
  const next = clone(live);
  const fx = moveFx(ev.move);
  const actorKey = monKey(ev.actor);
  // Moving again closes the opening a Glaive Rush left.
  const mover = next.mons[actorKey];
  if (mover?.exposed !== undefined) next.mons[actorKey] = without(mover, 'exposed');
  const damaging = ev.hits.length > 0 || !!ctx.gen.moves.get(toID(ev.move))?.basePower;

  const moveType = ctx.gen.moves.get(toID(ev.move))?.type;
  for (const hit of ev.hits) {
    const key = monKey(hit.target);
    const t = next.mons[key];
    // A Fire move taken in by Flash Fire: its Fire moves are stronger from now on (the calc applies it where that's its ability).
    if (t && hit.noEffect && moveType === 'Fire' && mayHaveAbility(ctx, next, hit.target, 'Flash Fire')) t.abilityOn = true;
    if (!t || hit.noEffect) continue;
    const max = maxHPOf(ctx, next, hit.target);
    if (hit.unread) {
      // Hit, but the HP wasn't read: unknown until the next reading. Guaranteed effects still happen.
      t.hpUnknown = true;
    } else {
      t.hp = hit.fainted ? 0 : hit.hpAfter;
      t.hpEstimated = false;
      t.hpUnknown = false;
    }
    giveStatus(ctx, next, hit.target, hit.status);
    if (hit.triggers.some(x => x === 'berry' || x === 'sash' || x === 'wp' || x === 'sitrus')) t.itemGone = true;
    if (hit.triggers.includes('sitrus') && !hit.fainted && !hit.healed) t.hp = Math.min(max, t.hp + Math.floor(max / 4));
    // My own Focus Sash saving me from full HP (which also turns on Unburden).
    if (hit.target.side === 'me' && !hit.unread && !hit.fainted && hit.hpAfter === 1 && hit.hpBefore === max
      && knownItem(ctx, next, hit.target) === 'Focus Sash') t.itemGone = true;
    // My own Sitrus: I know I hold it, so no message needed.
    if (hit.target.side === 'me' && !hit.unread && !hit.fainted && !hit.triggers.includes('sitrus')) {
      if (knownItem(ctx, next, hit.target) === 'Sitrus Berry' && t.hp <= Math.floor(max / 2)) {
        t.hp = Math.min(max, t.hp + Math.floor(max / 4));
        t.itemGone = true;
      }
      if (knownItem(ctx, next, hit.target) === 'Oran Berry' && t.hp <= Math.floor(max / 2)) {
        t.hp = Math.min(max, t.hp + 10);
        t.itemGone = true;
      }
    }
    // An Air Balloon pops at the first hit.
    if (knownItem(ctx, next, hit.target) === 'Air Balloon') t.itemGone = true;
    takeItem(ctx, next, ev, fx, hit.target);
    if (hit.fainted) {
      next.mons[key] = {...t, boosts: {}};
      continue;
    }
    // Hit by a damaging move with Electromorphosis: charged, so its next Electric move has double the power.
    if (damaging && mayHaveAbility(ctx, next, hit.target, 'Electromorphosis')) t.abilityOn = true;
    if (hit.triggers.includes('wp')) raiseStats(ctx, next, hit.target, {atk: 2, spa: 2});
    const drops: Boosts = {};
    for (const s of fx.sec ?? []) {
      if (s.ch >= 100 && s.b) {
        dropStats(ctx, next, hit.target, s.b);
        Object.assign(drops, s.b);
      }
      if (s.ch >= 100 && s.st) giveStatus(ctx, next, hit.target, s.st);
    }
    if (hit.boosts) dropStats(ctx, next, hit.target, hit.boosts);
    if (hit.reaction) applyReaction(next, hit.target, hit.reaction, drops);
    // Held by a binding move (not again while it's held), or salt cured: hurt at each turn's end from now on.
    const held = next.mons[key];
    if (held && BINDS.has(toID(ev.move)) && !held.bound) next.mons[key] = {...held, bound: {move: ev.move, by: ev.actor, ticks: 0}};
    if (held && toID(ev.move) === 'saltcure') next.mons[key] = {...next.mons[key], salted: true};
  }

  if (!ev.failed) {
    const landed = !damaging || ev.hits.some(h => !h.noEffect);
    if (landed && fx.sb) raiseStats(ctx, next, ev.actor, fx.sb);
    for (const s of fx.sec ?? []) if (landed && s.ch >= 100 && s.sb) raiseStats(ctx, next, ev.actor, s.sb);
    // A charge's rise (Electro Shot, Meteor Beam) comes before the attack: blocked by a Protect, it's still had.
    // As the game said it (a Contrary user's "fell" included).
    if ((landed || RISES_BEFORE_HIT[toID(ev.move)]) && ev.actorBoosts) addStages(next, ev.actor, ev.actorBoosts);
    for (const target of ev.targetRefs ?? []) {
      if (fx.tb) dropStats(ctx, next, target, fx.tb);
      giveStatus(ctx, next, target, fx.st);
      // Leech Seed takes on anyone but a Grass type.
      const seeded = next.mons[monKey(target)];
      if (seeded && seeded.hp > 0 && toID(ev.move) === 'leechseed' && !typesOf(ctx, next, target).includes('Grass')) next.mons[monKey(target)] = {...seeded, seeded: true};
    }
    // Rapid Spin, Mortal Spin: free of what held and seeded it.
    const spun = next.mons[actorKey];
    if (landed && spun && SPINS.has(toID(ev.move))) next.mons[actorKey] = without(spun, 'bound', 'seeded');
    applyFieldEffects(ctx, next, ev.actor, fx, landed);
    if (fx.bo) stageOps(ctx, next, ev, fx.bo);
    // Growth is doubled in the sun.
    const sun = next.field.weather === 'Sun' || next.field.weather === 'Harsh Sunshine';
    if (toID(ev.move) === 'growth' && sun) raiseStats(ctx, next, ev.actor, {atk: 1, spa: 1});
    if (fx.hpc) loseHP(ctx, next, ev.actor, fx.hpc, COST_ROUND[toID(ev.move)]);
    const self = next.mons[actorKey];
    if (self) {
      if (fx.it === 'fling') self.itemGone = true;
      if (landed && EXPOSES.has(toID(ev.move))) self.exposed = ev.turn;
      // Stance Change: Aegislash's Blade forme for an attack, its Shield again for King's Shield.
      const species = ev.actor.side === 'me' ? ctx.battle.myTeam[ev.actor.slot]?.species : ctx.battle.oppPreview[ev.actor.slot];
      if (/^aegislash/.test(toID(species ?? ''))) {
        if (toID(ev.move) === 'kingsshield') delete self.blade;
        else if (damaging) self.blade = true;
      }
      // A Normal Gem goes with the first Normal move it powers.
      if (landed && damaging && moveType === 'Normal' && knownItem(ctx, next, ev.actor) === 'Normal Gem') self.itemGone = true;
      // The charge from Electromorphosis goes with the Electric move it powered.
      if (damaging && moveType === 'Electric' && self.abilityOn && mayHaveAbility(ctx, next, ev.actor, 'Electromorphosis')) self.abilityOn = false;
      // Healed or hurt by an amount of the damage it dealt (Drain Punch, Brave Bird): unknown until it's read.
      if ((fx.dr || fx.rc) && ev.hits.some(h => !h.noEffect)) self.hpUnknown = true;
      // Explosion always; Memento, Final Gambit and Healing Wish once they work.
      if (fx.sd === 1 || (fx.sd === 2 && landed)) next.mons[actorKey] = {...self, hp: 0, boosts: {}, hpUnknown: false, hpEstimated: false};
    }
  }

  const actor = next.mons[actorKey];
  if (actor) {
    giveStatus(ctx, next, ev.actor, ev.actorStatus);
    const max = maxHPOf(ctx, next, ev.actor);
    const dealt = ev.hits.some(h => !h.noEffect);
    const lifeOrb = ev.actor.side === 'opp'
      ? ev.actorTriggers.includes('lifeorb')
      : dealt && knownItem(ctx, next, ev.actor) === 'Life Orb' && knownAbility(ctx, next, ev.actor) !== 'Magic Guard';
    if (lifeOrb) {
      actor.hp = Math.max(0, actor.hp - (ev.actor.side === 'opp' ? 10 : Math.floor(max / 10)));
      if (ev.actor.side === 'opp') actor.hpEstimated = true;
    }
    if (ev.actorTriggers.includes('helmet')) actor.hp = Math.max(0, actor.hp - Math.floor(max / 6));
    if (ev.actorTriggers.includes('helmet') || lifeOrb) {
      // HP after recoil is computed, not read off the screen.
      if (ev.actor.side === 'opp') actor.hpEstimated = true;
    }
    // Read off the screen after all that: where it really is.
    if (ev.actorHpAfter !== undefined) {
      Object.assign(actor, {hp: Math.min(max, ev.actorHpAfter), hpUnknown: false, hpEstimated: false});
      if (actor.hp <= 0) actor.boosts = {};
    }
  }
  return next;
}

/**
 * Whether the one leaving `side`'s place is passing on its stat stages: its last move, this turn, was a Baton Pass that
 * worked (the one coming in is the one it passes to).
 */
function batonPassed(battle: Battle, side: SideID, out: number): boolean {
  for (let i = battle.events.length - 1; i >= 0; i--) {
    const e = battle.events[i];
    if (e.turn !== battle.turn) return false;
    if (e.kind === 'switch' && e.side === side && (e.slotIn === out || e.slotOut === out)) return false;
    if (e.kind === 'action' && e.actor.side === side && e.actor.slot === out) return toID(e.move) === 'batonpass' && !e.failed;
  }
  return false;
}

/** Put `slotIn` into `position` (or empty it), with switch-in abilities; after a Baton Pass, the stages go with it. */
export function applySwitch(
  ctx: StateCtx, live: Snapshot, side: SideID, position: number, slotIn: number | null, entryAbility = true,
): Snapshot {
  const next = clone(live);
  const positions = next.active[side];
  const out = positions[position];
  if (slotIn !== null) {
    const already = positions.indexOf(slotIn);
    if (already >= 0) positions[already] = null;
  }
  let passed: Boosts | null = null;
  if (out !== null && out !== undefined) {
    const c = next.mons[`${side}${out}`];
    if (c && slotIn !== null && batonPassed(ctx.battle, side, out)) passed = {...c.boosts};
    if (c) next.mons[`${side}${out}`] = {...without(c, 'types', 'exposed', 'odd', 'blade', 'bound', 'seeded', 'salted'), boosts: {}, abilityOn: false, toxic: 0};
    // Its binding moves let go of those they held.
    for (const [key, m] of Object.entries(next.mons)) if (m.bound && m.bound.by.side === side && m.bound.by.slot === out) next.mons[key] = without(m, 'bound');
  }
  if (passed && slotIn !== null) {
    const c = next.mons[`${side}${slotIn}`];
    if (c) next.mons[`${side}${slotIn}`] = {...c, boosts: passed};
  }
  positions[position] = slotIn;
  if (slotIn !== null) entryHazards(ctx, next, {side, slot: slotIn});
  if (slotIn !== null && entryAbility) {
    const ref = {side, slot: slotIn};
    switchInAbility(ctx, next, ref, knownAbility(ctx, next, ref));
  }
  return next;
}

/** Leads: everyone is out before any Intimidate or weather goes off. */
export function applyEntryAbilities(ctx: StateCtx, live: Snapshot, refs: MonRef[]): Snapshot {
  const next = clone(live);
  for (const ref of refs) switchInAbility(ctx, next, ref, knownAbility(ctx, next, ref));
  return next;
}

/** What the game showed at a switch-in or Intimidate: apply it (the evidence is in posterior.ts). */
export function applyCheck(ctx: StateCtx, live: Snapshot, ev: CheckEvent): Snapshot {
  const next = clone(live);
  if (ev.skipped || !ev.seen) return next;
  // A seed goes as it's used.
  const c = next.mons[monKey(ev.mon)];
  if (c && ev.seenKind === 'item' && Object.values(SEEDS).includes(ev.seen)) next.mons[monKey(ev.mon)] = {...c, itemGone: true};
  if (ev.applied || ev.context === 'terrain') return next;
  if (ev.context === 'entry') {
    if (ev.seenKind !== 'item') switchInAbility(ctx, next, ev.mon, ev.seen);
  } else {
    applyReaction(next, ev.mon, ev.seen, {atk: -1});
  }
  return next;
}

/** Mega Evolution: new forme, and its ability kicks in immediately (Drought, Sand Stream…). */
export function applyMega(ctx: StateCtx, live: Snapshot, ref: MonRef): Snapshot {
  const next = clone(live);
  const c = next.mons[monKey(ref)];
  if (!c) return next;
  next.mons[monKey(ref)] = {...c, mega: true};
  switchInAbility(ctx, next, ref, knownAbility(ctx, next, ref));
  return next;
}

export function canMega(ctx: StateCtx, live: Snapshot, ref: MonRef): boolean {
  const already = Object.entries(live.mons).some(([k, c]) => k.startsWith(ref.side) && c.mega);
  if (already) return false;
  if (ref.side === 'me') return !!megaFormeOf(ctx.gen, ctx.battle.myTeam[ref.slot]);
  return true;
}

const SAND_IMMUNE_TYPES = new Set(['Rock', 'Ground', 'Steel']);
const SAND_IMMUNE_ABILITIES = new Set(['Sand Veil', 'Sand Rush', 'Sand Force', 'Overcoat', 'Magic Guard']);

/** End of turn: timers tick down, then residual damage and healing. */
export function applyEndTurn(ctx: StateCtx, live: Snapshot): Snapshot {
  const next = clone(live);
  const f = next.field;
  const turns = {...(f.turns ?? {})};
  for (const [key, left] of Object.entries(turns)) {
    if (left > 1) {
      turns[key] = left - 1;
      continue;
    }
    // Its 5th turn over, set by one of theirs that may hold what makes it last 8: up still, as it would be (the game
    // says if it's over, and the narrator takes its silence for the item).
    const may = f.mayLast?.[key];
    if (may && !may.past) {
      turns[key] = 3;
      f.mayLast = {...f.mayLast, [key]: {...may, past: true}};
      continue;
    }
    if (may) delete f.mayLast?.[key];
    delete turns[key];
    if (key === 'weather') f.weather = undefined;
    else if (key === 'terrain') f.terrain = undefined;
    else if (key === 'trickRoom') f.trickRoom = false;
    else if (key === 'magicRoom') f.magicRoom = false;
    else if (key === 'wonderRoom') f.wonderRoom = false;
    else if (key === 'gravity') f.gravity = false;
    else {
      const [side, cond] = key.split('.') as [SideID, keyof typeof f.me];
      f[side] = {...f[side], [cond]: false};
    }
  }
  f.turns = turns;
  // Glaive Rush's opening lasts until its user moves again: a turn on, it has had its go.
  for (const [key, c] of Object.entries(next.mons)) if (c.exposed !== undefined && c.exposed < ctx.battle.turn) next.mons[key] = without(c, 'exposed');

  for (const side of ['me', 'opp'] as const) {
    for (const slot of next.active[side]) {
      if (slot === null) continue;
      const ref = {side, slot};
      const c: MonCondition | undefined = next.mons[monKey(ref)];
      if (!c || c.hp <= 0) continue;
      const max = maxHPOf(ctx, next, ref);
      const ability = knownAbility(ctx, next, ref);
      const item = knownItem(ctx, next, ref);
      const types = typesOf(ctx, next, ref);
      const frac = (n: number) => (side === 'me' ? Math.floor(max / n) : 100 / n);
      let delta = 0;
      const guarded = ability === 'Magic Guard';
      const onGround = grounded(ctx, next, ref);
      if (f.weather === 'Sand' && !guarded && !types.some(t => SAND_IMMUNE_TYPES.has(t)) && !SAND_IMMUNE_ABILITIES.has(ability ?? '') && item !== 'Safety Goggles') delta -= frac(16);
      if (f.terrain === 'Grassy' && onGround) delta += frac(16);
      if (item === 'Leftovers') delta += frac(16);
      if (item === 'Black Sludge') delta += types.includes('Poison') ? frac(16) : -frac(8);
      if (!guarded && c.status === 'brn') delta -= frac(16);
      if (!guarded && c.status === 'psn' && ability !== 'Poison Heal') delta -= frac(8);
      let toxic = c.toxic;
      if (!guarded && c.status === 'tox' && ability !== 'Poison Heal') {
        toxic = Math.min(15, (c.toxic ?? 0) + 1);
        delta -= side === 'me' ? Math.floor((max * toxic) / 16) : (100 * toxic) / 16;
      }
      if (!guarded && c.seeded) delta -= frac(8);
      if (!guarded && c.salted) delta -= frac(types.includes('Water') || types.includes('Steel') ? 4 : 8);
      // Held by a binding move: hurt while its binder stays in, 4 or 5 times (7 with a Grip Claw), then freed (the
      // game says so, and the narrator frees it sooner if it's 4). Its binder gone, it's free, unhurt.
      let bound = c.bound;
      if (bound) {
        const binder = next.mons[monKey(bound.by)];
        const holding = next.active[bound.by.side].includes(bound.by.slot) && (binder?.hp ?? 0) > 0;
        const binderItem = knownItem(ctx, next, bound.by);
        if (!holding || bound.ticks >= (binderItem === 'Grip Claw' ? 7 : 5)) bound = undefined;
        else {
          if (!guarded) delta -= frac(binderItem === 'Binding Band' ? 6 : 8);
          bound = {...bound, ticks: bound.ticks + 1};
        }
      }
      if (!delta && bound === c.bound) continue;
      const hp = Math.max(0, Math.min(max, c.hp + delta));
      const after: MonCondition = {...c, toxic, bound, hp: side === 'me' ? hp : Math.round(hp), hpEstimated: side === 'opp' && delta ? true : c.hpEstimated};
      if (!bound) delete after.bound;
      next.mons[monKey(ref)] = after;
    }
  }
  return next;
}
