import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {calculate} from '@smogon/calc';
import {getGen, natureMods, STAT_IDS, STAT_LABELS} from '../data/dex';
import type {FormatData, FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import type {OfficialEntry, OfficialSnapshot} from '../data/official';
import {parseTeam} from '../data/paste';
import {createBattle, emptyField, uid} from './battle';
import {damageDistribution, fractionalPriority, makeField, makeMove, makePokemon} from './calc';
import {displayPct, mySpec, orderConsistency} from './likelihood';
import {buildMoveModel, inclusion, itemFactors, movesLogLik} from './moveset';
import {computeBeliefs, type DistEntry} from './posterior';
import {applyAction, applyCheck, applyEndTurn, applySwitch, type StateCtx} from './state';
import type {ActionEvent, Battle, CheckEvent, MonRef, RevealEvent} from './types';
import {
  canMoveAction, endTurn, everyoneMoved, logAction, logSwitch, moveAction, setOrdered, turnActions, undo, type ActionDraft,
} from '../ui/battle/actions';
import {dmgRange, hitVerdict, speedVerdict} from '../ui/battle/verdict';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const index = data('formats.json').formats as FormatInfo[];
const info = index.find(f => f.id === 'champions-doubles')!;
const structure = data('structure-doubles.json') as Structure;

/**
 * An "official-style" snapshot synthesised from the Showdown structure data, so the
 * fusion code runs exactly as it does against the live in-game Battle Data.
 */
function officialFrom(s: Structure, previews: string[]): OfficialSnapshot {
  const gen = getGen(0);
  const pokemon: Record<string, OfficialEntry> = {};
  previews.forEach((p, i) => {
    const formes = s.preview[p];
    const W = formes.reduce((t, f) => t + s.species[f].weight, 0);
    const agg = (get: (f: string) => [string, number][], skipMega = false) => {
      const m = new Map<string, number>();
      for (const f of formes) {
        if (skipMega && /-Mega/.test(f) && formes.some(g => !/-Mega/.test(g))) continue;
        for (const [n, q] of get(f)) m.set(n, (m.get(n) ?? 0) + (q * s.species[f].weight) / W);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    };
    const spreads = new Map<string, number>();
    const natures = new Map<string, number>();
    for (const f of formes) {
      for (const [n, sp, q] of s.species[f].spreads) {
        const w = (q * s.species[f].weight) / W;
        spreads.set(sp.join('/'), (spreads.get(sp.join('/')) ?? 0) + w);
        natures.set(n, (natures.get(n) ?? 0) + w);
      }
    }
    const label = (id?: string) => (id ? STAT_LABELS[id as keyof typeof STAT_LABELS] : '');
    pokemon[p] = {
      position: i + 1,
      move: agg(f => s.species[f].moves).map(([n, q], r) => [n, q * 100, r + 1]),
      held_item: agg(f => s.species[f].items).map(([n, q], r) => [n, q * 100, r + 1]),
      ability: agg(f => s.species[f].abilities, true).map(([n, q], r) => [n, q * 100, r + 1]),
      stat_alignment: [...natures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([n, q], r) => {
          const [up, down] = natureMods(gen, n);
          return [n, q * 100, label(up), label(down), r + 1];
        }),
      stat_points: [...spreads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([sp, q], r) => [q * 100, ...sp.split('/').map(Number), r + 1]),
      teammate: [],
    };
  });
  return {season: 'T', date: '01_01_2026', format: 'Doubles', pokemon};
}

const PREVIEWS = ['Garchomp', 'Incineroar', 'Charizard', 'Sneasler', 'Kingambit', 'Whimsicott', 'Venusaur', 'Sinistcha'];
const fmt: FormatData = fuse(info, structure, officialFrom(structure, PREVIEWS));
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

const find = (list: DistEntry[], name: string) => list.find(e => e.name === name);
const p = (list: DistEntry[], name: string) => find(list, name)?.p ?? 0;
const pr = (list: DistEntry[], name: string) => find(list, name)?.prior ?? 0;

describe('data fusion', () => {
  it('splits a previewed species into Mega formes by the stones it holds', () => {
    expect(fmt.preview.Charizard).toContain('Charizard-Mega-Y');
    expect(fmt.species['Charizard-Mega-Y'].items).toEqual([['Charizardite Y', 1]]);
    expect(fmt.species['Charizard-Mega-Y'].weight).toBeGreaterThan(fmt.species.Charizard.weight);
  });

  it('pairs official spreads with sensible stat alignments', () => {
    for (const [nature, sp] of fmt.species.Garchomp.spreads) {
      const [up, down] = natureMods(gen, nature);
      // Nobody lowers a stat they maxed.
      if (down) expect(sp[STAT_IDS.indexOf(down)]).toBeLessThan(32);
      void up;
    }
  });
});

describe('move-set model', () => {
  it('fits inclusion probabilities to usage stats', () => {
    const moves = structure.species.Incineroar.moves;
    const model = buildMoveModel(moves, () => false);
    const inc = inclusion(model.w, model.k);
    for (const [name, pi] of moves.slice(0, 6)) expect(inc[model.names.indexOf(name)]).toBeCloseTo(pi, 2);
  });

  it('keeps prior move marginals equal to usage stats after item rules', () => {
    const g = computeBeliefs(fmt, battleVs(['Garchomp', 'Kingambit'])).mons[0]!;
    const protect = fmt.species.Garchomp.moves.find(([n]) => n === 'Protect')![1];
    expect(pr(g.moves, 'Protect')).toBeCloseTo(protect, 1);
  });

  it('makes Protect impossible on Assault Vest', () => {
    const model = buildMoveModel([['Protect', 0.6], ['Earthquake', 0.8]], m => m === 'Protect');
    const protect = model.names.indexOf('Protect');
    expect(movesLogLik(model, [protect], [], itemFactors(model, 'Assault Vest'))).toBe(-Infinity);
  });
});

describe('certainty from logic', () => {
  it('outspeeding a 189-speed Sneasler with no modifiers means Choice Scarf, 100%', () => {
    const b = battleVs(['Garchomp', 'Incineroar']);
    b.events.push(action(b, 1, opp(0), 'Rock Slide'));
    b.events.push(action(b, 1, me(1), 'Close Combat'));
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(p(g.items, 'Choice Scarf')).toBe(1);
    expect(find(g.items, 'Choice Scarf')?.certain).toBe(true);
  });

  it('Mega Evolving reveals the Mega Stone', () => {
    const b = battleVs(['Charizard', 'Venusaur']);
    b.events.push({kind: 'reveal', id: uid(), turn: 1, mon: opp(0), what: 'forme', value: 'Charizard-Mega-Y', negate: false});
    const c = computeBeliefs(fmt, b).mons[0]!;
    expect(find(c.items, 'Charizardite Y')?.certain).toBe(true);
    expect(find(c.formes, 'Charizard-Mega-Y')?.certain).toBe(true);
  });

  it('being poisoned by Close Combat means Poison Touch', () => {
    const b = battleVs(['Sneasler', 'Incineroar']);
    const max = b.live.mons.me0.hp;
    b.events.push(action(b, 1, opp(0), 'Close Combat', [
      {target: me(0), hpBefore: max, hpAfter: 0, fainted: true, crit: false, triggers: [], status: 'psn'},
    ]));
    const s = computeBeliefs(fmt, b).mons[0]!;
    expect(find(s.abilities, 'Poison Touch')?.certain).toBe(true);
  });

  it('two different moves without switching out rule out Choice Scarf exactly', () => {
    const b = battleVs(['Garchomp', 'Incineroar']);
    b.events.push(action(b, 1, opp(0), 'Rock Slide'));
    b.events.push(action(b, 2, opp(0), 'Dragon Claw'));
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(pr(g.items, 'Choice Scarf')).toBeGreaterThan(0.1);
    expect(p(g.items, 'Choice Scarf')).toBe(0);
  });

  it('applies Item Clause across the team', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    const before = computeBeliefs(fmt, b).mons[1]!;
    const reveal: RevealEvent = {kind: 'reveal', id: uid(), turn: 1, mon: opp(0), what: 'item', value: 'Sitrus Berry', negate: false};
    b.events.push(reveal);
    const after = computeBeliefs(fmt, b).mons[1]!;
    expect(p(before.items, 'Sitrus Berry')).toBeGreaterThan(0.01);
    expect(p(after.items, 'Sitrus Berry')).toBe(0);
  });

  it('a hit to half HP with a Sitrus message pins the Sitrus Berry', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    b.events.push(action(b, 1, me(1), 'Dire Claw', [
      {target: opp(0), hpBefore: 75, hpAfter: 45, fainted: false, crit: false, triggers: ['sitrus']},
    ]));
    const inc = computeBeliefs(fmt, b).mons[0]!;
    expect(find(inc.items, 'Sitrus Berry')?.certain).toBe(true);
  });
});

describe('abilities', () => {
  const check = (mon: MonRef, context: CheckEvent['context'], seen: string | null): CheckEvent => ({
    kind: 'check', id: uid(), turn: 1, mon, context, about: 'x', seen, seenKind: 'ability', mega: false, itemGone: false,
  });

  it('keeps the pre-Mega ability separate from the Mega ability', () => {
    const b = battleVs(['Charizard', 'Venusaur']);
    b.events.push(check(opp(0), 'entry', null));
    b.events.push({kind: 'reveal', id: uid(), turn: 1, mon: opp(0), what: 'ability', value: 'Solar Power', negate: false});
    b.events.push({kind: 'reveal', id: uid(), turn: 1, mon: opp(0), what: 'forme', value: 'Charizard-Mega-Y', negate: false});
    const c = computeBeliefs(fmt, b).mons[0]!;
    // Showing Solar Power before evolving says nothing against Mega Y…
    expect(find(c.formes, 'Charizard-Mega-Y')?.certain).toBe(true);
    // …it's the ability it came in with, while the Mega's own is fixed.
    expect(find(c.abilities, 'Solar Power')?.certain).toBe(true);
    expect(c.megaAbilityOf['Charizard-Mega-Y']).toBe('Drought');
  });

  it('nothing shown on entry rules out abilities that always announce themselves', () => {
    const b = battleVs(['Sneasler', 'Incineroar']);
    const before = computeBeliefs(fmt, b).mons[0]!;
    b.events.push(check(opp(0), 'entry', null));
    const after = computeBeliefs(fmt, b).mons[0]!;
    expect(pr(before.abilities, 'Pressure')).toBeGreaterThan(0);
    expect(p(after.abilities, 'Pressure')).toBe(0);
  });

  it('an ability listed at 0.0% in the ranked data is rare, not ruled out', () => {
    const snap = {...officialFrom(structure, PREVIEWS), date: '02_01_2026'};
    snap.pokemon.Incineroar = {...snap.pokemon.Incineroar, ability: [['Intimidate', 100, 1], ['Blaze', 0, 2]]};
    const f0 = fuse(info, structure, snap);
    const c = computeBeliefs(f0, createBattle(f0, MY_TEAM, ['Incineroar', 'Garchomp'], 'test')).mons[0]!;
    expect(find(c.abilities, 'Intimidate')?.certain).toBeFalsy();
    expect(p(c.abilities, 'Blaze')).toBeGreaterThan(0.001);
  });

  it('never applies an opponent ability from usage odds alone, only once certain', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    b.live.active = {me: [0, 1], opp: [null, 1]};
    const withAbility = (p: number): StateCtx => ({fmt, gen, battle: b, oppAbility: () => ({name: 'Intimidate', p}), oppItem: () => undefined});
    expect(applySwitch(withAbility(0.998), b.live, 'opp', 0, 0).mons.me0.boosts.atk ?? 0).toBe(0);
    expect(applySwitch(withAbility(1), b.live, 'opp', 0, 0).mons.me0.boosts.atk).toBe(-1);
  });

  it('a stat-dropping move with no Defiant banner rules Defiant out', () => {
    const run = (reaction: string | null) => {
      const b = battleVs(['Kingambit', 'Incineroar']);
      b.events.push(action(b, 1, me(1), 'Icy Wind', [
        {target: opp(0), hpBefore: 100, hpAfter: 100, fainted: false, crit: false, triggers: [], noEffect: false, reaction},
      ]));
      // Only the reaction is being tested: drop the damage reading.
      (b.events[0] as ActionEvent).hits[0].hpAfter = 95;
      return computeBeliefs(fmt, b).mons[0]!;
    };
    expect(p(run(null).abilities, 'Defiant')).toBe(0);
    expect(find(run('Defiant').abilities, 'Defiant')?.certain).toBe(true);
  });

  it('a Defiant banner after Intimidate pins the ability and nets +1 Atk', () => {
    const b = battleVs(['Kingambit', 'Incineroar']);
    b.live.mons.opp0.boosts = {atk: -1};
    const ev = check(opp(0), 'intimidate', 'Defiant');
    b.events.push(ev);
    const k = computeBeliefs(fmt, b).mons[0]!;
    expect(find(k.abilities, 'Defiant')?.certain).toBe(true);
    const ctx: StateCtx = {fmt, gen, battle: b, oppAbility: () => undefined, oppItem: () => undefined};
    expect(applyCheck(ctx, b.live, ev).mons.opp0.boosts.atk).toBe(1);
  });
});

describe('HP% on screen', () => {
  it('uses the game rule: rounded down, never 0% while alive, 100% only when full', () => {
    expect(displayPct(1, 200)).toBe(1);
    expect(displayPct(3, 200)).toBe(1);
    expect(displayPct(101, 200)).toBe(50);
    expect(displayPct(199, 200)).toBe(99);
    expect(displayPct(200, 200)).toBe(100);
    expect(displayPct(0, 200)).toBe(0);
  });

  it('an exact reading keeps the truth and narrows bulk more than an eyeballed one', () => {
    const [nature, evs] = structure.species.Incineroar.spreads[0];
    const truth = makePokemon(gen, {species: 'Incineroar', level: 50, nature, evs, item: 'Sitrus Berry', ability: 'Intimidate'});
    const res = calculate(gen, makePokemon(gen, mySpec(gen, fmt, MY_TEAM[1])), truth, makeMove(gen, 'Dire Claw'),
      makeField('doubles', emptyField(), 'me'));
    const rolls = [...(res.damage as number[])].sort((x, y) => x - y);
    const max = truth.maxHP();
    const shown = displayPct(max - rolls[8], max);
    const run = (hpMode: 'game' | 'bar') => {
      const b = battleVs(['Incineroar', 'Garchomp']);
      b.settings = {hpMode, tolerance: 4};
      b.events.push(action(b, 1, me(1), 'Dire Claw', [
        {target: opp(0), hpBefore: 100, hpAfter: shown, fainted: false, crit: false, triggers: []},
      ]));
      return computeBeliefs(fmt, b);
    };
    const exact = run('game');
    const eyeballed = run('bar');
    expect(exact.notes.some(n => n.kind === 'conflict')).toBe(false);
    const truthMass = (r: typeof exact) => r.mons[0]!.spreads
      .filter(x => x.nature === nature && x.evs.join('/') === evs.join('/')).reduce((a, x) => a + x.p, 0);
    expect(truthMass(exact)).toBeGreaterThan(0);
    const hpValues = (r: typeof exact) => r.mons[0]!.stats.find(x => x.stat === 'hp')!.values.filter(([, q]) => q > 0.001).length;
    const defSpread = (r: typeof exact) => {
      const d = r.mons[0]!.stats.find(x => x.stat === 'def')!;
      return d.hi - d.lo;
    };
    expect(hpValues(exact) + defSpread(exact)).toBeLessThan(hpValues(eyeballed) + defSpread(eyeballed));
  });
});

describe('inference', () => {
  it('converges on the true attacking stat and item from damage', () => {
    const b = battleVs(['Garchomp', 'Incineroar']);
    const truth = makePokemon(gen, {species: 'Garchomp', level: 50, nature: 'Adamant', evs: [2, 32, 0, 0, 0, 32], item: 'Life Orb', ability: 'Rough Skin'});
    const def = makePokemon(gen, mySpec(gen, fmt, MY_TEAM[0]), b.live.mons.me0);
    const res = calculate(gen, truth, def, makeMove(gen, 'Dragon Claw'), makeField('doubles', b.live.field, 'opp'));
    const rolls = [...damageDistribution(res.damage).keys()].sort((x, y) => x - y);
    const max = def.maxHP();
    const hit = (roll: number) => ({target: me(0), hpBefore: max, hpAfter: max - roll, fainted: false, crit: false, triggers: []});
    b.events.push(action(b, 1, opp(0), 'Dragon Claw', [hit(rolls[rolls.length - 1])], {actorTriggers: ['lifeorb']}));
    b.events.push(action(b, 2, opp(0), 'Dragon Claw', [hit(rolls[0])], {actorTriggers: ['lifeorb']}));
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(find(g.items, 'Life Orb')?.certain).toBe(true);
    expect(g.stats.find(s => s.stat === 'atk')!.mode).toBe(truth.rawStats.atk);
  });

  it('sets aside an impossible observation instead of wiping beliefs', () => {
    const b = battleVs(['Incineroar', 'Garchomp']);
    // Close Combat from Sneasler can't leave Incineroar at 99%.
    b.events.push(action(b, 1, me(1), 'Close Combat', [
      {target: opp(0), hpBefore: 100, hpAfter: 99, fainted: false, crit: false, triggers: []},
    ]));
    const res = computeBeliefs(fmt, b);
    expect(res.notes.some(n => n.kind === 'conflict' && n.slot === 0)).toBe(true);
    // The damage reading is set aside; beliefs stay spread out rather than collapsing.
    const hp = res.mons[0]!.stats.find(s => s.stat === 'hp')!;
    const base = computeBeliefs(fmt, battleVs(['Incineroar', 'Garchomp'])).mons[0]!.stats.find(s => s.stat === 'hp')!;
    expect(hp.mode).toBe(base.mode);
    expect(res.mons[0]!.items.filter(e => e.p > 0).length).toBeGreaterThan(3);
  });

  it('uses turn order between two opponents', () => {
    const b = battleVs(['Garchomp', 'Charizard']);
    b.events.push({kind: 'reveal', id: uid(), turn: 1, mon: opp(1), what: 'forme', value: 'Charizard-Mega-Y', negate: false});
    b.live.mons.opp1.mega = true;
    b.events.push(action(b, 1, opp(1), 'Heat Wave'));
    b.events.push(action(b, 1, opp(0), 'Dragon Claw'));
    const res = computeBeliefs(fmt, b);
    const spe = res.mons[0]!.stats.find(s => s.stat === 'spe')!;
    const fast = (s: typeof spe) => s.values.filter(([v]) => v >= 168).reduce((a, [, q]) => a + q, 0);
    const before = computeBeliefs(fmt, battleVs(['Garchomp', 'Charizard'])).mons[0]!.stats.find(s => s.stat === 'spe')!;
    expect(fast(before)).toBeGreaterThan(0.2);
    expect(fast(spe)).toBe(0);
  });
});

describe('turn order', () => {
  const ctxOf = (b: Battle): StateCtx => ({fmt, gen, battle: b, oppAbility: () => undefined, oppItem: () => undefined});
  const draft = (actor: MonRef, move: string, hits: ActionEvent['hits'] = [], extra: Partial<ActionDraft> = {}): ActionDraft => ({
    actor, move, hits, targets: hits.length || 1, helpingHand: false, actorTriggers: [], ordered: true, ...extra,
  });
  const log = (b: Battle, d: ActionDraft) => logAction(ctxOf(b), b, d);
  const hit = (target: MonRef, hpBefore: number, hpAfter: number) => ({target, hpBefore, hpAfter, fainted: hpAfter <= 0, crit: false, triggers: []});

  it('a Pokémon that came in this turn moving means a new turn began', () => {
    let b = battleVs(['Garchomp', 'Kingambit', 'Incineroar']);
    b = logSwitch(ctxOf(b), b, 'opp', 1, 2);
    b = log(b, draft(opp(0), 'Dragon Claw'));
    expect(b.turn).toBe(1);
    // Incineroar used this turn to come in, so its move is next turn's.
    b = log(b, draft(opp(2), 'Fake Out'));
    expect(b.turn).toBe(2);
    expect(turnActions(b, 1).map(a => a.move)).toEqual(['Dragon Claw']);
    expect(turnActions(b, 2).map(a => a.move)).toEqual(['Fake Out']);
  });

  it('a replacement for a fainted Pokémon, sent in before anyone moved, moves that turn', () => {
    let b = battleVs(['Garchomp', 'Kingambit', 'Incineroar']);
    b = log(b, draft(me(1), 'Close Combat', [hit(opp(0), 100, 0)]));
    b = endTurn(ctxOf(b), b);
    b = logSwitch(ctxOf(b), b, 'opp', 0, 2);
    b = log(b, draft(opp(2), 'Fake Out'));
    expect(b.turn).toBe(2);
    expect(turnActions(b, 2).map(a => a.move)).toEqual(['Fake Out']);
  });

  it('lights up End turn once everyone has moved (a Fake Out flinch counts)', () => {
    let b = battleVs(['Garchomp', 'Kingambit']);
    b = log(b, draft(me(0), 'Fake Out', [hit(opp(0), 100, 90)]));
    b = log(b, draft(opp(1), 'Kowtow Cleave'));
    expect(everyoneMoved(b)).toBe(false);
    b = log(b, draft(me(1), 'Close Combat'));
    expect(everyoneMoved(b)).toBe(true);
  });

  it('fixing the order flips what Speed says', () => {
    let b = battleVs(['Garchomp', 'Incineroar']);
    b = log(b, draft(opp(0), 'Rock Slide'));
    b = log(b, draft(me(1), 'Close Combat'));
    expect(p(computeBeliefs(fmt, b).mons[0]!.items, 'Choice Scarf')).toBe(1);
    const cc = b.events[b.events.length - 1].id;
    expect(canMoveAction(b, cc, 1).ok).toBe(false);
    b = moveAction(ctxOf(b), b, cc, -1);
    expect(turnActions(b).map(a => a.move)).toEqual(['Close Combat', 'Rock Slide']);
    // Sneasler (189) went first: only a Scarf on a minus-Speed Garchomp (164 at most) stays possible.
    expect(p(computeBeliefs(fmt, b).mons[0]!.items, 'Choice Scarf')).toBeLessThan(0.05);
  });

  it('re-runs swapped moves so each sees the field as it was, and undo stays exact', () => {
    let b = battleVs(['Whimsicott', 'Garchomp']);
    b = log(b, draft(me(1), 'Close Combat'));
    b = log(b, draft(opp(0), 'Tailwind'));
    b = moveAction(ctxOf(b), b, b.events[b.events.length - 1].id, -1);
    const [first, second] = turnActions(b);
    expect(first.move).toBe('Tailwind');
    expect(first.before.field.opp.tailwind).toBe(false);
    expect(second.before.field.opp.tailwind).toBe(true);
    expect(b.live.field.opp.tailwind).toBe(true);
    expect(undo(b).live.field.opp.tailwind).toBe(true);
    expect(undo(undo(b)).live.field.opp.tailwind).toBe(false);
  });

  it('won\'t swap two moves that both changed the same HP', () => {
    let b = battleVs(['Garchomp', 'Kingambit']);
    b = log(b, draft(opp(0), 'Dragon Claw', [hit(me(0), 202, 150)]));
    b = log(b, draft(opp(1), 'Kowtow Cleave', [hit(me(0), 150, 90)]));
    expect(canMoveAction(b, b.events[b.events.length - 1].id, -1).ok).toBe(false);
  });

  it('"order unsure" keeps a move out of the Speed inference', () => {
    let b = battleVs(['Garchomp', 'Incineroar']);
    b = log(b, draft(opp(0), 'Rock Slide'));
    b = log(b, draft(me(1), 'Close Combat'));
    b = setOrdered(b, turnActions(b)[0].id, false);
    const g = computeBeliefs(fmt, b).mons[0]!;
    expect(p(g.items, 'Choice Scarf')).toBeGreaterThan(0);
    expect(p(g.items, 'Choice Scarf')).toBeLessThan(0.9);
  });

  it('Quick Claw explains a slow Pokémon moving first, and pins the item', () => {
    let b = battleVs(['Kingambit', 'Garchomp']);
    b = log(b, draft(opp(0), 'Kowtow Cleave', [], {quick: 'Quick Claw'}));
    b = log(b, draft(me(1), 'Close Combat'));
    const res = computeBeliefs(fmt, b);
    expect(find(res.mons[0]!.items, 'Quick Claw')?.certain).toBe(true);
    expect(res.notes.some(n => n.kind === 'conflict')).toBe(false);
  });

  it('Stall moves last in its bracket, even under Trick Room', () => {
    const stall: [number, number] = [fractionalPriority(gen, 'Foul Play', 'Stall', undefined, false), 200];
    const plain: [number, number] = [0, 50];
    expect(orderConsistency(plain, stall, false)).toBe(1);
    expect(orderConsistency(plain, stall, true)).toBe(1);
    expect(orderConsistency(stall, plain, true)).toBe(0);
  });

  it('a Mega Evolution counts from the start of the turn, whenever it was logged', () => {
    // A 160-Speed Sneasler: faster than any Mega Garchomp (158 max), not than every Garchomp (169).
    const team = parseTeam(`Sneasler @ Focus Sash
Ability: Unburden
EVs: 32 Atk / 20 Spe
Adamant Nature
- Close Combat
- Dire Claw
- Fake Out
- Protect`);
    const speedAfter = (megaFirst: boolean) => {
      const b = createBattle(fmt, team, ['Garchomp', 'Incineroar'], 'test');
      b.live.active = {me: [0, null], opp: [0, 1]};
      const mega = () => {
        b.events.push({kind: 'reveal', id: uid(), turn: 1, mon: opp(0), what: 'forme', value: 'Garchomp-Mega', negate: false});
        b.live.mons.opp0.mega = true;
      };
      if (megaFirst) mega();
      b.events.push(action(b, 1, me(0), 'Dire Claw'));
      if (!megaFirst) mega();
      b.events.push(action(b, 1, opp(0), 'Dragon Claw'));
      const spe = computeBeliefs(fmt, b).mons[0]!.stats.find(x => x.stat === 'spe')!;
      return [spe.lo, spe.mode, spe.hi];
    };
    expect(speedAfter(false)).toEqual(speedAfter(true));
  });
});

describe('damage and speed readings', () => {
  const hitOf = (lo: number, hi: number, ko = 0, sash = false) => ({move: 'X', lo, mid: (lo + hi) / 2, hi, ko, sash});

  it('writes damage ranges the usual way', () => {
    expect(dmgRange(34.4, 51.6)).toBe('34–52%');
    expect(dmgRange(5, 5.2)).toBe('5%');
    expect(dmgRange(0, 0)).toBe('immune');
  });

  it('says how many hits it takes instead of calling a big hit "safe"', () => {
    expect(hitVerdict(hitOf(88, 94), 100).text).toBe('2HKO');
    expect(hitVerdict(hitOf(34, 52), 100).text).toBe('2–3HKO');
    expect(hitVerdict(hitOf(17, 25), 100)).toMatchObject({text: '4+HKO', weak: true});
    expect(hitVerdict(hitOf(5, 8), 100).text).toBe('5+HKO');
    // From its HP now, not from full.
    expect(hitVerdict(hitOf(10, 12), 40).text).toBe('4HKO');
    expect(hitVerdict(hitOf(62, 94, 0.62), 100)).toMatchObject({text: 'KO 62%', cls: 'likely'});
    expect(hitVerdict(hitOf(100, 120, 1), 100).text).toBe('KO');
    expect(hitVerdict(hitOf(100, 120, 0, true), 100).text).toBe('Sash');
    expect(hitVerdict(hitOf(0, 0), 100).text).toBe('immune');
  });

  it('reads who moves first, flipped under Trick Room', () => {
    const s = {mySlot: 0, mySpeed: 100, pFaster: 1, pTie: 0};
    expect(speedVerdict(s, false)?.text).toBe('it moves first');
    expect(speedVerdict(s, true)?.text).toBe('you move first');
    expect(speedVerdict({...s, pFaster: 0.3}, false)?.text).toBe('it first 30%');
  });
});

describe('battle state', () => {
  const ctxFor = (b: Battle): StateCtx => ({
    fmt, gen, battle: b,
    oppAbility: slot => ({Incineroar: {name: 'Intimidate', p: 1}, Kingambit: {name: 'Defiant', p: 0.99}} as Record<string, {name: string; p: number}>)[b.oppPreview[slot]],
    oppItem: () => undefined,
  });

  it('applies guaranteed stat drops, self drops and field effects', () => {
    const b = battleVs(['Garchomp', 'Kingambit']);
    const ctx = ctxFor(b);
    let live = applyAction(ctx, b.live, action(b, 1, opp(0), 'Icy Wind', [
      {target: me(0), hpBefore: 202, hpAfter: 190, fainted: false, crit: false, triggers: []},
      {target: me(1), hpBefore: 157, hpAfter: 130, fainted: false, crit: false, triggers: []},
    ]));
    expect(live.mons.me0.boosts.spe).toBe(-1);
    expect(live.mons.me1.boosts.spe).toBe(-1);
    live = applyAction(ctx, live, action(b, 1, me(1), 'Close Combat', [
      {target: opp(1), hpBefore: 100, hpAfter: 40, fainted: false, crit: false, triggers: []},
    ]));
    expect(live.mons.me1.boosts).toMatchObject({def: -1, spd: -1});
    live = applyAction(ctx, live, action(b, 1, opp(1), 'Tailwind'));
    expect(live.field.opp.tailwind).toBe(true);
    for (let t = 0; t < 3; t++) live = applyEndTurn(ctx, live);
    expect(live.field.opp.tailwind).toBe(true);
    live = applyEndTurn(ctx, live);
    expect(live.field.opp.tailwind).toBe(false);
  });

  it('handles Intimidate on switch-in, with Defiant only once it is known', () => {
    const b = battleVs(['Garchomp', 'Kingambit']);
    b.live.active = {me: [null, 1], opp: [0, 1]};
    const live = applySwitch(ctxFor(b), b.live, 'me', 0, 0);
    expect(live.mons.opp0.boosts.atk).toBe(-1);
    // Defiant at 99% is still a guess: the reaction prompt asks instead of assuming it.
    expect(live.mons.opp1.boosts.atk).toBe(-1);
    const known: StateCtx = {...ctxFor(b), oppAbility: slot => (slot === 1 ? {name: 'Defiant', p: 1} : undefined)};
    expect(applySwitch(known, b.live, 'me', 0, 0).mons.opp1.boosts.atk).toBe(1);
  });

  it('eats my Sitrus Berry automatically at half HP', () => {
    const b = battleVs(['Garchomp', 'Kingambit']);
    const live = applyAction(ctxFor(b), b.live, action(b, 1, opp(0), 'Dragon Claw', [
      {target: me(0), hpBefore: 202, hpAfter: 90, fainted: false, crit: false, triggers: []},
    ]));
    expect(live.mons.me0.hp).toBe(90 + 50);
    expect(live.mons.me0.itemGone).toBe(true);
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
  });
});
