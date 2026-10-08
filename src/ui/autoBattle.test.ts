import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import type {IconGuess} from '../screen/preview';
import type {SavedTeam} from '../state/store';
import {allSpecies, toID} from '../data/dex';
import {broughtFrom, chooseTheirs, formatFor, previewNameOf, sentOut, teamFor} from './autoBattle';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const formats = data('formats.json').formats as FormatInfo[];
const fmt = fuse(formats.find(f => f.id === 'champions-doubles')!, data('structure-doubles.json') as Structure, null);
const gen = getGen(0);

const guess = (name: string, cost: number, shiny = false): IconGuess => ({name, cost, shiny});
const same = (name: string) => name;

describe('their six from the icons', () => {
  it("each slot's best fit, near ties to the one the ladder uses more", () => {
    const usage: Record<string, number> = {Raichu: 1, Pikachu: 0.2, Sylveon: 0.8, Slurpuff: 0.001};
    const six = chooseTheirs([
      [guess('Pikachu', 0.40), guess('Raichu', 0.41)],
      [guess('Slurpuff', 0.30), guess('Sylveon', 0.60)],
    ], same, n => usage[n] ?? 0);
    // 0.01 of fit is less than Raichu's usage over Pikachu's makes up (but not by enough to be sure); 0.3 is more than
    // Sylveon's does.
    expect(six.map(t => t.name)).toEqual(['Raichu', 'Slurpuff']);
    expect(six[1]).toMatchObject({sure: true, alts: ['Sylveon']});
    expect(six[0].sure).toBe(false);
  });

  it('one of each species: the surer slot keeps it, the other takes its next', () => {
    const six = chooseTheirs([
      [guess('Gengar', 0.50), guess('Banette', 0.55)],
      [guess('Gengar', 0.20, true), guess('Mismagius', 0.90)],
    ], same, () => 1);
    expect(six.map(t => t.name)).toEqual(['Banette', 'Gengar']);
  });

  it('team-preview names: as the format lists them, a forme that only looks different as its species', () => {
    expect(previewNameOf(fmt, gen, 'Aegislash-Shield')).toBe('Aegislash');
    expect(previewNameOf(fmt, gen, 'Raichu')).toBe('Raichu');
    expect(previewNameOf(fmt, gen, 'Vivillon-Fancy')).toBe('Vivillon');
    expect(previewNameOf(fmt, gen, 'Maushold-Four')).toBe('Maushold');
    // Not Lycanroc (Midday) or Dusk: another Pokémon in all but name.
    expect(previewNameOf(fmt, gen, 'Lycanroc-Midnight')).toBe('Lycanroc-Midnight');
  });
});

describe('a battle whose team preview was missed', () => {
  const names = allSpecies(gen).filter(n => !/-(Mega|Gmax)/.test(n) && !gen.species.get(toID(n))?.baseSpecies);

  it('opens at the first "… sent out …!" with the ones it names (titles off; yours are "Go! …!")', () => {
    expect(sentOut('Nacson sent out Garchomp and Gholdengo!', names)).toEqual(['Garchomp', 'Gholdengo']);
    expect(sentOut('Zack sent out Sneasler the Rank Master and Charizard!', names)).toEqual(['Sneasler', 'Charizard']);
    expect(sentOut('Bobsponge sent out Gholdengo the Sociable!', names)).toEqual(['Gholdengo']);
    expect(sentOut('Go! Raichu and Espathra!', names)).toBeNull();
    expect(sentOut('You lost toNacson!', names)).toBeNull();
  });
});

describe('your side of team preview', () => {
  const team = (id: string, paste: string): SavedTeam => ({id, name: id, paste, sets: parseTeam(paste), updated: 0});
  const mine = team('rain', `Raichu @ Raichunite X
- Fake Out

Pelipper @ Focus Sash
- Hurricane

Archaludon @ Leftovers
- Electro Shot

Espathra @ Electric Seed
- Lumina Crash

Golisopod @ Golisopite
- First Impression

イダイ195 (Basculegion) @ Life Orb
- Last Respects`);
  const other = team('sun', `Charizard @ Charizardite Y
- Heat Wave

Venusaur @ Life Orb
- Sleep Powder

Raichu @ Focus Sash
- Fake Out`);
  const read = ['Raichu', 'Pelipper', 'Archaludon', 'Espathra', 'Golisopod', '191195'];

  it('the team whose names are on screen (a nickname in another alphabet unread), and which is which', () => {
    expect(teamFor([other, mine], read, gen)).toEqual({team: mine, order: [0, 1, 2, 3, 4, 5]});
    // The game's order isn't the app's: the names say which is which.
    const shuffled = {...mine, sets: [mine.sets[3], mine.sets[5], mine.sets[0], mine.sets[1], mine.sets[2], mine.sets[4]]};
    expect(teamFor([shuffled], read, gen)?.order).toEqual([2, 3, 4, 0, 5, 1]);
    expect(teamFor([other], read, gen)).toBeNull();
  });

  it('a Mega or a regional forme by the name the game lists it by, its species', () => {
    const megas = team('megas', `Araquanid @ Leftovers
- Liquidation

Grimmsnarl @ Light Clay
- Reflect

Garchomp-Mega-Z @ Garchompite Z
- Dragon Pulse

Scovillain-Mega @ Scovillainite
- Rage Powder

Arcanine-Hisui @ Focus Sash
- Extreme Speed

Gholdengo @ Life Orb
- Make It Rain`);
    // Before, "Garchomp" and "Scovillain" matched neither Mega well enough, and the two were swapped.
    const shown = ['Grimmsnarl', 'Scovillain', 'Garchomp', 'Araquanid', 'Arcanine', 'Gholdengo'];
    expect(teamFor([megas], shown, gen)?.order).toEqual([1, 3, 2, 0, 4, 5]);
  });

  it('the four brought, from their numbers standing by', () => {
    expect(broughtFrom([2, 4, 3, 1, null, null], [0, 1, 2, 3, 4, 5])).toEqual([0, 1, 2, 3]);
    expect(broughtFrom([null, 1, 2, null, 4, 3], [2, 3, 4, 0, 5, 1])).toEqual([1, 3, 4, 5]);
  });

  it('the format from the header, else the one last played', () => {
    expect(formatFor('Ranked BattlesDouble Battle', formats, 'champions-singles')).toBe('champions-doubles');
    expect(formatFor('Ranked Battles Single Battle', formats, 'champions-doubles')).toBe('champions-singles');
    expect(formatFor('', formats, 'champions-singles')).toBe('champions-singles');
  });
});
