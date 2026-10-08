import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import {createBattle, uid} from './battle';
import {makeField, makeMove, makePokemon, runCalc} from './calc';
import {powerFromHistory} from './power';
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
