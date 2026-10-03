import {describe, expect, it} from 'vitest';
import {getGen} from '../data/dex';
import {addTheirs} from './picks';

describe('their picks at team preview', () => {
  const gen = getGen(0);

  it('a forme of one of theirs replaces it: one of each species', () => {
    expect(addTheirs(['Charizard', 'Goodra', 'Froslass'], 'Goodra-Hisui', gen))
      .toEqual({theirs: ['Charizard', 'Froslass', 'Goodra-Hisui'], said: 'Goodra → Goodra-Hisui'});
    expect(addTheirs(['Goodra-Hisui', 'Froslass'], 'Goodra', gen)).toEqual({theirs: ['Froslass', 'Goodra'], said: 'Goodra-Hisui → Goodra'});
  });

  it('no more than six, and none twice', () => {
    const six = ['Charizard', 'Goodra', 'Froslass', 'Incineroar', 'Sneasler', 'Kingambit'];
    expect(addTheirs(six, 'Garchomp', gen)).toEqual({theirs: six, note: 'their six are in already, not Garchomp'});
    expect(addTheirs(['Froslass'], 'Froslass', gen)).toEqual({theirs: ['Froslass'], note: 'Froslass is in already'});
  });
});
