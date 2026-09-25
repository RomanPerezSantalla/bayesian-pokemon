/**
 * Reading the speech model's output (CTC: for every 80 ms of audio, how likely each piece of the
 * vocabulary is, or nothing new, the "blank"), steered to the names that can come up.
 *
 * Plain reading takes the likeliest piece at each moment; names the model never heard come out
 * spelled the way they sounded ("Corvy Kight"). So every name that can come up right now is also
 * lined up against the audio, the best stretch for each, and scored by how much less likely it is
 * there than what plain reading heard (0: exactly as likely). One that's nearly as likely as the
 * best reading was almost certainly said, and replaces it. This is word spotting as in NVIDIA's
 * CTC-WS (Andrusenko et al., 2024), which is why it holds up for accents: the names are compared
 * on the sound itself, not on how the model happened to spell it.
 */
import type {PhraseGraph, Vocab} from './vocab';

/** The model's output: log-probabilities, [frames × size]. */
export interface Logprobs {
  data: Float32Array;
  frames: number;
  size: number;
}

/** A piece read by plain decoding, over frames start–end. */
export interface Token {
  id: number;
  start: number;
  end: number;
}

/** The likeliest piece at every frame, repeats merged and blanks dropped (greedy CTC decoding). */
export function greedy(lp: Logprobs, blank: number): Token[] {
  const out: Token[] = [];
  let prev = -1;
  for (let t = 0; t < lp.frames; t++) {
    const off = t * lp.size;
    let best = 0;
    for (let v = 1; v < lp.size; v++) if (lp.data[off + v] > lp.data[off + best]) best = v;
    if (best !== blank) {
      if (best === prev) out[out.length - 1].end = t;
      else out.push({id: best, start: t, end: t});
    }
    prev = best;
  }
  return out;
}

export function tokensText(tokens: Token[], vocab: Vocab): string {
  return tokens.map(t => vocab.pieces[t.id]).join('').replace(/▁/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A phrase lined up against frames start–end. */
export interface Spot {
  text: string;
  start: number;
  end: number;
  /** Log-likelihood against plain reading over those frames: 0 as likely, below 0 less. */
  score: number;
  /** Pieces it was spelled with. */
  pieces: number;
}

/**
 * Where each phrase fits the audio best, with its score: every end frame's best alignment scoring
 * at least `floor`. Alignments follow CTC's rules: each frame is one of the phrase's pieces in order
 * (repeated while it lasts) or a blank between them, and a piece said twice running needs a blank.
 */
export function spotPhrases(lp: Logprobs, blank: number, phrases: PhraseGraph[], floor = -30): Spot[] {
  const {frames: T, size: V, data} = lp;
  const top = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    let m = -Infinity;
    for (let v = 0, off = t * V; v < V; v++) if (data[off + v] > m) m = data[off + v];
    top[t] = m;
  }
  const out: Spot[] = [];
  for (const g of phrases) {
    const E = g.edges.length;
    const n = g.spelled.length;
    // Per edge (saying its piece) and per character (a blank after reaching it): best score so far,
    // the frame the phrase started, and the pieces used.
    let es = new Float64Array(E).fill(-Infinity), et = new Int32Array(E), ek = new Int32Array(E);
    let bs = new Float64Array(n + 1).fill(-Infinity), bt = new Int32Array(n + 1), bk = new Int32Array(n + 1);
    let es2 = new Float64Array(E), et2 = new Int32Array(E), ek2 = new Int32Array(E);
    let bs2 = new Float64Array(n + 1), bt2 = new Int32Array(n + 1), bk2 = new Int32Array(n + 1);
    for (let t = 0; t < T; t++) {
      const off = t * V;
      const blankRegret = data[off + blank] - top[t];
      for (let i = 1; i <= n; i++) {
        let s = bs[i], st = bt[i], sk = bk[i];
        for (const k of g.to[i]) if (es[k] > s) [s, st, sk] = [es[k], et[k], ek[k]];
        bs2[i] = s + blankRegret;
        bt2[i] = st;
        bk2[i] = sk;
      }
      for (let k = 0; k < E; k++) {
        const e = g.edges[k];
        let emit = -Infinity;
        for (const id of e.ids) emit = Math.max(emit, data[off + id] - top[t]);
        // Going on saying it…
        let s = es[k], st = et[k], sk = ek[k];
        // …or starting it: the phrase itself (here, fresh), or after a blank or the piece before.
        let enter = -Infinity, entT = t, entK = 0;
        if (e.from === 0) enter = 0;
        else {
          if (bs[e.from] > enter) [enter, entT, entK] = [bs[e.from], bt[e.from], bk[e.from]];
          for (const j of g.to[e.from]) {
            if (g.edges[j].piece !== e.piece && es[j] > enter) [enter, entT, entK] = [es[j], et[j], ek[j]];
          }
        }
        enter -= e.cost;
        if (enter >= s) [s, st, sk] = [enter, entT, entK + 1];
        es2[k] = s + emit;
        et2[k] = st;
        ek2[k] = sk;
        if (e.to === n && es2[k] >= floor) out.push({text: g.text, start: st, end: t, score: es2[k], pieces: sk});
      }
      [es, es2] = [es2, es];
      [et, et2] = [et2, et];
      [ek, ek2] = [ek2, ek];
      [bs, bs2] = [bs2, bs];
      [bt, bt2] = [bt2, bt];
      [bk, bk2] = [bk2, bk];
    }
  }
  return out;
}

/** The best of the spots that don't overlap, by `worth` (those worth less than 0 dropped), in time order. */
export function chooseSpots(spots: Spot[], worth: (s: Spot) => number): Spot[] {
  const ranked = spots.map(s => ({s, w: worth(s)})).filter(x => x.w >= 0).sort((a, b) => b.w - a.w);
  const taken: Spot[] = [];
  for (const {s} of ranked) if (!taken.some(o => s.start <= o.end && o.start <= s.end)) taken.push(s);
  return taken.sort((a, b) => a.start - b.start);
}

/** Plain reading with the chosen spots put in place of what it heard over their frames. */
export function mergeSpots(tokens: Token[], vocab: Vocab, spots: Spot[]): string {
  let text = '';
  let si = 0;
  let dropTail = false;
  for (const tok of tokens) {
    const piece = vocab.pieces[tok.id];
    while (si < spots.length && spots[si].end < tok.start) {
      text += ` ${spots[si++].text} `;
      dropTail = true;
    }
    const s = spots[si];
    if (s && tok.start <= s.end && tok.end >= s.start) continue;
    // The rest of a word the spot began in ("Corvy K|ight"): part of what it replaced.
    if (dropTail && !piece.startsWith('▁') && /\p{L}/u.test(piece)) continue;
    dropTail = false;
    text += piece.replace(/▁/g, ' ');
  }
  while (si < spots.length) text += ` ${spots[si++].text} `;
  return text.replace(/\s+/g, ' ').replace(/ ([,.?!])/g, '$1').trim();
}
