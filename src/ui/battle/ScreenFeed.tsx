/**
 * The battle logged from the game's screen: what the screen reader reads (src/screen) goes to the narrator, which
 * logs it as if tapped. What was read and what it did show here; a mistake goes with Undo like anything else.
 */
import {useEffect, useRef, useState} from 'react';
import type {Gen} from '../../data/dex';
import type {StateCtx} from '../../engine/state';
import type {InferResult} from '../../engine/worker';
import type {Battle, MonRef, SideID} from '../../engine/types';
import {useCapture} from '../../screen/capture';
import {describe, onReadings, useReader, type Reading} from '../../screen/reader';
import {battleById} from '../../state/store';
import {testLog} from '../../testlog';
import {Narrator, type NarratorIO} from './narration/narrator';
import {parseNarration, type NarrationEvent} from './narration/parse';
import {similarity, squash} from './narration/text';

/** How alike the name read in an HP box must be to a Pokémon's to be taken as it. */
const NAME_LIKE = 0.6;
/** The same text read again this soon, with nothing else read in between, is the same message (a menu was over it). */
const AGAIN_MS = 5000;
/** What the game's text never says (HP is read from the HP boxes; turns end at the move-select screen). */
const NOT_FROM_TEXT = new Set<NarrationEvent['kind']>(['hp', 'endTurn', 'order']);

/** Whose HP box it is: the name read in it, among that side's Pokémon out, else where it's shown (theirs mirrored). */
export function hpOwner(b: Battle, r: Extract<Reading, {kind: 'hp'}>): MonRef | undefined {
  const side: SideID = r.side;
  const out = b.live.active[side].filter((s): s is number => s !== null);
  const names = (slot: number) => (side === 'me' ? [b.myTeam[slot]?.nickname, b.myTeam[slot]?.species] : [b.oppPreview[slot]])
    .filter((n): n is string => !!n).flatMap(n => [n, n.split('-')[0]]);
  const read = squash(r.name.replace(/^mega\s+/i, ''));
  let best: {slot: number; score: number} | null = null;
  for (const slot of out) for (const n of names(slot)) {
    const score = similarity(read, squash(n));
    if (!best || score > best.score) best = {slot, score};
  }
  if (read && best && best.score >= NAME_LIKE) return {side, slot: best.slot};
  // Theirs face you: the first sent out is on the right.
  const slot = b.live.active[side][side === 'opp' ? 1 - r.screen : r.screen];
  return slot === null || slot === undefined ? undefined : {side, slot};
}

/** Words the recogniser ran together ("usedLight Screen"): the game never puts a capital straight after a small letter. */
export const spaced = (text: string) => text.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');

/** A reading as the narrator takes it. */
export function readingEvents(b: Battle, gen: Gen, mons: NarratorIO['mons'], r: Reading): NarrationEvent[] {
  const env = {battle: b, gen, mons: mons()};
  switch (r.kind) {
    case 'message':
      return parseNarration(spaced(r.text), env).filter(e => !NOT_FROM_TEXT.has(e.kind));
    case 'popup':
      // Theirs on the right: "The opposing Raichu's Electric Surge" (both sides can have a Raichu).
      return parseNarration(`${r.side === 'opp' ? 'The opposing ' : ''}${spaced(r.text)}`, env).filter(e => !NOT_FROM_TEXT.has(e.kind));
    case 'hp': {
      const mon = hpOwner(b, r);
      return mon && r.value !== null ? [{kind: 'hp', mon, value: r.value}] : [];
    }
    case 'command':
      return [{kind: 'endTurn'}];
  }
}

export function ScreenFeed({battleId, gen, result, run, ctxFor, onAskSwitch, onLogged}: {
  battleId: string;
  gen: Gen;
  result: InferResult | null;
  run(fn: (b: Battle, c: StateCtx) => Battle): void;
  ctxFor(b: Battle): StateCtx;
  onAskSwitch(side: SideID, slot: number): void;
  onLogged(): void;
}) {
  const capture = useCapture();
  const reader = useReader();
  const [lines, setLines] = useState<{read: string; did: string}[]>([]);
  const [draft, setDraft] = useState('');
  const latest = useRef({result, run, ctxFor, onAskSwitch, onLogged});
  latest.current = {result, run, ctxFor, onAskSwitch, onLogged};
  const narrator = useRef<Narrator | null>(null);
  if (!narrator.current) {
    const io: NarratorIO = {
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

  useEffect(() => {
    const n = narrator.current!;
    /** The last text read, to know it again. */
    let last: {key: string; at: number} | null = null;
    const take = (items: Reading[], at: number) => {
      const b = battleById(battleId);
      if (!b) return;
      const shown: {read: string; did: string}[] = [];
      for (const r of items) {
        if (r.kind === 'message' || r.kind === 'popup') {
          const key = `${r.kind}:${r.kind === 'popup' ? r.side : ''}:${squash(r.text)}`;
          const again = last && last.key === key && at - last.at < AGAIN_MS;
          last = {key, at};
          if (again) continue;
        }
        const now = battleById(battleId)!;
        const events = readingEvents(now, gen, () => latest.current.result?.mons, r);
        const did = events.length ? n.feed(events) : [];
        testLog('screen-log', {battle: battleId, turn: now.turn, read: describe(r), events, did, draft: n.describe()});
        shown.push({read: describe(r), did: did.join(' · ')});
      }
      setLines(prev => [...shown.reverse(), ...prev].slice(0, 4));
      setDraft(n.describe());
    };
    // Nothing logged yet: the readings from just before the battle was opened too (the game's first lines).
    const b = battleById(battleId);
    const since = b && !b.events.some(e => e.kind === 'action') ? Date.now() - 90_000 : undefined;
    return onReadings(take, since);
  }, [battleId, gen]);

  if (!capture.on) return null;
  const status = reader.status === 'loading' ? 'Loading the screen reader…'
    : reader.status === 'error' ? `Screen reader: ${reader.error}`
      : reader.status === 'reading' ? `Reading the game (${reader.ms} ms a frame)` : 'Screen reader off';
  return (
    <div className="screen-feed">
      <div className={`small ${reader.status === 'error' ? 'bad' : 'muted'}`}>{status}</div>
      {draft && <div className="screen-line open">{draft} …</div>}
      {lines.map((l, i) => (
        <div key={i} className="screen-line">
          <span className="read">{l.read}</span>
          {l.did && <span className="did"> → {l.did}</span>}
        </div>
      ))}
    </div>
  );
}
