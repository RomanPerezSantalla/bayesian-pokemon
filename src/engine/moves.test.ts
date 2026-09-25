/**
 * Every move @smogon/calc has for Pokémon Champions, one test each, against everything the app
 * does with a move: its data (type, category, power, priority), the damage the calc gives, which
 * stats that damage depends on (the inference groups hypotheses by them), what logging it does to
 * the battle (stat stages, statuses, weather, terrain, screens, rooms, hazards, HP, items), how
 * the action sheet asks for its targets and hits, and voice reading it.
 *
 * The calc's list is longer than what can be used: 15 of its moves no Pokémon in Champions learns
 * (Anchor Shot, Astral Barrage, Blood Moon, Bolt Beak, Dragon Hammer, Fishious Rend, Gear Grind,
 * Hyper Drill, Power Shift, Revelation Dance, Spore, Stuff Cheeks, Triple Dive, Water Spout; and
 * Struggle, which none needs to). They're tested all the same: the data has them.
 */
import fs from 'node:fs';
import path from 'node:path';
import {Dex} from '@pkmn/dex';
import {describe, expect, it} from 'vitest';
import {getGen, isDamagingMove, isSpreadMove, isStatusMove, toID} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import {createBattle, emptyField, uid} from './battle';
import {makeField, makeMove, makePokemon, movePriority, runCalc} from './calc';
import {relevantStats} from './likelihood';
import {DAMAGE_NOT_FROM_STATS, moveFx} from './moves';
import {applyAction, type StateCtx} from './state';
import type {ActionEvent, Boosts, FieldCondition, MonRef, Snapshot, Status} from './types';
import {hitChoices, targetPlan} from '../ui/battle/targets';
import {parseNarration} from '../ui/battle/voice/parse';

const gen = getGen(0);
const dex = Dex.forGen(9);
const MOVES = [...gen.moves].map(m => m.name).filter(n => n !== '(No Move)').sort();

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);

// Two of yours (the one moving holds nothing) against two of theirs, all on the field.
const TEAM = parseTeam('Kangaskhan\nAbility: Early Bird\n- Tackle\n\nSnorlax @ Leftovers\nAbility: Immunity\n- Tackle');
const ME: MonRef = {side: 'me', slot: 0};
const ALLY: MonRef = {side: 'me', slot: 1};
const FOE: MonRef = {side: 'opp', slot: 0};
const FOE2: MonRef = {side: 'opp', slot: 1};

function setup() {
  const battle = createBattle(fmt, TEAM, ['Metagross', 'Garchomp'], 'moves');
  battle.live.active = {me: [0, 1], opp: [0, 1]};
  const ctx: StateCtx = {fmt, gen, battle, oppAbility: () => undefined, oppItem: () => undefined};
  return {battle, ctx};
}

describe("every move in the calc's Champions data", () => {
  it('is here: 525 moves, the calc and the move table agreeing on each', () => {
    expect(MOVES.length).toBe(525);
  });

  describe.each(MOVES)('%s', name => {
    const m = gen.moves.get(toID(name))!;
    const d = dex.moves.get(name);
    const damaging = isDamagingMove(gen, name);

    it('has its data: type, category, power; and its priority for turn order', () => {
      expect(d.exists, 'in @pkmn/dex (its effects come from there)').toBe(true);
      expect(m.type, 'a type').toBeTruthy();
      expect(m.category ?? 'Status').toBe(d.category);
      if (d.category !== 'Status') expect(m.basePower ?? 0, 'power (0 only for moves with their own damage)').toBeGreaterThanOrEqual(0);
      expect(movePriority(gen, name, undefined, true, emptyField())).toBe(d.priority ?? 0);
    });

    it.runIf(damaging)('deals damage, or is known not to say anything about stats', () => {
      const dmg = damageAcross(name);
      if (DAMAGE_NOT_FROM_STATS.has(toID(name))) {
        // Kept honest: if the calc ever handles one of these, it should come off the list.
        expect(dmg, 'the calc gives it nothing').toBe(0);
      } else expect(dmg, 'damage on Snorlax or Metagross').toBeGreaterThan(0);
    });

    it.runIf(damaging && !DAMAGE_NOT_FROM_STATS.has(toID(name)))('depends only on the stats the inference groups by', () => {
      for (const role of ['attacker', 'defender'] as const) {
        const base = sig(name, role);
        const rel = relevantStats(gen, name, role, 'Synchronize');
        for (let s = 0; s < 6; s++) {
          if (rel.includes(s)) continue;
          expect(sig(name, role, s), `${role} stat ${s} changes it but isn't grouped by`).toBe(base);
        }
      }
    });

    it.runIf(isSpreadMove(gen, name) && damaging && !DAMAGE_NOT_FROM_STATS.has(toID(name)))('hits softer spread over two', () => {
      const on = damageOn(name, 'Snorlax') > 0 ? 'Snorlax' : 'Metagross';
      expect(damageOn(name, on, {targets: 2})).toBeLessThan(damageOn(name, on, {targets: 1}));
    });

    it('logs its effects on the battle', () => {
      const {ctx, battle} = setup();
      const plan = targetPlan(gen, name, [FOE, FOE2], [ALLY]);
      const targets = plan.kind === 'pick' ? [FOE] : plan.targets;
      const ev: ActionEvent = {
        kind: 'action', id: uid(), turn: 1, actor: ME, move: name, targets: Math.max(1, targets.length), helpingHand: false,
        actorTriggers: [], before: structuredClone(battle.live), ordered: true,
        hits: damaging ? targets.map(r => hit(battle.live, r)) : [],
        targetRefs: damaging ? undefined : targets,
      };
      const after = applyAction(ctx, battle.live, ev);
      const want = expected(name, targets);
      for (const [ref, boosts] of want.boosts) expect(clean(after.mons[`${ref.side}${ref.slot}`].boosts), `stat stages of ${ref.side}${ref.slot}`).toEqual(boosts);
      for (const [ref, st] of want.status) expect(after.mons[`${ref.side}${ref.slot}`].status, `status of ${ref.side}${ref.slot}`).toBe(st);
      for (const [key, value] of Object.entries(want.field)) expect(fieldValue(after.field, key), key).toEqual(value);
      const me = after.mons.me0;
      const before = battle.live.mons.me0;
      if (want.faints) expect(me.hp, 'the user faints').toBe(0);
      else if (want.cost) expect(before.hp - me.hp, 'HP it costs').toBe(want.cost(maxHP(ctx)));
      else if (want.unknownHP) expect(me.hpUnknown, 'HP changed by an amount of the damage: unknown until read').toBe(true);
      else expect(me.hp, 'no HP change for the user').toBe(before.hp);
      if (want.itemGone) expect(after.mons[`${want.itemGone.side}${want.itemGone.slot}`].itemGone, 'item taken').toBe(true);
    });

    it('is asked for the right targets on the action sheet', () => {
      const plan = targetPlan(gen, name, [FOE, FOE2], [ALLY]);
      const t = moveFx(name).tg ?? d.target;
      const kind = !damaging
        ? ['self', 'allySide', 'allyTeam', 'all', 'allies', 'adjacentAllyOrSelf', 'foeSide', 'randomNormal'].includes(t) ? 'none'
          : t === 'adjacentAlly' ? 'ally' : t === 'allAdjacentFoes' ? 'foes' : t === 'allAdjacent' ? 'around' : 'pick'
        : t === 'allAdjacentFoes' ? 'foes' : t === 'allAdjacent' ? 'around' : 'pick';
      const got = plan.kind === 'pick' ? 'pick' : plan.targets.length === 0 ? 'none'
        : plan.targets.length === 3 ? 'around' : plan.targets.length === 2 ? 'foes' : plan.targets[0].side === 'me' ? 'ally' : 'foe';
      expect(got).toBe(kind);
      // In Singles there's only ever the one foe: no asking.
      expect(targetPlan(gen, name, [FOE], []).kind).not.toBe('pick');
    });

    it('offers a hit count when it varies', () => {
      const varies = Array.isArray(d.multihit) || (!!d.multiaccuracy && !!d.multihit);
      expect(hitChoices(name).length > 0).toBe(varies);
    });

    it('is read by voice, with "used" or without', () => {
      const {battle} = setup();
      battle.live.active = {me: [0, 1], opp: [0, 1]};
      for (const line of [`The opposing Metagross used ${name}!`, `Metagross ${name}`]) {
        const use = parseNarration(line, {battle, gen, mons: undefined}).find(e => e.kind === 'use');
        expect(use && 'move' in use ? use.move : undefined, line).toBe(name);
      }
    });
  });
});

// --- damage -------------------------------------------------------------------------------------

const ZERO = [0, 0, 0, 0, 0, 0];
const mon = (species: string, ability: string, evs = ZERO, item?: string) =>
  makePokemon(gen, {species, level: 50, nature: 'Serious', evs, ability, item});

/** What a move needs before it does anything: an item to fling, an item to haunt, a terrain to roll. */
const NEEDS: Record<string, {attackerItem?: string; defenderItem?: string; terrain?: FieldCondition['terrain']}> = {
  fling: {attackerItem: 'Iron Ball'},
  poltergeist: {defenderItem: 'Leftovers'},
  steelroller: {terrain: 'Grassy'},
};

function damageOn(name: string, defender: 'Snorlax' | 'Metagross', opts: {targets?: number} = {}, evs?: {role: 'attacker' | 'defender'; stat: number}) {
  const need = NEEDS[toID(name)] ?? {};
  const spread = (role: 'attacker' | 'defender') => {
    const e = [...ZERO];
    if (evs?.role === role) e[evs.stat] = 32;
    return e;
  };
  const a = mon('Kangaskhan', 'Early Bird', spread('attacker'), need.attackerItem);
  const t = mon(defender, defender === 'Snorlax' ? 'Immunity' : 'Clear Body', spread('defender'), need.defenderItem);
  const field = makeField('doubles', {...emptyField(), terrain: need.terrain}, 'me');
  return Math.max(...runCalc(gen, a, t, makeMove(gen, name, {targets: opts.targets ?? 1}), field).dist.keys());
}

const damageAcross = (name: string) => Math.max(damageOn(name, 'Snorlax'), damageOn(name, 'Metagross'));

/** The whole damage distribution, with one stat of one side raised (or none). */
function sig(name: string, role: 'attacker' | 'defender', stat?: number) {
  const need = NEEDS[toID(name)] ?? {};
  const e = [...ZERO];
  if (stat !== undefined) e[stat] = 32;
  const a = mon('Kangaskhan', 'Early Bird', role === 'attacker' ? e : ZERO, need.attackerItem);
  const t = mon('Snorlax', 'Immunity', role === 'defender' ? e : ZERO, need.defenderItem);
  const field = makeField('doubles', {...emptyField(), terrain: need.terrain}, 'me');
  return [...runCalc(gen, a, t, makeMove(gen, name, {targets: 1}), field).dist.entries()].join(';');
}

// --- what logging it should do, from the games' own data ---------------------------------------

function hit(live: Snapshot, r: MonRef) {
  const hp = live.mons[`${r.side}${r.slot}`].hp;
  return {target: r, hpBefore: hp, hpAfter: r.side === 'opp' ? 60 : hp - 10, fainted: false, crit: false, triggers: []};
}

const maxHP = (ctx: StateCtx) => makePokemon(gen, {species: 'Kangaskhan', level: 50, nature: 'Serious', evs: ZERO, ability: 'Early Bird'}).maxHP()
  || ctx.battle.live.mons.me0.hp;

const clean = (b: Boosts) => Object.fromEntries(Object.entries(b).filter(([, v]) => v).sort());
const add = (into: Boosts, b?: Partial<Record<string, number>>) => {
  for (const [k, v] of Object.entries(b ?? {})) {
    // Accuracy and evasion aren't kept: they change nothing the app works out.
    if (v && ['atk', 'def', 'spa', 'spd', 'spe'].includes(k)) into[k as keyof Boosts] = Math.max(-6, Math.min(6, (into[k as keyof Boosts] ?? 0) + v));
  }
};

/**
 * Effects Showdown writes in code, not data: what logging them must do, as the games do it
 * (the move table carries them too, from scripts/build-data.mjs; this is the check).
 */
const CUSTOM: Record<string, {self?: Boosts; target?: Boosts; status?: Status}> = {
  partingshot: {target: {atk: -1, spa: -1}},
  scaleshot: {self: {def: -1, spe: 1}},
  tidyup: {self: {atk: 1, spe: 1}},
  stuffcheeks: {self: {def: 2}},
  bellydrum: {self: {atk: 6}},
  curse: {self: {atk: 1, def: 1, spe: -1}},
  spicyextract: {target: {atk: 2, def: -2}},
  bittermalice: {target: {atk: -1}},
  mortalspin: {status: 'psn'},
};

/** HP it costs the user, from its max, rounded as the games do. */
const COST: Record<string, (max: number) => number> = {
  substitute: m => Math.floor(m / 4), bellydrum: m => Math.floor(m / 2), clangoroussoul: m => Math.floor(m * 0.33),
  shedtail: m => Math.ceil(m / 2), mindblown: m => Math.round(m / 2), steelbeam: m => Math.round(m / 2), chloroblast: m => Math.round(m / 2),
};

const HAZARD_KEYS: Record<string, [string, unknown]> = {
  stealthrock: ['opp.stealthRock', true], spikes: ['opp.spikes', 1], toxicspikes: ['opp.toxicSpikes', 1], stickyweb: ['opp.stickyWeb', true],
};

function expected(name: string, targets: MonRef[]) {
  const d = dex.moves.get(name);
  const id = toID(name);
  const status = isStatusMove(gen, name);
  const self: Boosts = {};
  const on: Boosts = {};
  const selfTarget = ['self', 'adjacentAllyOrSelf', 'allies'].includes(d.target);
  if (status && d.boosts) add(selfTarget ? self : on, d.boosts);
  if (d.self?.boosts) add(self, d.self.boosts);
  let st: Status | undefined = status ? (d.status as Status | undefined) : undefined;
  for (const s of d.secondaries ?? []) {
    if ((s.chance ?? 100) < 100) continue;
    add(on, s.boosts);
    add(self, s.self?.boosts);
    if (s.status) st = s.status as Status;
  }
  const c = CUSTOM[id];
  if (c?.self) Object.assign(self, c.self);
  if (c?.target) Object.assign(on, c.target);
  if (c?.status) st = c.status;
  // Stat-stage operations: nothing to copy, reset or swap from a fresh start.
  const affected = targets.filter(r => r.side === 'opp' || status);
  const boosts: [MonRef, Boosts][] = [[ME, clean(self)], ...affected.filter(r => r.side !== 'me' || r.slot !== 0).map(r => [r, clean(on)] as [MonRef, Boosts])];
  const statusOf: [MonRef, Status][] = st ? affected.map(r => [r, st!]) : [];
  const field: Record<string, unknown> = {};
  const weather = ({sunnyday: 'Sun', raindance: 'Rain', sandstorm: 'Sand', snowscape: 'Snow', chillyreception: 'Snow'} as Record<string, string>)[id];
  if (weather) field.weather = weather;
  if (d.terrain) field.terrain = d.terrain.replace('terrain', '').replace(/^./, x => x.toUpperCase());
  if (['tailwind', 'reflect', 'lightscreen', 'auroraveil'].includes(d.sideCondition ?? '')) {
    field[`me.${({lightscreen: 'lightScreen', auroraveil: 'auroraVeil'} as Record<string, string>)[d.sideCondition!] ?? d.sideCondition}`] = true;
  }
  if (HAZARD_KEYS[d.sideCondition ?? '']) field[HAZARD_KEYS[d.sideCondition!][0]] = HAZARD_KEYS[d.sideCondition!][1];
  if (['trickroom', 'gravity', 'magicroom', 'wonderroom'].includes(d.pseudoWeather ?? '')) {
    field[({trickroom: 'trickRoom', magicroom: 'magicRoom', wonderroom: 'wonderRoom'} as Record<string, string>)[d.pseudoWeather!] ?? d.pseudoWeather!] = true;
  }
  const hurts = !!(d.drain || d.recoil) && !status;
  const itemGone = id === 'knockoff' || id === 'thief' || id === 'covet' ? FOE : id === 'fling' ? ME : undefined;
  return {
    boosts, status: statusOf, field,
    faints: d.selfdestruct === 'always' || (!!d.selfdestruct && (status || targets.length > 0)),
    cost: COST[id], unknownHP: hurts, itemGone,
  };
}

function fieldValue(f: FieldCondition, key: string): unknown {
  const [a, b] = key.split('.');
  return b ? (f as unknown as Record<string, Record<string, unknown>>)[a][b] : (f as unknown as Record<string, unknown>)[a];
}
