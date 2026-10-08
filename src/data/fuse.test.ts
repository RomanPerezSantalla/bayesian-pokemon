import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {computeStats, getGen} from './dex';
import type {FormatInfo} from './format';
import {fuse, type Structure} from './fuse';
import type {OfficialEntry, OfficialSnapshot} from './official';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const structure = data('structure-doubles.json') as Structure;
const gen = getGen(0);

/** Sneasler in the in-game Battle Data, Doubles, season M6 (2 Oct 2026): its alignments and spreads as listed. */
const SNEASLER: OfficialEntry = {
  position: 2,
  move: [['Fake Out', 80, 1], ['Close Combat', 75, 2], ['Dire Claw', 70, 3], ['Protect', 60, 4]],
  held_item: [['White Herb', 40, 1], ['Focus Sash', 30, 2]],
  ability: [['Unburden', 70, 1], ['Poison Touch', 30, 2]],
  stat_alignment: [
    ['Jolly', 54.5, 'spe', 'spa', 1], ['Adamant', 35.2, 'atk', 'spa', 2], ['Brave', 4.8, 'atk', 'spe', 3], ['Impish', 2.1, 'def', 'spa', 4],
    ['Careful', 1.4, 'spd', 'spa', 5], ['Lonely', 0.7, 'atk', 'def', 6], ['Naughty', 0.5, 'atk', 'spd', 7], ['Hasty', 0.4, 'spe', 'def', 8],
    ['Naive', 0.2, 'spe', 'spd', 9], ['Relaxed', 0.2, 'def', 'spe', 10],
  ],
  stat_points: [
    [34.7, 2, 32, 0, 0, 0, 32, 1], [6.3, 32, 32, 2, 0, 0, 0, 2], [5.9, 0, 32, 2, 0, 0, 32, 3], [4.0, 32, 32, 0, 0, 2, 0, 4],
    [3.9, 32, 32, 0, 0, 0, 2, 5], [3.8, 32, 32, 2, 0, 0, 0, 6], [3.8, 0, 32, 0, 0, 2, 32, 7], [3.1, 32, 32, 0, 2, 0, 0, 8],
    [2.3, 2, 32, 2, 0, 0, 32, 9], [2.2, 0, 32, 0, 0, 2, 32, 10],
  ],
  teammate: [],
};

describe('alignments and spreads from the in-game data, which lists them apart', () => {
  const official: OfficialSnapshot = {season: 'M6', date: '02_10_2026', format: 'Doubles', pokemon: {Sneasler: SNEASLER}};
  const spreads = fuse(info, structure, official).species.Sneasler.spreads;
  const head = spreads.reduce((s, [, , p]) => s + p, 0);
  const share = (keep: (nature: string, sp: number[]) => boolean) => spreads.filter(([n, sp]) => keep(n, sp)).reduce((s, [, , p]) => s + p, 0) / head;

  it('over all its spreads, each alignment at its in-game share', () => {
    expect(share(n => n === 'Jolly')).toBeCloseTo(0.545, 1);
    expect(share(n => n === 'Adamant')).toBeCloseTo(0.352, 1);
  });

  it("the Jollies on the spreads that invest in Speed: a Timid Mega Raichu X (178) is slower than most Sneasler", () => {
    const speed = (n: string, sp: number[]) => computeStats(gen, 'Sneasler', n, sp, 50)[5];
    // Jolly with 32 Speed is 189; Adamant with it, 172.
    expect(speed('Jolly', [2, 32, 0, 0, 0, 32])).toBe(189);
    expect(share((n, sp) => speed(n, sp) > 178)).toBeGreaterThan(0.5);
  });
});
