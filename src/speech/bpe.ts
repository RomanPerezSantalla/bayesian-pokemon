/**
 * The language model's tokenizer: Gemma's byte-pair encoding over the tokens the app keeps (40k of
 * its 262k, with every merge that builds them: .cache/llm/vocab.py). Text made of kept tokens comes
 * out exactly as Gemma's own tokenizer gives it; anything else, in smaller pieces (down to bytes).
 */

export interface BpeData {
  /** The kept tokens, spaces written "▁"; a token's index is its id here (and its row in the model). */
  tokens: string[];
  /** Merges, lowest rank first: [left, right] token indices. */
  merges: [number, number][];
  bos: number;
  eos: number;
  start: number;
  end: number;
}

const SPECIAL = ['<start_of_turn>', '<end_of_turn>', '<bos>', '<eos>'] as const;

export class Bpe {
  private readonly index = new Map<string, number>();
  private readonly rank = new Map<number, number>();
  private readonly n: number;

  constructor(readonly data: BpeData) {
    this.n = data.tokens.length;
    data.tokens.forEach((t, k) => this.index.set(t, k));
    data.merges.forEach(([a, b], r) => {
      const key = a * this.n + b;
      if (!this.rank.has(key)) this.rank.set(key, r);
    });
  }

  private special(s: (typeof SPECIAL)[number]): number {
    return s === '<start_of_turn>' ? this.data.start : s === '<end_of_turn>' ? this.data.end : s === '<bos>' ? this.data.bos : this.data.eos;
  }

  /** Token ids for text, the special tokens in it read as such (no <bos> added). */
  encode(text: string): number[] {
    const out: number[] = [];
    let i = 0;
    while (i < text.length) {
      let next = text.length;
      let which: (typeof SPECIAL)[number] | undefined;
      for (const s of SPECIAL) {
        const at = text.indexOf(s, i);
        if (at >= 0 && at < next) [next, which] = [at, s];
      }
      if (next > i) out.push(...this.piece(text.slice(i, next)));
      if (which) {
        out.push(this.special(which));
        next += which.length;
      }
      i = next;
    }
    return out;
  }

  /** One run of text between special tokens: characters (or their bytes), then merges by rank. */
  private piece(text: string): number[] {
    const seq: number[] = [];
    for (const ch of text.replaceAll(' ', '▁')) {
      const id = this.index.get(ch);
      if (id !== undefined) seq.push(id);
      else for (const byte of new TextEncoder().encode(ch)) seq.push(this.index.get(`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`)!);
    }
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let k = 0; k + 1 < seq.length; k++) {
        const r = this.rank.get(seq[k] * this.n + seq[k + 1]);
        if (r !== undefined && r < bestRank) [best, bestRank] = [k, r];
      }
      if (best < 0) return seq;
      const merged = this.index.get(this.data.tokens[seq[best]] + this.data.tokens[seq[best + 1]]);
      if (merged === undefined) return seq;
      seq.splice(best, 2, merged);
    }
  }

  /** Text for token ids (the model's answer): "▁" back to spaces, byte tokens back to characters. */
  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    let out = '';
    const flush = () => {
      if (bytes.length) out += new TextDecoder().decode(new Uint8Array(bytes.splice(0)));
    };
    for (const id of ids) {
      const t = this.data.tokens[id];
      const byte = /^<0x([0-9A-F]{2})>$/.exec(t);
      if (byte) bytes.push(parseInt(byte[1], 16));
      else {
        flush();
        out += t.replaceAll('▁', ' ');
      }
    }
    flush();
    return out;
  }
}
