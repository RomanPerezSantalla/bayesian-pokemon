import {describe, expect, it} from 'vitest';
import {sidesOf} from '../../scripts/build-leads.mjs';
import {backOdds, eachOdds, leadName, leadOdds, leadRate, type LeadSpecies, type LeadTable} from './leads';

const table = (over: Partial<LeadTable> = {}): LeadTable => ({
  source: {formats: [], sides: 0, complete: 0, from: '', to: ''},
  species: {}, pairs: {}, links: {}, aliases: {}, ...over,
});
const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];
const sum = (xs: {p: number}[]) => xs.reduce((s, x) => s + x.p, 0);

describe('lead odds', () => {
  it('knowing nothing, every pair of the six is as likely', () => {
    const odds = leadOdds(table(), SIX);
    expect(odds).toHaveLength(15);
    expect(sum(odds)).toBeCloseTo(1);
    for (const o of odds) expect(o.p).toBeCloseTo(1 / 15);
  });

  it('one that leads most games it is in is in all of the top five pairs', () => {
    const odds = leadOdds(table({species: {a: [100, 80, 0, 0]}}), SIX);
    expect(odds.slice(0, 5).every(o => o.pair.includes('A'))).toBe(true);
    expect(sum(odds)).toBeCloseTo(1);
  });

  it('a pair that leads together more than its rates say comes first', () => {
    const odds = leadOdds(table({species: {a: [100, 50, 0, 0]}, pairs: {'b|c': [30, 5, 0, 0]}}), SIX);
    expect(odds[0].pair).toEqual(['B', 'C']);
  });

  it('formes counted as another are looked up as it, and the table can say how hard to shrink', () => {
    const t = table({species: {vivillon: [50, 40, 0, 0]}, aliases: {vivillonpokeball: 'vivillon'}});
    expect(leadRate(t, 'Vivillon-Pokeball')).toBe(leadRate(t, 'Vivillon'));
    expect(leadRate(t, 'Vivillon')).toBeGreaterThan(0.6);
    expect(leadRate({...t, tuning: {prior: 10000, pad: 3}}, 'Vivillon')).toBeCloseTo(1 / 3, 2);
  });
});

describe('back odds', () => {
  it('pairs of the four that didn\'t lead; one seen, the other is one of the three left', () => {
    const t = table();
    const odds = backOdds(t, SIX, ['A', 'B']);
    expect(odds).toHaveLength(6);
    expect(odds.every(o => !o.pair.includes('A') && !o.pair.includes('B'))).toBe(true);
    expect(sum(odds)).toBeCloseTo(1);
    const each = eachOdds(odds);
    expect([...each.values()].reduce((s, p) => s + p, 0)).toBeCloseTo(2);

    const seen = backOdds(t, SIX, ['A', 'B'], ['C']);
    expect(seen).toHaveLength(3);
    expect(eachOdds(seen).get('C')).toBeCloseTo(1);
  });

  it('one often brought with a lead is likelier in the back when that one leads', () => {
    const t = table({links: {'a>d': [40, 10]}});
    const each = eachOdds(backOdds(t, SIX, ['A', 'B']));
    expect(each.get('D')!).toBeGreaterThan(each.get('E')!);
    const without = eachOdds(backOdds(t, SIX, ['B', 'C']));
    expect(without.get('D')).toBeCloseTo(without.get('E')!);
  });
});

describe('leadName', () => {
  const dex: Record<string, LeadSpecies> = {
    Vivillon: {name: 'Vivillon', types: ['Bug', 'Flying'], baseStats: {hp: 80, spe: 89}, abilities: {0: 'Shield Dust', H: 'Friend Guard'}},
    'Vivillon-Pokeball': {name: 'Vivillon-Pokeball', baseSpecies: 'Vivillon', types: ['Bug', 'Flying'], baseStats: {hp: 80, spe: 89}, abilities: {0: 'Shield Dust', H: 'Friend Guard'}},
    Meowstic: {name: 'Meowstic', types: ['Psychic'], baseStats: {hp: 74, spe: 104}, abilities: {0: 'Keen Eye', H: 'Prankster'}},
    'Meowstic-F': {name: 'Meowstic-F', baseSpecies: 'Meowstic', types: ['Psychic'], baseStats: {hp: 74, spe: 104}, abilities: {0: 'Keen Eye', H: 'Competitive'}},
    Alcremie: {name: 'Alcremie', types: ['Fairy'], baseStats: {hp: 65, spe: 64}, abilities: {0: 'Sweet Veil', H: 'Aroma Veil'}},
  };
  const get = (n: string) => dex[n];

  it('a forme no different in battle counts as its regular one; one that plays differently stays apart', () => {
    expect(leadName(get, 'Vivillon-Pokeball')).toBe('Vivillon');
    expect(leadName(get, 'Meowstic-F')).toBe('Meowstic-F');
    expect(leadName(get, 'Alcremie-Lemon-Cream')).toBe('Alcremie');
    expect(leadName(get, 'Missingno')).toBe('Missingno');
  });
});

describe('reading a replay (scripts/build-leads.mjs)', () => {
  const log = (lines: string[]) => [
    '|player|p1|Alice|1|', '|player|p2|Bob|2|', '|gametype|doubles',
    '|poke|p1|Charizard, L50, M|', '|poke|p1|Venusaur, L50, F|', '|poke|p1|Incineroar, L50, M|',
    '|poke|p1|Vivillon-Pokeball, L50, F|', '|poke|p1|Zoroark-Hisui, L50, M|', '|poke|p1|Garchomp, L50, M|',
    '|poke|p2|Rillaboom, L50, M|', '|poke|p2|Incineroar, L50, M|', '|poke|p2|Gholdengo, L50|',
    '|poke|p2|Volcarona, L50, M|', '|poke|p2|Raichu, L50, F|', '|poke|p2|Garchomp, L50, F|',
    '|teampreview|4', '|start', ...lines,
  ].join('\n');

  it('leads, the ones brought, a Mega back in as its Mega, Illusion seen through, a forme folded', () => {
    const sides = sidesOf(log([
      '|switch|p1a: Charizard|Charizard, L50, M|100/100',
      // Zoroark-Hisui leading as Garchomp.
      '|switch|p1b: Garchomp|Garchomp, L50, M|100/100',
      '|switch|p2a: Raichu|Raichu, L50, F|100/100',
      '|switch|p2b: Volcarona|Volcarona, L50, M|100/100',
      '|turn|1',
      '|detailschange|p1a: Charizard|Charizard-Mega-Y, L50, M',
      '|replace|p1b: Zoroark|Zoroark-Hisui, L50, M',
      '|turn|2',
      '|switch|p1a: Venusaur|Venusaur, L50, F|100/100',
      '|drag|p2a: Rillaboom|Rillaboom, L50, M|100/100',
      '|turn|3',
      '|switch|p1a: Charizard|Charizard-Mega-Y, L50, M|100/100',
      '|switch|p1b: Vivillon|Vivillon-Pokeball, L50, F|100/100',
      '|switch|p2b: Garchomp|Garchomp, L50, F|100/100',
      '|win|Alice',
    ]));
    expect(sides).toHaveLength(2);
    const [alice, bob] = sides as Extract<(typeof sides)[number], {player: string}>[];
    expect(alice.player).toBe('Alice');
    expect(alice.six).toContain('Vivillon');
    expect(alice.leads).toEqual(['Charizard', 'Zoroark-Hisui']);
    expect([...alice.brought].sort()).toEqual(['Charizard', 'Venusaur', 'Vivillon', 'Zoroark-Hisui']);
    expect(alice.complete).toBe(true);
    expect(bob.leads).toEqual(['Raichu', 'Volcarona']);
    expect([...bob.brought].sort()).toEqual(['Garchomp', 'Raichu', 'Rillaboom', 'Volcarona']);
  });

  it('a side naming one not in its six is left out; three seen is a side, not a complete one', () => {
    const sides = sidesOf(log([
      '|switch|p1a: Charizard|Charizard, L50, M|100/100',
      '|switch|p1b: Venusaur|Venusaur, L50, F|100/100',
      '|switch|p2a: Raichu|Raichu, L50, F|100/100',
      '|switch|p2b: Pikachu|Pikachu, L50, F|100/100',
      '|turn|1',
      '|switch|p1a: Incineroar|Incineroar, L50, M|100/100',
    ]));
    expect(sides[0]).toMatchObject({leads: ['Charizard', 'Venusaur'], complete: false});
    expect(sides[1]).toEqual({rejected: 'unmatched Pikachu'});
  });
});
