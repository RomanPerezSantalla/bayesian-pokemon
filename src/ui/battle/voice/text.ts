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

/**
 * A rough sound-alike form of a squash()ed name, so that spellings the recogniser picks for the
 * same sounds come out alike: "sneezler" and "sneasler", "fairy giraffe" and "farigiraf", "whimsy
 * cot" and "whimsicott".
 */
export function sound(s: string): string {
  return s
    .replace(/ph/g, 'f').replace(/gh/g, 'g').replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
    .replace(/y/g, 'i').replace(/ee|ea|ie/g, 'i').replace(/oo|ou/g, 'u')
    .replace(/(.)\1+/g, '$1')
    .replace(/(.)e$/, '$1');
}

const CONSONANT: Record<string, number> = {
  b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6,
};

/**
 * The consonant sounds of a squash()ed name, in order (Soundex's classes, never cut short). The
 * recogniser gets vowels and word breaks wrong far more than consonants, so "carbonite" and
 * "corviknight" come out nearly alike, "really boom" and "rillaboom" exactly.
 */
export function consonants(s: string): string {
  s = s.replace(/^gh/, 'g').replace(/gh/g, '').replace(/ph/g, 'f').replace(/dg/g, 'j').replace(/^kn/, 'n').replace(/^wr/, 'r');
  let out = /^[aeiouy]/.test(s) ? 'a' : '';
  let prev = 0;
  for (const ch of s) {
    const c = CONSONANT[ch];
    if (!c) {
      // A vowel between two alike consonants keeps both ("tat"); h and w don't.
      if ('aeiouy'.includes(ch)) prev = 0;
      continue;
    }
    if (c !== prev) out += c;
    prev = c;
  }
  return out;
}

const memo = (fn: (s: string) => string) => {
  const cache = new Map<string, string>();
  return (s: string) => {
    let v = cache.get(s);
    if (v === undefined) cache.set(s, (v = fn(s)));
    return v;
  };
};
const soundOf = memo(sound);
const consonantsOf = memo(consonants);

/**
 * Words that don't start a Pokémon's name: the ones said around names ("opponent sent … and …",
 * "I brought …"), which a lenient match would otherwise take for a short name.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'up', 'down',
  'it', 'its', 'is', 'was', 'are', 'be', 'has', 'have', 'had', 'do', 'did', 'now', 'then', 'this', 'that', 'there', 'here',
  'i', 'im', 'ill', 'my', 'me', 'mine', 'we', 'our', 'you', 'your', 'they', 'their', 'theirs', 'them',
  'opponent', 'opponents', 'opposing', 'trainer', 'foe', 'enemy', 'rival',
  'sent', 'send', 'sends', 'sending', 'out', 'go', 'lead', 'leads', 'leading', 'brought', 'bring', 'bringing', 'used', 'uses', 'use',
  'what', 'who', 'know', 'mean', 'okay', 'ok', 'yes', 'no', 'not', 'just', 'like', 'well', 'oh', 'um', 'uh', 'hp', 'percent',
  'one', 'two', 'three', 'four', 'five', 'six', 'first', 'second', 'third', 'fourth', 'turn', 'next',
]);

export interface MatchOptions {
  /**
   * Also compare consonant sounds: for a handful of names (the Pokémon in a battle, your team),
   * where it rescues badly heard ones. Among hundreds it matches unrelated names, so not there.
   */
  consonants?: boolean;
  /** Words a name can't start with ("and", "brought"): common words would otherwise match short names. */
  stop?: ReadonlySet<string>;
  /** A word of 4+ letters that starts only one name ("corvi") names it. */
  prefix?: boolean;
}

/** How alike a heard word is to a name: by spelling, or by sound, whichever is closer. */
function likeness(heard: string, key: string, opts: MatchOptions): number {
  const close = Math.max(similarity(heard, key), similarity(soundOf(heard), soundOf(key)));
  if (!opts.consonants) return close;
  const a = consonantsOf(heard);
  const b = consonantsOf(key);
  if (a.length < 3 || b.length < 3) return close;
  const c = similarity(a, b);
  // Consonants alone, with the spelling far off, only when they agree closely ("carbonite", not "brought").
  return close >= 0.5 || c >= 0.72 ? Math.max(close, c * 0.95) : close;
}

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

/** Every candidate for the 1–3 words at `i`, best first, each with the words that fit it best. */
export function rankAt<T>(words: string[], i: number, cands: Named<T>[], opts: MatchOptions = {}): Match<T>[] {
  const best = new Map<T, Match<T>>();
  if (opts.stop?.has(words[i] ?? '')) return [];
  const keep = (value: T, len: number, score: number) => {
    const cur = best.get(value);
    if (!cur || score > cur.score || (score === cur.score && len < cur.len)) best.set(value, {value, len, score});
  };
  for (let n = 1; n <= 3 && i + n <= words.length; n++) {
    // A name doesn't run on past a number or a common word: "Celtic 3 Metagross" is two names.
    if (n > 1 && opts.stop && (opts.stop.has(words[i + n - 1]) || /^\d/.test(words[i + n - 1]))) break;
    const w = words.slice(i, i + n).join('');
    const forms = w.length > 4 && w.endsWith('s') ? [w, w.slice(0, -1)] : [w];
    for (const c of cands) {
      if (Math.abs(c.key.length - w.length) > Math.max(2, Math.ceil(c.key.length * 0.4))) continue;
      keep(c.value, n, Math.max(...forms.map(f => likeness(f, c.key, opts))) + (c.bonus ?? 0));
    }
  }
  if (opts.prefix) {
    const w = words[i] ?? '';
    const starts = w.length >= 4 ? cands.filter(c => w.length >= c.key.length * 0.4 && (c.key.startsWith(w) || soundOf(c.key).startsWith(soundOf(w)))) : [];
    if (starts.length && starts.every(c => c.value === starts[0].value)) keep(starts[0].value, 1, 0.8 + (starts[0].bonus ?? 0));
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * The candidate named by the 1–3 words at `i`, if it's clearly the one meant: close enough
 * (`min`) and ahead of the next-best different candidate by `margin`. A trailing "s" is
 * also tried without it, for possessives ("salamences intimidate").
 */
export function matchAt<T>(words: string[], i: number, cands: Named<T>[], min = 0.72, margin = 0.08, opts: MatchOptions = {}): Match<T> | null {
  const [top, next] = rankAt(words, i, cands, opts);
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
