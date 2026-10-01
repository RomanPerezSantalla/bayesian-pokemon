import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../../../data/dex';
import type {FormatInfo} from '../../../data/format';
import {fuse, type Structure} from '../../../data/fuse';
import {parseTeam} from '../../../data/paste';
import {createBattle} from '../../../engine/battle';
import {namesPutBack, switchPutPlain} from './heard';
import {abilityHeard, applyPreview, battleContext, battleShown, mentionsLeftOut, modelInput, previewContext, readBattleAnswer, readPreviewAnswer, saidSo, startSaid, yesSaid, type Known} from './lm';
import type {Picks} from './preview';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);
const gen = getGen(fmt.gen);

const TEAM = parseTeam(`Charizard @ Charizardite Y
Ability: Solar Power
- Heat Wave
- Weather Ball
- Solar Beam
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
- Fake Out
- Knock Off
- Parting Shot
- Snarl

Garchomp @ Life Orb
Ability: Rough Skin
- Earthquake
- Rock Slide
- Dragon Claw
- Protect

Sneasler @ Focus Sash
Ability: Unburden
- Close Combat
- Dire Claw
- Fake Out
- Protect`);

const battle = () => {
  const b = createBattle(fmt, TEAM, ['Salamence', 'Kingambit', 'Rillaboom', 'Mr. Rime'], 'lm');
  b.live.active = {me: [1, 0], opp: [0, 1]};
  return b;
};
const known: Known = {gen, fmt, maxHp: () => 200};
const read = (answer: string, k: Known = known) => readBattleAnswer(battle(), k, answer);

describe("what the language model's shown", () => {
  it('the battle: the ones out first (*), in the order they stand, Mega marked, and what the phrase before did', () => {
    const b = battle();
    b.live.mons.me0 = {...b.live.mons.me0, mega: true};
    const {me, opp} = battleShown(b);
    expect(battleContext(me, opp, ['use me:Incineroar Fake Out > opp:Salamence', 'hp opp:Salamence 90'])).toBe(
      'me: Incineroar*, Charizard* Mega, Garchomp, Sneasler\nopp: Salamence*, Kingambit*, Rillaboom, Mr. Rime\n'
      + 'before: use me:Incineroar Fake Out > opp:Salamence | hp opp:Salamence 90');
  });

  it('team preview: your six, the ones picked, theirs so far (nothing picked yet: nothing after the colon)', () => {
    expect(previewContext(['Charizard', 'Incineroar'], 4, [], ['Froslass'])).toBe('team preview\nme: Charizard, Incineroar\nbring 4:\nopp: Froslass');
    expect(modelInput('x', 'hi')).toBe('<start_of_turn>user\nx\nsaid: hi<end_of_turn>\n<start_of_turn>model\n');
  });
});

describe('a battle answer, checked', () => {
  it('moves: yours only from its set; theirs if seen on the ladder or learnable', () => {
    const r = read('use me:Incineroar fake out > opp:Salamence\nuse me:Incineroar Flamethrower\nuse opp:Kingambit Kowtow Cleave > me:Charizard');
    expect(r.lines).toEqual(['use me:Incineroar Fake Out > opp:Salamence', 'use opp:Kingambit Kowtow Cleave > me:Charizard']);
    expect(r.events.slice(0, 2)).toEqual([{kind: 'use', actor: {side: 'me', slot: 1}, move: 'Fake Out'}, {kind: 'target', mon: {side: 'opp', slot: 0}}]);
    expect(r.dropped).toEqual([{line: 'use me:Incineroar Flamethrower', why: "your Incineroar doesn't have Flamethrower"}]);
    // Without learnsets only whether the move exists is checked; with them, theirs must be able to learn it.
    expect(read('use opp:Kingambit Moonblast').lines).toEqual(['use opp:Kingambit Moonblast']);
    expect(read('use opp:Kingambit Moonblast', {...known, learns: () => false}).dropped[0].why).toBe("Kingambit can't learn Moonblast");
    expect(read('use opp:Kingambit Moonbeam').dropped[0].why).toBe('no move Moonbeam');
  });

  it('Pokémon: only yours brought and theirs at preview, names with spaces too', () => {
    expect(read('use opp:Mr. Rime Freeze-Dry > me:Garchomp').lines).toEqual(['use opp:Mr. Rime Freeze-Dry > me:Garchomp']);
    expect(read('use opp:Froslass Protect').dropped[0].why).toMatch(/no Pokémon of theirs called Froslass/);
    const b = battle();
    b.brought = [0, 1];
    expect(readBattleAnswer(b, known, 'faint me:Garchomp').dropped).toHaveLength(1);
  });

  it('abilities, items and Mega Evolution: only what that Pokémon can have', () => {
    const r = read([
      'ability opp:Salamence Intimidate', 'ability opp:Salamence Levitate', 'item opp:Salamence Salamencite', 'item opp:Rillaboom Salamencite',
      'item me:Incineroar Sitrus Berry gone', 'item me:Incineroar Leftovers', 'mega me:Charizard Y', 'mega me:Charizard X', 'mega me:Garchomp',
      'mega opp:Salamence', 'mega opp:Rillaboom',
    ].join('\n'));
    expect(r.lines).toEqual(['ability opp:Salamence Intimidate', 'item opp:Salamence Salamencite', 'item me:Incineroar Sitrus Berry gone', 'mega me:Charizard Y', 'mega opp:Salamence']);
    expect(r.dropped.map(d => d.why)).toEqual([
      "Salamence can't have Levitate", "Salamencite isn't Rillaboom's", 'your Incineroar holds Sitrus Berry', 'Charizard has no Mega X',
      "Garchomp can't Mega Evolve", "Rillaboom can't Mega Evolve",
    ]);
  });

  it('numbers in range: theirs in %, yours up to their max HP, stats ±1 to 6, hits 1 to 10', () => {
    const r = read('hp opp:Salamence 140\nhp opp:Salamence 40\nhp me:Incineroar 201\nhp me:Incineroar 150\nstat opp:Kingambit atk +2\nstat opp:Kingambit atk +9\nstat opp:Kingambit hp +1\nstat opp:Kingambit spe min\nhits 3\nhits 0');
    expect(r.lines).toEqual(['hp opp:Salamence 40', 'hp me:Incineroar 150', 'stat opp:Kingambit atk +2', 'stat opp:Kingambit spe min', 'hits 3']);
    expect(r.events.find(e => e.kind === 'stat' && e.limit)).toEqual({kind: 'stat', mon: {side: 'opp', slot: 1}, boosts: {spe: -1}, limit: true});
  });

  it('the field: the effects there are, whose side, starting or ending', () => {
    const r = read('field tailwind opp\nfield trickroom end\nfield rain\nfield weather end\nfield lava\nfield rain opp');
    expect(r.events).toEqual([
      {kind: 'field', news: {what: 'tailwind', value: true, side: 'opp'}}, {kind: 'field', news: {what: 'trickRoom', value: false}},
      {kind: 'field', news: {what: 'weather', value: 'Rain'}}, {kind: 'field', news: {what: 'weather', value: null}},
    ]);
    expect(r.dropped.map(d => d.why)).toEqual(['no field effect lava', 'weather has no side']);
  });

  it('a name a letter or two off, when one is clearly meant; not a made-up one', () => {
    expect(read('use opp:Salamenc Protect\nuse opp:Kingambitt Sucker Punch > me:Incineroar').lines)
      .toEqual(['use opp:Salamence Protect', 'use opp:Kingambit Sucker Punch > me:Incineroar']);
    expect(read('use opp:Overlordee Protect').dropped[0].why).toMatch(/no Pokémon of theirs called Overlordee/);
  });

  it('undo only first; switches on one side; team preview actions dropped', () => {
    const r = read('undo\nswitch opp:Salamence > opp:Rillaboom\nswitch opp:Salamence > me:Garchomp\nadd opp:Froslass\nundo');
    expect(r.undo).toBe(true);
    expect(r.events).toEqual([{kind: 'withdraw', mon: {side: 'opp', slot: 0}, voluntary: true}, {kind: 'sendOut', mon: {side: 'opp', slot: 2}}]);
    expect(r.dropped.map(d => d.why)).toEqual(['a switch is on one side', 'that’s for team preview', 'undo comes first']);
    expect(read('none')).toEqual({undo: false, events: [], lines: [], dropped: []});
  });
});

describe('a team preview answer, checked and applied', () => {
  const env = {fmt, gen, team: TEAM, bring: 4};
  const picks: Picks = {theirs: ['Charizard', 'Goodra-Hisui'], mine: [1]};

  it('theirs by preview name, formes and all; yours from your six', () => {
    const r = readPreviewAnswer(env, picks, 'add opp:Charizard-Mega-Y\nadd opp:Froslass\nremove opp:Goodra\nbring me:Sneasler\nremove me:Garchomp\nadd opp:Pikablu\nuse opp:Froslass Protect');
    expect(r.ops).toEqual([
      {kind: 'add', name: 'Charizard'}, {kind: 'add', name: 'Froslass'}, {kind: 'remove', side: 'theirs', name: 'Goodra-Hisui'}, {kind: 'bring', slot: 3},
    ]);
    expect(r.dropped.map(d => d.why)).toEqual(["your Garchomp isn't picked", 'no Pikablu here', 'that’s for the battle']);
    const done = applyPreview(env, picks, r.ops);
    expect(done.picks).toEqual({theirs: ['Charizard', 'Froslass'], mine: [1, 3], last: 'mine'});
    expect(done.notes).toEqual(['Charizard is in already']);
  });

  it('names a letter or two off: the one clearly meant', () => {
    const r = readPreviewAnswer(env, {theirs: [], mine: null}, 'add opp:Annihilate\nadd opp:Stormie\nbring me:Sneaslr\nremove me:Ethereoe-F');
    expect(r.ops).toEqual([{kind: 'add', name: 'Annihilape'}, {kind: 'add', name: 'Starmie'}, {kind: 'bring', slot: 3}]);
    expect(r.dropped.map(d => d.why)).toEqual(['no Ethereoe-F in your team']);
  });

  it('"my bad, Froslass not Volcarona", clearing a side, and the battle starting', () => {
    const r = readPreviewAnswer(env, {theirs: ['Volcarona'], mine: null}, 'remove opp:Volcarona\nadd opp:Froslass');
    expect(applyPreview(env, {theirs: ['Volcarona'], mine: null}, r.ops).picks.theirs).toEqual(['Froslass']);
    const c = readPreviewAnswer(env, picks, 'clear me\nstart');
    expect(applyPreview(env, picks, c.ops)).toMatchObject({picks: {mine: []}, battle: true, said: ['cleared yours']});
  });
});

describe('what the model missed or mixed up', () => {
  it('an ability named on its own: the one Pokémon on the field that can have it', () => {
    expect(abilityHeard(battle(), known, 'Solar Power.')).toBe('ability me:Charizard Solar Power');
    expect(abilityHeard(battle(), known, 'he seemen her Defiant')).toBe('ability opp:Kingambit Defiant');
    // Your Incineroar and their Salamence can both have Intimidate: whose isn't guessed.
    expect(abilityHeard(battle(), known, 'Intimidate.')).toBeNull();
    expect(abilityHeard(battle(), known, 'what time is it')).toBeNull();
  });

  it('abilities and items named that the answer left out (not Mega Stones: a misheard name)', () => {
    expect(mentionsLeftOut(battle(), known, 'Kingambit 84 Defiant activated', ['hp opp:Kingambit 84'])).toEqual(['ability opp:Kingambit Defiant']);
    expect(mentionsLeftOut(battle(), known, 'forty percent HP Chople Berry', ['hp ? 40'])).toEqual(['item ? Chople Berry']);
    expect(mentionsLeftOut(battle(), known, 'Kingambit Defiant', ['ability opp:Kingambit Defiant'])).toEqual([]);
    expect(mentionsLeftOut(battle(), known, 'Close Combat from Charizardite Kingambit', [])).toEqual([]);
  });

  it("a move said with one who can't use it: yours whose set has it, or the only one who can", () => {
    expect(read('use opp:Salamence Heat Wave', {...known, learns: () => false}).lines).toEqual(['use me:Charizard Heat Wave']);
  });

  it('a move taken for an ability, and an ability for a move', () => {
    expect(read('ability opp:Kingambit Sucker Punch').lines).toEqual(['use opp:Kingambit Sucker Punch']);
    expect(read('use opp:Salamence Intimidate').lines).toEqual(['ability opp:Salamence Intimidate']);
    expect(read('ability opp:Kingambit Flamethrower', {...known, learns: () => false}).dropped[0].why).toBe('no ability Flamethrower');
  });

  it('"yes" to what was offered, and "start the battle", however they are heard', () => {
    for (const t of ['Yes.', 'Yeah, forty nine.', 'correct', 'do it']) expect(yesSaid(t), t).toBe(true);
    for (const t of ['Yesterday I lost', 'yes I think the Froslass used Protect on Lopunny', 'no']) expect(yesSaid(t), t).toBe(false);
    for (const t of ['Start butter.', 'U start.', "Let's battle!", 'begin']) expect(startSaid(t), t).toBe(true);
    expect(startSaid('Charizard, Goodra-Hisui.')).toBe(false);
  });

  it('ending the turn, or taking the phrase before back, only with words for it', () => {
    for (const t of ['end turn', 'next turn', "that's the turn", 'turn over', 'new turn', 'end of turn']) expect(saidSo('endturn', t), t).toBe(true);
    expect(saidSo('endturn', 'From last turn Bellibolt toward was at eighty four percent.')).toBe(false);
    for (const t of ['no, it was Froslass', 'sorry, Bellibolt used Protect', 'I meant Triple Axel', 'scratch that', 'not a crit', 'my bad, it was Leftovers',
      'it was Blizzard', "it didn't faint", 'wrong', 'forget that', 'never mind', 'take that back']) expect(saidSo('undo', t), t).toBe(true);
    expect(saidSo('undo', 'Yeah, forty nine.')).toBe(false);
    expect(saidSo('use me:Lopunny Fake Out', 'anything')).toBe(true);
  });
});

describe('names as the recogniser has heard them, put back', () => {
  it('for the Pokémon that can be meant only', () => {
    expect(namesPutBack('Right to Protect.', ['Raichu', 'Glimmora'])).toBe('Raichu Protect.');
    expect(namesPutBack('Rite to Mega Evolved into right two Y', ['Raichu', 'Sneasler'])).toBe('Raichu Mega Evolved into Raichu Y');
    expect(namesPutBack('Right to the face', ['Glimmora'])).toBe('Right to the face');
    expect(namesPutBack("Lopunny Fake Out't write you but write you had Protect.", ['Raichu'])).toBe("Lopunny Fake Out't Raichu but Raichu had Protect.");
    expect(namesPutBack('Glimmora Power Gem into Sneasler, fright to', ['Raichu'])).toBe('Glimmora Power Gem into Sneasler, fright to');
  });
});

describe('a switch said as "X switch for Y"', () => {
  const names = ['Dragonite', 'Sneasler', 'Lopunny', 'Raichu', 'Goodra-Hisui', 'Glimmora'];
  it('put as the reader knows one, however the recogniser spelt the verb', () => {
    expect(switchPutPlain('Dragonite swwitch for Sneasler?', names)).toBe('Dragonite out, Sneasler in?');
    expect(switchPutPlain('dragonite, switched out for sneasler.', names)).toBe('dragonite out, sneasler in.');
    expect(switchPutPlain('Switch Dragonite to Goodra Hisui', names)).toBe('Dragonite out, Goodra Hisui in');
    expect(switchPutPlain('Lopunny swapped with Dragonite', names)).toBe('Lopunny out, Dragonite in');
  });
  it('a move with "switch" in it, or no second name, left alone', () => {
    expect(switchPutPlain('Raichu Ally Switch', names)).toBe('Raichu Ally Switch');
    expect(switchPutPlain('Glimmora Switcheroo into Raichu', names)).toBe('Glimmora Switcheroo into Raichu');
    expect(switchPutPlain('Dragonite switch for Garchomp', names)).toBe('Dragonite switch for Garchomp');
  });
});
