import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import {createBattle, uid} from './battle';
import {makeField, makeMove, makePokemon, runCalc} from './calc';
import {enduring, myHitLikelihood} from './likelihood';
import {hitsOn, powerFromHistory} from './power';
import type {ActionEvent, Battle, BattleEvent, HitResult, MonRef} from './types';

const gen = getGen(0);
const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);

const TEAM = parseTeam(`Toxapex @ Leftovers
Ability: Regenerator
- Baneful Bunker

Glimmora @ Focus Sash
Ability: Toxic Debris
- Spiky Shield

Incineroar
Ability: Intimidate
- Fake Out

Rillaboom
Ability: Grassy Surge
- Grassy Glide`);

const me = (slot: number): MonRef => ({side: 'me', slot});
const opp = (slot: number): MonRef => ({side: 'opp', slot});
const hit = (target: MonRef, extra: Partial<HitResult> = {}): HitResult => ({target, hpBefore: 100, hpAfter: 80, fainted: false, crit: false, triggers: [], ...extra});

function battle(events: BattleEvent[] = []): Battle {
  const b = createBattle(fmt, TEAM, ['Garchomp', 'Basculegion', 'Annihilape', 'Abomasnow'], 'power');
  b.live.active = {me: [0, 1], opp: [0, 1]};
  return {...b, events};
}
function act(b: Battle, actor: MonRef, move: string, turn: number, hits: HitResult[] = [], extra: Partial<ActionEvent> = {}): ActionEvent {
  return {kind: 'action', id: uid(), turn, actor, move, hits, targets: Math.max(1, hits.length), helpingHand: false, actorTriggers: [], before: structuredClone(b.live), ordered: true, ...extra};
}

describe('base power from the battle so far (6 Oct)', () => {
  it('Last Respects: 50 more for each of its side fainted; the calc deals it so', () => {
    const b = battle();
    expect(powerFromHistory(gen, b, opp(1), 'Last Respects')).toBeUndefined();
    b.live.mons.opp2 = {...b.live.mons.opp2, hp: 0};
    b.live.mons.opp3 = {...b.live.mons.opp3, hp: 0};
    expect(powerFromHistory(gen, b, opp(1), 'Last Respects')).toBe(150);
    // As a logged move: in the state it was used in.
    const ev = act(b, opp(1), 'Last Respects', 3, [hit(me(1))]);
    expect(powerFromHistory(gen, {...b, events: [ev]}, opp(1), 'Last Respects', ev)).toBe(150);
    const atk = makePokemon(gen, {species: 'Basculegion', level: 50, nature: 'Adamant', evs: [0, 32, 0, 0, 0, 32], ability: 'Adaptability'});
    const def = makePokemon(gen, {species: 'Glimmora', level: 50, evs: [0, 0, 0, 0, 0, 0]});
    const field = makeField('doubles', b.live.field, 'opp');
    const top = (bp?: number) => Math.max(...runCalc(gen, atk, def, makeMove(gen, 'Last Respects', {targets: 1, bp}), field).dist.keys());
    expect(top(150) / top()).toBeGreaterThan(2.8);
  });

  it('Rage Fist: 50 more for each hit it took (a multi-hit move each hit), to 350', () => {
    const b0 = battle();
    const events: BattleEvent[] = [
      act(b0, me(0), 'Grassy Glide', 1, [hit(opp(2))]),
      act(b0, me(1), 'Rock Slide', 1, [hit(opp(2), {noEffect: true})]),
      act(b0, me(0), 'Bullet Seed', 2, [hit(opp(2))], {hitCount: 3}),
    ];
    const b = battle(events);
    const fist = act(b, opp(2), 'Rage Fist', 3, [hit(me(0))]);
    expect(powerFromHistory(gen, {...b, events: [...events, fist]}, opp(2), 'Rage Fist', fist)).toBe(250);
    const lots = Array.from({length: 9}, () => act(b0, me(0), 'Grassy Glide', 1, [hit(opp(2))]));
    expect(powerFromHistory(gen, battle(lots), opp(2), 'Rage Fist')).toBe(350);
  });

  it("Stomping Tantrum: doubled after its move came to nothing the turn before, but not after a Protect stopped it", () => {
    const b0 = battle();
    const at = (prev: ActionEvent, turn = 3) => {
      const st = act(b0, opp(0), 'Stomping Tantrum', turn, [hit(me(0))]);
      return powerFromHistory(gen, battle([prev, st]), opp(0), 'Stomping Tantrum', st);
    };
    expect(at(act(b0, opp(0), 'Swords Dance', 2, [], {failed: true}))).toBe(150);
    expect(at(act(b0, opp(0), 'Earthquake', 2, [hit(me(1), {noEffect: true})]))).toBe(150);
    // Blocked (Baneful Bunker): the next did 75's damage.
    expect(at(act(b0, opp(0), 'Stomping Tantrum', 2))).toBeUndefined();
    expect(at(act(b0, opp(0), 'Swords Dance', 1, [], {failed: true}))).toBeUndefined();
    // Switched out and back in since: its last turn's move doesn't count.
    const prev = act(b0, opp(0), 'Swords Dance', 2, [], {failed: true});
    const away: BattleEvent = {kind: 'switch', id: uid(), turn: 2, side: 'opp', position: 0, slotIn: 2, slotOut: 0};
    const st = act(b0, opp(0), 'Stomping Tantrum', 3, [hit(me(0))]);
    expect(powerFromHistory(gen, battle([prev, away, st]), opp(0), 'Stomping Tantrum', st)).toBeUndefined();
  });

  it('Avalanche once its target has hurt it this turn; Round after its partner\'s this turn', () => {
    const b0 = battle();
    const glide = act(b0, me(0), 'Grassy Glide', 4, [hit(opp(1))]);
    const avalanche = act(b0, opp(1), 'Avalanche', 4, [hit(me(0))]);
    expect(powerFromHistory(gen, battle([glide, avalanche]), opp(1), 'Avalanche', avalanche)).toBe(120);
    const other = act(b0, opp(1), 'Avalanche', 4, [hit(me(1))]);
    expect(powerFromHistory(gen, battle([glide, other]), opp(1), 'Avalanche', other)).toBeUndefined();
    const round = act(b0, opp(0), 'Round', 5, [hit(me(0))]);
    const second = act(b0, opp(1), 'Round', 5, [hit(me(1))]);
    expect(powerFromHistory(gen, battle([round, second]), opp(1), 'Round', second)).toBe(120);
  });
});

describe('Round, the second of a pair (9 Nov)', () => {
  it('shows on the cards at double power beside its own', async () => {
    const {computeBeliefs} = await import('./posterior');
    const {myMoveInto} = await import('./predict');
    const b = battle();
    const belief = computeBeliefs(fmt, b).mons[0]!;
    const once = myMoveInto(fmt, gen, b, belief, 1, 'Round', b.live)!;
    const twice = myMoveInto(fmt, gen, b, belief, 1, 'Round', b.live, 120)!;
    expect(twice.hi / once.hi).toBeGreaterThan(1.8);
    expect(twice.hi / once.hi).toBeLessThan(2.2);
  });

  it('Dragon Darts on the cards: one dart, about half of both', async () => {
    const {computeBeliefs} = await import('./posterior');
    const {oppMoveInto} = await import('./predict');
    const b = battle();
    b.oppPreview = ['Dragapult', 'Basculegion', 'Annihilape', 'Abomasnow'];
    const belief = computeBeliefs(fmt, b).mons[0]!;
    const one = oppMoveInto(fmt, gen, b, belief, 0, 'Dragon Darts', b.live, undefined, 1)!;
    const two = oppMoveInto(fmt, gen, b, belief, 0, 'Dragon Darts', b.live)!;
    expect(two.hi / one.hi).toBeGreaterThan(1.8);
    expect(two.hi / one.hi).toBeLessThan(2.2);
  });

  it("isn't taken for Speed: it moves straight after its partner's, whatever its own", async () => {
    const {computeBeliefs} = await import('./posterior');
    const {turnOrderLikelihoods} = await import('./likelihood');
    const b0 = battle();
    const first = act(b0, opp(0), 'Round', 1, [hit(me(0))]);
    const second = act(b0, opp(1), 'Round', 1, [hit(me(1))]);
    const mine = act(b0, me(0), 'Grassy Glide', 1, [hit(opp(0))]);
    const b = battle([first, second, mine]);
    const spaces = computeBeliefs(fmt, battle()).mons.map(m => m?.space ?? null);
    const {mine: notes} = turnOrderLikelihoods({fmt, gen, battle: b, spaces}, [first, second, mine]);
    expect(notes.map(n => n.slot)).toEqual([0]);
  });
});

describe('moves met in no game yet (9 Nov)', () => {
  it("Assurance: doubled once its target was hurt this turn, by either side's move or its own", () => {
    const b0 = battle();
    const slide = act(b0, opp(1), 'Rock Slide', 4, [hit(me(0)), hit(me(1))]);
    const assurance = act(b0, opp(0), 'Assurance', 4, [hit(me(1))]);
    expect(powerFromHistory(gen, battle([slide, assurance]), opp(0), 'Assurance', assurance)).toBe(120);
    const lastTurn = act(b0, opp(1), 'Rock Slide', 3, [hit(me(1))]);
    expect(powerFromHistory(gen, battle([lastTurn, assurance]), opp(0), 'Assurance', assurance)).toBeUndefined();
    // Its own move's recoil hurt it.
    const max = b0.live.mons.me1.hp;
    const recoil = act(b0, me(1), 'Flare Blitz', 4, [hit(opp(1))], {actorHpAfter: max - 20});
    expect(powerFromHistory(gen, battle([recoil, assurance]), opp(0), 'Assurance', assurance)).toBe(120);
  });

  it("Lash Out: doubled once a stat of its fell this turn (an Intimidate from one switched in), not one that fell before; the calc doesn't", () => {
    const b0 = battle();
    const dropped = structuredClone(b0.live);
    dropped.mons.opp0 = {...dropped.mons.opp0, boosts: {atk: -1}};
    // My Incineroar in for Glimmora by choice, at the start of turn 3: its Intimidate.
    const sw: BattleEvent = {kind: 'switch', id: uid(), turn: 3, side: 'me', position: 1, slotIn: 2, slotOut: 1, undo: {live: structuredClone(b0.live), turn: 3}};
    const lash = {...act(b0, opp(0), 'Lash Out', 3, [hit(me(0))]), before: dropped};
    expect(powerFromHistory(gen, battle([sw, lash]), opp(0), 'Lash Out', lash)).toBe(150);
    // Down since a turn before.
    const glide = {...act(b0, me(0), 'Grassy Glide', 3, [hit(opp(1))]), before: dropped};
    const later = {...act(b0, opp(0), 'Lash Out', 3, [hit(me(0))]), before: dropped};
    expect(powerFromHistory(gen, battle([glide, later]), opp(0), 'Lash Out', later)).toBeUndefined();
    // The calc's own doubling counts only rises, so it never comes.
    const atk = makePokemon(gen, {species: 'Annihilape', level: 50, evs: [0, 32, 0, 0, 0, 0]}, dropped.mons.opp0);
    const def = makePokemon(gen, {species: 'Toxapex', level: 50, evs: [0, 0, 0, 0, 0, 0]});
    const field = makeField('doubles', b0.live.field, 'opp');
    const top = (bp?: number) => Math.max(...runCalc(gen, atk, def, makeMove(gen, 'Lash Out', {targets: 1, bp}), field).dist.keys());
    expect(top(150) / top()).toBeGreaterThan(1.8);
  });

  it('Fickle Beam: doubled when it went all out', () => {
    const b0 = battle();
    const allOut = act(b0, opp(1), 'Fickle Beam', 2, [hit(me(0))], {allOut: true});
    expect(powerFromHistory(gen, battle([allOut]), opp(1), 'Fickle Beam', allOut)).toBe(160);
    const plain = act(b0, opp(1), 'Fickle Beam', 2, [hit(me(0))]);
    expect(powerFromHistory(gen, battle([plain]), opp(1), 'Fickle Beam', plain)).toBeUndefined();
  });

  it("Payback: doubled once its target has moved this turn, whatever the Speeds, and the calc doesn't double it again", () => {
    const b0 = battle();
    const glide = act(b0, me(0), 'Grassy Glide', 2, [hit(opp(1))]);
    const after = act(b0, opp(1), 'Payback', 2, [hit(me(0))]);
    expect(powerFromHistory(gen, battle([glide, after]), opp(1), 'Payback', after)).toBe(100);
    const first = act(b0, opp(1), 'Payback', 2, [hit(me(0))]);
    expect(powerFromHistory(gen, battle([first, glide]), opp(1), 'Payback', first)).toBe(50);
    // A user slower than its target: the calc alone doubles it for that; told 50, it's 50.
    const atk = makePokemon(gen, {species: 'Toxapex', level: 50, evs: [0, 32, 0, 0, 0, 0]});
    const def = makePokemon(gen, {species: 'Garchomp', level: 50, evs: [0, 0, 0, 0, 0, 32]});
    const field = makeField('doubles', b0.live.field, 'me');
    const top = (bp?: number) => Math.max(...runCalc(gen, atk, def, makeMove(gen, 'Payback', {targets: 1, bp}), field).dist.keys());
    expect(top(50) / top()).toBeLessThan(0.6);
    expect(top(100) / top(50)).toBeGreaterThan(1.8);
  });

  it('Dragon Darts that hit both takes a dart at each; at one alone, both (and Rage Fist counts the darts that hit it)', () => {
    const b0 = battle();
    const both = act(b0, opp(0), 'Dragon Darts', 2, [hit(me(0)), hit(me(1))], {hitCount: 2});
    expect(hitsOn(both)).toBe(1);
    const one = act(b0, opp(0), 'Dragon Darts', 2, [hit(me(0))], {hitCount: 2});
    expect(hitsOn(one)).toBe(2);
    // The calc keeps a fixed number of hits whatever it's told, unless the move's own number is changed.
    expect(makeMove(gen, 'Dragon Darts', {hits: 1}).hits).toBe(1);
    expect(makeMove(gen, 'Dragon Darts').hits).toBe(2);
    const fist = act(b0, me(1), 'Rage Fist', 3, [hit(opp(0))]);
    expect(powerFromHistory(gen, battle([both, fist]), me(1), 'Rage Fist', fist)).toBe(100);
  });
});

describe('Endure (9 Nov)', () => {
  it('a hit on one that used it earlier this turn leaves it at 1 HP, whatever its HP: taken so, not as that damage', () => {
    const b0 = battle();
    const endure = act(b0, me(0), 'Endure', 2);
    const hitIt = act(b0, opp(0), 'Earthquake', 2, [hit(me(0), {hpBefore: 80, hpAfter: 1})]);
    const b = battle([endure, hitIt]);
    expect(enduring(b, hitIt, me(0))).toBe(true);
    expect(enduring(battle([hitIt]), hitIt, me(0))).toBe(false);
    expect(enduring(battle([act(b0, me(0), 'Endure', 1), hitIt]), hitIt, me(0))).toBe(false);
    // Every roll would KO it from 80: endured, 1 HP left is certain; not, it can't be.
    const dist = new Map([[90, 0.5], [100, 0.5]]);
    expect(myHitLikelihood(dist, hitIt.hits[0], 150, false, false, true)).toBe(1);
    expect(myHitLikelihood(dist, hitIt.hits[0], 150, false)).toBe(0);
  });
});
