/**
 * The speech model's vocabulary (1024 SentencePiece pieces, "▁" starting a word, plus the CTC
 * blank), and the ways a phrase can be spelled with it: "Rillaboom" is "▁R ill a boom", "▁Ri ll ab
 * oom", and so on. The model was only ever shown one of them, but on a name it never heard it may
 * favour another, so all are kept.
 */

export interface Vocab {
  pieces: string[];
  blank: number;
  /** Token ids by lowercased piece. */
  byPiece: Map<string, number[]>;
  longest: number;
}

/** tokens.txt: a piece and its id per line ("▁the 6"). */
export function parseVocab(text: string): Vocab {
  const pieces: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.lastIndexOf(' ');
    if (at <= 0) continue;
    pieces[Number(line.slice(at + 1))] = line.slice(0, at);
  }
  const blank = pieces.indexOf('<blk>');
  const byPiece = new Map<string, number[]>();
  let longest = 0;
  pieces.forEach((p, id) => {
    if (id === blank || p.startsWith('<')) return;
    const key = p.toLowerCase();
    byPiece.set(key, [...(byPiece.get(key) ?? []), id]);
    longest = Math.max(longest, key.length);
  });
  return {pieces, blank: blank < 0 ? pieces.length - 1 : blank, byPiece, longest};
}

/** One piece of a phrase: characters `from`–`to` of its spelling, said as any of `ids`. */
export interface Edge {
  from: number;
  to: number;
  ids: number[];
  piece: string;
  /** Log-likelihood cost of using it: breaking a word ("King Ambit") or joining two ("Dracometeor"). */
  cost: number;
}

/**
 * The model splits a name it doesn't know into words it does ("King Ambot", "Rail a boom", "Corvy
 * Kight") and runs words together ("Dracomometeor"), so a phrase may be spelled with word breaks
 * added or dropped, at this cost each.
 */
export const BREAK_COST = 0.5;

export interface PhraseGraph {
  text: string;
  /** "▁grassy▁glide": the phrase as the model spells it, lowercased. */
  spelled: string;
  edges: Edge[];
  /** Edge indices by the character they start at. */
  from: number[][];
  /** Edge indices by the character they end at. */
  to: number[][];
}

/** Every way of spelling `text` with the vocabulary, as a graph over its characters; null if it can't be spelled. */
export function phraseGraph(text: string, vocab: Vocab): PhraseGraph | null {
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const spelled = words.map(w => `▁${w}`).join('');
  const n = spelled.length;
  const edges: Edge[] = [];
  const add = (from: number, to: number, piece: string, cost: number) => {
    const ids = vocab.byPiece.get(piece);
    if (ids) edges.push({from, to, ids, piece, cost});
  };
  for (let i = 0; i < n; i++) {
    for (let len = 1; len <= vocab.longest && i + len <= n; len++) add(i, i + len, spelled.slice(i, i + len), 0);
    for (let len = 1; len < vocab.longest && i + len <= n; len++) {
      // A word break the model heard inside a word ("▁King▁ambit")…
      if (spelled[i] !== '▁' && spelled[i - 1] !== '▁' && i > 0) add(i, i + len, `▁${spelled.slice(i, i + len)}`, BREAK_COST);
      // …or one it didn't hear, between words or before the phrase ("…on|kingambit").
      if (spelled[i] === '▁' && i + 1 + len <= n && !spelled.slice(i + 1, i + 1 + len).includes('▁')) add(i, i + 1 + len, spelled.slice(i + 1, i + 1 + len), BREAK_COST);
    }
  }
  const from: number[][] = Array.from({length: n + 1}, () => []);
  const to: number[][] = Array.from({length: n + 1}, () => []);
  edges.forEach((e, k) => {
    from[e.from].push(k);
    to[e.to].push(k);
  });
  // Every character reachable from the start and leading to the end, or it can't be spelled.
  const reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (let i = 0; i < n; i++) if (reach[i]) for (const k of from[i]) reach[edges[k].to] = 1;
  return reach[n] ? {text, spelled, edges, from, to} : null;
}
