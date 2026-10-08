import {describe, expect, it} from 'vitest';
import {getGen} from '../../data/dex';
import type {Battle} from '../../engine/types';
import {stateCtx} from './actions';

describe('stateCtx', () => {
  it("knows a Mega's ability from the forme the game named, the beliefs in or not (8 Oct: Mega Staraptor's Contrary)", () => {
    const b = {
      oppPreview: ['Staraptor'],
      events: [{kind: 'reveal', id: 'x', turn: 1, mon: {side: 'opp', slot: 0}, what: 'forme', value: 'Staraptor-Mega', negate: false}],
    } as unknown as Battle;
    expect(stateCtx({} as never, getGen(0), b, undefined).oppAbility(0, true)).toEqual({name: 'Contrary', p: 1});
  });
});
