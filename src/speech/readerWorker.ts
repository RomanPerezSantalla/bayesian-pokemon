/// <reference lib="webworker" />
/**
 * The language model that reads what's said into the app's actions (ui/battle/voice/lm.ts), off the
 * main thread: FunctionGemma 270M fine-tuned for it, 8-bit, answering greedily with the KV cache.
 * The start of a prompt that's the same as last time (the field, mostly) isn't read again: its KV
 * cache is kept. Each answer line comes with how sure the model was of it (its least sure token).
 */
import * as ort from 'onnxruntime-web/wasm';
import {Bpe, type BpeData} from './bpe';
import {isOrtThread} from './ortThread';
import {readFile, type Manifest} from './store';

export type ReaderIn =
  | {type: 'load'; manifest: Manifest}
  | {type: 'read'; id: number; input: string};

export interface AnswerLine {
  text: string;
  /** The model's probability for its least sure token in the line. */
  p: number;
}

export type ReaderOut =
  | {type: 'ready'; ms: number; threads: number}
  | {type: 'error'; id?: number; message: string}
  | {type: 'answer'; id: number; lines: AnswerLine[]; ms: number; tokens: number; reused: number};

/** The reader's files in the voice model's pack. */
export interface ReaderData extends BpeData {
  /** The output layer's columns, as token ids. */
  out: number[];
}

const post = (m: ReaderOut) => (self as DedicatedWorkerGlobalScope).postMessage(m);
const MAX_ANSWER = 80;
/** Gemma 3 270M: one key/value head of 256 per layer. */
const HEAD = 256;

let session: ort.InferenceSession | null = null;
let bpe: Bpe | null = null;
let out: number[] = [];
let pastNames: string[] = [];
/** The last prompt and its KV cache, for the next one that starts the same way. */
let kept: {ids: number[]; past: Record<string, ort.Tensor>} | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(m: Manifest) {
  const t0 = performance.now();
  ort.env.wasm.wasmBinary = await readFile(m, 'ort-wasm-simd-threaded.wasm');
  const threads = (self as unknown as {crossOriginIsolated?: boolean}).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.numThreads = threads;
  const data = JSON.parse(new TextDecoder().decode(await readFile(m, 'reader.json'))) as ReaderData;
  bpe = new Bpe(data);
  out = data.out;
  session = await ort.InferenceSession.create(await readFile(m, 'reader.onnx'), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
  pastNames = session.inputNames.filter(n => n.startsWith('past_key_values.'));
  post({type: 'ready', ms: Math.round(performance.now() - t0), threads});
}

const ones = (n: number) => new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);
const emptyPast = () => Object.fromEntries(pastNames.map(n => [n, new ort.Tensor('float32', new Float32Array(0), [1, 1, 0, HEAD])]));
/** The first `len` positions of a kept KV cache. */
const cut = (past: Record<string, ort.Tensor>, len: number) =>
  Object.fromEntries(pastNames.map(n => [n, new ort.Tensor('float32', (past[n].data as Float32Array).subarray(0, len * HEAD), [1, 1, len, HEAD])]));
const presents = (res: ort.InferenceSession.OnnxValueMapType) => Object.fromEntries(pastNames.map(n => [n, res[n.replace('past_key_values.', 'present.')] as ort.Tensor]));

async function read(id: number, input: string) {
  const t0 = performance.now();
  const ids = [bpe!.data.bos, ...bpe!.encode(input)];
  // What's the same as the last prompt's start, at least one token short of this one's end.
  let reused = 0;
  if (kept) while (reused < ids.length - 1 && reused < kept.ids.length && kept.ids[reused] === ids[reused]) reused++;
  let past: Record<string, ort.Tensor> = reused ? cut(kept!.past, reused) : emptyPast();
  let step = ids.slice(reused);
  let len = ids.length;
  const answer: number[] = [];
  const probs: number[] = [];
  for (let s = 0; s < MAX_ANSWER; s++) {
    const res = await session!.run({input_ids: new ort.Tensor('int64', BigInt64Array.from(step.map(BigInt)), [1, step.length]), attention_mask: ones(len), ...past});
    if (s === 0) kept = {ids, past: presents(res)};
    const logits = res.logits.data as Float32Array;
    const [, T, V] = res.logits.dims;
    const at = (T - 1) * V;
    let best = 0;
    for (let v = 1; v < V; v++) if (logits[at + v] > logits[at + best]) best = v;
    let sum = 0;
    for (let v = 0; v < V; v++) sum += Math.exp(logits[at + v] - logits[at + best]);
    const next = out[best];
    if (next === bpe!.data.end || next === bpe!.data.eos) break;
    answer.push(next);
    probs.push(1 / sum);
    past = presents(res);
    step = [next];
    len++;
  }
  post({type: 'answer', id, lines: toLines(answer, probs), ms: Math.round(performance.now() - t0), tokens: ids.length, reused});
}

/** The answer split into lines, each as sure as its least sure token. */
function toLines(answer: number[], probs: number[]): AnswerLine[] {
  const lines: AnswerLine[] = [];
  let text = '';
  let p = 1;
  answer.forEach((t, k) => {
    const piece = bpe!.decode([t]);
    const parts = piece.split('\n');
    parts.forEach((part, j) => {
      if (j > 0) {
        if (text.trim()) lines.push({text: text.trim(), p});
        text = '';
        p = 1;
      }
      text += part;
      if (part.trim()) p = Math.min(p, probs[k]);
    });
  });
  if (text.trim()) lines.push({text: text.trim(), p});
  return lines;
}

// Not in the ONNX runtime's own threads, which run this file too (ortThread.ts).
if (!isOrtThread()) self.onmessage = (e: MessageEvent<ReaderIn>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === 'load') await load(msg.manifest);
      else await read(msg.id, msg.input);
    } catch (err) {
      post({type: 'error', id: msg.type === 'read' ? msg.id : undefined, message: err instanceof Error ? err.message : String(err)});
    }
  });
};
