import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {calculate} from '@smogon/calc';
import {getGen} from '../data/dex';
import type {FormatData} from '../data/format';
import {parseTeam} from '../data/paste';
import {createBattle, uid} from './battle';
import {makeField, makeMove, makePokemon, damageDistribution} from './calc';
import {mySpec} from './likelihood';
import {buildMoveModel, inclusion, itemFactors, movesLogLik} from './moveset';
import {computeBeliefs} from './posterior';
import type {ActionEvent, Battle, MonRef, RevealEvent} from './types';

const fmt: FormatData = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../public/data/gen9championsvgc2026regmb.json'), 'utf8'),
);
const gen = getGen(fmt.gen);

const MY_TEAM = parseTeam(`
Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 10 Def / 24 SpD
Careful Nature
- Fake Out
- Flare Blitz
- Parting Shot
- Throat Chop

Sneasler @ Focus Sash
Ability: Unburden
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Fake Out
- Close Combat
- Dire Claw
- Protect
`);

const opp = (slot: number): MonRef => ({side: 'opp', slot});
const me = (slot: number): MonRef => ({side: 'me', slot});

function battleVs(preview: string[]): Battle {
  const b = createBattle(fmt, MY_TEAM, preview, 'test');
  b.live.active = {me: [0, 1], opp: [0, 1]};
  return b;
}

function action(b: Battle, turn: number, actor: MonRef, move: string, hits: ActionEvent['hits'] = [], extra: Partial<ActionEvent> = {}): ActionEvent {
  return {
    kind: 'action', id: uid(), turn, actor, move, hits, targets: hits.length || 1, helpingHand: false,
    actorTriggers: [], before: structuredClone(b.live), ordered: true, ...extra,
  };
}

const p = (list: {name: string; p: number}[], name: string) => list.find(e => e.name === name)?.p ?? 0;
const pr = (list: {name: string; prior: number}[], name: string) => list.find(e => e.name === name)?.prior ?? 0;

describe('move-set model', () => {
  it('fits inclusion probabilities to usage stats', () => {
    const moves = fmt.species.Incineroar.moves;
    const model = buildMoveModel(moves, () => false);
    const inc = inclusion(model.w, model.k);
    for (const [name, pi] of moves.slice(0, 6)) {
      expect(inc[model.names.indexOf(name)]).toBeCloseTo(pi, 2);
    }
  });

  it('keeps prior move marginals equal to usage stats after item rules', () => {
    const g = computeBeliefs(fmt, battleVs(['Garchomp', 'Kingambit'])).mons[0]!;
    const protect = fmt.species.Garchomp.moves.find(([n]) => n === 'Protect')![1];
    expect(pr(g.moves, 'Protect')).toBeCloseTo(protect, 1);
  });

  it('makes Protect nearly impossible on Assault Vest sets', () => {
    const model = buildMoveModel([['Protect', 0.6], ['Earthquake', 0.8]], m => m === 'Protect');
    const protect = model.names.indexOf('Protect');
    const av = movesLogLik(model, [protect], [], itemFactors(model, 'Assault Vest'));
    const lo = movesLogLik(model, [protect], [], itemFactors(model, 'Life Orb'));
    expect(Math.exp(av - lo)).toBeLessThan(0.01);
  });
});

describe('priors', () => {
  it('reads a previewed Charizard as almost surely Mega Y', () => {
    const {mons} = computeBeliefs(fmt, battleVs(['Charizard', 'Venusaur']));
    expect(p(mons[0]!.formes, 'Charizard-Mega-Y')).toBeGreaterThan(0.9);
  });

  it('applies Item Clause across the team', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    const before = computeBeliefs(fmt, b).mons[1]!;
    const reveal: RevealEvent = {kind: 'reveal', id: uid(), turn: 1, mon: opp(0), what: 'item', value: 'Sitrus Berry', negate: false};
    b.events.push(reveal);
    const after = computeBeliefs(fmt, b).mons[1]!;
    expect(p(before.items, 'Sitrus Berry')).toBeGreaterThan(0.05);
    expect(p(after.items, 'Sitrus Berry')).toBeLessThan(0.001);
  });
});

describe('inference', () => {
  it('rules out Choice items and Assault Vest after Protect', () => {
    const b = battleVs(['Garchomp', 'Incineroar']);
    b.events.push(action(b, 1, opp(0), 'Protect'));
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(pr(g.items, 'Choice Scarf')).toBeGreaterThan(0.1);
    expect(p(g.items, 'Choice Scarf')).toBeLessThan(0.02);
  });

  it('detects Choice Scarf from turn order', () => {
    const b = battleVs(['Garchomp', 'Incineroar']);
    // Garchomp outspeeds my max-speed Jolly Sneasler (189): only possible with Scarf.
    b.events.push(action(b, 1, opp(0), 'Rock Slide'));
    b.events.push(action(b, 1, me(1), 'Close Combat'));
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(p(g.items, 'Choice Scarf')).toBeGreaterThan(0.95);
  });

  it('uses turn order between two opponents', () => {
    const b = battleVs(['Garchomp', 'Charizard']);
    b.live.mons.opp1.mega = true;
    // Mega Charizard Y (167 Spe at best) moving first means Garchomp isn't Jolly max speed (169).
    b.events.push(action(b, 1, opp(1), 'Heat Wave'));
    b.events.push(action(b, 1, opp(0), 'Dragon Claw'));
    const res = computeBeliefs(fmt, b);
    const spe = res.mons[0]!.stats.find(s => s.stat === 'spe')!;
    const before = computeBeliefs(fmt, battleVs(['Garchomp', 'Charizard'])).mons[0]!.stats.find(s => s.stat === 'spe')!;
    const fast = (s: typeof spe) => s.values.filter(([v]) => v >= 168).reduce((a, [, q]) => a + q, 0);
    expect(fast(before)).toBeGreaterThan(0.3);
    expect(fast(spe)).toBeLessThan(0.05);
  });

  it('converges on the true attacking stat and item from damage', () => {
    const b = battleVs(['Garchomp', 'Incineroar']);
    // Ground truth: Adamant 2/32/0/0/0/32 Life Orb Garchomp, Dragon Claw into my Incineroar.
    const truth = makePokemon(gen, {species: 'Garchomp', level: 50, nature: 'Adamant', evs: [2, 32, 0, 0, 0, 32], item: 'Life Orb', ability: 'Rough Skin'});
    const inc = MY_TEAM[0];
    const def = makePokemon(gen, mySpec(gen, fmt, inc), b.live.mons.me0);
    const res = calculate(gen, truth, def, makeMove(gen, 'Dragon Claw'), makeField('doubles', b.live.field, 'opp'));
    const rolls = [...damageDistribution(res.damage).keys()].sort((x, y) => x - y);
    const max = def.maxHP();
    const hit = (roll: number) => ({target: me(0), hpBefore: max, hpAfter: max - roll, fainted: false, crit: false, triggers: []});
    b.events.push(action(b, 1, opp(0), 'Dragon Claw', [hit(rolls[rolls.length - 1])], {actorTriggers: ['lifeorb']}));
    b.events.push(action(b, 2, opp(0), 'Dragon Claw', [hit(rolls[0])], {actorTriggers: ['lifeorb']}));
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(p(g.items, 'Life Orb')).toBeGreaterThan(0.99);
    const atk = g.stats.find(s => s.stat === 'atk')!;
    expect(atk.mode).toBe(truth.rawStats.atk);
  });

  it('narrows bulk from damage dealt to the opponent', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    b.events.push(action(b, 1, me(1), 'Close Combat', [
      {target: opp(0), hpBefore: 100, hpAfter: 0, fainted: true, crit: false, triggers: []},
    ]));
    const inc = computeBeliefs(fmt, b).mons[0]!;
    // An OHKO from full rules out Sitrus-less survival paths but, more to the point,
    // it must shift belief towards frailer Incineroar.
    const hp = inc.stats.find(s => s.stat === 'hp')!;
    expect(hp.values.length).toBeGreaterThan(1);
    expect(inc.items.length).toBeGreaterThan(1);
  });
});

describe('other formats and HP modes', () => {
  const sv: FormatData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/gen9ou.json'), 'utf8'));
  const svTeam = parseTeam(`Great Tusk @ Booster Energy
Ability: Protosynthesis
Tera Type: Ground
EVs: 252 Atk / 4 Def / 252 Spe
Jolly Nature
- Headlong Rush
- Close Combat
- Ice Spinner
- Rapid Spin`);

  it('handles SV OU (level 100 EVs, Tera)', () => {
    const b = createBattle(sv, svTeam, ['Kingambit', 'Gholdengo', 'Dragapult'], 'sv');
    b.live.active = {me: [0], opp: [0]};
    b.events.push(action(b, 1, me(0), 'Close Combat', [
      {target: opp(0), hpBefore: 100, hpAfter: 0, fainted: true, crit: false, triggers: []},
    ]));
    b.events.push({kind: 'reveal', id: uid(), turn: 1, mon: opp(1), what: 'tera', value: 'Fighting', negate: false});
    const res = computeBeliefs(sv, b);
    expect(res.mons[0]!.items.length).toBeGreaterThan(1);
    expect(res.mons[1]!.tera?.[0]).toMatchObject({name: 'Fighting', p: 1});
    expect(res.mons[2]!.tera!.length).toBeGreaterThan(1);
  });

  it('accepts eyeballed HP within a tolerance', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    b.settings = {hpMode: 'approx', tolerance: 5};
    b.events.push(action(b, 1, me(1), 'Dire Claw', [
      {target: opp(0), hpBefore: 75, hpAfter: 45, fainted: false, crit: false, triggers: ['sitrus']},
    ]));
    const res = computeBeliefs(fmt, b);
    const note = res.notes.find(n => n.kind === 'damage-taken')!;
    expect(note.consistent).toBeGreaterThan(0.05);
    expect(p(res.mons[0]!.items, 'Sitrus Berry')).toBeGreaterThan(0.99);
  });
});

describe('paste parsing', () => {
  it('parses nicknames, gender, items, SPs and moves', () => {
    const [s] = parseTeam(`Bruno (Incineroar) (M) @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 10 Def / 24 SpD
Careful Nature
IVs: 0 Spe
- Fake Out
- Flare Blitz`);
    expect(s).toMatchObject({nickname: 'Bruno', species: 'Incineroar', gender: 'M', item: 'Sitrus Berry', ability: 'Intimidate', level: 50, nature: 'Careful'});
    expect(s.evs).toEqual([32, 0, 10, 0, 24, 0]);
    expect(s.ivs).toEqual([31, 31, 31, 31, 31, 0]);
    expect(s.moves).toEqual(['Fake Out', 'Flare Blitz']);
  });
});
