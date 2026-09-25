/**
 * The live battle state, advanced automatically from what's logged so the user
 * only types what the game actually showed: HP, crits, messages.
 *
 * Everything here is bookkeeping, not inference: stat stages from moves, statuses,
 * weather/terrain/Tailwind/Trick Room/screens with their turn counters, switch-in
 * abilities, berries, end-of-turn residuals.
 */
import {toID, type BoostID, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {makePokemon, typeEffectiveness} from './calc';
import {megaFormeOf, mySpec} from './likelihood';
import {reactionEffect} from './abilities';
import {moveFx, type MoveFx} from './moves';
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
const clamp6 = (v: number) => Math.max(-6, Math.min(6, v));
const foe = (side: SideID): SideID => (side === 'me' ? 'opp' : 'me');

const WEATHER: Record<string, Weather> = {sun: 'Sun', rain: 'Rain', sand: 'Sand', snow: 'Snow'};
export const WEATHER_ABILITY: Record<string, Weather> = {Drought: 'Sun', Drizzle: 'Rain', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'};
const TERRAIN_ABILITY: Record<string, FieldCondition['terrain']> = {
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

export function maxHPOf(ctx: StateCtx, live: Snapshot, ref: MonRef): number {
  if (ref.side === 'opp') return 100;
  const set = ctx.battle.myTeam[ref.slot];
  return set ? makePokemon(ctx.gen, mySpec(ctx.gen, ctx.fmt, set, live.mons[monKey(ref)])).maxHP() : 100;
}

/** Stat changes from an opponent's move or ability, with the reactions we can see coming. */
function dropStats(ctx: StateCtx, live: Snapshot, ref: MonRef, boosts: Boosts) {
  const c = live.mons[monKey(ref)];
  if (!c || c.hp <= 0) return;
  const ability = knownAbility(ctx, live, ref);
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
  raiseStats(live, ref, boosts);
  const c = live.mons[monKey(ref)];
  if (c && itemGone) live.mons[monKey(ref)] = {...c, itemGone: true};
}

function raiseStats(live: Snapshot, ref: MonRef, boosts: Boosts) {
  const c = live.mons[monKey(ref)];
  if (!c || c.hp <= 0) return;
  const next = {...c.boosts};
  for (const [k, v] of Object.entries(boosts) as [BoostID, number][]) next[k] = clamp6((next[k] ?? 0) + v);
  live.mons[monKey(ref)] = {...c, boosts: next};
}

function setTimed(field: FieldCondition, key: string, turns: number) {
  field.turns = {...(field.turns ?? {}), [key]: turns};
}

/** The rock that makes the setter's weather last 8 turns instead of 5. */
const WEATHER_ROCK: Partial<Record<Weather, string>> = {Sun: 'Heat Rock', Rain: 'Damp Rock', Sand: 'Smooth Rock', Snow: 'Icy Rock'};

function setWeather(field: FieldCondition, w: Weather, item?: string) {
  field.weather = w;
  setTimed(field, 'weather', item && WEATHER_ROCK[w] === item ? 8 : 5);
}

function setTerrain(field: FieldCondition, t: FieldCondition['terrain'], item?: string) {
  field.terrain = t;
  setTimed(field, 'terrain', item === 'Terrain Extender' ? 8 : 5);
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
  if (fx.w) setWeather(f, WEATHER[fx.w], item);
  if (fx.tr) setTerrain(f, (fx.tr.charAt(0).toUpperCase() + fx.tr.slice(1)) as FieldCondition['terrain'], item);
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
    for (const k of SCREENS) delete f.turns?.[`${foeSide}.${k}`];
    f.terrain = undefined;
    delete f.turns?.terrain;
  }
  if (fx.clr === 'swap') {
    const turns: Record<string, number> = {};
    for (const [key, left] of Object.entries(f.turns ?? {})) {
      const [s, cond] = key.split('.');
      turns[cond && (s === 'me' || s === 'opp') ? `${foe(s)}.${cond}` : key] = left;
    }
    [f.me, f.opp] = [f.opp, f.me];
    f.turns = turns;
  }
}

function switchInAbility(ctx: StateCtx, live: Snapshot, ref: MonRef, ability: string | undefined) {
  if (!ability) return;
  const item = knownItem(ctx, live, ref);
  const w = WEATHER_ABILITY[ability];
  if (w) setWeather(live.field, w, item);
  const t = TERRAIN_ABILITY[ability];
  if (t) setTerrain(live.field, t, item);
  if (ability === 'Intimidate') applyIntimidate(ctx, live, ref, 1);
}

/** Its types (as a Mega once it has evolved, where that's known). */
function typesOf(ctx: StateCtx, live: Snapshot, ref: MonRef): string[] {
  const c = live.mons[monKey(ref)];
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
    else raiseStats(live, ev.actor, {atk: 1, def: 1, spe: -1});
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
  if (a === 'Guard Dog') return {atk: 1};
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
    raiseStats(live, target, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (v ?? 0) * sign])));
  }
}

/** Carry a logged action's consequences into the live state. */
export function applyAction(ctx: StateCtx, live: Snapshot, ev: ActionEvent): Snapshot {
  const next = clone(live);
  const fx = moveFx(ev.move);
  const actorKey = monKey(ev.actor);
  const damaging = ev.hits.length > 0 || !!ctx.gen.moves.get(toID(ev.move))?.basePower;

  for (const hit of ev.hits) {
    const key = monKey(hit.target);
    const t = next.mons[key];
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
    if (hit.triggers.includes('wp')) raiseStats(next, hit.target, {atk: 2, spa: 2});
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
  }

  if (!ev.failed) {
    const landed = !damaging || ev.hits.some(h => !h.noEffect);
    if (landed && fx.sb) raiseStats(next, ev.actor, fx.sb);
    for (const s of fx.sec ?? []) if (landed && s.ch >= 100 && s.sb) raiseStats(next, ev.actor, s.sb);
    if (landed && ev.actorBoosts) raiseStats(next, ev.actor, ev.actorBoosts);
    for (const target of ev.targetRefs ?? []) {
      if (fx.tb) dropStats(ctx, next, target, fx.tb);
      giveStatus(ctx, next, target, fx.st);
    }
    applyFieldEffects(ctx, next, ev.actor, fx, landed);
    if (fx.bo) stageOps(ctx, next, ev, fx.bo);
    // Growth is doubled in the sun.
    const sun = next.field.weather === 'Sun' || next.field.weather === 'Harsh Sunshine';
    if (toID(ev.move) === 'growth' && sun) raiseStats(next, ev.actor, {atk: 1, spa: 1});
    if (fx.hpc) loseHP(ctx, next, ev.actor, fx.hpc, COST_ROUND[toID(ev.move)]);
    const self = next.mons[actorKey];
    if (self) {
      if (fx.it === 'fling') self.itemGone = true;
      // A Normal Gem goes with the first Normal move it powers.
      const moveType = ctx.gen.moves.get(toID(ev.move))?.type;
      if (landed && damaging && moveType === 'Normal' && knownItem(ctx, next, ev.actor) === 'Normal Gem') self.itemGone = true;
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

/** Put `slotIn` into `position` (or empty it), with switch-in abilities. */
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
  if (out !== null && out !== undefined) {
    const c = next.mons[`${side}${out}`];
    if (c) next.mons[`${side}${out}`] = {...c, boosts: {}, abilityOn: false, toxic: 0};
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

  for (const side of ['me', 'opp'] as const) {
    for (const slot of next.active[side]) {
      if (slot === null) continue;
      const ref = {side, slot};
      const c: MonCondition | undefined = next.mons[monKey(ref)];
      if (!c || c.hp <= 0) continue;
      const max = maxHPOf(ctx, next, ref);
      const ability = knownAbility(ctx, next, ref);
      const item = knownItem(ctx, next, ref);
      const species = side === 'me'
        ? mySpec(ctx.gen, ctx.fmt, ctx.battle.myTeam[slot], c).species
        : ctx.battle.oppPreview[slot];
      const types: string[] = [...(ctx.gen.species.get(toID(species))?.types ?? [])];
      const frac = (n: number) => (side === 'me' ? Math.floor(max / n) : 100 / n);
      let delta = 0;
      const guarded = ability === 'Magic Guard';
      const grounded = !types.includes('Flying') && ability !== 'Levitate' && item !== 'Air Balloon';
      if (f.weather === 'Sand' && !guarded && !types.some(t => SAND_IMMUNE_TYPES.has(t)) && !SAND_IMMUNE_ABILITIES.has(ability ?? '') && item !== 'Safety Goggles') delta -= frac(16);
      if (f.terrain === 'Grassy' && grounded) delta += frac(16);
      if (item === 'Leftovers') delta += frac(16);
      if (item === 'Black Sludge') delta += types.includes('Poison') ? frac(16) : -frac(8);
      if (!guarded && c.status === 'brn') delta -= frac(16);
      if (!guarded && c.status === 'psn' && ability !== 'Poison Heal') delta -= frac(8);
      let toxic = c.toxic;
      if (!guarded && c.status === 'tox' && ability !== 'Poison Heal') {
        toxic = Math.min(15, (c.toxic ?? 0) + 1);
        delta -= side === 'me' ? Math.floor((max * toxic) / 16) : (100 * toxic) / 16;
      }
      if (!delta) continue;
      const hp = Math.max(0, Math.min(max, c.hp + delta));
      next.mons[monKey(ref)] = {...c, toxic, hp: side === 'me' ? hp : Math.round(hp), hpEstimated: side === 'opp' ? true : c.hpEstimated};
    }
  }
  return next;
}
