/**
 * The screen reader: the captured game's frames to the reading worker (ocrWorker.ts) a few times a second, one at a
 * time, and what it reads out to whoever is listening (the battle on screen). The last minute and a half of
 * readings are kept, so a battle opened in the app just after the game's first lines still gets them.
 */
import {useSyncExternalStore} from 'react';
import {testLog, testLogOn} from '../testlog';
import {onCaptureTick} from './capture';
import type {OcrIn, OcrOut, Reading} from './ocrWorker';

export type {Reading} from './ocrWorker';

export interface ReaderState {
  status: 'off' | 'loading' | 'reading' | 'error';
  error?: string;
  /** How long reading a frame took lately, ms. */
  ms: number;
  /** The last thing read. */
  last?: string;
}

let state: ReaderState = {status: 'off', ms: 0};
const watchers = new Set<() => void>();
function set(patch: Partial<ReaderState>) {
  state = {...state, ...patch};
  for (const w of watchers) w();
}

export function useReader(): ReaderState {
  return useSyncExternalStore(cb => {
    watchers.add(cb);
    return () => {
      watchers.delete(cb);
    };
  }, () => state);
}

const KEEP_MS = 90_000;
const recent: {at: number; items: Reading[]}[] = [];
/** Readings, with the time of the frame they're from. */
type Listener = (items: Reading[], at: number) => void;
const listeners = new Set<Listener>();

/** Readings from now on; `since`: also those kept from that time on. */
export function onReadings(fn: Listener, since?: number): () => void {
  if (since !== undefined) for (const r of recent) if (r.at >= since) fn(r.items, r.at);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let worker: Worker | null = null;
let busy = false;
let unhook: (() => void) | null = null;

/** Start reading the captured frames (the recogniser loads the first time: about 22 MB with its runtime). */
export function startReader() {
  if (unhook) return;
  if (!worker) {
    set({status: 'loading', error: undefined});
    worker = new Worker(new URL('./ocrWorker.ts', import.meta.url), {type: 'module'});
    worker.onmessage = (e: MessageEvent<OcrOut>) => received(e.data);
    worker.onerror = e => set({status: 'error', error: e.message || 'the reader stopped'});
    send({type: 'load', base: document.baseURI});
  }
  unhook = onCaptureTick(video => {
    if (busy || state.status !== 'reading' || video.readyState < 2) return;
    busy = true;
    createImageBitmap(video).then(frame => send({type: 'frame', t: Date.now(), frame}, [frame]), () => (busy = false));
  });
}

export function stopReader() {
  unhook?.();
  unhook = null;
  busy = false;
  if (state.status === 'reading') set({status: 'off'});
}

function send(m: OcrIn, transfer: Transferable[] = []) {
  worker?.postMessage(m, transfer);
}

/** A frame sent from feedFrames, waiting for its reading. */
let fed: (() => void) | null = null;

/**
 * Development and test copies: recorded frames (image URLs) read as if captured, as fast as they're read:
 * window.__screenFeed(urls). Recorded at 2 a second, each is looked at once (half a second apart, so text must hold
 * still over two of them to be read). Resolves once all are read.
 */
async function feedFrames(urls: string[], from = Date.now()) {
  if (!worker) {
    startReader();
    stopReader();
  }
  while (state.status === 'loading') await new Promise(r => setTimeout(r, 100));
  if (state.status === 'error') throw new Error(state.error);
  set({status: 'reading'});
  for (const [k, url] of urls.entries()) {
    const frame = await createImageBitmap(await (await fetch(url)).blob());
    await new Promise<void>(resolve => {
      fed = resolve;
      send({type: 'frame', t: from + k * 500, frame}, [frame]);
    });
  }
  set({status: 'off'});
}

if (import.meta.env.DEV || testLogOn) (window as unknown as {__screenFeed?: typeof feedFrames}).__screenFeed = feedFrames;

function received(m: OcrOut) {
  if (m.type === 'read' || m.type === 'error') {
    const done = fed;
    fed = null;
    done?.();
  }
  if (m.type === 'ready') {
    testLog('screen-reader', {loaded: m.ms});
    set({status: unhook ? 'reading' : 'off'});
    return;
  }
  if (m.type === 'error') {
    busy = false;
    testLog('screen-reader', {error: m.message});
    set({status: 'error', error: m.message});
    return;
  }
  busy = false;
  set({ms: Math.round(0.8 * state.ms + 0.2 * m.ms)});
  if (m.area) testLog('screen-area', {t: m.t, area: m.area});
  if (!m.items.length) return;
  testLog('screen-read', {t: m.t, items: m.items, ms: m.ms});
  const last = m.items.map(describe).join(' · ');
  set({last});
  recent.push({at: m.t, items: m.items});
  while (recent.length && recent[0].at < m.t - KEEP_MS) recent.shift();
  for (const fn of listeners) fn(m.items, m.t);
}

export function describe(r: Reading): string {
  switch (r.kind) {
    case 'message': return r.text;
    case 'popup': return `${r.side === 'opp' ? 'their ' : ''}${r.text}`;
    case 'hp': return `${r.name || '?'} ${r.value ?? r.raw}${r.side === 'opp' ? '%' : ''}`;
    case 'command': return `choosing moves${r.field ? ` (${r.field})` : ''}`;
  }
}
