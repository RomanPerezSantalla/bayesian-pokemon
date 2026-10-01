/**
 * Whole turns read out line by line as Pokémon Champions writes them (its English battle text:
 * btl_set and btl_std, and the ability and item pop-ups, "{Pokémon}'s {Ability}"): what gets
 * logged, in the order it happened, with nothing counted twice. Champions writes nothing between
 * turns, so a new turn is told by what starts it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../../../data/dex';
import type {FormatInfo} from '../../../data/format';
import {fuse, type Structure} from '../../../data/fuse';
import {parseTeam} from '../../../data/paste';
import {createBattle} from '../../../engine/battle';
import {computeBeliefs} from '../../../engine/posterior';
import type {Battle, SideID} from '../../../engine/types';
import type {MonSummary} from '../../../engine/worker';
import {turnActions, undo} from '../actions';
import {Narrator, type VoiceIO} from './narrator';
import {narrationPhrases, parseNarration} from './parse';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../public/data', f), 'utf8'));
const infos = data('formats.json').formats as FormatInfo[];
const doublesFmt = fuse(infos.find(f => f.id === 'champions-doubles')!, data('structure-doubles.json') as Structure, null);
const singlesFmt = fuse(infos.find(f => f.id === 'champions-singles')!, data('structure-singles.json') as Structure, null);
const gen = getGen(0);

const TEAM = parseTeam(`Charizard @ Charizardite Y
Ability: Solar Power
EVs: 2 HP / 32 SpA / 32 Spe
Timid Nature
- Heat Wave
- Weather Ball
- Solar Beam
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 10 Def / 24 SpD
Careful Nature
- Fake Out
- Knock Off
- Parting Shot
- Snarl

Garchomp @ Life Orb
Ability: Rough Skin
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Earthquake
- Rock Slide
- Dragon Claw
- Protect

Metagross @ Leftovers
Ability: Clear Body
EVs: 32 HP / 32 Atk / 2 Spe
Adamant Nature
- Meteor Mash
- Bullet Punch
- Protect
- Trick Room`);

const THEIRS = ['Salamence', 'Kingambit', 'Rillaboom', 'Clefable'];

/** A battle driven only by what's read out. */
function rig(active: Battle['live']['active'], {fmt = doublesFmt, preview = THEIRS, team = TEAM} = {}) {
  let b = createBattle(fmt, team, preview, 'turns');
  b.live.active = active;
  let cache: {n: number; mons: MonSummary[]} | null = null;
  const asked: [SideID, number][] = [];
  const io: VoiceIO = {
    gen,
    battle: () => b,
    mons: () => {
      if (!cache || cache.n !== b.events.length) cache = {n: b.events.length, mons: computeBeliefs(fmt, b).mons as unknown as MonSummary[]};
      return cache.mons;
    },
    ctx: bb => ({fmt, gen, battle: bb, oppAbility: () => undefined, oppItem: () => undefined}),
    apply: fn => {
      b = fn(b, io.ctx(b));
    },
    askSwitch: (side, slot) => asked.push([side, slot]),
  };
  const n = new Narrator(io);
  const notes: string[] = [];
  /** The game's lines, one at a time, as they come up. */
  const read = (...lines: string[]) => {
    for (const line of lines) notes.push(...n.feed(parseNarration(line, {battle: b, gen, mons: io.mons()})));
  };
  return {
    n, read, notes, asked,
    get b() {
      return b;
    },
    /** The screen's undo: the last entry taken back. */
    undo: () => {
      b = undo(b);
    },
    /** The battle put back as it was (a phrase taken back by voice). */
    restore: (to: Battle) => {
      b = to;
    },
    /** A Pokémon's stat stages now. */
    boosts: (key: string) => b.live.mons[key].boosts,
    max: (key: string) => b.live.mons[key].hp,
  };
}

const events = (text: string, active: Battle['live']['active'] = {me: [0, 1], opp: [0, 1]}) =>
  parseNarration(text, {battle: rig(active).b, gen, mons: undefined});

describe('the start of a battle', () => {
  it('Intimidate both ways (both of a side in one line) and Defiant answering it: every stage counted once', () => {
    const r = rig({me: [null, null], opp: [null, null]});
    r.read(
      'Kim sent out Salamence and Kingambit!',
      'Go! Charizard and Incineroar!',
      // The pop-ups name only the Pokémon.
      "Salamence's Intimidate",
      "Charizard and Incineroar's Attack fell!",
      "Incineroar's Intimidate",
      "The opposing Salamence and the opposing Kingambit's Attack fell!",
      "Kingambit's Defiant",
      "The opposing Kingambit's Attack rose sharply!",
    );
    expect(r.b.live.active).toEqual({me: [0, 1], opp: [0, 1]});
    expect([r.boosts('me0'), r.boosts('me1')]).toEqual([{atk: -1}, {atk: -1}]);
    expect([r.boosts('opp0'), r.boosts('opp1')]).toEqual([{atk: -1}, {atk: 1}]);
    expect(r.asked).toEqual([]);
  });

  it('an Incineroar on each side: the pop-up goes to the one it fits', () => {
    const r = rig({me: [null, null], opp: [null, null]}, {preview: ['Incineroar', 'Salamence', 'Rillaboom', 'Kingambit']});
    r.read(
      'Kim sent out Incineroar and Salamence!',
      'Go! Incineroar and Charizard!',
      "Incineroar's Intimidate",
      "Incineroar and Charizard's Attack fell!",
      "Incineroar's Intimidate",
      "The opposing Incineroar and the opposing Salamence's Attack fell!",
    );
    // Theirs is asked about when it comes in; the first pop-up answers that, mine needs no asking.
    expect(r.b.events.some(e => e.kind === 'check' && e.mon.side === 'opp' && e.mon.slot === 0 && e.seen === 'Intimidate')).toBe(true);
    expect([r.boosts('me1'), r.boosts('me0')]).toEqual([{atk: -1}, {atk: -1}]);
    expect([r.boosts('opp0'), r.boosts('opp1')]).toEqual([{atk: -1}, {atk: -1}]);
  });
});

describe('a turn read out in order', () => {
  it('Mega Evolution, priority moves, a spread move with a crit on one target, a flinch; the next turn starts with the one that flinched', () => {
    const r = rig({me: [0, 1], opp: [0, 1]});
    const zard = r.max('me0');
    r.read(
      "Charizard's Charizardite Y is reacting to Roman's Omni Ring!",
      'Charizard has Mega Evolved into Mega Charizard Y!',
      "Charizard's Drought",
      'The sunlight turned harsh!',
      'Incineroar used Fake Out!',
      'The opposing Salamence 90',
      'The opposing Kingambit used Sucker Punch!',
      `Charizard ${zard - 25}`,
      'Charizard used Heat Wave!',
      'A critical hit on the opposing Kingambit!',
      "It's super effective on the opposing Kingambit!",
      "It's not very effective on the opposing Salamence.",
      'The opposing Salamence 71',
      'The opposing Kingambit fainted!',
      "The opposing Salamence flinched and couldn't move!",
      'Kim sent out Rillaboom!',
      'The opposing Salamence used Dragon Claw!',
    );
    r.n.commit();
    const [fake, sucker, wave] = turnActions(r.b, 1);
    expect([fake.move, sucker.move, wave.move]).toEqual(['Fake Out', 'Sucker Punch', 'Heat Wave']);
    expect(fake.hits).toEqual([expect.objectContaining({target: {side: 'opp', slot: 0}, hpAfter: 90})]);
    expect(sucker.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 0}, hpAfter: zard - 25})]);
    expect(wave.hits).toEqual([
      expect.objectContaining({target: {side: 'opp', slot: 0}, hpAfter: 71, crit: false}),
      expect.objectContaining({target: {side: 'opp', slot: 1}, fainted: true, crit: true}),
    ]);
    // Salamence flinched in turn 1, so its Dragon Claw is turn 2's.
    expect(turnActions(r.b, 1)).toHaveLength(3);
    expect(turnActions(r.b, 2).map(a => a.move)).toEqual(['Dragon Claw']);
    expect(r.b.live.mons.me0.mega).toBe(true);
    expect(r.b.live.field.weather).toBe('Sun');
    // Rillaboom replaced Kingambit.
    expect(r.b.live.active.opp).toEqual([0, 2]);
  });

  it("a stat change the move makes for sure is counted once; a chance one is logged with the move, and says whom it hit", () => {
    const r = rig({me: [0, 1], opp: [0, 3]});
    const zard = r.max('me0');
    r.read(
      'The opposing Salamence used Dragon Dance!',
      "The opposing Salamence's Attack and Speed rose!",
      'The opposing Clefable used Moonblast!',
      `Charizard ${zard - 40}`,
      "Charizard's Sp. Atk fell!",
      'Incineroar used Parting Shot!',
      "The opposing Salamence's Attack and Sp. Atk fell!",
      'Incineroar went back to Roman!',
      'Go! Garchomp!',
    );
    const [dance, moonblast, shot] = turnActions(r.b, 1);
    expect(dance.move).toBe('Dragon Dance');
    expect(moonblast.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 0}, boosts: {spa: -1}})]);
    // Parting Shot's target, from whose stats fell.
    expect(shot.targetRefs).toEqual([{side: 'opp', slot: 0}]);
    expect(r.boosts('opp0')).toEqual({atk: 0, spe: 1, spa: -1});
    expect(r.boosts('me0')).toEqual({spa: -1});
    expect(r.b.live.active.me).toEqual([0, 2]);
  });

  it('the same with a pause after every line (each pause logs the move so far)', () => {
    const r = rig({me: [0, 1], opp: [0, 3]});
    const zard = r.max('me0');
    const lines = [
      'The opposing Salamence used Dragon Dance!',
      "The opposing Salamence's Attack and Speed rose!",
      'The opposing Clefable used Moonblast!',
      `Charizard ${zard - 40}`,
      "Charizard's Sp. Atk fell!",
      'Incineroar used Parting Shot!',
      "The opposing Salamence's Attack and Sp. Atk fell!",
      'Incineroar went back to Roman!',
      'Go! Garchomp!',
    ];
    for (const line of lines) {
      r.read(line);
      r.n.commit();
    }
    const [, moonblast, shot] = turnActions(r.b, 1);
    expect(turnActions(r.b, 1)).toHaveLength(3);
    expect(moonblast.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 0}, hpAfter: zard - 40, boosts: {spa: -1}})]);
    expect(shot.targetRefs).toEqual([{side: 'opp', slot: 0}]);
    expect(r.boosts('opp0')).toEqual({atk: 0, spe: 1, spa: -1});
    expect(r.boosts('me0')).toEqual({spa: -1});
    expect(r.b.live.active.me).toEqual([0, 2]);
  });

  it("Snarl on both in one line; Defiant answering it, from its pop-up or, without it, from the Attack rising sharply", () => {
    for (const popup of [true, false]) {
      const r = rig({me: [0, 1], opp: [0, 1]});
      r.read(
        'Incineroar used Snarl!',
        'The opposing Salamence 90',
        'The opposing Kingambit 85',
        "The opposing Salamence and the opposing Kingambit's Sp. Atk fell!",
        ...(popup ? ["Kingambit's Defiant"] : []),
        "The opposing Kingambit's Attack rose sharply!",
      );
      r.n.commit();
      const snarl = turnActions(r.b).at(-1)!;
      expect(snarl.hits.find(h => h.target.slot === 1)?.reaction).toBe('Defiant');
      expect(r.boosts('opp0')).toEqual({spa: -1});
      expect(r.boosts('opp1')).toEqual({spa: -1, atk: 2});
    }
  });

  it("its own chance boost (Meteor Mash); a boost nothing logged explains (Moxie) goes on after the move", () => {
    const r = rig({me: [3, 1], opp: [0, 1]});
    r.read(
      'Metagross used Meteor Mash!',
      'The opposing Salamence 60',
      "Metagross's Attack rose!",
      'The opposing Salamence used Double-Edge!',
      'Incineroar fainted!',
      "Salamence's Moxie",
      "The opposing Salamence's Attack rose!",
    );
    r.n.commit();
    const [mash, edge] = turnActions(r.b);
    expect(mash.actorBoosts).toEqual({atk: 1});
    expect(r.boosts('me3')).toEqual({atk: 1});
    // Moxie went off after the hit: not in the state the hit is judged by.
    expect(edge.before.mons.opp0.boosts.atk ?? 0).toBe(0);
    expect(r.boosts('opp0')).toEqual({atk: 1});
    expect(edge.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 1}, fainted: true})]);
  });

  it('a Sitrus Berry: its pop-up, then the HP it settled on once healed', () => {
    const r = rig({me: [0, 1], opp: [0, 1]});
    const settled = Math.floor(r.max('me1') * 0.6);
    r.read(
      'The opposing Salamence used Double-Edge!',
      "Incineroar's Sitrus Berry",
      'Incineroar had its HP restored.',
      `Incineroar ${settled}`,
    );
    r.n.commit();
    const hit = turnActions(r.b).at(-1)!.hits[0];
    expect(hit).toMatchObject({target: {side: 'me', slot: 1}, hpAfter: settled, healed: true, triggers: ['sitrus']});
    expect(r.b.live.mons.me1).toMatchObject({hp: settled, itemGone: true});
  });

  it("a resist berry: \"Occa Berry weakened Heat Wave's power!\" is the target's, not the attacker's", () => {
    const r = rig({me: [0, 1], opp: [2, 3]});
    r.read('Charizard used Heat Wave!', 'The opposing Rillaboom 55', "Occa Berry weakened Heat Wave's power!", 'The opposing Clefable 70');
    r.n.commit();
    const wave = turnActions(r.b).at(-1)!;
    expect(wave.hits.find(h => h.target.slot === 2)?.triggers).toEqual(['berry']);
    expect(wave.hits.find(h => h.target.slot === 3)?.triggers).toEqual([]);
  });

  it("a Pokémon that couldn't move, a status given and one that ended", () => {
    const r = rig({me: [0, 1], opp: [0, 3]});
    r.read(
      'The opposing Clefable used Thunder Wave!',
      'Incineroar is paralyzed, so it may be unable to move!',
      "Incineroar couldn't move because it's paralyzed!",
      'The opposing Salamence used Draco Meteor!',
      `Charizard ${r.max('me0') - 60}`,
      "The opposing Salamence's Sp. Atk harshly fell!",
    );
    r.n.commit();
    const [wave, draco] = turnActions(r.b);
    expect(wave.targetRefs).toEqual([{side: 'me', slot: 1}]);
    expect(r.b.live.mons.me1.status).toBe('par');
    // The full paralysis is no move, and gave Draco Meteor no status.
    expect(turnActions(r.b)).toHaveLength(2);
    expect(draco.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 0}, status: undefined})]);
    expect(r.boosts('opp0')).toEqual({spa: -2});
    r.read('The opposing Salamence used Rest!', 'The opposing Salamence slept and restored its HP!');
    r.read('The opposing Salamence is fast asleep.', 'The opposing Salamence woke up!');
    expect(r.b.live.mons.opp0.status).toBe('');
  });

  it('a move that failed, the number of hits, an item knocked off, one that failed to affect', () => {
    const r = rig({me: [1, 2], opp: [0, 2]});
    const chomp = r.max('me2');
    r.read(
      'Incineroar used Fake Out!',
      'But it failed!',
      'The opposing Rillaboom used Bullet Seed!',
      `Garchomp ${chomp - 30}`,
      'The Pokémon was hit 4 times!',
      // Incineroar moving again: turn 2.
      'Incineroar used Knock Off!',
      'The opposing Salamence 70',
      "Incineroar knocked off the opposing Salamence's Life Orb!",
      'The opposing Rillaboom used Spore!',
      'But it failed to affect Garchomp!',
    );
    r.n.commit();
    const [fake, seed] = turnActions(r.b, 1);
    const [knock, spore] = turnActions(r.b, 2);
    expect(fake).toMatchObject({move: 'Fake Out', failed: true, hits: []});
    expect(seed).toMatchObject({move: 'Bullet Seed', hitCount: 4});
    expect(seed.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 2}, hpAfter: chomp - 30})]);
    expect(knock.hits).toEqual([expect.objectContaining({target: {side: 'opp', slot: 0}, hpAfter: 70})]);
    expect(r.b.events.some(e => e.kind === 'reveal' && e.what === 'item' && e.value === 'Life Orb' && e.mon.slot === 0)).toBe(true);
    expect(r.b.live.mons.opp0.itemGone).toBe(true);
    // Garchomp stayed awake: no target to put to sleep.
    expect(spore.targetRefs).toEqual([]);
    expect(r.b.live.mons.me2.status).toBe('');
  });

  it("the end of the turn: its first line ends the turn, and HP read then is where it's at, not part of a move", () => {
    const r = rig({me: [0, 1], opp: [0, 2]});
    r.b.live.field = {...r.b.live.field, weather: 'Sand', me: {...r.b.live.field.me, tailwind: true}, turns: {weather: 1, 'me.tailwind': 1}};
    r.read(
      'The opposing Salamence used Protect!',
      'The opposing Salamence protected itself!',
      'Charizard used Heat Wave!',
      'The opposing Salamence protected itself!',
      'The opposing Rillaboom 40',
      'The sandstorm subsided.',
      // Leftovers shows as a pop-up.
      "Rillaboom's Leftovers",
      'The opposing Rillaboom 46',
      "Your side's tailwind petered out!",
      'end turn',
    );
    const [protect, wave] = turnActions(r.b, 1);
    expect(protect.move).toBe('Protect');
    // Salamence protected itself from Heat Wave: only Rillaboom was hit.
    expect(wave.hits).toEqual([expect.objectContaining({target: {side: 'opp', slot: 2}, hpAfter: 40})]);
    expect(r.b.turn).toBe(2);
    expect(r.b.live.mons.opp2).toMatchObject({hp: 46, hpEstimated: false});
    expect(r.b.events.some(e => e.kind === 'reveal' && e.what === 'item' && e.value === 'Leftovers')).toBe(true);
    expect(r.b.live.field.weather).toBeUndefined();
    expect(r.b.live.field.me.tailwind).toBe(false);
  });

  it('Leftovers alone tells the turn is over; so does a switch chosen for the next one', () => {
    const r = rig({me: [3, 1], opp: [2, 3]});
    r.read('Metagross used Bullet Punch!', 'The opposing Clefable 80', "Metagross's Leftovers", 'Metagross 190');
    expect(r.b.turn).toBe(2);
    r.read('The opposing Rillaboom used Wood Hammer!', 'Metagross 150', 'Incineroar, come back!', 'Go! Garchomp!');
    expect(r.b.turn).toBe(3);
    // The switch is turn 3's, made before its moves.
    expect(r.b.events.at(-1)).toMatchObject({kind: 'switch', turn: 3, slotIn: 2});
  });

  it('the field as the game describes it: rooms, a tailwind and weather put right, turned off at the end', () => {
    const r = rig({me: [0, 3], opp: [0, 3]});
    r.read(
      'The opposing Salamence used Tailwind!',
      'A tailwind started blowing on the opposing side!',
      'Metagross used Trick Room!',
      'Metagross twisted the dimensions!',
      // Nobody logged Drizzle: the line alone says it's raining now.
      'It started to rain!',
    );
    expect(r.b.live.field).toMatchObject({trickRoom: true, weather: 'Rain', opp: expect.objectContaining({tailwind: true})});
    expect(r.b.live.field.turns).toMatchObject({trickRoom: 5, weather: 5, 'opp.tailwind': 4});
    r.read('The twisted dimensions returned to normal!', "The opposing side's tailwind petered out!");
    expect(r.b.turn).toBe(2);
    expect(r.b.live.field).toMatchObject({trickRoom: false, weather: 'Rain', opp: expect.objectContaining({tailwind: false})});
  });

  it('entry hazards laid and cleared, said with whose side', () => {
    const r = rig({me: [0, 1], opp: [0, 1]});
    r.read(
      'Pointed stones float in the air on your side!',
      'Spikes were scattered on the ground all around the opposing side!',
      'Toxic spikes were scattered on the ground all around your side!',
      'A sticky web has been laid out on the ground on the opposing side!',
    );
    expect(r.b.live.field.me).toMatchObject({stealthRock: true, toxicSpikes: 1});
    expect(r.b.live.field.opp).toMatchObject({spikes: 1, stickyWeb: true});
    r.read('The pointed stones disappeared from your side!', 'The sticky web has disappeared from the ground on the opposing side!');
    expect(r.b.live.field.me.stealthRock).toBe(false);
    expect(r.b.live.field.opp.stickyWeb).toBe(false);
  });

  it('White Herb after Intimidate answers what the game showed', () => {
    const r = rig({me: [0, null], opp: [0, 1]}, {preview: ['Salamence', 'Kingambit', 'Rillaboom', 'Clefable']});
    const herb = computeBeliefs(doublesFmt, r.b).mons[1]?.items.some(i => i.name === 'White Herb' && i.p > 0);
    r.read('Go! Incineroar!', "Incineroar's Intimidate", "The opposing Salamence and the opposing Kingambit's Attack fell!");
    r.read("The opposing Kingambit returned its stats to normal using its White Herb!");
    expect(r.boosts('opp1')).toEqual(herb ? {atk: 0} : {});
    expect(r.b.live.mons.opp1.itemGone).toBe(true);
  });
});

describe('as the recogniser writes it', () => {
  it('lower case, no punctuation, "Sp. Atk" said out loud, lines run together', () => {
    const r = rig({me: [0, 1], opp: [0, 3]});
    r.read(
      'the opposing salamence used dragon dance the opposing salamences attack and speed rose',
      'the opposing clefable used moonblast charizard 100 charizards special attack fell',
      'the opposing clefable used moonblast incineroar 150 its not very effective',
    );
    r.n.commit();
    expect(turnActions(r.b, 1).map(a => a.move)).toEqual(['Dragon Dance', 'Moonblast']);
    expect(r.boosts('opp0')).toEqual({atk: 1, spe: 1});
    expect(r.boosts('me0')).toEqual({spa: -1});
    // Clefable moving again started turn 2.
    expect(turnActions(r.b, 2)[0].hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 1}, hpAfter: 150})]);
  });

  it("the game's lines that aren't about a move leave the move alone", () => {
    const kinds = (text: string) => events(text).map(e => e.kind);
    // Not "Charizard used Protect": it couldn't use it.
    expect(kinds('charizard cant use protect after the taunt')).toEqual(['cant']);
    // Not a move called Knock Off used again.
    expect(kinds('incineroar knocked off the opposing salamences life orb')).toEqual(['item']);
    // "Hit 3 times" is no HP of 3; the perish count is no HP either.
    expect(kinds('the pokemon was hit 3 times')).toEqual(['hits']);
    expect(kinds('the opposing salamences perish count fell to 2')).toEqual(['residual']);
    // "Your side's tailwind", not a Pokémon's.
    expect(kinds('your sides tailwind petered out')).toEqual(['field']);
    // Paralysis stopping a move isn't paralysis being given.
    expect(kinds('charizard couldnt move because its paralyzed')).toEqual(['cant']);
    expect(kinds('charizard is paralyzed so it may be unable to move')).toEqual(['status']);
    // Rapid Spin's "…blew away Stealth Rock!" is no Stealth Rock used; nor is a disabled move.
    expect(events('incineroar blew away stealth rock')).toEqual([{kind: 'field', news: {what: 'stealthRock', value: false, side: 'me'}}]);
    expect(kinds('the opposing salamences draco meteor was disabled')).toEqual([]);
    expect(kinds('the opposing salamence took the future sight attack')).toEqual([]);
    // Quick Draw's own line.
    expect(events('quick draw made the opposing salamence move faster')).toEqual([
      {kind: 'ability', mon: {side: 'opp', slot: 0}, ability: 'Quick Draw'},
    ]);
    // A hit through protection is still a hit.
    expect(kinds('it broke through the opposing salamences protection')).toEqual([]);
    // Lines that aren't a move used, though a move's name sounds or spells like a word in them.
    for (const line of [
      'the opposing salamence has mega evolved into mega salamence', 'the opposing salamence put in a substitute',
      'the opposing salamence ended its encore', 'the opposing salamence caused an uproar', 'the opposing salamence stockpiled 1',
      'the opposing salamence already has a substitute', 'the opposing salamence has no moves left that it can use',
    ]) expect(kinds(line).filter(k => k === 'use' || k === 'hp'), line).toEqual([]);
    // No HP in these: Perish Song, Fairy Lock, Forewarn.
    expect(kinds('all pokemon that heard the song will faint in three turns')).toEqual([]);
    expect(kinds('no one will be able to leave the battlefield during the next turn')).toEqual([]);
    expect(kinds('heat wave was revealed to be one of the moves that the opposing salamence knows')).toEqual([]);
    // It didn't take; Magnet Rise isn't Levitate; Quick Claw going off isn't the turn order.
    expect(kinds('the opposing salamence cannot be poisoned')).toEqual(['miss']);
    expect(kinds('the opposing salamence is already asleep')).toEqual(['miss']);
    expect(kinds('the opposing salamence levitated with electromagnetism')).toEqual([]);
    expect(events('the opposing salamence can act faster than normal thanks to its quick claw')).toEqual([
      {kind: 'item', mon: {side: 'opp', slot: 0}, item: 'Quick Claw', gone: false},
    ]);
    // Two on one line.
    expect(events('its super effective on the opposing salamence and kingambit')).toEqual([
      {kind: 'effective', mon: {side: 'opp', slot: 0}}, {kind: 'effective', mon: {side: 'opp', slot: 1}},
    ]);
    // "Come back" is about the one named before it, and a switch chosen for the turn; "Go!" the one after.
    expect(events('charizard come back go garchomp')).toEqual([
      {kind: 'withdraw', mon: {side: 'me', slot: 0}, voluntary: true}, {kind: 'sendOut', mon: {side: 'me', slot: 2}},
    ]);
    expect(events('incineroar went back to roman')).toEqual([{kind: 'withdraw', mon: {side: 'me', slot: 1}}]);
  });
});

describe('Singles', () => {
  it('turns told apart by who moves again, then a switch into Stealth Rock', () => {
    const r = rig({me: [0], opp: [0]}, {fmt: singlesFmt, preview: ['Garchomp', 'Kingambit', 'Clefable', 'Salamence']});
    r.read(
      'The opposing Garchomp used Stealth Rock!',
      'Pointed stones float in the air on your side!',
      'Charizard used Heat Wave!',
      'The opposing Garchomp 70',
      'The opposing Garchomp used Earthquake!',
      "It doesn't affect Charizard...",
    );
    r.n.commit();
    const [rock, wave] = turnActions(r.b, 1);
    expect(rock.move).toBe('Stealth Rock');
    expect(wave.hits).toEqual([expect.objectContaining({target: {side: 'opp', slot: 0}, hpAfter: 70})]);
    const [quake] = turnActions(r.b, 2);
    expect(quake.hits).toEqual([expect.objectContaining({target: {side: 'me', slot: 0}, noEffect: true})]);
    expect(r.b.live.field.me.stealthRock).toBe(true);
    // Incineroar is Fire: Stealth Rock takes a quarter, as the engine works out; read, it only confirms it.
    const max = r.max('me1');
    r.read('Charizard, come back!', 'Go! Incineroar!', 'Pointed stones dug into Incineroar!', `Incineroar ${max - Math.floor(max / 4)}`);
    expect(r.b.turn).toBe(3);
    expect(r.b.live.active.me).toEqual([1]);
    expect(r.b.live.mons.me1.hp).toBe(max - Math.floor(max / 4));
    expect(r.asked).toEqual([]);
  });
});

describe('the first battle narrated on a PC (29 Sep): your Mega Lopunny and Dragonite against Froslass and Bellibolt', () => {
  const MINE = parseTeam(`Sneasler @ Psychic Seed
Ability: Unburden
- Close Combat

Ceruledge @ Focus Sash
Ability: Flash Fire
- Bitter Blade

Lopunny @ Lopunnite
Ability: Limber
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Fake Out
- Close Combat
- Protect

Indeedee-F @ Colbur Berry
Ability: Psychic Surge
- Follow Me

Dragonite @ Life Orb
Ability: Inner Focus
EVs: 2 HP / 32 Atk / 32 Spe
Adamant Nature
- Dragon Dance
- Stomping Tantrum
- Extreme Speed
- Protect

Gardevoir @ Gardevoirite
Ability: Trace
- Moonblast`);
  const OPP = ['Charizard', 'Goodra-Hisui', 'Froslass', 'Annihilape', 'Bellibolt', 'Incineroar'];
  const start = () => rig({me: [2, 4], opp: [2, 4]}, {team: MINE, preview: OPP});
  const moves = (b: Battle) => b.events.filter(e => e.kind === 'action').map(e => (e.kind === 'action' ? `${e.turn} ${e.move}` : ''));

  it('the turns stay in place: turn 1 taken back and read again, the switch, Parabolic Charge, then Fake Out starting turn 3', () => {
    const r = start();
    // As the voice model heard it (the Mega, said plainly), with the target named straight after the move.
    r.read('Lopunny mega.', 'Froslass Protect Lopunny Fake Out Bellibolt.', 'Dragonite Dragon Dance.', 'Bellibolt flinched.');
    expect(r.b.live.mons.me2.mega).toBe(true);
    expect(turnActions(r.b).find(a => a.move === 'Fake Out')?.hits.map(h => h.target)).toEqual([{side: 'opp', slot: 4}]);
    // Taken back on the screen, then read again: the flinch heard before goes with it.
    r.undo();
    r.undo();
    r.undo();
    r.read('Froslass Protect.', 'Lopunny Fake Out Bellibolt, eighty four percent.', 'Dragonite Dragon Dance?', 'Bellibolt flinched.');
    expect(r.b.turn).toBe(1);
    expect(moves(r.b)).toEqual(['1 Protect', '1 Fake Out', '1 Dragon Dance']);
    // A switch chosen for the turn: turn 2. Scrappy and Inner Focus stop the Intimidate.
    r.read('Withdrew Froslass sent out Incineroar.', 'Intimidate from Incineroar?', "Lopunny 's attack was not lowered.", 'Dragonite attack was not lowered.');
    expect(r.b.turn).toBe(2);
    expect([r.b.live.mons.me2.boosts.atk ?? 0, r.b.live.mons.me4.boosts.atk ?? 0]).toEqual([0, 1]);
    r.read('Lopunny Close Combat Incineroar forty percent.', 'Dragonite Stomping Tantrum.', 'Bellibolt one percent?', 'Bellibolt Sitrus Berry?',
      'Bellibolt used a Parabolic Charge.', 'Lopunny forty nine HP Dragonite ninety five HP.', 'Incineroar thirteen.');
    expect(r.b.turn).toBe(2);
    // Incineroar came in this turn and Fake Out goes before anything ordinary: the next turn.
    r.read('Incineroar Fake Out Dragonite.', 'Lopunny Close Combat.');
    // Close Combat's target wasn't said: one of the two, which the note says rather than both hit.
    expect(r.n.commit()).toMatch(/Close Combat → Incineroar \/ Bellibolt \(not said\): HP skipped$/);
    expect(moves(r.b)).toEqual([
      '1 Protect', '1 Fake Out', '1 Dragon Dance', '2 Close Combat', '2 Stomping Tantrum', '2 Parabolic Charge', '3 Fake Out', '3 Close Combat',
    ]);
    const fakeOut = r.b.events.find(e => e.kind === 'action' && e.turn === 3 && e.move === 'Fake Out');
    expect(fakeOut?.kind === 'action' && fakeOut.hits.map(h => h.target)).toEqual([{side: 'me', slot: 4}]);
  });

  it("\"…was not lowered\": the drop logged goes back, and yours with a Mega that would have stopped it is asked about", () => {
    const r = start();
    r.read('Froslass Protect.', 'Lopunny Fake Out Bellibolt, eighty four percent.', 'Dragonite Dragon Dance.', 'Bellibolt flinched.');
    // The Mega wasn't said, so Lopunny is logged with Limber, which doesn't stop Intimidate.
    r.read('The opposing trainer withdrew Froslass!', 'The opposing trainer sent out Incineroar!', "The opposing Incineroar's Intimidate");
    expect(r.b.live.mons.me2.boosts.atk).toBe(-1);
    r.read("Lopunny's Attack was not lowered!", "Dragonite's Attack was not lowered!");
    expect(r.b.live.mons.me2.boosts.atk ?? 0).toBe(0);
    expect(r.notes.slice(-2)).toEqual([
      'Lopunny: Atk not lowered: put back (has it Mega Evolved? Scrappy would stop it)',
      'Dragonite: Atk not lowered ✓',
    ]);
  });

  it('listens out for their likely items, not the "(other)" row ("other" is said all the time)', () => {
    const b = start().b;
    const phrases = narrationPhrases({battle: b, gen, mons: computeBeliefs(doublesFmt, b).mons as unknown as MonSummary[]});
    expect(phrases).toEqual(expect.arrayContaining(['Froslassite', 'Mega Evolved']));
    expect(phrases.filter(p => p.startsWith('('))).toEqual([]);
  });

  it('a Pokémon named straight after a move aimed at one is its target, unless it moves next', () => {
    const env = {battle: start().b, gen, mons: undefined};
    const kinds = (line: string) => parseNarration(line, env).map(e => `${e.kind}${'mon' in e && e.mon ? ` ${e.mon.side}${e.mon.slot}` : ''}`);
    expect(kinds('Lopunny Fake Out Bellibolt')).toEqual(['use', 'target opp4']);
    expect(kinds('Incineroar Fake Out Dragonite')).toEqual(['use', 'target me4']);
    expect(kinds('Lopunny Fake Out Froslass Protect')).toEqual(['use', 'use']);
    // Dragon Dance is aimed at no one: a name after it is the next line's.
    expect(kinds('Dragonite Dragon Dance Bellibolt flinched')).toEqual(['use', 'cant opp4']);
  });

  it('Mega Evolution said plainly: "Lopunny mega", "mega Lopunny", "Lopunny Mega Evolved"; not Mega Kick', () => {
    const b = start().b;
    const env = {battle: b, gen, mons: undefined};
    for (const line of ['Lopunny mega.', 'mega Lopunny', 'Lopunny Mega Evolved', 'Lopunny has Mega Evolved into Mega Lopunny!']) {
      expect(parseNarration(line, env).filter(e => e.kind === 'mega'), line).toEqual([{kind: 'mega', mon: {side: 'me', slot: 2}, suffix: undefined}]);
    }
    expect(parseNarration('The opposing Froslass used Mega Kick', env).map(e => e.kind)).not.toContain('mega');
  });
});

describe('a phrase taken back ("scratch that", "no, it was…": the language model\'s undo)', () => {
  it('the narrator goes back to what it knew before it, the battle to what it was', () => {
    const r = rig({me: [0, 1], opp: [0, 1]});
    r.read('Charizard used Heat Wave!');
    const battle = r.b;
    const saved = r.n.save();
    const was = r.n.describe();
    // The next move logs the first; then it's taken back, with the move it logged.
    r.read('The opposing Salamence used Draco Meteor on Charizard!', 'Charizard 40');
    expect(r.b.events.length).toBeGreaterThan(battle.events.length);
    r.restore(battle);
    r.n.load(saved);
    expect(r.b.events).toEqual(battle.events);
    expect(r.n.describe()).toBe(was);
    // And it carries on from there as if the phrase had never been heard.
    r.read('The opposing Salamence used Dragon Claw on Charizard!');
    expect(r.b.events.at(-1)).toMatchObject({kind: 'action', move: 'Heat Wave'});
    expect(r.n.describe()).toMatch(/Dragon Claw/);
  });
});

describe("an HP said once another move has come (the move it's about can't take it any more)", () => {
  it('after a move logged since: where it is at now', () => {
    const r = rig({me: [1, 3], opp: [0, 1]});
    r.read('Incineroar used Knock Off on the opposing Salamence!', 'Metagross used Trick Room!');
    r.read('The opposing Salamence 60');
    r.n.commit();
    expect(r.notes).toContain('Salamence 60%');
    expect(r.b.live.mons.opp0.hp).toBe(60);
  });

  it('while another move is open: where it is at, once that move is logged', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('Incineroar used Knock Off on the opposing Salamence!', 'Garchomp used Dragon Claw on the opposing Kingambit!');
    r.read('The opposing Salamence 60', 'The opposing Kingambit 70');
    r.n.commit();
    expect(r.b.live.mons.opp0.hp).toBe(60);
    expect(r.b.live.mons.opp1.hp).toBe(70);
  });
});

describe('a bare HP during a move that hit several', () => {
  it("isn't put over one whose HP is in already (a name misheard): whose is asked", () => {
    const r = rig({me: [2, 1], opp: [0, 1]});
    r.read('Garchomp used Rock Slide!', 'The opposing Salamence 49', '8');
    expect(r.notes).toContain('HP 8: whose? Say the name with it');
    r.read('The opposing Kingambit 70');
    r.n.commit();
    expect([r.b.live.mons.opp0.hp, r.b.live.mons.opp1.hp]).toEqual([49, 70]);
  });
});

describe("another Pokémon's HP while a single-target move is open", () => {
  it("isn't a second target once the move's target is said: it's where that one is at", () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('Incineroar used Knock Off on the opposing Salamence!', 'The opposing Salamence 60', 'The opposing Kingambit 70');
    r.n.commit();
    const knock = r.b.events.filter(e => e.kind === 'action').at(-1);
    expect(knock?.kind === 'action' && knock.hits.map(h => [h.target.slot, h.hpAfter])).toEqual([[0, 60]]);
    expect(r.b.live.mons.opp1.hp).toBe(70);
  });
});

describe('a Sitrus Berry and the HP said about it', () => {
  it('an HP under a quarter is from before the berry (it heals a quarter), whichever came first', () => {
    const r = rig({me: [2, 1], opp: [0, 1]});
    r.read('Garchomp used Dragon Claw on the opposing Kingambit!', "The opposing Kingambit's Sitrus Berry", 'The opposing Kingambit 1');
    r.n.commit();
    const claw = r.b.events.filter(e => e.kind === 'action').at(-1);
    expect(claw?.kind === 'action' && claw.hits[0]).toMatchObject({hpAfter: 1, healed: false});
    expect(r.b.live.mons.opp1.hp).toBe(26);
  });

  it('one over a quarter, said after the berry, is where it settled once healed', () => {
    const r = rig({me: [2, 1], opp: [0, 1]});
    r.read('Garchomp used Dragon Claw on the opposing Kingambit!', "The opposing Kingambit's Sitrus Berry", 'The opposing Kingambit 40');
    r.n.commit();
    expect(r.b.live.mons.opp1.hp).toBe(40);
  });
});

describe('a turn said out of order (30 Sep): what priority settles, and nothing about Speed from the rest', () => {
  it('Fake Out said after an ordinary attack: this turn, first, its place not taken as the order', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Kingambit used Kowtow Cleave on Garchomp!', 'Garchomp 100');
    r.read('Incineroar used Fake Out on the opposing Salamence!', 'The opposing Salamence 90');
    r.n.commit();
    expect(r.b.turn).toBe(1);
    expect(turnActions(r.b).map(a => [a.move, a.ordered])).toEqual([['Fake Out', false], ['Kowtow Cleave', true]]);
  });

  it('into a Protect made this turn: nothing happened to it, and no HP is waited for', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Salamence used Protect!', 'Incineroar used Fake Out on the opposing Salamence!');
    expect(r.n.commit()).toMatch(/Fake Out → Salamence protected$/);
    expect(turnActions(r.b).find(a => a.move === 'Fake Out')?.hits).toEqual([]);
  });

  it('a Mega with an X and a Y, neither said: logged as Mega, not as the likelier one', () => {
    const forme = (line: string) => {
      const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Charizard', 'Kingambit', 'Rillaboom', 'Clefable']});
      r.read(line);
      const e = r.b.events.find(x => x.kind === 'reveal' && x.what === 'forme');
      return e?.kind === 'reveal' ? e.value : undefined;
    };
    expect(forme('The opposing Charizard has Mega Evolved into Mega Charizard!')).toBe('Charizard-Mega');
    expect(forme('The opposing Charizard has Mega Evolved into Mega Charizard Y!')).toBe('Charizard-Mega-Y');
  });
});

describe('a move told again (30 Sep): the one there is, not a second move, nor a new turn', () => {
  it('said twice, three times', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Salamence used Protect!', 'The opposing Salamence used Protect!');
    expect(r.notes.at(-1)).toMatch(/Protect: logged already$/);
    r.read('The opposing Salamence used Protect!');
    expect(r.b.turn).toBe(1);
    expect(turnActions(r.b).map(a => a.move)).toEqual(['Protect']);
  });

  it('brought up again as a phrase goes on, after the move it was about', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Salamence used Protect!', 'Incineroar used Fake Out on the opposing Salamence!');
    r.n.commit();
    // "Fake Out into Salamence, but Salamence had Protect": both logged already.
    r.n.feed([
      {kind: 'use', actor: {side: 'me', slot: 1}, move: 'Fake Out'}, {kind: 'target', mon: {side: 'opp', slot: 0}},
      {kind: 'use', actor: {side: 'opp', slot: 0}, move: 'Protect'},
    ]);
    r.n.commit();
    expect(r.b.turn).toBe(1);
    expect(turnActions(r.b).map(a => a.move)).toEqual(['Protect', 'Fake Out']);
  });

  it('the same move into another, or with another HP in the same phrase: a second one, the next turn', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Kingambit used Kowtow Cleave on Garchomp! Garchomp 100');
    r.n.commit();
    r.read('The opposing Kingambit used Kowtow Cleave on Garchomp! Garchomp 40');
    r.n.commit();
    expect(r.b.turn).toBe(2);
    expect(turnActions(r.b, 2).map(a => a.hits.map(h => h.hpAfter))).toEqual([[40]]);
    r.read('The opposing Kingambit used Kowtow Cleave on Incineroar!');
    r.n.commit();
    expect(r.b.turn).toBe(3);
  });
});
