/**
 * Voice narration: read the game's text as it appears ("The opposing Salamence used Draco
 * Meteor!", "Charizard 45", "A critical hit!") and it's logged as if tapped. What was heard
 * and what was done show here; mistakes go with Undo like anything else.
 */
import {useEffect, useRef, useState} from 'react';
import type {Gen} from '../../data/dex';
import type {StateCtx} from '../../engine/state';
import type {InferResult} from '../../engine/worker';
import type {Battle, SideID} from '../../engine/types';
import {battleById} from '../../state/store';
import {testLog, testLogOn} from '../../testlog';
import {useWakeLock} from '../wake';
import {Narrator, type VoiceIO} from './voice/narrator';
import {narrationPhrases, parseNarration} from './voice/parse';
import {useSpeech} from './voice/useSpeech';

/** What the voice model is doing, while it's not showing words. */
export const ACTIVITY = {loading: 'Loading the voice model…', hearing: 'Hearing you…', reading: 'Reading it…'} as const;

/** Long enough for the HP to show after the text; the next move logs it sooner. */
const COMMIT_AFTER_MS = 6000;

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
    setDraft('');
  };

  const onFinal = (alternatives: string[]) => {
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
      ...(events.length ? [] : [{text: `didn't catch: “${alternatives[0].trim()}”`, bad: true}]),
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
    const w = window as unknown as {__narrate?: (t: string) => void};
    w.__narrate = t => feedText.current([t]);
    return () => {
      delete w.__narrate;
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
      {(listening || draft || error) && (
        <div className="voice-panel">
          {error && <div className="note alert">{error}</div>}
          {listening && <div className="voice-live">{interim ? `…${interim}` : activity ? ACTIVITY[activity] : 'Read the battle text as it appears; add HP where you have it.'}</div>}
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
