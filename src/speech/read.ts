/**
 * A line of speech from the model's output: plain reading, with the names that can come up put in
 * where the audio says them (ctc.ts).
 */
import {chooseSpots, greedy, mergeSpots, spotPhrases, tokensText, type Logprobs, type Spot} from './ctc';
import {phraseGraph, type PhraseGraph, type Vocab} from './vocab';

/**
 * How much less likely than plain reading a phrase may be, per letter, and still be taken (the
 * natural log of the likelihood). Set on synthetic voices, an American one and a Spanish one reading
 * English: 1.5 found 98 of 106 names and moves, 51 and 47, with nothing false, including 40 lines
 * with no names at all against the 213 at team preview; false ones started at 1.7.
 */
export const PER_LETTER = 1.5;

const letters = (text: string) => text.replace(/[^\p{L}]/gu, '').length;

export const worth = (s: Spot) => s.score + PER_LETTER * letters(s.text);

/** Phrase graphs, built once each. */
export class PhraseCache {
  private readonly graphs = new Map<string, PhraseGraph | null>();

  constructor(private readonly vocab: Vocab) {}

  get(texts: readonly string[]): PhraseGraph[] {
    const out: PhraseGraph[] = [];
    for (const t of new Set(texts)) {
      let g = this.graphs.get(t);
      if (g === undefined) this.graphs.set(t, (g = phraseGraph(t, this.vocab)));
      if (g) out.push(g);
    }
    return out;
  }
}

export interface Reading {
  /** With the names put in. */
  text: string;
  /** As the model spelled it. */
  plain: string;
  /** Best first, for the recogniser's alternatives. */
  alternatives: string[];
  spots: {text: string; score: number; worth: number}[];
}

export function readLine(lp: Logprobs, vocab: Vocab, phrases: PhraseGraph[]): Reading {
  const tokens = greedy(lp, vocab.blank);
  const plain = tokensText(tokens, vocab);
  const chosen = phrases.length ? chooseSpots(spotPhrases(lp, vocab.blank, phrases), worth) : [];
  const text = chosen.length ? mergeSpots(tokens, vocab, chosen) : plain;
  return {
    text,
    plain,
    alternatives: [...new Set([text, plain])].filter(Boolean),
    spots: chosen.map(s => ({text: s.text, score: Math.round(s.score * 10) / 10, worth: Math.round(worth(s) * 10) / 10})),
  };
}
