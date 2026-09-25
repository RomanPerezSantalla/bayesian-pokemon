import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {IDLE_MS, SpeechSession, type Activity, type Recognizer} from '../ui/battle/voice/useSpeech';
import {chooseSpots, greedy, mergeSpots, spotPhrases, tokensText, type Logprobs} from './ctc';
import {Endpointer, ENDPOINT, FRAME} from './endpoint';
import {MELS, melFeatures, SAMPLE_RATE} from './features';
import {PER_LETTER, PhraseCache, readLine, worth} from './read';
import {CACHE, install, installedManifest, MODEL_ID, readFile, uninstall, type Manifest} from './store';
import {BREAK_COST, parseVocab, phraseGraph} from './vocab';

// A vocabulary like the model's, small: pieces with "▁" start a word, the blank is last.
const PIECES = ['<unk>', '▁r', 'ill', 'a', 'boom', '▁rail', '▁a', '▁boom', '▁used', '▁c', 'or', 'vi', 'kn', 'ight', '▁k', '▁g',
  'rass', 'y', '▁gl', 'ide', '▁grass', 'l', 'i', 'o', 'm', 'b', '▁', '.', 'R', 'g', '<blk>'];
const vocab = parseVocab(PIECES.map((p, i) => `${p} ${i}`).join('\n'));
const id = (p: string) => PIECES.indexOf(p);

/** Log-probabilities where each frame's likeliest piece is the one given ('_' the blank), others far behind, some close. */
function frames(seq: (string | [string, [string, number][]])[]): Logprobs {
  const size = PIECES.length;
  const data = new Float32Array(seq.length * size).fill(-20);
  seq.forEach((f, t) => {
    const [top, close] = typeof f === 'string' ? [f, []] : f;
    data[t * size + (top === '_' ? vocab.blank : id(top))] = -0.01;
    for (const [p, lp] of close) data[t * size + (p === '_' ? vocab.blank : id(p))] = lp;
  });
  return {data, frames: seq.length, size};
}

describe('what the voice model reads', () => {
  it('80 log-mel bands every 10 ms, each normalised over the clip', () => {
    const n = SAMPLE_RATE / 2;
    const tone = Float32Array.from({length: n}, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) + 0.01 * Math.sin(i * 7.1));
    const {data, frames: T} = melFeatures(tone);
    expect(T).toBe(Math.floor(n / 160) + 1);
    expect(data.length).toBe(MELS * T);
    for (const m of [0, 20, 79]) {
      const row = data.subarray(m * T, (m + 1) * T);
      const mean = row.reduce((s, v) => s + v, 0) / T;
      const sd = Math.sqrt(row.reduce((s, v) => s + (v - mean) ** 2, 0) / (T - 1));
      expect(Math.abs(mean)).toBeLessThan(1e-4);
      expect(sd).toBeGreaterThan(0.99);
      expect(sd).toBeLessThan(1.001);
    }
  });
});

describe('spelling a phrase with the vocabulary', () => {
  it('every way, including word breaks the model adds or drops', () => {
    const g = phraseGraph('Rillaboom', vocab)!;
    expect(g.spelled).toBe('▁rillaboom');
    const pieces = g.edges.map(e => `${e.piece}${e.cost ? '*' : ''}`);
    expect(pieces).toEqual(expect.arrayContaining(['▁r', 'ill', 'a', 'boom', '▁a*', '▁boom*']));
    expect(g.edges.find(e => e.piece === '▁a')?.cost).toBe(BREAK_COST);
    // Two words: "▁grass" isn't a piece of "grassy", but "▁g rass y" is; and they can run together.
    const gg = phraseGraph('Grassy Glide', vocab)!;
    expect(gg.spelled).toBe('▁grassy▁glide');
    expect(gg.edges.some(e => e.piece === 'g' && e.from === 7 && e.to === 9 && e.cost === BREAK_COST)).toBe(true);
  });

  it("a phrase the vocabulary can't spell is left out", () => {
    expect(phraseGraph('Xyz', vocab)).toBeNull();
    expect(phraseGraph('   ', vocab)).toBeNull();
  });
});

describe('reading the model with the names that can come up', () => {
  // "Rail a boom used": the model's own spelling of a name it doesn't know.
  const heard = frames(['_', '▁rail', '_', '▁a', '▁boom', '_', '_', '▁used', '_']);

  it('plain reading: the likeliest piece each moment', () => {
    const toks = greedy(heard, vocab.blank);
    expect(tokensText(toks, vocab)).toBe('rail a boom used');
    expect(toks[0]).toEqual({id: id('▁rail'), start: 1, end: 1});
  });

  it('a name lined up with what was heard scores by how much less likely it is', () => {
    // Where "rail" was heard, "▁r" + "ill" were nearly as likely.
    const close = frames([
      '_', ['▁rail', [['▁r', -0.6]]], ['_', [['ill', -1.2]]], '▁a', '▁boom', '_', '_', '▁used', '_',
    ]);
    const spots = spotPhrases(close, vocab.blank, [phraseGraph('Rillaboom', vocab)!]);
    const best = spots.reduce((a, b) => (b.score > a.score ? b : a));
    expect(best.start).toBe(1);
    expect(best.end).toBe(4);
    // ▁r (−0.6), ill in place of a blank (−1.2), a break before "a" and before "boom" (0.5 each).
    expect(best.score).toBeCloseTo(-0.6 - 1.2 - 2 * BREAK_COST, 1);
    const text = mergeSpots(greedy(close, vocab.blank), vocab, chooseSpots(spots, worth));
    expect(text).toBe('Rillaboom used');
  });

  it("a name that doesn't fit isn't put in", () => {
    const spots = spotPhrases(heard, vocab.blank, [phraseGraph('Corviknight', vocab)!]);
    expect(chooseSpots(spots, worth)).toEqual([]);
    expect(readLine(heard, vocab, [phraseGraph('Corviknight', vocab)!]).text).toBe('rail a boom used');
  });

  it('overlapping candidates: the one that fits best, per letter', () => {
    const got = chooseSpots([
      {text: 'Rillaboom', start: 1, end: 4, score: -6, pieces: 4},
      {text: 'Boom', start: 3, end: 4, score: -1, pieces: 1},
      {text: 'Used', start: 7, end: 7, score: 0, pieces: 1},
    ], s => s.score + PER_LETTER * s.text.length);
    expect(got.map(s => s.text)).toEqual(['Rillaboom', 'Used']);
  });

  it('what a spot replaces goes, the rest of the word it began in too', () => {
    const toks = greedy(frames(['▁c', 'or', 'vi', '_', '▁k', 'ight', '_', '▁used']), vocab.blank);
    expect(tokensText(toks, vocab)).toBe('corvi kight used');
    expect(mergeSpots(toks, vocab, [{text: 'Corviknight', start: 0, end: 4, score: -3, pieces: 5}])).toBe('Corviknight used');
  });

  it('phrase graphs are built once', () => {
    const cache = new PhraseCache(vocab);
    const [a] = cache.get(['Rillaboom', 'Rillaboom']);
    expect(cache.get(['Rillaboom'])[0]).toBe(a);
  });
});

describe('where lines start and end', () => {
  const run = (probs: number[]) => {
    const e = new Endpointer();
    return probs.flatMap((p, t) => e.push(p).map(ev => ({t, ...ev})));
  };
  const pause = Math.round(ENDPOINT.pauseMs / 1000 * SAMPLE_RATE / FRAME);

  it('starts when sure, ends after a pause, with a little before and after', () => {
    const probs = [...Array(20).fill(0), ...Array(30).fill(0.9), ...Array(pause + 5).fill(0.05)];
    const evs = run(probs);
    expect(evs[0]).toMatchObject({t: 20, kind: 'start'});
    const end = evs[1] as {kind: 'end'; from: number; to: number; t: number};
    expect(end.kind).toBe('end');
    expect(end.from).toBe(20 - Math.round(ENDPOINT.beforeMs / 1000 * SAMPLE_RATE / FRAME));
    expect(end.to).toBe(49 + Math.round(ENDPOINT.afterMs / 1000 * SAMPLE_RATE / FRAME) + 1);
    expect(end.t).toBe(49 + pause);
  });

  it('a short dip mid-line keeps it going; a blip is no line', () => {
    const line = run([...Array(10).fill(0.9), ...Array(5).fill(0.2), ...Array(10).fill(0.9), ...Array(pause + 1).fill(0)]);
    expect(line.filter(e => e.kind === 'end')).toHaveLength(1);
    const blip = run([0.9, 0.9, ...Array(pause + 1).fill(0)]);
    expect(blip[1]).toMatchObject({kind: 'end'});
    expect((blip[1] as {from: number; to: number}).to).toBe((blip[1] as {from: number}).from);
  });

  it('a long stretch is cut so it still gets read; stopping ends the line there', () => {
    const max = Math.round(ENDPOINT.maxMs / 1000 * SAMPLE_RATE / FRAME);
    expect(run(Array(max + 10).fill(0.9)).filter(e => e.kind === 'end')).toHaveLength(1);
    const e = new Endpointer();
    for (let t = 0; t < 30; t++) e.push(0.9);
    expect(e.flush()).toEqual([{kind: 'end', from: 0, to: 30}]);
    expect(e.speaking).toBe(false);
  });
});

/** Cache Storage, in memory. */
class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, Response>();
    this.stores.set(name, store);
    return {
      match: async (url: string) => store.get(url)?.clone(),
      put: async (url: string, res: Response) => void store.set(url, res),
      keys: async () => [...store.keys()].map(url => ({url})),
      delete: async (req: {url: string}) => store.delete(req.url),
    };
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

const sha256 = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');

describe('the voice model, downloaded once and kept', () => {
  const base = 'https://example.test/voice/';
  let files: Record<string, Uint8Array<ArrayBuffer>>;
  let manifest: Manifest;
  let fetched: string[];

  beforeEach(async () => {
    const model = Uint8Array.from({length: 300}, (_, i) => i % 251);
    const parts = [model.slice(0, 128), model.slice(128, 256), model.slice(256)];
    files = {'model.int8.onnx.000': parts[0], 'model.int8.onnx.001': parts[1], 'model.int8.onnx.002': parts[2], 'tokens.txt': new TextEncoder().encode('▁a 0\n<blk> 1\n')};
    manifest = {
      id: MODEL_ID, ort: '1.30.0', size: 300 + files['tokens.txt'].length,
      files: [
        {name: 'model.int8.onnx', size: 300, sha256: await sha256(model), parts: await Promise.all(parts.map(async (p, k) => ({path: `model.int8.onnx.00${k}`, size: p.length, sha256: await sha256(p)})))},
        {name: 'tokens.txt', size: files['tokens.txt'].length, sha256: await sha256(files['tokens.txt']), parts: [{path: 'tokens.txt', size: files['tokens.txt'].length, sha256: await sha256(files['tokens.txt'])}]},
      ],
    };
    fetched = [];
    vi.stubGlobal('caches', new FakeCaches());
    vi.stubGlobal('document', {baseURI: 'https://example.test/'});
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      const name = url.slice(base.length);
      if (name === 'manifest.json') return new Response(JSON.stringify(manifest));
      const f = files[name];
      return f ? new Response(f.slice()) : new Response('', {status: 404});
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads each part, checks it, and reads the files back whole', async () => {
    expect(await installedManifest()).toBeNull();
    const seen: number[] = [];
    await install(p => seen.push(p.done), undefined, base);
    expect(seen[seen.length - 1]).toBe(manifest.size);
    const m = await installedManifest();
    expect(m?.id).toBe(MODEL_ID);
    const model = await readFile(m!, 'model.int8.onnx');
    expect(model.length).toBe(300);
    expect(model[255]).toBe(255 % 251);
    expect(new TextDecoder().decode(await readFile(m!, 'tokens.txt'))).toContain('<blk>');
  });

  it('a damaged part stops it, and a half-done download never counts as installed', async () => {
    files['model.int8.onnx.001'] = new Uint8Array(128);
    await expect(install(() => {}, undefined, base)).rejects.toThrow(/damaged/);
    expect(await installedManifest()).toBeNull();
    // Fixed on the server: what arrived fine isn't downloaded again.
    files['model.int8.onnx.001'] = Uint8Array.from({length: 128}, (_, i) => (i + 128) % 251);
    fetched = [];
    await install(() => {}, undefined, base);
    expect(fetched.some(u => u.endsWith('.000'))).toBe(false);
    expect(await installedManifest()).not.toBeNull();
  });

  it("another app version's model isn't taken for this one's; removing it removes it all", async () => {
    await install(() => {}, undefined, base);
    await uninstall();
    expect(await installedManifest()).toBeNull();
    manifest = {...manifest, id: 'something-else'};
    await expect(install(() => {}, undefined, base)).rejects.toThrow(/doesn’t match/);
    expect((globalThis.caches as unknown as FakeCaches).stores.get(CACHE)?.size ?? 0).toBe(0);
  });
});

/** The voice model's recogniser, driven by hand: whole lines, and what it's doing. */
class WholeLines implements Recognizer {
  static last: WholeLines;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: Recognizer['onresult'] = null;
  onerror: Recognizer['onerror'] = null;
  onend: Recognizer['onend'] = null;
  onaudiostart: Recognizer['onaudiostart'] = null;
  onactivity: Recognizer['onactivity'] = null;
  readonly wholePhrases = true;
  context?: () => string[];
  constructor() {
    WholeLines.last = this;
  }
  start() {}
  stop() {
    setTimeout(() => this.onend?.(), 0);
  }
  abort() {
    this.stop();
  }
  line(...alternatives: string[]) {
    this.onresult?.({resultIndex: 0, results: [Object.assign(alternatives.map(transcript => ({transcript})), {isFinal: true})]});
  }
  act(a: Activity) {
    this.onactivity?.(a);
  }
}

describe('the speech session with the voice model', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('each line goes out as soon as it ends, all its readings with it, even said twice', () => {
    const s = new SpeechSession(() => WholeLines);
    s.start();
    const got: string[][] = [];
    s.take(a => got.push(a));
    WholeLines.last.line('Kingambit used Sucker Punch', 'King Ambot used sucker punch');
    WholeLines.last.line('Kingambit used Sucker Punch');
    expect(got).toEqual([['Kingambit used Sucker Punch', 'King Ambot used sucker punch'], ['Kingambit used Sucker Punch']]);
  });

  it('the screen showing says what names can come up; what the model is doing shows', () => {
    const s = new SpeechSession(() => WholeLines);
    s.start();
    const release = s.take(() => {}, () => ['Rillaboom', 'Grassy Glide']);
    expect(WholeLines.last.context?.()).toEqual(['Rillaboom', 'Grassy Glide']);
    WholeLines.last.act('hearing');
    expect(s.getState().activity).toBe('hearing');
    WholeLines.last.act(null);
    expect(s.getState().activity).toBeNull();
    release();
    expect(WholeLines.last.context?.()).toEqual([]);
    vi.advanceTimersByTime(IDLE_MS + 10);
    expect(s.getState().listening).toBe(false);
  });

  it('turning voice on can wait for the model: the gate holds it, then starts it', () => {
    let later: (() => void) | null = null;
    let ready = false;
    const s = new SpeechSession(() => WholeLines, 'en-US', start => {
      if (ready) return true;
      later = start;
      return false;
    });
    s.start();
    expect(s.getState().listening).toBe(false);
    ready = true;
    later!();
    expect(s.getState().listening).toBe(true);
  });
});
