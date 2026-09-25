/// <reference lib="webworker" />
/**
 * The voice model, off the main thread: audio comes straight from the microphone's worklet, the
 * speech detector finds each line, and the line is read with the names that can come up right
 * now (sent in by the page as the battle goes).
 */
import * as ort from 'onnxruntime-web/wasm';
import {Endpointer, FRAME} from './endpoint';
import {MELS, melFeatures, SAMPLE_RATE} from './features';
import {PhraseCache, readLine, type Reading} from './read';
import {readFile, type Manifest} from './store';
import {parseVocab, type Vocab} from './vocab';

export type WorkerIn =
  | {type: 'load'; manifest: Manifest}
  /** 16 kHz audio from the capture worklet. */
  | {type: 'audio'; port: MessagePort}
  | {type: 'listen'; on: boolean; keepAudio?: boolean}
  | {type: 'context'; phrases: string[]}
  /** A clip read directly (tests, replaying the phone test log). */
  | {type: 'read'; id: number; samples: Float32Array; phrases?: string[]};

export type WorkerOut =
  | {type: 'ready'; ms: number; threads: number}
  /** The stored model came with another version of the runtime: it needs downloading again. */
  | {type: 'outdated'}
  | {type: 'error'; message: string}
  | {type: 'speech'}
  | {type: 'silence'}
  | {type: 'reading'}
  | {type: 'line'; id?: number; reading: Reading; ms: {audio: number; features: number; model: number; read: number}; audio?: Float32Array};

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

let model: ort.InferenceSession | null = null;
let vad: ort.InferenceSession | null = null;
let vocab: Vocab | null = null;
let phrases: PhraseCache | null = null;
let context: string[] = [];
let listening = false;
let keepAudio = false;

// Silero VAD v5 reads each 512-sample frame with the 64 samples before it, and carries a state.
const VAD_CONTEXT = 64;
let vadState = new Float32Array(2 * 128);
let vadContext = new Float32Array(VAD_CONTEXT);
const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

/** The last 16 s of audio, by sample number since listening began. */
const RING = SAMPLE_RATE * 16;
const ring = new Float32Array(RING);
let written = 0;
let pending = new Float32Array(0);
let endpointer = new Endpointer();
/** Frames and lines are handled one at a time, in order. */
let queue: Promise<void> = Promise.resolve();

async function load(m: Manifest) {
  const t0 = performance.now();
  if (m.ort !== ort.env.versions.web) {
    post({type: 'outdated'});
    return;
  }
  ort.env.wasm.wasmBinary = await readFile(m, 'ort-wasm-simd-threaded.wasm');
  const threads = (self as unknown as {crossOriginIsolated?: boolean}).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.numThreads = threads;
  const opts: ort.InferenceSession.SessionOptions = {executionProviders: ['wasm'], graphOptimizationLevel: 'all'};
  vad = await ort.InferenceSession.create(await readFile(m, 'silero_vad.onnx'), opts);
  model = await ort.InferenceSession.create(await readFile(m, 'model.int8.onnx'), opts);
  vocab = parseVocab(new TextDecoder().decode(await readFile(m, 'tokens.txt')));
  phrases = new PhraseCache(vocab);
  post({type: 'ready', ms: Math.round(performance.now() - t0), threads});
}

function reset() {
  vadState = new Float32Array(2 * 128);
  vadContext = new Float32Array(VAD_CONTEXT);
  written = 0;
  pending = new Float32Array(0);
  endpointer = new Endpointer();
}

async function speechProb(frame: Float32Array): Promise<number> {
  const input = new Float32Array(VAD_CONTEXT + FRAME);
  input.set(vadContext);
  input.set(frame, VAD_CONTEXT);
  vadContext = frame.slice(FRAME - VAD_CONTEXT);
  // Near silence isn't worth asking about (and keeps a quiet room cheap).
  let e = 0;
  for (const v of frame) e += v * v;
  if (e / frame.length < 1e-7) return 0;
  const r = await vad!.run({
    input: new ort.Tensor('float32', input, [1, input.length]),
    state: new ort.Tensor('float32', vadState, [2, 1, 128]),
    sr,
  });
  vadState = new Float32Array(r.stateN.data as Float32Array);
  return (r.output.data as Float32Array)[0];
}

function clip(fromFrame: number, toFrame: number): Float32Array {
  const from = Math.max(fromFrame * FRAME, written - RING);
  const to = Math.min(toFrame * FRAME, written);
  const out = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i++) out[i] = ring[(from + i) % RING];
  return out;
}

async function read(samples: Float32Array, context: string[]) {
  const t0 = performance.now();
  const {data, frames} = melFeatures(samples);
  const t1 = performance.now();
  const r = await model!.run({
    audio_signal: new ort.Tensor('float32', data, [1, MELS, frames]),
    length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
  });
  const t2 = performance.now();
  const lp = r.logprobs;
  const reading = readLine({data: lp.data as Float32Array, frames: lp.dims[1], size: lp.dims[2]}, vocab!, phrases!.get(context));
  const t3 = performance.now();
  const ms = {audio: Math.round((samples.length / SAMPLE_RATE) * 1000), features: Math.round(t1 - t0), model: Math.round(t2 - t1), read: Math.round(t3 - t2)};
  return {reading, ms};
}

async function onAudio(chunk: Float32Array) {
  if (!listening || !model) return;
  const joined = new Float32Array(pending.length + chunk.length);
  joined.set(pending);
  joined.set(chunk, pending.length);
  let at = 0;
  for (; at + FRAME <= joined.length; at += FRAME) {
    const frame = joined.subarray(at, at + FRAME);
    for (let i = 0; i < FRAME; i++) ring[(written + i) % RING] = frame[i];
    written += FRAME;
    for (const ev of endpointer.push(await speechProb(frame))) await onEvent(ev);
  }
  pending = joined.slice(at);
}

async function onEvent(ev: ReturnType<Endpointer['push']>[number]) {
  if (ev.kind === 'start') {
    post({type: 'speech'});
    return;
  }
  if (ev.to <= ev.from) {
    post({type: 'silence'});
    return;
  }
  post({type: 'reading'});
  const samples = clip(ev.from, ev.to);
  const {reading, ms} = await read(samples, context);
  if (keepAudio) post({type: 'line', reading, ms, audio: samples}, [samples.buffer]);
  else post({type: 'line', reading, ms});
}

const run = (fn: () => Promise<void>) => {
  queue = queue.then(fn).catch(err => post({type: 'error', message: err instanceof Error ? err.message : String(err)}));
};

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'load':
      run(() => load(m.manifest));
      break;
    case 'audio':
      m.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const chunk = ev.data;
        run(() => onAudio(chunk));
      };
      break;
    case 'listen':
      run(async () => {
        if (!m.on && listening) for (const ev of endpointer.flush()) await onEvent(ev);
        listening = m.on;
        keepAudio = !!m.keepAudio;
        reset();
      });
      break;
    case 'context':
      context = m.phrases;
      break;
    case 'read':
      run(async () => {
        const {reading, ms} = await read(m.samples, m.phrases ?? context);
        post({type: 'line', id: m.id, reading, ms});
      });
      break;
  }
};
