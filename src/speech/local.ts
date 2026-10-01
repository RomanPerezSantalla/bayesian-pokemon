/**
 * Voice on this device: the speech model (worker.ts) behind the same interface as the browser's
 * recogniser, so the speech session (ui/battle/voice/useSpeech.ts) uses either. The model is
 * downloaded only when you first turn voice on and agree (store.ts); until then, and for anyone who
 * says no, the app works as before by tapping, or with the browser's recogniser if chosen.
 */
import {testLog, testLogAudio, testLogOn} from '../testlog';
import type {Activity, Recognizer} from '../ui/battle/voice/useSpeech';
import captureUrl from './capture.worklet.ts?worker&url';
import {loadReader, unloadReader} from './reader';
import {fetchManifest, install, installedManifest, uninstall, type Manifest, type Progress} from './store';
import type {WorkerIn, WorkerOut} from './worker';

/** Which recogniser voice uses: the model here, or the browser's (Chrome sends the audio to Google). */
export type Engine = 'local' | 'browser';
const ENGINE_KEY = 'bayesian-battle:voice-engine';

export function chosenEngine(): Engine | null {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    return v === 'local' || v === 'browser' ? v : null;
  } catch {
    return null;
  }
}

export function chooseEngine(e: Engine) {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {
    // Asked again next time.
  }
  setup({engine: e});
}

// --- what the voice set-up screen shows -------------------------------------------------------

export interface VoiceSetup {
  engine: Engine | null;
  /** The model stored here (undefined: not checked yet). */
  installed: Manifest | null | undefined;
  /** The offer to download it is showing. */
  offer: boolean;
  progress: Progress | null;
  error: string | null;
}

let state: VoiceSetup = {engine: chosenEngine(), installed: undefined, offer: false, progress: null, error: null};
const listeners = new Set<() => void>();

function setup(patch: Partial<VoiceSetup>) {
  state = {...state, ...patch};
  for (const fn of listeners) fn();
}

export const voiceSetup = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  get: () => state,
};

/** Whether the model is here, checked at start-up. */
export async function checkInstalled() {
  const m = await installedManifest();
  setup({installed: m});
  return m;
}

/** The download's size, for the offer (from the manifest; null until it's known or if it's not served here). */
export async function packSize(): Promise<number | null> {
  try {
    return (await fetchManifest()).size;
  } catch {
    return null;
  }
}

let afterInstall: (() => void) | null = null;

/** Voice was turned on without the model: ask first. `then` turns it on once there's an answer. */
export function offerModel(then: () => void) {
  afterInstall = then;
  setup({offer: true, error: null});
}

export function closeOffer() {
  download?.abort();
  afterInstall = null;
  setup({offer: false, progress: null});
}

let download: AbortController | null = null;

export async function downloadModel() {
  if (download) return;
  download = new AbortController();
  setup({progress: {done: 0, total: 0}, error: null});
  let last = 0;
  try {
    const m = await install(p => {
      // A few updates a second is plenty.
      const now = Date.now();
      if (now - last > 150 || p.done === p.total) {
        last = now;
        setup({progress: p});
      }
    }, download.signal);
    chooseEngine('local');
    setup({installed: m, offer: false, progress: null});
    testLog('voice-model', {installed: m.id, size: m.size});
    const then = afterInstall;
    afterInstall = null;
    then?.();
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    setup({progress: null, error: aborted ? null : err instanceof Error ? err.message : String(err)});
  } finally {
    download = null;
  }
}

/** Uses the browser's recogniser instead, now and from now on. */
export function chooseBrowserVoice() {
  chooseEngine('browser');
  const then = afterInstall;
  closeOffer();
  then?.();
}

/**
 * Before voice starts listening: false holds it back while the model is checked for, or offered
 * (`start` is called again once there's an answer).
 */
export function gateVoice(start: () => void): boolean {
  if (state.engine === 'browser') return true;
  if (state.installed === undefined) {
    void checkInstalled().then(start, start);
    return false;
  }
  if (!state.installed) {
    offerModel(start);
    return false;
  }
  return true;
}

export async function removeModel() {
  unload();
  await uninstall();
  setup({installed: null});
}

/** Voice should use the model: chosen (or not decided yet) and not turned down. */
export const wantsLocal = () => state.engine !== 'browser';
export const localReady = () => !!state.installed;

// --- the worker --------------------------------------------------------------------------------

let worker: Worker | null = null;
let loaded: Promise<Worker> | null = null;
let active: LocalRecognizer | null = null;

function unload() {
  worker?.terminate();
  worker = null;
  loaded = null;
  unloadReader();
}

function engine(m: Manifest): Promise<Worker> {
  if (loaded) return loaded;
  const w = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
  worker = w;
  loaded = new Promise<Worker>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'outdated') {
        setup({installed: null});
        reject(Object.assign(new Error('The voice model needs an update'), {code: 'model-update'}));
        return;
      }
      if (msg.type === 'ready') {
        testLog('voice-model', {loaded: m.id, ms: msg.ms, threads: msg.threads});
        resolve(w);
        // The language model that reads what's said, if the pack has it: voice reads by its rules until it's ready.
        void loadReader(m);
        return;
      }
      if (msg.type === 'error' && !active) reject(new Error(msg.message));
      active?.fromWorker(msg);
    };
    w.onerror = e => {
      reject(new Error(e.message || 'The voice model failed to start'));
      active?.fromWorker({type: 'error', message: e.message || 'The voice model stopped'});
    };
  });
  loaded.catch(() => unload());
  post(w, {type: 'load', manifest: m});
  return loaded;
}

function post(w: Worker, m: WorkerIn, transfer: Transferable[] = []) {
  w.postMessage(m, transfer);
}

// --- the recogniser ------------------------------------------------------------------------------

const finalResult = (alternatives: string[]) => {
  const res = Object.assign(alternatives.map(transcript => ({transcript})), {isFinal: true});
  return {resultIndex: 0, results: [res]};
};

export class LocalRecognizer implements Recognizer {
  lang = 'en-US';
  continuous = true;
  interimResults = true;
  maxAlternatives = 3;
  onresult: Recognizer['onresult'] = null;
  onerror: Recognizer['onerror'] = null;
  onend: Recognizer['onend'] = null;
  onaudiostart: Recognizer['onaudiostart'] = null;
  onactivity: Recognizer['onactivity'] = null;
  /** Each result is a whole line (the speech detector found where it ended). */
  readonly wholePhrases = true;
  context: () => string[] = () => [];

  private running = false;
  private run = 0;
  private audio: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private workletAdded = false;

  start() {
    if (this.running) throw new Error('already listening');
    this.running = true;
    const run = ++this.run;
    // Made now, while the tap that turned voice on still counts.
    this.audio ??= new AudioContext({sampleRate: 16_000, latencyHint: 'interactive'});
    void this.begin(run, this.audio);
  }

  stop() {
    this.end();
  }

  abort() {
    this.end();
  }

  private async begin(run: number, ctx: AudioContext) {
    const current = () => run === this.run && this.running;
    // Test builds: where setting up stopped, if it did.
    let stage = 'finding the model';
    const stuck = setTimeout(() => testLog('voice-mic', {stuck: stage, state: this.audio?.state}), 10_000);
    try {
      const m = await installedManifest();
      if (!m) throw Object.assign(new Error('The voice model isn’t on this device: turn voice on again to download it'), {code: 'model'});
      if (!loaded) this.onactivity?.('loading');
      stage = 'loading the model';
      const w = await engine(m);
      if (!current()) return;
      stage = 'asking for the microphone';
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true},
      });
      if (!current()) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.stream = stream;
      stage = 'connecting the microphone';
      let source: MediaStreamAudioSourceNode;
      let resampled = false;
      try {
        source = ctx.createMediaStreamSource(stream);
      } catch {
        resampled = true;
        // Firefox won't take a microphone at another rate than the context's: run at the microphone's (the worklet resamples).
        void ctx.close().catch(() => {});
        ctx = this.audio = new AudioContext({latencyHint: 'interactive'});
        this.workletAdded = false;
        source = ctx.createMediaStreamSource(stream);
      }
      if (!this.workletAdded) {
        stage = 'loading the capture worklet';
        await ctx.audioWorklet.addModule(captureUrl);
        this.workletAdded = true;
      }
      stage = 'starting the audio';
      await ctx.resume();
      const node = new AudioWorkletNode(ctx, 'speech-capture', {numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1});
      const channel = new MessageChannel();
      node.port.postMessage({port: channel.port1}, [channel.port1]);
      post(w, {type: 'audio', port: channel.port2}, [channel.port2]);
      post(w, {type: 'context', phrases: this.context()});
      post(w, {type: 'listen', on: true, keepAudio: testLogOn});
      // Nothing is played: the node's output is silence, connected so the graph keeps running it.
      source.connect(node).connect(ctx.destination);
      // For the screen's meter.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.analyser = analyser;
      this.node = node;
      this.source = source;
      active = this;
      clearTimeout(stuck);
      const track = stream.getAudioTracks()[0];
      testLog('voice-mic', {rate: ctx.sampleRate, state: ctx.state, resampled, device: track?.label, settings: track?.getSettings?.()});
      this.onactivity?.(null);
      this.onaudiostart?.();
    } catch (err) {
      clearTimeout(stuck);
      if (!current()) return;
      const name = err instanceof DOMException ? err.name : '';
      const own = (err as {code?: unknown}).code;
      const code = typeof own === 'string' ? own
        : name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed'
        : name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' ? 'audio-capture'
          : err instanceof Error ? err.message : String(err);
      this.onerror?.({error: code});
      this.end();
    }
  }

  private end() {
    if (!this.running) return;
    this.running = false;
    this.run++;
    if (active === this) active = null;
    if (worker) post(worker, {type: 'listen', on: false});
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.port.close();
    this.analyser?.disconnect();
    this.source = null;
    this.node = null;
    this.analyser = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.audio?.suspend().catch(() => {});
    this.onactivity?.(null);
    // Like the browser's recogniser: the end comes after stop() returns.
    setTimeout(() => this.onend?.(), 0);
  }

  /** How loud the microphone is right now: 0 at -60 dB or quieter, 1 at -10 dB (a loud voice close by). */
  level(): number {
    const a = this.analyser;
    if (!a) return 0;
    const buf = (this.samples ??= new Float32Array(a.fftSize));
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 10 * Math.log10(sum / buf.length + 1e-12);
    return Math.min(1, Math.max(0, (db + 60) / 50));
  }

  /** From the worker, while this one is listening. */
  fromWorker(msg: WorkerOut) {
    switch (msg.type) {
      case 'speech':
        // Someone's talking: the names that can come up, fresh for when the line ends.
        if (worker) post(worker, {type: 'context', phrases: this.context()});
        this.onactivity?.('hearing');
        break;
      case 'silence':
        this.onactivity?.(null);
        break;
      case 'reading':
        this.onactivity?.('reading');
        break;
      case 'line': {
        this.onactivity?.(null);
        const {reading, ms, audio} = msg;
        const clip = audio ? testLogAudio(audio) : undefined;
        testLog('voice-heard', {text: reading.text, plain: reading.plain, spots: reading.spots, ms, clip});
        if (reading.alternatives.length) this.onresult?.(finalResult(reading.alternatives));
        break;
      }
      case 'level':
        testLog('voice-level', {batches: msg.batches, rms: msg.rms, peak: msg.peak, speech: msg.speech});
        break;
      case 'error':
        this.onerror?.({error: msg.message});
        break;
    }
  }
}

export type {Activity};
