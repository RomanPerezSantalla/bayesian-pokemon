/**
 * Voice narration: read the game's text as it appears ("The opposing Salamence used Draco
 * Meteor!", "Charizard 45", "A critical hit!") and it's logged as if tapped. What was heard
 * and what was done show here; mistakes go with Undo like anything else.
 */
import {useEffect, useRef, useState} from 'react';
import type {Gen} from '../../data/dex';
import {loadLearnsets, type Learns} from '../../data/learnsets';
import {maxHPOf, type StateCtx} from '../../engine/state';
import type {InferResult} from '../../engine/worker';
import type {Battle, SideID} from '../../engine/types';
import {loadReader, readerReady, readWith} from '../../speech/reader';
import {installedManifest} from '../../speech/store';
import {battleById} from '../../state/store';
import {testLog, testLogOn} from '../../testlog';
import {useWakeLock} from '../wake';
import {namesPutBack, switchPutPlain} from './voice/heard';
import {battleContext, battleShown, mentionsLeftOut, modelInput, readBattleAnswer, saidSo, yesSaid, type Known} from './voice/lm';
import {Narrator, type NarratorState, type VoiceIO} from './voice/narrator';
import {narrationPhrases, parseNarration} from './voice/parse';
import {speech, useSpeech} from './voice/useSpeech';

/** What the voice model is doing, while it's not showing words. */
export const ACTIVITY = {loading: 'Loading the voice model…', hearing: 'Hearing you…', reading: 'Reading it…'} as const;

/** A line nothing came of, as heard; the voice model can hear speech and read no words in it ("."). */
export const missed = (heard: string) => (/[\p{L}\p{N}]/u.test(heard) ? `didn’t catch: “${heard.trim()}”` : 'didn’t catch that');

/**
 * How loud the microphone is, live, so it's plain it's hearing you before a word is made out. Drawn
 * straight onto the bar each frame, not through React; hidden when the recogniser doesn't show it.
 */
export function MicMeter() {
  const box = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const v = speech.level();
      if (box.current) box.current.style.visibility = v === null ? 'hidden' : 'visible';
      // Up at once, down gently, so a word reads as a swell rather than flicker.
      shown = Math.max(v ?? 0, shown - 0.04);
      if (bar.current) bar.current.style.width = `${Math.round(100 * shown)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span ref={box} className="mic-meter" title="How loud the microphone is"><span ref={bar} /></span>;
}

/** Long enough for the HP to show after the text; the next move logs it sooner. */
const COMMIT_AFTER_MS = 6000;
/** How sure the language model must be of a line to apply it as heard; a less sure one is offered to tap. */
export const SURE = 0.6;
/** For a line that ends the turn or takes the phrase before back. */
const DISRUPTIVE = 0.95;
/** How long what a phrase did stays "the phrase before", to be put right by the next one. */
export const BEFORE_MS = 60_000;

/** A line of the model's answer for the screen: "use opp:Froslass Protect" as "Froslass: Protect". */
const lineLabel = (line: string) => line.replace(/^use (\S+) (.+?)(?: > (.+))?$/, (_, a, m, t) => `${a}: ${m}${t ? ` → ${t}` : ''}`)
  .replaceAll('opp:', '').replaceAll('me:', 'your ');

/** What the last phrase did, while it can still be taken back: the battle and narrator before it, the battle after. */
interface LastPhrase {
  battle: Battle;
  narrator: NarratorState;
  after: Battle;
  lines: string[];
  at: number;
}

export function VoiceBar({battleId, gen, result, run, ctxFor, onAskSwitch, onLogged}: {
  battleId: string;
  gen: Gen;
  result: InferResult | null;
  run(fn: (b: Battle, c: StateCtx) => Battle): void;
  ctxFor(b: Battle): StateCtx;
  onAskSwitch(side: SideID, slot: number): void;
  onLogged(): void;
}) {
  const [lines, setLines] = useState<{text: string; bad?: boolean}[]>([]);
  const [draft, setDraft] = useState('');
  const timer = useRef<number | undefined>(undefined);
  // The narrator outlives renders; it reads the latest of everything through these.
  const latest = useRef({result, run, ctxFor, onAskSwitch, onLogged});
  latest.current = {result, run, ctxFor, onAskSwitch, onLogged};
  const narrator = useRef<Narrator | null>(null);
  if (!narrator.current) {
    const io: VoiceIO = {
      gen,
      battle: () => battleById(battleId)!,
      mons: () => latest.current.result?.mons,
      ctx: b => latest.current.ctxFor(b),
      apply: fn => {
        latest.current.run(fn);
        latest.current.onLogged();
      },
      askSwitch: (side, slot) => latest.current.onAskSwitch(side, slot),
    };
    narrator.current = new Narrator(io);
  }

  const note = (items: {text: string; bad?: boolean}[]) => {
    if (items.length) setLines(prev => [...items.reverse(), ...prev].slice(0, 3));
  };
  const commitNow = (how: 'pause' | 'tap' | 'stop') => {
    window.clearTimeout(timer.current);
    const n = narrator.current!;
    const was = n.open ? n.describe() : '';
    const done = n.commit();
    if (done) note([{text: done}]);
    if (was || done) testLog('voice-commit', {battle: battleId, how, draft: was, did: done});
    // Logging the phrase's move is still that phrase: taking it back takes this back too.
    const last = lastPhrase.current;
    if (done && last && battleById(battleId) !== last.after) last.after = battleById(battleId)!;
    setDraft('');
  };

  // --- by the language model (speech/reader.ts), when it's loaded ---------------------------------
  const lastPhrase = useRef<LastPhrase | null>(null);
  const reading = useRef<Promise<void>>(Promise.resolve());
  const [thinking, setThinking] = useState(false);
  /** Lines the model wasn't sure of: offered to tap. */
  const [offers, setOffers] = useState<string[]>([]);
  // The same, for a "yes" heard before the next render.
  const offersNow = useRef<string[]>([]);
  offersNow.current = offers;
  const learns = useRef<Learns | null>(null);
  const known = (b: Battle): Known => {
    const c = latest.current.ctxFor(b);
    return {gen, fmt: c.fmt, learns: learns.current ?? undefined, maxHp: ref => maxHPOf(c, b.live, ref)};
  };

  const afterFeed = (n: Narrator) => {
    setDraft(n.describe());
    window.clearTimeout(timer.current);
    if (n.open) timer.current = window.setTimeout(() => commitNow('pause'), COMMIT_AFTER_MS);
  };

  const byModel = async (alternatives: string[]) => {
    const n = narrator.current!;
    const heard = alternatives[0];
    const last = lastPhrase.current;
    // What the phrase before did, while it's recent and nothing else has changed the battle since.
    const fresh = last && Date.now() - last.at < BEFORE_MS && battleById(battleId) === last.after ? last : null;
    const {me, opp} = battleShown(battleById(battleId)!);
    setThinking(true);
    const [answer] = await Promise.all([
      readWith(modelInput(battleContext(me, opp, fresh?.lines ?? []), heard)).finally(() => setThinking(false)),
      loadLearnsets().then(l => (learns.current = l)),
    ]);
    const b = battleById(battleId)!;
    // Ending the turn and taking the phrase before back upset the most when wrong: they need the model surer.
    // They also need words for them in the phrase ("from last turn…" isn't the end of one).
    const unsaid = answer.lines.filter(l => !saidSo(l.text, heard));
    const lines = answer.lines.filter(l => saidSo(l.text, heard));
    const sure = (l: {text: string; p: number}) => l.p >= (l.text === 'endturn' || l.text === 'undo' ? DISRUPTIVE : SURE);
    const read = readBattleAnswer(b, known(b), lines.filter(sure).map(l => l.text).join('\n'));
    const told = lines.filter(l => l.text !== 'undo' && l.text !== 'none').length;
    const taken = read.lines.length;
    const unsure = readBattleAnswer(b, known(b), lines.filter(l => !sure(l) && l.text !== 'undo').map(l => l.text).join('\n'));
    read.dropped.push(...unsaid.map(l => ({line: l.text, why: 'not said'})));
    // Abilities and items named that the answer leaves out ("…Electromorphosis activated", "…Chople Berry", "Intimidate.").
    const extra = mentionsLeftOut(b, known(b), heard, [...read.lines, ...unsure.lines]);
    if (extra.length) {
      const r = readBattleAnswer(b, known(b), extra.join('\n'));
      read.events.push(...r.events);
      read.lines.push(...r.lines);
    }
    const notes: {text: string; bad?: boolean}[] = [];
    // Taking the phrase before back only to say it again, the same, is nothing ("Lopunny not intimidated" after an Intimidate).
    if (read.undo && fresh && read.lines.join('\n') === fresh.lines.join('\n')) Object.assign(read, {undo: false, events: [], lines: []});
    // A correction not all of which could be taken (the check dropped a line of it, or the model wasn't sure of one):
    // the phrase before stays as it was, and none of it is done ("It was Protect…": "Lopunny Protect", which it hasn't).
    if (read.undo && taken < told) {
      Object.assign(read, {undo: false, events: [], lines: []});
      notes.push({text: 'couldn’t read the correction: nothing changed', bad: true});
    }
    if (read.undo) {
      if (fresh && battleById(battleId) === fresh.after) {
        window.clearTimeout(timer.current);
        latest.current.run(() => fresh.battle);
        n.load(fresh.narrator);
        notes.push({text: `took back: ${fresh.lines.map(lineLabel).join(', ') || 'that'}`});
      } else {
        // The right version of something that can't be taken back would be logged twice: nothing is done.
        notes.push({text: 'nothing to take back here: use Undo', bad: true});
        Object.assign(read, {events: [], lines: []});
      }
    }
    const before = {battle: battleById(battleId)!, narrator: n.save()};
    const done = n.feed(read.events);
    if (read.lines.length) lastPhrase.current = {...before, after: battleById(battleId)!, lines: read.lines, at: Date.now()};
    else if (read.undo) lastPhrase.current = null;
    setOffers(unsure.lines.filter(l => !read.lines.includes(l)));
    testLog('voice', {battle: battleId, turn: b.turn, heard: alternatives, used: 0, events: read.events, did: done, draft: n.describe(),
      reader: {lines: answer.lines, ms: answer.ms, tokens: answer.tokens, reused: answer.reused, before: fresh?.lines, undo: read.undo,
        dropped: [...read.dropped, ...unsure.dropped], offered: unsure.lines}});
    note([
      ...notes,
      ...(read.events.length || read.undo || unsure.lines.length ? [] : [{text: missed(heard), bad: true}]),
      ...done.map(text => ({text, bad: !text.startsWith('✓') && !text.startsWith('—') && /\?|isn't|wasn't|can't/.test(text)})),
    ]);
    afterFeed(n);
  };

  /** A line the model wasn't sure of, tapped: applied as if heard. */
  const takeOffer = (line: string) => {
    const n = narrator.current!;
    const b = battleById(battleId)!;
    const read = readBattleAnswer(b, known(b), line);
    const before = {battle: b, narrator: n.save()};
    const done = n.feed(read.events);
    lastPhrase.current = {...before, after: battleById(battleId)!, lines: read.lines, at: Date.now()};
    setOffers(o => o.filter(x => x !== line));
    testLog('voice-offer', {battle: battleId, line, did: done});
    note(done.map(text => ({text})));
    afterFeed(n);
  };

  const onFinal = (heard: string[]) => {
    // Names as the recogniser has been heard to spell them ("Right to" for Raichu), put back for this battle's Pokémon;
    // a switch said as "X switch for Y", put as the reader knows one.
    const b = battleById(battleId)!;
    const names = [...b.myTeam.map(s => s.species), ...b.oppPreview];
    const alternatives = heard.map(t => switchPutPlain(namesPutBack(t, names), names));
    // "Yes" to what was offered to tap.
    const offered = offersNow.current;
    if (offered.length && yesSaid(alternatives[0])) {
      testLog('voice', {battle: battleId, heard: alternatives, used: 0, events: [], did: [], draft: narrator.current!.describe(), reader: {yes: offered}});
      offersNow.current = [];
      for (const o of offered) takeOffer(o);
      return;
    }
    if (readerReady()) {
      reading.current = reading.current.then(() => byModel(alternatives)).catch(err => {
        testLog('voice-error', {battle: battleId, error: `reader: ${err instanceof Error ? err.message : String(err)}`});
        byRules(alternatives);
      });
      return;
    }
    byRules(alternatives);
  };

  const byRules = (alternatives: string[]) => {
    const n = narrator.current!;
    const env = {battle: battleById(battleId)!, gen, mons: latest.current.result?.mons};
    // The recogniser's alternatives: take the one that makes the most sense.
    let events = parseNarration(alternatives[0], env);
    let used = 0;
    alternatives.slice(1).forEach((alt, i) => {
      const e = parseNarration(alt, env);
      if (e.length > events.length) [events, used] = [e, i + 1];
    });
    const done = n.feed(events);
    testLog('voice', {battle: battleId, turn: env.battle.turn, heard: alternatives, used, events, did: done, draft: n.describe()});
    note([
      ...(events.length ? [] : [{text: missed(alternatives[0]), bad: true}]),
      ...done.map(text => ({text, bad: !text.startsWith('✓') && !text.startsWith('—') && /\?|isn't|wasn't|can't/.test(text)})),
    ]);
    setDraft(n.describe());
    window.clearTimeout(timer.current);
    if (n.open) timer.current = window.setTimeout(() => commitNow('pause'), COMMIT_AFTER_MS);
  };

  const {listening, interim, error, activity, start, stop} = useSpeech(onFinal,
    () => narrationPhrases({battle: battleById(battleId)!, gen, mons: latest.current.result?.mons}));
  // Nothing is tapped while narrating, so the screen would otherwise lock mid-battle.
  useWakeLock(listening);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (error) testLog('voice-error', {battle: battleId, error});
  }, [error, battleId]);
  // Development and test builds: feed narration as text (window.__narrate("…")) to try it without a microphone.
  const feedText = useRef(onFinal);
  feedText.current = onFinal;
  useEffect(() => {
    if (!import.meta.env.DEV && !testLogOn) return;
    const w = window as unknown as {__narrate?: (t: string) => void; __reader?: () => Promise<boolean>};
    w.__narrate = t => feedText.current([t]);
    // The language model without the microphone: loaded from the installed pack.
    w.__reader = () => installedManifest().then(m => (m ? loadReader(m) : false));
    return () => {
      delete w.__narrate;
      delete w.__reader;
    };
  }, []);

  const toggle = () => {
    if (listening) {
      stop();
      commitNow('stop');
    } else start();
  };
  return (
    <>
      <button className={`btn sm voice-btn${listening ? ' on' : ''}`} onClick={toggle}
        title="Narrate the game's text; add HP where you have it (“Charizard 45”)">
        {listening ? '● Listening' : '🎙 Voice'}
      </button>
      {/* The header stays on screen: only while it's in use. The log keeps everything. */}
      {(listening || draft || error || offers.length > 0) && (
        <div className="voice-panel">
          {error && <div className="note alert">{error}</div>}
          {listening && <div className="voice-live"><MicMeter />{interim ? `…${interim}` : thinking ? ACTIVITY.reading : activity ? ACTIVITY[activity] : 'Read the battle text as it appears; add HP where you have it.'}</div>}
          {offers.map(o => (
            <div key={o} className="voice-draft">
              <span className="muted">{lineLabel(o)}?</span>
              <button className="btn sm" onClick={() => takeOffer(o)}>✓</button>
              <button className="btn sm ghost" onClick={() => setOffers(list => list.filter(x => x !== o))}>✕</button>
            </div>
          ))}
          {draft && (
            <div className="voice-draft">
              <span>{draft}</span>
              <button className="btn sm" onClick={() => commitNow('tap')}>✓</button>
              <button className="btn sm ghost" onClick={() => {
                window.clearTimeout(timer.current);
                testLog('voice-discard', {battle: battleId, draft: narrator.current!.describe()});
                narrator.current!.discard();
                setDraft('');
              }}>✕</button>
            </div>
          )}
          {listening && lines.map((l, i) => <div key={i} className={`voice-line${l.bad ? ' bad' : ''}`}>{l.text}</div>)}
        </div>
      )}
    </>
  );
}
