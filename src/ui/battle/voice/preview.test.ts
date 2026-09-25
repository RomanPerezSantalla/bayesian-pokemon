import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getGen} from '../../../data/dex';
import type {FormatData, FormatInfo} from '../../../data/format';
import {fuse, type Structure} from '../../../data/fuse';
import {parseTeam} from '../../../data/paste';
import {createBattle} from '../../../engine/battle';
import type {MonRef} from '../../../engine/types';
import {parseNarration} from './parse';
import {readPreview, spokenNames, type Picks} from './preview';
import {IDLE_MS, QUIET_MS, SpeechSession, WAIT_MS, type Recognizer} from './useSpeech';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);
const gen = getGen(fmt.gen);

const TEAM = parseTeam(`Incineroar @ Sitrus Berry
Ability: Intimidate
- Fake Out

Charizard @ Charizardite Y
Ability: Solar Power
- Heat Wave

Garchomp @ Life Orb
Ability: Rough Skin
- Earthquake

Sneasler @ Focus Sash
Ability: Unburden
- Close Combat

Whimsicott @ Covert Cloak
Ability: Prankster
- Tailwind

Kingambit @ Black Glasses
Ability: Defiant
- Kowtow Cleave`);

const env = {fmt, gen, team: TEAM, bring: 4};
const none: Picks = {theirs: [], mine: null};
/** Says each phrase in turn, as the setup screen does. */
const say = (...phrases: string[]) => phrases.reduce((picks, p) => readPreview(p, picks, env).picks, none);

describe('team preview by voice', () => {
  it('their six, however the recogniser spells them', () => {
    const r = readPreview('sneezler, incinerator, king gambit, gar chomp, gold engo, fairy giraffe', none, env);
    expect(r.picks.theirs).toEqual(['Sneasler', 'Incineroar', 'Kingambit', 'Garchomp', 'Gholdengo', 'Farigiraf']);
    expect(r.said).toHaveLength(6);
    expect(r.battle).toBe(false);
  });

  it('formes by their spoken names', () => {
    expect(spokenNames('Ninetales-Alola')).toEqual(expect.arrayContaining(['alolan Ninetales', 'Ninetales alola']));
    expect(say('alolan ninetales', 'female basculegion', 'floette', 'gourgeist', 'kommo o').theirs)
      .toEqual(['Ninetales-Alola', 'Basculegion-F', 'Floette-Eternal', 'Gourgeist-Super', 'Kommo-o']);
    // A regional forme is said with its region; plain is the plain Pokémon.
    expect(say('ninetales').theirs).toEqual(['Ninetales']);
  });

  it('with a female forme too, the plain name is the one used more', () => {
    const f = (fmt.previewUsage['Basculegion-F'] ?? 0) > (fmt.previewUsage.Basculegion ?? 0);
    const [more, other] = f ? ['Basculegion-F', 'Basculegion'] : ['Basculegion', 'Basculegion-F'];
    expect(say('basculegion').theirs).toEqual([more]);
    expect(say(`${f ? 'male' : 'female'} basculegion`).theirs).toEqual([other]);
    expect(say('male basculegion female basculegion').theirs).toEqual(['Basculegion', 'Basculegion-F']);
  });

  it('then yours, in the order picked: the ones you bring and your leads', () => {
    const six = say('sneasler incineroar kingambit garchomp gholdengo pelipper');
    const r = readPreview('incineroar whimsicott garchomp sneasler charizard', six, env);
    // Incineroar is theirs too: with their six in, names are yours. Only four are brought.
    expect(r.picks.mine).toEqual([0, 4, 2, 3]);
    expect(r.said).toEqual(['your Incineroar', 'your Whimsicott', 'your Garchomp', 'your Sneasler']);
  });

  it('"mine" and "theirs" say whose, whatever has been said so far', () => {
    const r = readPreview('they have pelipper archaludon, mine is incineroar and garchomp, theirs gholdengo', none, env);
    expect(r.picks).toEqual({theirs: ['Pelipper', 'Archaludon', 'Gholdengo'], mine: [0, 2]});
  });

  it('taking back and clearing', () => {
    expect(say('pelipper archaludon scratch that gholdengo').theirs).toEqual(['Pelipper', 'Gholdengo']);
    expect(say('pelipper archaludon', 'clear', 'garchomp').theirs).toEqual(['Garchomp']);
    expect(say('mine incineroar garchomp undo sneasler').mine).toEqual([0, 3]);
    // Said twice is once.
    expect(say('pelipper', 'pelipper').theirs).toEqual(['Pelipper']);
  });

  it('a line from the battle means it has started', () => {
    expect(readPreview('The opposing trainer sent out Sneasler and Garchomp!', none, env).battle).toBe(true);
    expect(readPreview('Go! Incineroar and Charizard!', none, env).battle).toBe(true);
    // Not every "go" is the battle.
    expect(readPreview('pelipper go', none, env)).toMatchObject({battle: false, picks: {theirs: ['Pelipper']}});
    expect(readPreview('nothing to see here', none, env)).toMatchObject({battle: false, said: []});
  });
});

describe('the first real test (Chrome on Android)', () => {
  // Their six and your team then. Names the bundled data lacks are added; the format's 200+ others stay, as decoys.
  const extra = {Rillaboom: 0.3, Corviknight: 0.12, Pidgeot: 0.04, Altaria: 0.05};
  const live = {
    ...fmt,
    preview: {...fmt.preview, ...Object.fromEntries(Object.keys(extra).map(n => [n, [n]]))},
    previewUsage: {...fmt.previewUsage, ...extra},
  } as FormatData;
  const THEIRS = ['Kingambit', 'Rillaboom', 'Altaria', 'Corviknight', 'Pidgeot', 'Gholdengo'];
  const MINE = parseTeam(['Indeedee-F', 'Dragapult', 'Milotic', 'Metagross-Mega', 'Arcanine-Hisui', 'Altaria'].map(s => `${s}\n- Protect`).join('\n\n'));
  const real = {fmt: live, gen, team: MINE, bring: 4};
  const opp = (slot: number): MonRef => ({side: 'opp', slot});
  const me = (slot: number): MonRef => ({side: 'me', slot});

  it('their six at team preview, as the phone heard them', () => {
    const r = readPreview('idiot King Gambit Carbonite relay boom gardenia', none, real);
    expect(r.picks.theirs).toEqual(['Pidgeot', 'Kingambit', 'Corviknight', 'Rillaboom', 'Gholdengo']);
    expect(readPreview('Alitalia', r.picks, real).picks.theirs).toHaveLength(6);
    // Not a Pokémon at all: nothing, not a guess.
    for (const filler of ['not nothing yet', 'Thursday night', 'okay', 'Google', 'organized', 'la la la la', 'available']) {
      expect(readPreview(filler, none, real).picks.theirs).toEqual([]);
    }
  });

  it('yours, numbered as you picked them', () => {
    const six = {theirs: THEIRS, mine: null};
    const r = readPreview('I brought dragon food Dragon Ball 1 Arcanine to Celtic 3 Metagross 4', six, real);
    expect(r.picks.mine).toEqual([1, 4, 2, 3]);
  });

  it('"I brought", a pause, then the names: still yours, even with their six not all in', () => {
    const five = {theirs: THEIRS.slice(0, 5), mine: null};
    const first = readPreview('I brought', five, real);
    expect(first.side).toBe('mine');
    expect(readPreview('Dragon Ball', first.picks, real, first.side).picks).toEqual({theirs: THEIRS.slice(0, 5), mine: [1]});
    // Without it, a name after the pause would count as theirs.
    expect(readPreview('Dragon Ball', first.picks, real).picks.mine).toBeNull();
  });

  it("what it can't tell apart it offers to tap", () => {
    // Close enough to take straight away…
    expect(readPreview('pidge ought', none, real).picks.theirs).toEqual(['Pidgeot']);
    // …or only by its consonants, which among hundreds is a guess.
    const r = readPreview('picture', none, real);
    expect(r.picks.theirs).toEqual([]);
    expect(r.unsure[0]).toMatchObject({side: 'theirs', options: expect.arrayContaining(['Pidgeot'])});
  });

  describe('the leads, at the start of the battle', () => {
    const start = () => {
      const b = createBattle(live, MINE, THEIRS, 'test');
      b.live.active = {me: [1, 4], opp: [null, null]};
      return b;
    };
    const read = (text: string, b = start()) => parseNarration(text, {battle: b, gen, mons: undefined});
    const sent = (...mons: MonRef[]) => mons.map(mon => ({kind: 'sendOut', mon}));

    it('said plainly, however the names came out', () => {
      expect(read('opponents and in relabum and curvonite')).toEqual(sent(opp(1), opp(3)));
      expect(read('opponent sent upon it sent really boom and carbonite')).toEqual(sent(opp(1), opp(3)));
      expect(read('opponent leads with Pidgeot and Kingambit')).toEqual(sent(opp(4), opp(0)));
    });

    it('a species on both sides is the side being talked about', () => {
      expect(read('opponent Pidgeot and Altaria')).toEqual(sent(opp(4), opp(2)));
      const b = start();
      b.live.active = {me: [null, null], opp: [1, 3]};
      expect(read('I lead Altaria and Dragapult', b)).toEqual(sent(me(5), me(1)));
    });

    it("names of Pokémon already out, or said with nothing free, bring nobody in", () => {
      const b = start();
      b.live.active.opp = [1, 3];
      expect(read('marilaboom curvy night', b)).toEqual([]);
      expect(read('Pidgeot', b)).toEqual([]);
    });

    it("everyday words aren't names", () => {
      for (const filler of ['but what are you trying to do', 'I know', 'I mean', 'almost', 'person', 'YouTube', 'available', 'brought', 'and']) {
        expect(read(filler)).toEqual([]);
      }
    });
  });

  it('a move said exactly still counts with "used" misheard (the voice model, a Spanish accent)', () => {
    const b = createBattle(live, MINE, THEIRS, 'test');
    b.live.active = {me: [1, 4], opp: [1, 3]};
    const events = parseNarration('Opposing Rillaboom Mus said Fake Out Dragapult.', {battle: b, gen, mons: undefined});
    expect(events[0]).toEqual({kind: 'use', actor: opp(1), move: 'Fake Out'});
    // Not across a number or another Pokémon: "Rillaboom 45 Fake Out" is its HP, then a move nobody used.
    expect(parseNarration('Rillaboom 45 Fake Out', {battle: b, gen, mons: undefined})[0]).toEqual({kind: 'hp', mon: opp(1), value: 45});
  });
});

/** The browser's recogniser, driven by hand. */
class FakeRecognizer implements Recognizer {
  static all: FakeRecognizer[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: Recognizer['onresult'] = null;
  onerror: Recognizer['onerror'] = null;
  onend: Recognizer['onend'] = null;
  onaudiostart: Recognizer['onaudiostart'] = null;
  active = false;
  starts = 0;
  constructor() {
    FakeRecognizer.all.push(this);
  }
  start() {
    if (this.active) throw new Error('already started');
    this.active = true;
    this.starts++;
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    setTimeout(() => this.onend?.(), 20);
  }
  abort() {
    this.stop();
  }
  say(text: string) {
    this.onresult?.({resultIndex: 0, results: [Object.assign([{transcript: text}], {isFinal: true})]});
  }
  /** It stops by itself after a pause, or straight away when it can't work. */
  end() {
    this.active = false;
    this.onend?.();
  }
}

describe('one speech session for the whole app', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognizer.all = [];
  });
  afterEach(() => vi.useRealTimers());

  const session = () => {
    const s = new SpeechSession(() => FakeRecognizer);
    s.start();
    const rec = () => FakeRecognizer.all[FakeRecognizer.all.length - 1];
    /** A whole phrase, then the pause that ends it. */
    const phrase = (text: string) => {
      rec().say(text);
      vi.advanceTimersByTime(QUIET_MS);
    };
    return {s, rec, phrase};
  };

  it("puts Android's pieces of a phrase together, whole-again repeats and revisions included", () => {
    const {s, rec} = session();
    const got: string[] = [];
    s.take(a => got.push(a[0]));
    // As the phone sent them in the first real test: their six at team preview.
    for (const p of ['idiot King', ' Gambit', ' Carbonite', 'idiot King Gambit carbonite', 'idiot King Gambit Carbonite', ' relay', ' boom', ' gardeno']) {
      rec().say(p);
      vi.advanceTimersByTime(300);
    }
    expect(s.getState().interim).toBe('idiot King Gambit Carbonite relay boom gardeno');
    rec().say('idiot King Gambit Carbonite relay boom gardenia');
    expect(got).toEqual([]);
    vi.advanceTimersByTime(QUIET_MS);
    expect(got).toEqual(['idiot King Gambit Carbonite relay boom gardenia']);
    expect(s.getState().interim).toBe('');
  });

  it('a pause ends a phrase; the session ending does too', () => {
    const {s, rec} = session();
    const got: string[] = [];
    s.take(a => got.push(a[0]));
    for (const p of ['opponent', ' sent', ' really', ' boom']) rec().say(p);
    vi.advanceTimersByTime(QUIET_MS);
    rec().say('and carbonite');
    rec().end();
    expect(got).toEqual(['opponent sent really boom', 'and carbonite']);
  });

  it('whichever screen is showing takes the phrases; one heard in between waits for the next', () => {
    const {s, phrase} = session();
    const preview: string[] = [];
    const battle: string[] = [];
    const letGo = s.take(a => preview.push(a[0]));
    phrase('sneasler garchomp');
    letGo();
    phrase('go incineroar');
    vi.advanceTimersByTime(WAIT_MS / 2);
    s.take(a => battle.push(a[0]));
    expect([preview, battle]).toEqual([['sneasler garchomp'], ['go incineroar']]);
    expect(s.getState().listening).toBe(true);
  });

  it('a line passed on goes to the next screen', () => {
    const {s, phrase} = session();
    const battle: string[] = [];
    const letGo = s.take(a => s.passOn(a));
    phrase('the opposing trainer sent out sneasler');
    letGo();
    s.take(a => battle.push(a[0]));
    expect(battle).toEqual(['the opposing trainer sent out sneasler']);
  });

  it('with nobody taking phrases for a while, it stops listening; old phrases are dropped', () => {
    const {s, phrase} = session();
    s.take(() => {})();
    phrase('old news');
    vi.advanceTimersByTime(IDLE_MS + 100);
    expect(s.getState().listening).toBe(false);
    const got: string[] = [];
    s.take(a => got.push(a[0]));
    expect(got).toEqual([]);
  });

  it('a phrase sent again after it went out, or again with more, counts once', () => {
    const {s, phrase} = session();
    const got: string[] = [];
    s.take(a => got.push(a[0]));
    phrase('garchomp used earthquake');
    phrase('Garchomp used Earthquake');
    phrase('garchomp used earth quake sneasler 40');
    expect(got).toEqual(['garchomp used earthquake', 'sneasler 40']);
  });

  it('restarts after a pause; a session being replaced stays stopped', () => {
    const {s, rec} = session();
    const first = rec();
    vi.advanceTimersByTime(5000);
    first.end();
    expect(first.starts).toBe(2);
    s.stop();
    s.start();
    vi.advanceTimersByTime(50);
    expect([first.active, first.starts, rec() !== first, rec().active]).toEqual([false, 2, true, true]);
  });

  it('says why in a browser without speech recognition (Firefox)', () => {
    vi.stubGlobal('navigator', {userAgent: 'Mozilla/5.0 (Android 16; Mobile; rv:156.0) Gecko/156.0 Firefox/156.0'});
    const s = new SpeechSession(() => undefined);
    s.start();
    expect(s.getState()).toMatchObject({listening: false, error: expect.stringMatching(/^Firefox has no speech recognition.*Chrome/)});
    vi.unstubAllGlobals();
  });

  it('gives up with a message when it keeps stopping straight away', () => {
    const {s, rec} = session();
    for (let k = 0; k < 4; k++) rec().end();
    expect(s.getState()).toMatchObject({listening: false, error: expect.stringMatching(/keeps stopping/)});
  });
});
