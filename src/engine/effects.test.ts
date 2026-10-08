/**
 * The battle effects the per-move tests only touch at the edges: entry hazards on the way in and
 * off again, the rooms in the damage calc, stat stages copied, reset or swapped, items taken.
 */
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import {createBattle, emptyField, uid} from './battle';
import {asLogged, makeField, makeMove, makePokemon, runCalc} from './calc';
import {applyAction, applyEndTurn, applySwitch, maxHPOf, type StateCtx} from './state';
import type {ActionEvent, Battle, HitResult, MonRef} from './types';

const gen = getGen(0);
const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);

const TEAM = parseTeam(`Charizard @ Charizardite Y
Ability: Blaze
- Heat Wave

Incineroar
Ability: Intimidate
- Knock Off

Metagross @ Metagrossite
Ability: Clear Body
- Psych Up

Snorlax @ Leftovers
Ability: Immunity
- Curse`);

const me = (slot: number): MonRef => ({side: 'me', slot});
const opp = (slot: number): MonRef => ({side: 'opp', slot});

function rig(preview = ['Garchomp', 'Clefable', 'Glimmora', 'Kingambit']) {
  const b = createBattle(fmt, TEAM, preview, 'effects');
  b.live.active = {me: [1, 3], opp: [0, 3]};
  const ctx: StateCtx = {fmt, gen, battle: b, oppAbility: () => undefined, oppItem: () => undefined};
  return {b, ctx};
}

function act(b: Battle, actor: MonRef, move: string, hits: HitResult[] = [], extra: Partial<ActionEvent> = {}): ActionEvent {
  return {
    kind: 'action', id: uid(), turn: 1, actor, move, hits, targets: Math.max(1, hits.length), helpingHand: false,
    actorTriggers: [], before: structuredClone(b.live), ordered: true, ...extra,
  };
}
const hit = (target: MonRef, hpBefore: number, hpAfter: number): HitResult => ({target, hpBefore, hpAfter, fainted: false, crit: false, triggers: []});

describe('entry hazards', () => {
  it('Stealth Rock takes its share by type on the way in: exactly for yours, as an estimate for theirs', () => {
    const {b, ctx} = rig();
    b.live.field.me.stealthRock = true;
    b.live.field.opp.stealthRock = true;
    const max = b.live.mons.me0.hp;
    // Charizard, Fire/Flying: Rock hits it 4x, so half its HP.
    const mine = applySwitch(ctx, b.live, 'me', 0, 0);
    expect(mine.mons.me0.hp).toBe(max - Math.floor(max / 2));
    // Their Garchomp (Dragon/Ground): Ground resists Rock, so 6.25%.
    const theirs = applySwitch(ctx, {...b.live, active: {...b.live.active, opp: [null, 3]}}, 'opp', 0, 0);
    expect(theirs.mons.opp0.hp).toBe(94);
    expect(theirs.mons.opp0.hpEstimated).toBe(true);
  });

  it("theirs that could have Magic Guard: its HP is left to be read, not guessed", () => {
    const {b, ctx} = rig();
    b.live.field.opp.stealthRock = true;
    b.live.active.opp = [null, 3];
    const after = applySwitch(ctx, b.live, 'opp', 0, 1);
    expect(after.mons.opp1.hp).toBe(100);
    expect(after.mons.opp1.hpUnknown).toBe(true);
  });

  it('Spikes by layers for the grounded; Toxic Spikes poison, or a Poison type soaks them up; Sticky Web slows', () => {
    const {b, ctx} = rig();
    b.live.field.me = {...b.live.field.me, spikes: 2, toxicSpikes: 1, stickyWeb: true};
    b.live.active.me = [null, 3];
    const max = b.live.mons.me1.hp;
    const incin = applySwitch(ctx, b.live, 'me', 0, 1);
    expect(incin.mons.me1.hp).toBe(max - Math.floor(max / 6));
    expect(incin.mons.me1.status).toBe('psn');
    expect(incin.mons.me1.boosts.spe).toBe(-1);
    // Charizard flies over the lot.
    const zard = applySwitch(ctx, b.live, 'me', 0, 0);
    expect(zard.mons.me0.hp).toBe(b.live.mons.me0.hp);
    expect(zard.mons.me0.status).toBe('');
    // Their Glimmora (Rock/Poison) soaks up Toxic Spikes on its side.
    const g = rig();
    g.b.live.field.opp.toxicSpikes = 2;
    g.b.live.active.opp = [null, 3];
    const glim = applySwitch(g.ctx, g.b.live, 'opp', 0, 2);
    expect(glim.field.opp.toxicSpikes).toBe(0);
    expect(glim.mons.opp2.status).toBe('');
  });

  it('Rapid Spin clears its own side; Defog both, with the other side’s screens; Court Change swaps them', () => {
    const {b, ctx} = rig();
    b.live.field.me = {...b.live.field.me, stealthRock: true, spikes: 1};
    b.live.field.opp = {...b.live.field.opp, stealthRock: true, reflect: true};
    b.live.field.turns = {'opp.reflect': 3};
    const spun = applyAction(ctx, b.live, act(b, me(1), 'Rapid Spin', [hit(opp(0), 100, 90)]));
    expect(spun.field.me).toMatchObject({stealthRock: false, spikes: 0});
    expect(spun.field.opp.stealthRock).toBe(true);
    const fogged = applyAction(ctx, b.live, act(b, me(1), 'Defog', [], {targetRefs: [opp(0)]}));
    expect(fogged.field.me.stealthRock).toBe(false);
    expect(fogged.field.opp).toMatchObject({stealthRock: false, reflect: false});
    const swapped = applyAction(ctx, b.live, act(b, me(1), 'Court Change'));
    expect(swapped.field.me).toMatchObject({stealthRock: true, reflect: true});
    expect(swapped.field.opp).toMatchObject({stealthRock: true, spikes: 1});
    expect(swapped.field.turns).toEqual({'me.reflect': 3});
  });
});

describe('rooms in the damage calc', () => {
  const dmg = (field: ReturnType<typeof emptyField>, item: string | undefined, move: string, defender = 'Snorlax') => {
    const a = makePokemon(gen, {species: 'Garchomp', level: 50, nature: 'Serious', evs: [0, 0, 0, 0, 0, 0], ability: 'Rough Skin', item});
    const t = makePokemon(gen, {species: defender, level: 50, nature: 'Serious', evs: [0, 0, 0, 0, 0, 0], ability: 'Immunity'});
    return Math.max(...runCalc(gen, a, t, makeMove(gen, move, {targets: 1}), makeField('doubles', field, 'me')).dist.keys());
  };

  it('Magic Room: items do nothing', () => {
    const room = {...emptyField(), magicRoom: true};
    expect(dmg(emptyField(), 'Life Orb', 'Dragon Claw')).toBeGreaterThan(dmg(emptyField(), undefined, 'Dragon Claw'));
    expect(dmg(room, 'Life Orb', 'Dragon Claw')).toBe(dmg(room, undefined, 'Dragon Claw'));
  });

  it('Wonder Room: Defense and Sp. Def swap', () => {
    // Snorlax's Sp. Def is well above its Defense: in Wonder Room a physical hit meets the higher one.
    const room = {...emptyField(), wonderRoom: true};
    expect(dmg(room, undefined, 'Dragon Claw')).toBeLessThan(dmg(emptyField(), undefined, 'Dragon Claw'));
  });

  it('both are logged as rooms that end when used again, with five turns', () => {
    const {b, ctx} = rig();
    const on = applyAction(ctx, b.live, act(b, me(1), 'Wonder Room'));
    expect(on.field.wonderRoom).toBe(true);
    expect(on.field.turns?.wonderRoom).toBe(5);
    expect(applyAction(ctx, on, act(b, me(1), 'Wonder Room')).field.wonderRoom).toBe(false);
  });
});

describe('stat stages set, copied, reset or swapped', () => {
  it('Psych Up copies the target; Haze clears everyone; Topsy-Turvy flips; Guard Swap trades Def and Sp. Def', () => {
    const {b, ctx} = rig();
    b.live.active.me = [2, 3];
    b.live.mons.opp0.boosts = {atk: 2, spe: 1};
    b.live.mons.me2.boosts = {def: 1};
    expect(applyAction(ctx, b.live, act(b, me(2), 'Psych Up', [], {targetRefs: [opp(0)]})).mons.me2.boosts).toEqual({atk: 2, spe: 1});
    const hazed = applyAction(ctx, b.live, act(b, me(2), 'Haze'));
    expect([hazed.mons.opp0.boosts, hazed.mons.me2.boosts]).toEqual([{}, {}]);
    expect(applyAction(ctx, b.live, act(b, me(2), 'Topsy-Turvy', [], {targetRefs: [opp(0)]})).mons.opp0.boosts).toEqual({atk: -2, spe: -1});
    const swapped = applyAction(ctx, b.live, act(b, me(2), 'Guard Swap', [], {targetRefs: [opp(0)]}));
    expect(swapped.mons.me2.boosts.def).toBeUndefined();
    expect(swapped.mons.opp0.boosts.def).toBe(1);
  });

  it('Belly Drum maxes Attack for half its HP; a non-Ghost Curse trades Speed for Attack and Defense', () => {
    const {b, ctx} = rig();
    const max = b.live.mons.me3.hp;
    const drummed = applyAction(ctx, b.live, act(b, me(3), 'Belly Drum'));
    expect(drummed.mons.me3.boosts.atk).toBe(6);
    expect(drummed.mons.me3.hp).toBe(max - Math.floor(max / 2));
    expect(applyAction(ctx, b.live, act(b, me(3), 'Curse', [], {targetRefs: [opp(0)]})).mons.me3.boosts).toEqual({atk: 1, def: 1, spe: -1});
  });
});

describe('items taken', () => {
  it("Knock Off takes theirs; a Mega Stone stays with the Pokémon it's for", () => {
    const {b, ctx} = rig();
    b.live.active.me = [2, 1];
    const knocked = applyAction(ctx, b.live, act(b, me(1), 'Knock Off', [hit(opp(0), 100, 60)]));
    expect(knocked.mons.opp0.itemGone).toBe(true);
    const onMine = applyAction(ctx, b.live, act(b, opp(0), 'Knock Off', [hit(me(2), b.live.mons.me2.hp, 100)]));
    expect(onMine.mons.me2.itemGone).toBe(false);
  });
});

describe("a charge's Sp. Atk rise, counted once (5 Oct)", () => {
  it("Electro Shot and Meteor Beam: the calc adds the rise itself; a hit logged at +1 is taken at +1, not +2", () => {
    const spec = {species: 'Archaludon', level: 50, nature: 'Modest', evs: [0, 0, 0, 32, 0, 0]};
    const defender = makePokemon(gen, {species: 'Grimmsnarl', level: 50, nature: 'Careful', evs: [32, 0, 0, 0, 0, 0]});
    const field = makeField('doubles', {...emptyField(), weather: 'Rain'}, 'opp');
    const max = (spa: number, move: string, logged: boolean) => {
      const a = makePokemon(gen, spec, {hp: 100, boosts: {spa}, status: '', mega: false, abilityOn: false, itemGone: false});
      const mv = makeMove(gen, move, {targets: 1});
      return Math.max(...runCalc(gen, logged ? asLogged(a, mv) : a, defender, mv, field).dist.keys());
    };
    // Its rise said and logged (+1): as the calc has a +0 attacker charging in the hit.
    expect(max(1, 'Electro Shot', true)).toBe(max(0, 'Electro Shot', false));
    expect(max(1, 'Meteor Beam', true)).toBe(max(0, 'Meteor Beam', false));
    // Other moves are as they are.
    expect(max(1, 'Flash Cannon', true)).toBe(max(1, 'Flash Cannon', false));
  });
});

describe('Stance Change in the calc (5 Oct)', () => {
  it('Aegislash in its Blade forme hits with, and takes hits on, the Blade forme\'s stats', () => {
    const spec = {species: 'Aegislash-Shield', level: 50, nature: 'Adamant', evs: [0, 32, 0, 0, 0, 0]};
    const cond = {hp: 100, boosts: {}, status: '' as const, mega: false, abilityOn: false, itemGone: false};
    expect(makePokemon(gen, spec, cond).rawStats.atk).toBeLessThan(makePokemon(gen, spec, {...cond, blade: true}).rawStats.atk);
    expect(makePokemon(gen, spec, {...cond, blade: true}).species.name).toBe('Aegislash-Blade');
    // Anyone else: as it is.
    expect(makePokemon(gen, {...spec, species: 'Garchomp'}, {...cond, blade: true}).species.name).toBe('Garchomp');
  });
});

describe('Contrary and Simple (6 Oct)', () => {
  it("a known Contrary turns its own stat changes round, and others': Mega Staraptor's Close Combat raises its defences", () => {
    const {b, ctx: base} = rig(['Staraptor', 'Clefable', 'Glimmora', 'Kingambit']);
    const ctx: StateCtx = {...base, oppAbility: (slot, mega) => (slot === 0 && mega ? {name: 'Contrary', p: 1} : undefined)};
    b.live.mons.opp0 = {...b.live.mons.opp0, mega: true};
    let live = applyAction(ctx, b.live, act(b, opp(0), 'Close Combat', [hit(me(1), 200, 100)]));
    expect(live.mons.opp0.boosts).toEqual({def: 1, spd: 1});
    // Snarl's sure Sp. Atk drop raises it.
    b.live = live;
    live = applyAction(ctx, b.live, act(b, me(1), 'Snarl', [hit(opp(0), 100, 90)]));
    expect(live.mons.opp0.boosts).toEqual({def: 1, spd: 1, spa: 1});
    // Not yet Mega Evolved (its ability not Contrary): as the move has it.
    const {b: b2, ctx: ctx2} = rig(['Staraptor', 'Clefable', 'Glimmora', 'Kingambit']);
    expect(applyAction({...ctx2, oppAbility: ctx.oppAbility}, b2.live, act(b2, opp(0), 'Close Combat', [hit(me(1), 200, 100)])).mons.opp0.boosts)
      .toEqual({def: -1, spd: -1});
  });

  it('Simple doubles them; a stat change the game said is taken as said', () => {
    const {b, ctx: base} = rig();
    const ctx: StateCtx = {...base, oppAbility: slot => (slot === 3 ? {name: 'Simple', p: 1} : undefined)};
    expect(applyAction(ctx, b.live, act(b, opp(3), 'Swords Dance')).mons.opp3.boosts).toEqual({atk: 4});
    // Electro Shot's rise, as logged from the game's line: not doubled again.
    expect(applyAction(ctx, b.live, act(b, opp(3), 'Electro Shot', [], {actorBoosts: {spa: 2}, charged: true})).mons.opp3.boosts.spa).toBe(2);
  });
});

describe('what hurts at the end of each turn until it leaves (6 Oct)', () => {
  it("a binding move holds what it hit: 1/8 a turn while its binder stays in, 5 times at most, and its binder's leaving frees it", () => {
    const {b, ctx} = rig();
    let live = applyAction(ctx, b.live, act(b, opp(0), 'Sand Tomb', [hit(me(1), 200, 190)]));
    expect(live.mons.me1.bound).toEqual({move: 'Sand Tomb', by: opp(0), ticks: 0});
    const max = maxHPOf(ctx, live, me(1));
    live = applyEndTurn(ctx, live);
    expect(live.mons.me1.hp).toBe(190 - Math.floor(max / 8));
    expect(live.mons.me1.bound?.ticks).toBe(1);
    // Garchomp switched out: free, and not hurt again.
    const freed = applySwitch(ctx, live, 'opp', 0, 1);
    expect(freed.mons.me1.bound).toBeUndefined();
    expect(applyEndTurn(ctx, freed).mons.me1.hp).toBe(live.mons.me1.hp);
    // Held on: hurt 5 times in all, then let go unhurt (the game's "…was freed" may come a turn sooner).
    for (let k = 0; k < 4; k++) live = applyEndTurn(ctx, live);
    expect(live.mons.me1.bound?.ticks).toBe(5);
    const hp = live.mons.me1.hp;
    live = applyEndTurn(ctx, live);
    expect(live.mons.me1.bound).toBeUndefined();
    expect(live.mons.me1.hp).toBe(hp);
  });

  it("theirs, an estimate: Whirlpool's 12.5% a turn; Leech Seed (not on a Grass type) and Salt Cure (1/4 on a Steel type) until they leave", () => {
    const {b, ctx} = rig(['Rillaboom', 'Clefable', 'Glimmora', 'Kingambit']);
    let live = applyAction(ctx, b.live, act(b, me(3), 'Whirlpool', [hit(opp(3), 100, 90)]));
    live = applyAction(ctx, live, act(b, me(1), 'Leech Seed', [], {targetRefs: [opp(0)]}));
    expect(live.mons.opp0.seeded).toBeUndefined();
    live = applyAction(ctx, live, act(b, me(1), 'Salt Cure', [hit(opp(3), 90, 85)]));
    live = applyEndTurn(ctx, live);
    // 85 − 12.5 (Whirlpool) − 25 (Salt Cure, Kingambit being Steel).
    expect(live.mons.opp3.hp).toBe(48);
    expect(live.mons.opp3.hpEstimated).toBe(true);
    const back = applySwitch(ctx, live, 'opp', 1, 2);
    expect(back.mons.opp3.salted).toBeUndefined();
    expect(back.mons.opp3.bound).toBeUndefined();
  });

  it('Rapid Spin frees its user of what held and seeded it', () => {
    const {b, ctx} = rig();
    let live = applyAction(ctx, b.live, act(b, opp(0), 'Fire Spin', [hit(me(1), 200, 190)]));
    live = {...live, mons: {...live.mons, me1: {...live.mons.me1, seeded: true}}};
    b.live = live;
    live = applyAction(ctx, live, act(b, me(1), 'Rapid Spin', [hit(opp(0), 100, 95)]));
    expect(live.mons.me1.bound).toBeUndefined();
    expect(live.mons.me1.seeded).toBeUndefined();
  });
});
