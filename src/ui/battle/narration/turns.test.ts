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
import type {ActionEvent, Battle, SideID} from '../../../engine/types';
import type {MonSummary} from '../../../engine/worker';
import {hitState} from '../../../engine/likelihood';
import {maxHPOf} from '../../../engine/state';
import {turnActions, undo} from '../actions';
import {readingEvents} from '../ScreenFeed';
import {Narrator, type NarratorIO} from './narrator';
import {parseNarration} from './parse';

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
function rig(active: Battle['live']['active'], {fmt = doublesFmt, preview = THEIRS, team = TEAM, beliefs = true} = {}) {
  let b = createBattle(fmt, team, preview, 'turns');
  b.live.active = active;
  let cache: {n: number; mons: MonSummary[]} | null = null;
  const asked: [SideID, number][] = [];
  const io: NarratorIO = {
    gen,
    battle: () => b,
    mons: () => {
      // The beliefs not in yet (worked out off the main thread, they can lag a line or two behind).
      if (!beliefs) return undefined;
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
    /** The battle put back as it was (a phrase taken back). */
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

describe('written loosely', () => {
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
    // The Mega written plainly, with the target named straight after the move.
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

describe('a turn as the game writes it', () => {
  it('a Protect read after ordinary moves (an Encore made it so, 2 Oct): in the order read, and "But it failed!" its own', () => {
    const r = rig({me: [1, 2], opp: [0, 3]});
    r.read('The opposing Salamence used Dragon Claw on Garchomp!', 'Garchomp 80', 'The opposing Clefable used Encore!', 'Garchomp must do an encore!',
      'Garchomp used Protect!', 'But it failed!');
    r.n.commit();
    expect(r.b.turn).toBe(1);
    // The Protect goes at the priority of the move chosen before the Encore: its place says nothing of Speed.
    expect(turnActions(r.b).map(a => [a.move, a.ordered, !!a.failed])).toEqual([['Dragon Claw', true, false], ['Encore', true, false], ['Protect', false, true]]);
    expect(turnActions(r.b).find(a => a.move === 'Encore')?.targetRefs).toEqual([{side: 'me', slot: 2}]);
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

describe('the game\'s text as read off the screen (2 Oct)', () => {
  it('one coming in after its side\'s Parting Shot, Baton Pass…, with no "…, come back!" (chosen on the party screen): in for it', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('Incineroar used Parting Shot on the opposing Salamence!', 'Go! Metagross!');
    expect(r.b.live.active.me).toEqual([3, 2]);
  });

  it('"…had its HP restored." ends the turn (Leftovers, Grassy Terrain), but straight after a Sitrus Berry is part of the move', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Salamence used Dragon Claw on Garchomp!', 'The opposing Kingambit had its HP restored.');
    expect(r.b.events.at(-1)?.kind).toBe('endTurn');
    const s = rig({me: [1, 2], opp: [0, 1]});
    s.read('The opposing Salamence used Dragon Claw on Incineroar!', "Incineroar's Sitrus Berry", 'Incineroar had its HP restored.');
    expect(s.b.events.some(e => e.kind === 'endTurn')).toBe(false);
  });

  it('"…flinched and couldn\'t move!" straight after a Fake Out with no target said: whom it hit', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('Incineroar used Fake Out!', "The opposing Kingambit flinched and couldn't move!");
    expect(turnActions(r.b).find(a => a.move === 'Fake Out')?.hits.map(h => h.target)).toEqual([{side: 'opp', slot: 1}]);
  });

  it('the battle over: the move still being told is logged; 0 read for one it hit is a KO', () => {
    const r = rig({me: [1, 2], opp: [0, 1]});
    r.read('The opposing Kingambit used Kowtow Cleave on Garchomp!');
    r.n.feed([{kind: 'hp', mon: {side: 'me', slot: 2}, value: 0}]);
    r.read('The battle has ended due to a forfeit.');
    expect(turnActions(r.b, 1).map(a => [a.move, a.hits.map(h => h.fainted)])).toEqual([['Kowtow Cleave', [true]]]);
    // "You lost to …!" names a trainer, not a Pokémon.
    expect(events('You lost to Brylo!').map(e => e.kind)).toEqual(['battleEnd']);
  });

  it("a ribbon's title after the name isn't another Pokémon", () => {
    const kinds = events('Kim sent out Salamence the Alola Champion and Kingambit!', {me: [null, null], opp: [null, null]});
    expect(kinds).toEqual([{kind: 'sendOut', mon: {side: 'opp', slot: 0}}, {kind: 'sendOut', mon: {side: 'opp', slot: 1}}]);
  });
});

describe('the game\'s text, live (3 Oct)', () => {
  const LIVE = parseTeam(`Espathra @ Electric Seed
Ability: Speed Boost
EVs: 28 HP / 11 Def / 2 SpD / 25 Spe
Bold Nature
- Lumina Crash
- Calm Mind
- Baton Pass
- Protect

Raichu @ Raichunite X
Ability: Lightning Rod
EVs: 24 HP / 10 SpA / 32 Spe
Timid Nature
- Fake Out
- Rising Voltage
- Light Screen
- Reflect

Pelipper @ Focus Sash
Ability: Drizzle
EVs: 32 HP / 32 SpA / 2 Spe
Modest Nature
- Hurricane
- Weather Ball
- Tailwind
- Wide Guard

Archaludon @ Leftovers
Ability: Stamina
EVs: 29 HP / 1 Def / 5 SpA / 20 SpD / 11 Spe
Modest Nature
- Electro Shot
- Flash Cannon
- Dragon Pulse
- Protect`);
  const PREVIEW = ['Rillaboom', 'Arcanine-Hisui', 'Gholdengo', 'Salamence'];

  it('Baton Pass: the one sent in takes its stat stages', () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {team: LIVE, preview: PREVIEW});
    r.read('Espathra used Calm Mind!', "Espathra's Sp. Atk and Sp. Def rose!");
    r.n.commit();
    // Speed Boost, at the end of the turn.
    r.read("Espathra's Speed rose!");
    r.n.feed([{kind: 'endTurn'}]);
    r.read('Espathra used Baton Pass!', 'Go! Archaludon!');
    expect(r.b.live.active.me).toEqual([3, 1]);
    expect(r.boosts('me3')).toEqual({spa: 1, spd: 1, spe: 1});
    expect(r.boosts('me0')).toEqual({});
  });

  it("Electro Shot in the rain: its Sp. Atk rise is part of it (its damage taken with it), and counted once", () => {
    const r = rig({me: [3, 2], opp: [2, 0]}, {team: LIVE, preview: PREVIEW});
    r.b.live.field.weather = 'Rain';
    r.read('Archaludon used Electro Shot!', 'Archaludon absorbed electricity!', "Archaludon's Sp. Atk rose!");
    r.n.feed([{kind: 'hp', mon: {side: 'opp', slot: 2}, value: 0}]);
    r.read('The opposing Gholdengo fainted!');
    r.n.commit();
    const shot = turnActions(r.b).find(a => a.move === 'Electro Shot')!;
    expect(shot.actorBoosts).toEqual({spa: 1});
    expect(shot.hits.map(h => h.fainted)).toEqual([true]);
    expect(r.boosts('me3')).toEqual({spa: 1});
    // The hit was dealt at +1, the state before the move at +0.
    expect(hitState(shot).mons.me3.boosts).toEqual({spa: 1});
    expect(shot.before.mons.me3.boosts).toEqual({});
  });

  it("Electro Shot into a Protect in the rain: the charge's rise is had all the same, the hit isn't", () => {
    const r = rig({me: [3, 2], opp: [2, 0]}, {team: LIVE, preview: PREVIEW});
    r.b.live.field.weather = 'Rain';
    r.read('The opposing Gholdengo used Protect!', 'Archaludon used Electro Shot!', 'Archaludon absorbed electricity!',
      "Archaludon's Sp. Atk rose!", 'The opposing Gholdengo protected itself!');
    r.n.commit();
    const shot = turnActions(r.b).find(a => a.move === 'Electro Shot')!;
    expect([shot.hits, shot.charged]).toEqual([[], undefined]);
    expect(r.boosts('me3')).toEqual({spa: 1});
  });

  it("Electro Shot in the rain, its \"…'s Sp. Atk rose!\" unread: the charge comes with its rise all the same (5 Oct)", () => {
    const r = rig({me: [3, 2], opp: [2, 0]}, {team: LIVE, preview: PREVIEW});
    r.b.live.field.weather = 'Rain';
    r.read('Archaludon used Electro Shot!', 'Archaludon absorbed electricity!');
    r.n.feed([{kind: 'hp', mon: {side: 'opp', slot: 2}, value: 40}]);
    r.n.commit();
    const shot = turnActions(r.b).find(a => a.move === 'Electro Shot')!;
    expect([shot.actorBoosts, hitState(shot).mons.me3.boosts, r.boosts('me3')]).toEqual([{spa: 1}, {spa: 1}, {spa: 1}]);
  });

    it('Electro Shot out of the rain: the charge is its turn (its rise with it), the attack its next', () => {
    const r = rig({me: [3, 2], opp: [2, 0]}, {team: LIVE, preview: PREVIEW});
    r.read('Archaludon used Electro Shot!', 'Archaludon absorbed electricity!', "Archaludon's Sp. Atk rose!",
      'The opposing Gholdengo used Shadow Ball on Archaludon!', 'Archaludon 150');
    r.n.feed([{kind: 'endTurn'}]);
    r.read('Archaludon used Electro Shot on the opposing Gholdengo!', 'The opposing Gholdengo 40');
    r.n.commit();
    const [charge, attack] = r.b.events.filter((e): e is ActionEvent => e.kind === 'action' && e.move === 'Electro Shot');
    expect([charge.turn, charge.charged, charge.hits]).toEqual([1, true, []]);
    expect([attack.turn, attack.charged, attack.actorBoosts, attack.hits.map(h => h.hpAfter)]).toEqual([2, undefined, undefined, [40]]);
    expect(r.boosts('me3')).toEqual({spa: 1});
  });

  it('a charge with no "…used" line, the attack straight after (singles: nothing to choose in between): two turns', () => {
    const r = rig({me: [3, 2], opp: [2, 0]}, {team: LIVE, preview: PREVIEW});
    r.read('Archaludon absorbed electricity!', "Archaludon's Sp. Atk rose!", 'Archaludon used Electro Shot on the opposing Gholdengo!',
      'The opposing Gholdengo 40');
    r.n.commit();
    const shots = r.b.events.filter((e): e is ActionEvent => e.kind === 'action' && e.move === 'Electro Shot');
    expect(shots.map(s => [s.turn, !!s.charged, s.hits.length])).toEqual([[1, true, 0], [2, false, 1]]);
    expect(r.boosts('me3')).toEqual({spa: 1});
  });

  it('Life Orb said twice (the pop-up, then "…lost some of its HP!"): one recoil', () => {
    const r = rig({me: [3, 1], opp: [2, 0]}, {team: LIVE, preview: PREVIEW});
    r.read('The opposing Gholdengo used Shadow Ball on Archaludon!', 'Archaludon 134', "The opposing Gholdengo's Life Orb",
      'The opposing Gholdengo lost some of its HP!');
    r.n.commit();
    expect(turnActions(r.b).find(a => a.move === 'Shadow Ball')?.actorTriggers).toEqual(['lifeorb']);
  });
});

describe('the game\'s text, live (5 Oct)', () => {
  const MINE = parseTeam(`Araquanid @ Leftovers
Ability: Water Bubble
EVs: 32 HP / 32 Def / 2 SpD
Relaxed Nature
- Liquidation
- Stockpile
- Infestation
- Protect

Grimmsnarl @ Light Clay
Ability: Prankster
EVs: 32 HP / 16 Def / 18 SpD
Careful Nature
- Spirit Break
- Reflect
- Light Screen
- Taunt

Milotic @ Sitrus Berry
Ability: Competitive
EVs: 32 HP / 16 Def / 18 SpD
Calm Nature
- Scald
- Ice Beam
- Psych Up
- Recover

Gholdengo @ Life Orb
Ability: Good as Gold
EVs: 32 HP / 32 SpA / 2 Spe
Modest Nature
- Make It Rain
- Shadow Ball
- Nasty Plot
- Protect`);
  const THEIRS5 = ['Gholdengo', 'Baxcalibur', 'Arcanine-Hisui', 'Greninja', 'Oranguru', 'Rillaboom'];
  const live = (active: Battle['live']['active']) => rig(active, {team: MINE, preview: THEIRS5});

  it("Make It Rain: Sp. Atk down 2 a time (\"harshly fell\"), as Champions has it (Scarlet and Violet's was 1)", () => {
    const r = live({me: [1, 0], opp: [0, 2]});
    r.read('The opposing Gholdengo used Make It Rain!', 'Grimmsnarl 41', 'Araquanid 120', "The opposing Gholdengo's Life Orb",
      'The opposing Gholdengo lost some of its HP!', "The opposing Gholdengo's Sp. Atk harshly fell!");
    r.n.feed([{kind: 'endTurn'}]);
    expect(r.boosts('opp0')).toEqual({spa: -2});
    r.read('The opposing Gholdengo used Make It Rain!', 'Grimmsnarl 0', 'Grimmsnarl fainted!', 'Araquanid 70',
      "The opposing Gholdengo's Sp. Atk harshly fell!");
    r.n.commit();
    expect(r.boosts('opp0')).toEqual({spa: -4});
  });

  it('how far a stat went is as the game says, whatever the move does as the app has it', () => {
    // A Simple Pokémon's drops are doubled: Snarl's 1 read as 2, the other's as 1.
    const r = rig({me: [0, 1], opp: [0, 1]});
    r.read('Incineroar used Snarl!', "The opposing Salamence's Sp. Atk harshly fell!", "The opposing Kingambit's Sp. Atk fell!");
    r.n.commit();
    expect([r.boosts('opp0'), r.boosts('opp1')]).toEqual([{spa: -2}, {spa: -1}]);
    // Said once what made it is logged (a switch-in's Intimidate): the same.
    const s = rig({me: [null, null], opp: [0, 1]});
    s.read('Go! Charizard and Incineroar!', "Incineroar's Intimidate", "The opposing Salamence's Attack harshly fell!",
      "The opposing Kingambit's Attack fell!");
    expect([s.boosts('opp0'), s.boosts('opp1')]).toEqual([{atk: -2}, {atk: -1}]);
  });

  it("Psych Up: its stat stages become the other's, an ally's or a foe's (the game names it with no \"opposing\")", () => {
    const r = live({me: [0, 2], opp: [1, 0]});
    r.read('Araquanid used Stockpile!', 'Araquanid stockpiled 1!', "Araquanid's Defense and Sp. Def rose!");
    r.read('Milotic used Psych Up!', "Milotic copied Araquanid's stat changes!");
    r.n.commit();
    expect(r.boosts('me2')).toEqual({def: 1, spd: 1});
    r.read('The opposing Baxcalibur used Dragon Dance!', "The opposing Baxcalibur's Attack and Speed rose!");
    r.read('Milotic used Psych Up!', "Milotic copied Baxcalibur's stat changes!");
    r.n.commit();
    expect(r.boosts('me2')).toEqual({atk: 1, spe: 1});
  });

  it('Glaive Rush: its user takes double damage until it moves again', () => {
    const r = live({me: [0, 2], opp: [1, 0]});
    r.read('The opposing Baxcalibur used Glaive Rush on Araquanid!', 'Araquanid 80');
    r.read('Milotic used Scald on the opposing Baxcalibur!', 'The opposing Baxcalibur 40');
    r.n.commit();
    expect(r.b.live.mons.opp1.exposed).toBe(1);
    const scald = turnActions(r.b).find(a => a.move === 'Scald')!;
    expect(scald.before.mons.opp1.exposed).toBe(1);
    // Its next move closes it.
    r.n.feed([{kind: 'endTurn'}]);
    r.read('The opposing Baxcalibur used Protect!');
    r.n.commit();
    expect(r.b.live.mons.opp1.exposed).toBeUndefined();
  });

  it('types the game says changed (Protean, Burn Up…): kept until it leaves the field', () => {
    const r = live({me: [0, 2], opp: [3, 0]});
    r.read("The opposing Greninja's Protean", 'The opposing Greninja transformed into the Ice type!');
    expect(r.b.live.mons.opp3.types).toEqual(['Ice']);
    r.read('The opposing Greninja, come back!', 'Kim sent out Rillaboom!');
    expect(r.b.live.mons.opp3.types).toBeUndefined();
  });

  it('nothing shown as one came in (no Intimidate): answered by the moves being chosen, not asked', () => {
    const r = live({me: [null, null], opp: [null, null]});
    r.read('Kim sent out Arcanine and Rillaboom!', 'Go! Grimmsnarl and Araquanid!', "Rillaboom's Grassy Surge",
      'Grass grew to cover the battlefield!');
    r.n.feed([{kind: 'endTurn'}]);
    const checks = r.b.events.filter(e => e.kind === 'check');
    const arcanine = checks.find(c => c.kind === 'check' && c.mon.slot === 2);
    expect(arcanine && arcanine.kind === 'check' && arcanine.seen).toBe(null);
    // Rillaboom showed its Grassy Surge: that's its answer, not "nothing"; the terrain it set showed no Grassy Seed of its
    // own.
    expect(checks.filter(c => c.kind === 'check' && c.mon.slot === 5).map(c => c.kind === 'check' && [c.context, c.seen]))
      .toEqual([['entry', 'Grassy Surge'], ['terrain', null]]);
  });

  it('a seed for the terrain up as one came in, or as the terrain started, would have gone off: none shown, none held', () => {
    const r = live({me: [null, null], opp: [null, null]});
    r.read('Kim sent out Rillaboom and Arcanine!', 'Go! Grimmsnarl and Araquanid!', "Rillaboom's Grassy Surge",
      'Grass grew to cover the battlefield!');
    r.n.feed([{kind: 'endTurn'}]);
    const arcanine = r.b.events.find(e => e.kind === 'check' && e.mon.slot === 2);
    expect(arcanine && arcanine.kind === 'check' && [arcanine.seen, arcanine.terrain]).toEqual([null, 'Grassy']);
    // Shown: it's held, and gone once used.
    const s = live({me: [null, null], opp: [null, null]});
    s.read('Kim sent out Rillaboom and Arcanine!', 'Go! Grimmsnarl and Araquanid!', "Rillaboom's Grassy Surge",
      'Grass grew to cover the battlefield!', "The opposing Arcanine's Grassy Seed", "The opposing Arcanine's Defense rose!");
    s.n.feed([{kind: 'endTurn'}]);
    const seed = s.b.events.find(e => e.kind === 'check' && e.mon.slot === 2);
    expect(seed && seed.kind === 'check' && seed.seen).toBe('Grassy Seed');
    expect([s.b.live.mons.opp2.itemGone, s.boosts('opp2')]).toEqual([true, {def: 1}]);
    // Out before the terrain started: its moment is the terrain's.
    const t = live({me: [null, null], opp: [null, null]});
    t.read('Kim sent out Arcanine and Gholdengo!', 'Go! Grimmsnarl and Araquanid!');
    t.n.feed([{kind: 'endTurn'}]);
    t.read('Kim withdrew Gholdengo!', 'Kim sent out Rillaboom!', "Rillaboom's Grassy Surge", 'Grass grew to cover the battlefield!');
    t.n.feed([{kind: 'endTurn'}]);
    const terrain = t.b.events.filter(e => e.kind === 'check' && e.mon.slot === 2).map(e => e.kind === 'check' && [e.context, e.seen]);
    expect(terrain).toEqual([['entry', null], ['terrain', null]]);
  });

  it('After You, Quash: that move says nothing of its Speed', () => {
    const r = live({me: [0, 2], opp: [4, 1]});
    r.read('The opposing Oranguru used After You on the opposing Baxcalibur!', 'The opposing Baxcalibur took the kind offer!',
      'The opposing Baxcalibur used Glaive Rush on Araquanid!', 'Araquanid 60');
    r.n.commit();
    const acts = turnActions(r.b);
    expect(acts.map(a => [a.move, a.ordered])).toEqual([['After You', true], ['Glaive Rush', false]]);
  });

  it('Instruct: the move made again is the same turn, and says nothing of its Speed', () => {
    const r = live({me: [0, 2], opp: [4, 1]});
    r.read('The opposing Baxcalibur used Glaive Rush on Araquanid!', 'Araquanid 100', 'The opposing Oranguru used Instruct!',
      "The opposing Baxcalibur followed the opposing Oranguru's instructions!", 'The opposing Baxcalibur used Glaive Rush on Araquanid!',
      'Araquanid 30');
    r.n.commit();
    const acts = turnActions(r.b);
    expect(acts.map(a => [a.turn, a.move, a.ordered])).toEqual([[1, 'Glaive Rush', true], [1, 'Instruct', true], [1, 'Glaive Rush', false]]);
  });

  it('changed in a way the app does not follow (Transform): counted as nothing until it leaves', () => {
    const r = live({me: [0, 2], opp: [3, 0]});
    r.read('The opposing Greninja transformed into Milotic!');
    expect(r.b.live.mons.opp3.odd).toBe(true);
    r.read('The opposing Greninja used Scald on Araquanid!', 'Araquanid 150');
    r.n.commit();
    expect(turnActions(r.b).find(a => a.move === 'Scald')?.ordered).toBe(false);
    const notes = computeBeliefs(doublesFmt, r.b).notes.filter(n => n.slot === 3 && n.kind === 'damage-dealt');
    expect(notes).toEqual([]);
    r.read('The opposing Greninja, come back!', 'Kim sent out Rillaboom!');
    expect(r.b.live.mons.opp3.odd).toBeUndefined();
  });
});

describe('lines that change what a Pokémon is (5 Oct)', () => {
  const me0 = {side: 'me', slot: 0};
  const opp0 = {side: 'opp', slot: 0};
  const opp1 = {side: 'opp', slot: 1};
  it('types: to one, one added, the same as another, one lost, its own again', () => {
    expect(events('The opposing Salamence transformed into the Water type!')).toEqual([{kind: 'types', mon: opp0, to: 'Water'}]);
    expect(events('Ghost type was added to the opposing Kingambit!')).toEqual([{kind: 'types', mon: opp1, add: 'Ghost'}]);
    expect(events('Charizard became the same type as the opposing Salamence!')).toEqual([{kind: 'types', mon: me0, like: opp0}]);
    expect(events('Charizard burned itself out!')).toEqual([{kind: 'types', mon: me0, lose: 'Fire'}]);
    expect(events('The opposing Salamence used up all its electricity!')).toEqual([{kind: 'types', mon: opp0, lose: 'Electric'}]);
    expect(events('The opposing Salamence returned to its original type!')).toEqual([{kind: 'types', mon: opp0, back: true}]);
  });

  it("stat stages copied, inverted; a move out of its Speed's turn; one the app doesn't follow", () => {
    expect(events("The opposing Salamence copied Charizard's stat changes!")).toEqual([{kind: 'copyBoosts', mon: opp0, from: me0}]);
    expect(events('All stat changes on the opposing Salamence were inverted!')).toEqual([{kind: 'copyBoosts', mon: opp0, from: opp0, invert: true}]);
    expect(events("The opposing Kingambit's move was postponed!")).toEqual([{kind: 'outOfTurn', mon: opp1}]);
    expect(events('The opposing Salamence transformed into Charizard!')).toEqual([{kind: 'odd', mon: opp0}]);
    expect(events('Charizard switched its Attack and Defense!')).toEqual([{kind: 'odd', mon: me0}]);
    // Role Play copies an ability: what it says is the other's.
    expect(events("Charizard copied the opposing Salamence's Intimidate Ability!")).toEqual([{kind: 'ability', mon: opp0, ability: 'Intimidate'}]);
  });
});

describe('Mega Evolution, theirs (5 Oct)', () => {
  it('the stone shown says which Mega (the line after calls Garchomp-Mega-Z plain "Mega Garchomp"), listed or not', () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Garchomp', 'Kingambit', 'Rillaboom', 'Clefable']});
    r.read("The opposing Garchomp's Garchompite Z is reacting to Kim's Omni Ring!", 'The opposing Garchomp has Mega Evolved into Mega Garchomp!');
    const forme = r.b.events.find(e => e.kind === 'reveal' && e.what === 'forme');
    expect(forme && forme.kind === 'reveal' && forme.value).toBe('Garchomp-Mega-Z');
    // Not in the format's data (Showdown's, without the in-game data): there all the same, nothing impossible.
    expect(doublesFmt.preview.Garchomp).not.toContain('Garchomp-Mega-Z');
    const res = computeBeliefs(doublesFmt, r.b);
    expect(res.notes.filter(n => n.kind === 'conflict')).toEqual([]);
    expect(res.mons[0]?.formes.find(f => f.name === 'Garchomp-Mega-Z')?.p).toBeGreaterThan(0.99);
  });
});

describe('Ally Switch (5 Oct)', () => {
  it('the two of a side change places: one coming in for a fainted one goes where it was', () => {
    const r = rig({me: [0, 1], opp: [0, 1]});
    r.read('The opposing Kingambit used Ally Switch!', 'The opposing Kingambit and the opposing Salamence switched places!');
    expect(r.b.live.active.opp).toEqual([1, 0]);
    r.read('Charizard used Heat Wave!', 'The opposing Salamence 0', 'The opposing Salamence fainted!', 'Kim sent out Rillaboom!');
    expect(r.b.live.active.opp).toEqual([1, 2]);
  });
});

describe('an entry pop-up read before the beliefs are in (5 Oct)', () => {
  it("answers its question at the moves being chosen, its effect not made again", () => {
    const r = rig({me: [0, 1], opp: [null, null]}, {beliefs: false});
    r.read('Kim sent out Salamence and Kingambit!', "Salamence's Intimidate", "Charizard and Incineroar's Attack fell!");
    r.n.feed([{kind: 'endTurn'}]);
    expect([r.boosts('me0'), r.boosts('me1')]).toEqual([{atk: -1}, {atk: -1}]);
    const checks = r.b.events.filter(e => e.kind === 'check').map(e => e.kind === 'check' ? [e.mon.slot, e.seen] : []);
    expect(checks).toEqual([[0, 'Intimidate'], [1, null]]);
  });
});

describe('switches as the game writes them (5 Oct, evening)', () => {
  const MIRROR = parseTeam(`Grimmsnarl @ Light Clay
- Reflect

Milotic @ Sitrus Berry
- Scald

Slowbro-Mega @ Slowbronite
- Body Press

Volcarona @ Rocky Helmet
- Struggle Bug`);

  it('"… withdrew X!" is theirs, of a species both sides have too (yours are told "…, come back!")', () => {
    const r = rig({me: [3, 2], opp: [1, 3]}, {team: MIRROR, preview: ['Aegislash', 'Rillaboom', 'Sneasler', 'Volcarona', 'Salamence', 'Milotic']});
    r.read('TrashRat withdrew Volcarona!', 'TrashRat sent out Aegislash!', 'TrashRat withdrew Rillaboom!', 'TrashRat sent out Milotic!');
    expect(r.b.live.active).toEqual({me: [3, 2], opp: [5, 0]});
    expect(r.asked).toEqual([]);
  });

  it("a trainer's name before \"withdrew\" isn't taken in with the Pokémon's (\"c.c. withdrew Avalugg!\")", () => {
    const r = rig({me: [0, 2], opp: [2, 3]}, {team: MIRROR, preview: ['Camerupt', 'Farigiraf', 'Aromatisse', 'Avalugg-Hisui', 'Rillaboom', 'Sneasler']});
    r.read('c.c. withdrew Avalugg!', 'c.c. sent out Camerupt!');
    expect(r.b.live.active.opp).toEqual([2, 0]);
  });

  it("an HP box naming one the log doesn't have out: it came in there (a switch read wrong, or missed)", () => {
    const r = rig({me: [0, 2], opp: [2, 3]}, {team: MIRROR, preview: ['Camerupt', 'Farigiraf', 'Aromatisse', 'Avalugg-Hisui', 'Rillaboom', 'Sneasler']});
    // Theirs face you: the right-hand box (screen 1) is their first place.
    const box = {kind: 'hp' as const, side: 'opp' as const, screen: 0, name: 'Camerupt', value: 100, raw: '100%'};
    r.n.feed(readingEvents(r.b, gen, () => undefined, box));
    expect(r.b.live.active.opp).toEqual([2, 0]);
    // What it has there already, the box agreeing: nothing more.
    const n = r.b.events.length;
    r.n.feed(readingEvents(r.b, gen, () => undefined, box));
    expect(r.b.events.length).toBe(n);
  });
});

describe('abilities as the game shows them (5 Oct, evening)', () => {
  const MIRROR = parseTeam(`Grimmsnarl @ Light Clay
Ability: Prankster
- Reflect

Milotic @ Sitrus Berry
- Scald`);

  it("Trace: the pop-up after it is the ability it copied (your Grimmsnarl's Prankster), not its own", () => {
    const r = rig({me: [null, null], opp: [null, null]}, {team: MIRROR, preview: ['Gardevoir', 'Sneasler', 'Torkoal', 'Kingambit']});
    r.read('The Trainer sent out Sneasler and Gardevoir!', 'Go! Grimmsnarl and Milotic!', "The opposing Gardevoir's Trace",
      "The opposing Gardevoir's Prankster", "It traced Grimmsnarl's Prankster!");
    r.n.feed([{kind: 'endTurn'}]);
    // What it showed of its own: Trace, as the answer to its coming in.
    const shown = r.b.events.filter(e => (e.kind === 'reveal' && e.what === 'ability') || (e.kind === 'check' && e.seen))
      .filter(e => (e.kind === 'reveal' || e.kind === 'check') && e.mon.side === 'opp' && e.mon.slot === 0)
      .map(e => (e.kind === 'reveal' ? e.value : e.kind === 'check' ? e.seen : ''));
    expect(shown).toEqual(['Trace']);
    expect(computeBeliefs(doublesFmt, r.b).notes.filter(n => n.kind === 'conflict')).toEqual([]);
  });

  it('back into the terrain its ability sets: no pop-up, and that says nothing against the ability', () => {
    const r = rig({me: [null, null], opp: [null, null]}, {team: MIRROR, preview: ['Rillaboom', 'Garchomp', 'Kingambit', 'Incineroar']});
    r.read('Chris sent out Garchomp and Rillaboom!', 'Go! Grimmsnarl and Milotic!', "The opposing Rillaboom's Grassy Surge",
      'Grass grew to cover the battlefield!');
    r.n.feed([{kind: 'endTurn'}]);
    r.read('The opposing Rillaboom used U-turn on Grimmsnarl!', 'Grimmsnarl 180', 'The opposing Rillaboom went back to Chris!',
      'Chris sent out Kingambit!');
    r.n.feed([{kind: 'endTurn'}]);
    r.read('Chris withdrew Kingambit!', 'Chris sent out Rillaboom!');
    r.n.feed([{kind: 'endTurn'}]);
    const back = r.b.events.filter(e => e.kind === 'check' && e.mon.slot === 0 && e.context === 'entry').at(-1);
    expect(back && back.kind === 'check' && [back.seen, back.already?.terrain]).toEqual([null, 'Grassy']);
    expect(computeBeliefs(doublesFmt, r.b).notes.filter(n => n.kind === 'conflict')).toEqual([]);
  });
});

describe('Stance Change, and abilities not its own (5 Oct, evening)', () => {
  const MINE = parseTeam(`Slowbro-Mega @ Slowbronite
Ability: Oblivious
- Body Press

Milotic @ Sitrus Berry
- Scald`);

  it("an ability none of its formes can have (Trace's copy, its own pop-up unread) isn't taken as its own", () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {team: MINE, preview: ['Meowstic-F', 'Lucario', 'Indeedee-F', 'Sneasler']});
    r.read("The opposing Meowstic's Shell Armor", "It traced Slowbro's Shell Armor!");
    expect(r.b.events.filter(e => e.kind === 'reveal' && e.mon.side === 'opp')).toEqual([]);
  });

  it('Aegislash attacks in its Blade forme, and stays in it until King\'s Shield', () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {team: MINE, preview: ['Aegislash', 'Rillaboom', 'Sneasler', 'Volcarona']});
    r.read('The opposing Aegislash used Shadow Ball on Milotic!', 'Milotic 150');
    r.n.commit();
    expect(r.b.live.mons.opp0.blade).toBe(true);
    const ball = turnActions(r.b).find(a => a.move === 'Shadow Ball')!;
    expect(hitState(ball).mons.opp0.blade).toBe(true);
    r.n.feed([{kind: 'endTurn'}]);
    r.read("The opposing Aegislash used King's Shield!");
    r.n.commit();
    expect(r.b.live.mons.opp0.blade).toBeUndefined();
  });
});

describe('stat lines the other way round: Contrary (6 Oct)', () => {
  it("Mega Staraptor's Close Combat raised its defences, as the game said, though logged as drops (they had been left at 0)", () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Staraptor', 'Grimmsnarl', 'Basculegion', 'Primarina']});
    r.read("The opposing Staraptor's Staraptite is reacting to ukulele's Omni Ring!", 'The opposing Staraptor has Mega Evolved into Mega Staraptor!');
    r.read('The opposing Staraptor used Close Combat!', 'Incineroar 80', "The opposing Staraptor's Defense and Sp. Def rose!");
    r.n.commit();
    expect(r.boosts('opp0')).toEqual({def: 1, spd: 1});
  });

  it("Serperior's Leaf Storm: its Sp. Atk rose sharply, so it has Contrary, shown", () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Serperior', 'Grimmsnarl', 'Basculegion', 'Primarina']});
    r.read('The opposing Serperior used Leaf Storm!', 'Incineroar 150', "The opposing Serperior's Sp. Atk rose sharply!");
    r.n.commit();
    expect(r.boosts('opp0')).toEqual({spa: 2});
    expect(r.b.events.some(e => e.kind === 'reveal' && e.what === 'ability' && e.value === 'Contrary')).toBe(true);
  });
});

describe('screens, weather and terrain that may last 8 turns (6 Oct)', () => {
  /** A turn's lines, then the moves being chosen for the next. */
  const turn = (r: ReturnType<typeof rig>, ...lines: string[]) => {
    r.read(...lines);
    r.n.feed([{kind: 'endTurn'}]);
  };
  const items = (r: ReturnType<typeof rig>) => r.b.events.flatMap(e => (e.kind === 'reveal' && e.what === 'item' ? [[e.value, e.negate, e.mon.slot]] : []));

  it("Sableye's Light Screen up past its 5th turn, and no line saying it's over: Light Clay (it had been taken off after 5)", () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Sableye', 'Archaludon', 'Pelipper', 'Sneasler']});
    turn(r, 'The opposing Sableye used Light Screen!', 'Light Screen made the opposing side stronger against special moves!');
    for (let k = 0; k < 4; k++) turn(r, 'Charizard used Protect!', 'Charizard protected itself!');
    // Five turns over: up still, as it would be with Light Clay.
    expect(r.b.live.field.opp.lightScreen).toBe(true);
    r.read('Charizard used Protect!');
    expect(items(r)).toEqual([['Light Clay', false, 0]]);
    expect(r.b.live.field.turns?.['opp.lightScreen']).toBe(3);
    expect(r.b.live.field.mayLast?.['opp.lightScreen']).toBeUndefined();
  });

  it('…and one that wore off at the end of its 5th turn: no Light Clay', () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Sableye', 'Archaludon', 'Pelipper', 'Sneasler']});
    turn(r, 'The opposing Sableye used Light Screen!', 'Light Screen made the opposing side stronger against special moves!');
    for (let k = 0; k < 3; k++) turn(r, 'Charizard used Protect!', 'Charizard protected itself!');
    turn(r, 'Charizard used Protect!', 'Charizard protected itself!', "The opposing side's Light Screen wore off!");
    expect(r.b.live.field.opp.lightScreen).toBe(false);
    r.read('Charizard used Protect!');
    expect(items(r)).toEqual([['Light Clay', true, 0]]);
  });

  it("Pelipper's Drizzle: the rain still falling past 5 turns is Damp Rock's", () => {
    const r = rig({me: [0, 1], opp: [null, null]}, {preview: ['Pelipper', 'Archaludon', 'Sableye', 'Sneasler']});
    r.read('Kim sent out Pelipper and Archaludon!', "Pelipper's Drizzle", 'It started to rain!');
    expect(r.b.live.field.mayLast?.weather).toEqual({slot: 0, item: 'Damp Rock'});
    for (let k = 0; k < 5; k++) turn(r, 'Charizard used Protect!', 'Charizard protected itself!');
    r.read('Charizard used Protect!');
    expect(items(r)).toEqual([['Damp Rock', false, 0]]);
    expect(r.b.live.field.weather).toBe('Rain');
  });
});

describe('binding moves as the game writes them (6 Oct)', () => {
  it("Toxapex's Infestation: held, hurt at the end of each turn, and freed when the game says (not hurt that turn)", () => {
    const r = rig({me: [0, 1], opp: [0, 1]}, {preview: ['Toxapex', 'Archaludon', 'Sableye', 'Pelipper']});
    const max = maxHPOf({fmt: doublesFmt, gen, battle: r.b, oppAbility: () => undefined, oppItem: () => undefined}, r.b.live, {side: 'me', slot: 0});
    r.read('The opposing Toxapex used Infestation!', 'Charizard 150', 'Charizard has been afflicted with an infestation by the opposing Toxapex!');
    r.read('Charizard is hurt by Infestation!');
    expect(r.b.live.mons.me0.bound).toEqual({move: 'Infestation', by: {side: 'opp', slot: 0}, ticks: 1});
    expect(r.max('me0')).toBe(150 - Math.floor(max / 8));
    r.n.feed([{kind: 'endTurn'}]);
    // The next turn ends with it let go, instead of hurt: as it was.
    r.read('Charizard used Protect!', 'Charizard protected itself!', 'Charizard was freed from Infestation!');
    expect(r.b.live.mons.me0.bound).toBeUndefined();
    expect(r.max('me0')).toBe(150 - Math.floor(max / 8));
  });
});
