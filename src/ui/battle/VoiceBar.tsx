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
import {useStore} from '../../state/store';
import {Narrator, type VoiceIO} from './voice/narrator';
import {parseNarration} from './voice/parse';
import {speechSupported, useSpeech} from './voice/useSpeech';

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
      battle: () => useStore.getState().battles.find(b => b.id === battleId)!,
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
  const commitNow = () => {
    window.clearTimeout(timer.current);
    const done = narrator.current!.commit();
    if (done) note([{text: done}]);
    setDraft('');
  };

  const onFinal = (alternatives: string[]) => {
    const n = narrator.current!;
    const env = {battle: useStore.getState().battles.find(b => b.id === battleId)!, gen, mons: latest.current.result?.mons};
    // The recogniser's alternatives: take the one that makes the most sense.
    let events = parseNarration(alternatives[0], env);
    for (const alt of alternatives.slice(1)) {
      const e = parseNarration(alt, env);
      if (e.length > events.length) events = e;
    }
    const done = n.feed(events);
    note([
      ...(events.length ? [] : [{text: `didn't catch: “${alternatives[0].trim()}”`, bad: true}]),
      ...done.map(text => ({text, bad: !text.startsWith('✓') && !text.startsWith('—') && /\?|isn't|wasn't|can't/.test(text)})),
    ]);
    setDraft(n.describe());
    window.clearTimeout(timer.current);
    if (n.open) timer.current = window.setTimeout(commitNow, COMMIT_AFTER_MS);
  };

  const {listening, interim, error, start, stop} = useSpeech(onFinal);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Development only: feed narration as text (window.__narrate("…")) to try it without a microphone.
  const feedText = useRef(onFinal);
  feedText.current = onFinal;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as {__narrate?: (t: string) => void};
    w.__narrate = t => feedText.current([t]);
    return () => {
      delete w.__narrate;
    };
  }, []);

  if (!speechSupported()) return null;
  const toggle = () => {
    if (listening) {
      stop();
      commitNow();
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
          {listening && <div className="voice-live">{interim ? `…${interim}` : 'Read the battle text as it appears; add HP where you have it.'}</div>}
          {draft && (
            <div className="voice-draft">
              <span>{draft}</span>
              <button className="btn sm" onClick={commitNow}>✓</button>
              <button className="btn sm ghost" onClick={() => {
                window.clearTimeout(timer.current);
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
