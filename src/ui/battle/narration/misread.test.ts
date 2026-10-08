import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {allSpecies, getGen} from '../../../data/dex';
import type {FormatInfo} from '../../../data/format';
import {fuse, type Structure} from '../../../data/fuse';
import {parseTeam} from '../../../data/paste';
import {createBattle} from '../../../engine/battle';
import type {Battle} from '../../../engine/types';
import {misread, putRight} from './misread';
import {parseNarration} from './parse';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../public/data', f), 'utf8'));
const fmt = fuse((data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!, data('structure-doubles.json') as Structure, null);
const gen = getGen(0);
const every = allSpecies(gen);

const TEAM = parseTeam(`Raichu @ Raichunite X
- Fake Out

Espathra @ Electric Seed
- Lumina Crash`);

/** Their six as read at team preview, Raichu taken for Ampharos (same type, same colours). */
function battle(): Battle {
  const b = createBattle(fmt, TEAM, ['Ceruledge', 'Ampharos', 'Sylveon', 'Kingambit', 'Rillaboom', 'Gengar'], 'vs Ceruledge, Ampharos, Sylveon');
  return {...b, oppRead: [
    {alts: ['Skeledirge'], sure: true}, {alts: ['Raichu', 'Jolteon'], sure: false}, {alts: ['Slurpuff'], sure: true},
    {alts: [], sure: true}, {alts: ['Gogoat'], sure: true}, {alts: [], sure: true},
  ]};
}

describe("their six put right by the battle's text", () => {
  it('one named that was read as another: the slot that had it as likely', () => {
    expect(misread(battle(), gen, every, 'The opposing Raichu used Thunderbolt!')).toEqual({slot: 1, name: 'Raichu'});
    expect(misread(battle(), gen, every, 'mac sent out Raichu and Gengar!')).toEqual({slot: 1, name: 'Raichu'});
  });

  it('one of their six named: nothing to put right', () => {
    expect(misread(battle(), gen, every, 'The opposing Gengar used Shadow Ball!')).toBeNull();
    expect(misread(battle(), gen, every, 'mac sent out Kingambit and Gengar!')).toBeNull();
    // A regional forme or a gender's forme goes by its species' name in the text.
    const fish = {...battle(), oppPreview: ['Basculegion-F', 'Ninetales-Alola', 'Sylveon', 'Kingambit', 'Rillaboom', 'Gengar']};
    expect(misread(fish, gen, every, 'The opposing Basculegion used Last Respects!')).toBeNull();
    expect(misread(fish, gen, every, 'The opposing Ninetales used Blizzard!')).toBeNull();
    // Words that name none clearly, and yours.
    expect(misread(battle(), gen, every, 'Light Screen made the opposing team stronger against special moves!')).toBeNull();
    expect(misread(battle(), gen, every, 'Raichu used Fake Out!')).toBeNull();
  });

  it('else one of its types the battle hasn not shown, else one not read surely', () => {
    // Pikachu wasn't a likely one for any: Ampharos is Electric too.
    expect(misread(battle(), gen, every, 'The opposing Pikachu used Fake Out!')).toEqual({slot: 1, name: 'Pikachu'});
    // Mimikyu fits none's types: the one not read surely.
    expect(misread(battle(), gen, every, 'The opposing Mimikyu used Shadow Sneak!')).toEqual({slot: 1, name: 'Mimikyu'});
  });

  it('never one the battle has shown', () => {
    const b = battle();
    const out = {...b, live: {...b.live, active: {...b.live.active, opp: [1, 5]}}};
    expect(misread(out, gen, every, 'The opposing Raichu used Thunderbolt!')?.slot).not.toBe(1);
  });

  it('fewer than six known (team preview missed): one more of theirs, added', () => {
    const b = createBattle(fmt, TEAM, ['Garchomp', 'Gholdengo'], 'vs Garchomp, Gholdengo');
    expect(misread(b, gen, every, 'The opposing Volcarona used Heat Wave!')).toEqual({slot: 2, name: 'Volcarona'});
    const more = putRight(b, 2, 'Volcarona');
    expect(more.oppPreview).toEqual(['Garchomp', 'Gholdengo', 'Volcarona']);
    expect(more.live.mons.opp2?.hp).toBe(100);
    expect(more.label).toBe('vs Garchomp, Gholdengo, Volcarona');
  });

  it('by the name the game writes: "Floette" is Floette-Eternal (the calc lists it with no base species), 5 Oct', () => {
    const b = createBattle(fmt, TEAM, ['Rillaboom', 'Incineroar', 'Alcremie', 'Gholdengo', 'Sneasler', 'Dragonite'], 'vs Rillaboom');
    const read = {...b, oppRead: [0, 1, 2, 3, 4, 5].map(k => ({alts: k === 2 ? ['Sylveon', 'Clefable', 'Floette-Eternal'] : [], sure: true}))};
    expect(misread(read, gen, every, 'Kirbaevski sent out Floette!')).toEqual({slot: 2, name: 'Floette-Eternal'});
    expect(misread(read, gen, every, 'The opposing Floette used Moonblast!')).toEqual({slot: 2, name: 'Floette-Eternal'});
    // Not read as possibly it: still the species, not the name as written.
    const plain = {...b, oppRead: undefined};
    expect(misread(plain, gen, every, 'The opposing Floette used Moonblast!')?.name).toBe('Floette-Eternal');
    // Among the six already: nothing to put right.
    const right = createBattle(fmt, TEAM, ['Rillaboom', 'Incineroar', 'Floette-Eternal', 'Gholdengo', 'Sneasler', 'Dragonite'], 'x');
    expect(misread(right, gen, every, 'The opposing Floette has Mega Evolved into Mega Floette!')).toBeNull();
  });

  it('put right, the line reads as about it', () => {
    const b = putRight(battle(), 1, 'Raichu');
    expect(b.oppPreview[1]).toBe('Raichu');
    expect(b.label).toBe('vs Ceruledge, Raichu, Sylveon');
    const events = parseNarration('The opposing Raichu used Thunderbolt!', {battle: b, gen, mons: undefined});
    expect(JSON.stringify(events)).toContain('"side":"opp","slot":1');
  });
});
