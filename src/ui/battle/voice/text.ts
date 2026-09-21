/**
 * Text helpers for narration: normalising what the speech recogniser heard, matching the
 * Pokémon, moves, items and abilities in it (it mangles names: "rilla boom", "king gambit"),
 * and reading spoken numbers ("45", "forty five", "one fifty").
 */

/** Lowercase words, no accents, punctuation or apostrophes ("Salamence's" → "salamences"). */
export function norm(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A name as one run of letters, for matching however the recogniser split it. */
export const squash = (s: string) => norm(s).replace(/\s/g, '');

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export const similarity = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

export interface Named<T> {
  /** squash()ed name. */
  key: string;
  value: T;
  /** Added to the score (e.g. Pokémon on the field over ones on the bench). */
  bonus?: number;
}

export interface Match<T> {
  value: T;
  /** Words used. */
  len: number;
  score: number;
}

/**
 * The candidate named by the 1–3 words at \`i\`, if it's clearly the one meant: close enough
 * (\`min\`) and ahead of the next-best different candidate by \`margin\`. A trailing "s" is
 * also tried without it, for possessives ("salamences intimidate").
 */
export function matchAt<T>(words: string[], i: number, cands: Named<T>[], min = 0.72, margin = 0.08): Match<T> | null {
  const best = new Map<T, Match<T>>();
  for (let n = 1; n <= 3 && i + n <= words.length; n++) {
    const w = words.slice(i, i + n).join('');
    const forms = w.length > 4 && w.endsWith('s') ? [w, w.slice(0, -1)] : [w];
    for (const c of cands) {
      if (Math.abs(c.key.length - w.length) > Math.max(2, Math.ceil(c.key.length * 0.4))) continue;
      const score = Math.max(...forms.map(f => similarity(f, c.key))) + (c.bonus ?? 0);
      const cur = best.get(c.value);
      if (!cur || score > cur.score || (score === cur.score && n < cur.len)) best.set(c.value, {value: c.value, len: n, score});
    }
  }
  const [top, next] = [...best.values()].sort((a, b) => b.score - a.score);
  if (!top || top.score < min) return null;
  if (next && top.score - next.score < margin) return null;
  return top;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90};

function under100(words: string[], i: number): {value: number; len: number} | null {
  const w = words[i];
  if (w === undefined) return null;
  if (w in UNITS) return {value: UNITS[w], len: 1};
  if (w in TENS) {
    const u = words[i + 1];
    if (u !== undefined && UNITS[u] >= 1 && UNITS[u] <= 9) return {value: TENS[w] + UNITS[u], len: 2};
    return {value: TENS[w], len: 1};
  }
  return null;
}

/** A number spoken at \`i\`: "45", "forty five", "a hundred", "one hundred and twenty", "one fifty", "two oh two". */
export function numberAt(words: string[], i: number): {value: number; len: number} | null {
  const w = words[i];
  if (w === undefined) return null;
  if (/^\d{1,3}$/.test(w)) {
    // "1 50" (how "one fifty" can come back) is 150.
    const next = words[i + 1];
    if (/^[1-9]$/.test(w) && next && /^\d{2}$/.test(next)) return {value: Number(w) * 100 + Number(next), len: 2};
    return {value: Number(w), len: 1};
  }
  let hundreds = 0;
  let j = i;
  if ((w === 'a' || w === 'one') && words[i + 1] === 'hundred') [hundreds, j] = [100, i + 2];
  else if (UNITS[w] >= 2 && UNITS[w] <= 9 && words[i + 1] === 'hundred') [hundreds, j] = [100 * UNITS[w], i + 2];
  if (hundreds) {
    if (words[j] === 'and') j++;
    const rest = under100(words, j);
    return rest ? {value: hundreds + rest.value, len: j - i + rest.len} : {value: hundreds, len: j - i};
  }
  const first = under100(words, i);
  if (!first) return null;
  if (first.len === 1 && first.value >= 1 && first.value <= 9) {
    const w2 = words[i + 1];
    if (w2 === 'oh' || w2 === 'o') {
      const u = under100(words, i + 2);
      if (u && u.value < 10) return {value: first.value * 100 + u.value, len: 3};
    }
    const rest = under100(words, i + 1);
    if (rest && rest.value >= 10) return {value: first.value * 100 + rest.value, len: 1 + rest.len};
  }
  return first;
}
