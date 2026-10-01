/**
 * The language model's worker (readerWorker.ts), for the page. It comes with the voice model's pack
 * and loads alongside it; until it's ready, or if the pack has no reader, voice reads by its rules
 * (ui/battle/voice/parse.ts, preview.ts) as before.
 */
import {testLog} from '../testlog';
import type {AnswerLine, ReaderIn, ReaderOut} from './readerWorker';
import type {Manifest} from './store';

export type {AnswerLine};

export interface Answer {
  lines: AnswerLine[];
  ms: number;
  /** The prompt's length in tokens, and how many of them were the same as last time's (not read again). */
  tokens: number;
  reused: number;
}

let worker: Worker | null = null;
let ready = false;
let loading: Promise<boolean> | null = null;
let nextId = 1;
const waiting = new Map<number, {resolve: (a: Answer) => void; reject: (e: Error) => void}>();

/** Whether this pack has the reader. */
export const hasReader = (m: Manifest) => m.files.some(f => f.name === 'reader.onnx');

/** Starts the reader from the installed pack (once); resolves whether it's ready. */
export function loadReader(m: Manifest): Promise<boolean> {
  if (!hasReader(m)) return Promise.resolve(false);
  if (loading) return loading;
  const w = new Worker(new URL('./readerWorker.ts', import.meta.url), {type: 'module'});
  worker = w;
  loading = new Promise<boolean>(resolve => {
    w.onmessage = (e: MessageEvent<ReaderOut>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        ready = true;
        testLog('reader', {loaded: m.id, ms: msg.ms, threads: msg.threads});
        resolve(true);
      } else if (msg.type === 'answer') {
        waiting.get(msg.id)?.resolve({lines: msg.lines, ms: msg.ms, tokens: msg.tokens, reused: msg.reused});
        waiting.delete(msg.id);
      } else if (msg.type === 'error') {
        testLog('reader', {error: msg.message});
        if (msg.id === undefined) {
          unloadReader();
          resolve(false);
        } else {
          waiting.get(msg.id)?.reject(new Error(msg.message));
          waiting.delete(msg.id);
        }
      }
    };
    w.onerror = e => {
      testLog('reader', {error: e.message || 'the reader stopped'});
      unloadReader();
      resolve(false);
    };
  });
  w.postMessage({type: 'load', manifest: m} satisfies ReaderIn);
  return loading;
}

export const readerReady = () => ready;

/** The model's answer to a prompt (lm.ts's modelInput). */
export function readWith(input: string): Promise<Answer> {
  if (!worker || !ready) return Promise.reject(new Error('the reader isn’t loaded'));
  const id = nextId++;
  return new Promise<Answer>((resolve, reject) => {
    waiting.set(id, {resolve, reject});
    worker!.postMessage({type: 'read', id, input} satisfies ReaderIn);
  });
}

export function unloadReader() {
  worker?.terminate();
  worker = null;
  ready = false;
  loading = null;
  for (const w of waiting.values()) w.reject(new Error('the reader stopped'));
  waiting.clear();
}
