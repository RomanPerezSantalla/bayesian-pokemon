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
import {makePokemon} from './calc';
import {megaFormeOf, mySpec} from './likelihood';
import {reactionEffect} from './abilities';
import {moveFx, type MoveFx} from './moves';
import {
  monKey, type ActionEvent, type Battle, type Boosts, type CheckEvent, type FieldCondition, type MonCondition, type MonRef, type SideID,
  type Snapshot, type Weather,
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
const WEATHER_ABILITY: Record<string, Weather> = {Drought: 'Sun', Drizzle: 'Rain', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'};
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

function setWeather(field: FieldCondition, w: Weather) {
  field.weather = w;
  setTimed(field, 'weather', 5);
}

function applyFieldEffects(live: Snapshot, side: SideID, fx: MoveFx) {
  const f = live.field;
  if (fx.w) setWeather(f, WEATHER[fx.w]);
  if (fx.tr) {
    f.terrain = (fx.tr.charAt(0).toUpperCase() + fx.tr.slice(1)) as FieldCondition['terrain'];
    setTimed(f, 'terrain', 5);
  }
  if (fx.pw === 'trickroom') {
    f.trickRoom = !f.trickRoom;
    if (f.trickRoom) setTimed(f, 'trickRoom', 5);
    else delete f.turns?.trickRoom;
  }
  if (fx.pw === 'gravity') {
    f.gravity = true;
    setTimed(f, 'gravity', 5);
  }
  if (fx.sc) {
    const key = fx.sc === 'lightscreen' ? 'lightScreen' : fx.sc === 'auroraveil' ? 'auroraVeil' : fx.sc;
    f[side] = {...f[side], [key]: true};
    setTimed(f, `${side}.${key}`, fx.sc === 'tailwind' ? 4 : 5);
  }
}

function switchInAbility(ctx: StateCtx, live: Snapshot, ref: MonRef, ability: string | undefined) {
  if (!ability) return;
  const w = WEATHER_ABILITY[ability];
  if (w) setWeather(live.field, w);
  const t = TERRAIN_ABILITY[ability];
  if (t) {
    live.field.terrain = t;
    setTimed(live.field, 'terrain', 5);
  }
  if (ability === 'Intimidate') applyIntimidate(ctx, live, ref, 1);
}

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
    t.hp = hit.fainted ? 0 : hit.hpAfter;
    t.hpEstimated = false;
    if (hit.status && !t.status) t.status = hit.status;
    if (hit.triggers.some(x => x === 'berry' || x === 'sash' || x === 'wp' || x === 'sitrus')) t.itemGone = true;
    if (hit.triggers.includes('sitrus') && !hit.fainted) t.hp = Math.min(max, t.hp + Math.floor(max / 4));
    // My own Focus Sash saving me from full HP (which also turns on Unburden).
    if (hit.target.side === 'me' && !hit.fainted && hit.hpAfter === 1 && hit.hpBefore === max
      && knownItem(ctx, next, hit.target) === 'Focus Sash') t.itemGone = true;
    // My own Sitrus: I know I hold it, so no message needed.
    if (hit.target.side === 'me' && !hit.fainted && !hit.triggers.includes('sitrus')) {
      if (knownItem(ctx, next, hit.target) === 'Sitrus Berry' && t.hp <= Math.floor(max / 2)) {
        t.hp = Math.min(max, t.hp + Math.floor(max / 4));
        t.itemGone = true;
      }
    }
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
      if (s.ch >= 100 && s.st && !next.mons[key].status) next.mons[key] = {...next.mons[key], status: s.st};
    }
    if (hit.boosts) dropStats(ctx, next, hit.target, hit.boosts);
    if (hit.reaction) applyReaction(next, hit.target, hit.reaction, drops);
  }

  if (!ev.failed) {
    const landed = !damaging || ev.hits.some(h => !h.noEffect);
    if (landed && fx.sb) raiseStats(next, ev.actor, fx.sb);
    for (const s of fx.sec ?? []) if (landed && s.ch >= 100 && s.sb) raiseStats(next, ev.actor, s.sb);
    for (const target of ev.targetRefs ?? []) {
      if (fx.tb) dropStats(ctx, next, target, fx.tb);
      const tc = next.mons[monKey(target)];
      if (fx.st && tc && !tc.status && tc.hp > 0) next.mons[monKey(target)] = {...tc, status: fx.st};
    }
    applyFieldEffects(next, ev.actor.side, fx);
  }

  const actor = next.mons[actorKey];
  if (actor) {
    if (ev.actorStatus && !actor.status) actor.status = ev.actorStatus;
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
