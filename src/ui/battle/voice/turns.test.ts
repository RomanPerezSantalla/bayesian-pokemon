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
import {turnActions} from '../actions';
import {Narrator, type VoiceIO} from './narrator';
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
function rig(active: Battle['live']['active'], {fmt = doublesFmt, preview = THEIRS} = {}) {
  let b = createBattle(fmt, TEAM, preview, 'turns');
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
