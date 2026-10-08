import {describe, expect, it} from 'vitest';
import type {Battle} from '../../engine/types';
import {cameIn} from './Leads';

const battle = (events: object[], opp: (number | null)[] = [null, null]) =>
  ({events, live: {active: {me: [null, null], opp}}}) as unknown as Battle;
const sw = (slotIn: number, side = 'opp') => ({kind: 'switch', side, position: 0, slotIn, slotOut: null});

describe('cameIn', () => {
  it('their slots in the order they first came in (the first two led), not yours', () => {
    expect(cameIn(battle([sw(2), sw(4), sw(0, 'me'), sw(2), sw(5)], [2, 5]))).toEqual([2, 4, 5]);
  });

  it('none at team preview', () => {
    expect(cameIn(battle([]))).toEqual([]);
  });
});
