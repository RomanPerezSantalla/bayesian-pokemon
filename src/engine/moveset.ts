/**
 * Move-set model.
 *
 * Usage stats only give P(move in set) per move. We model a 4-move set as a
 * conditional-Poisson sample: P(M) ∝ Π_{m∈M} w_m over sets of exactly k moves,
 * with weights fitted so the inclusion probabilities match the stats. That makes
 * "which moves have we seen" a proper likelihood, P(R ⊆ M), and gives honest
 * predictions for the unrevealed slots.
 *
 * Items reweight moves (an Assault Vest can't hold Protect; Choice items rarely
 * carry status moves but love Trick), so revealing a move shifts item beliefs.
 */
import {toID} from '../data/dex';

export interface MoveModel {
  names: string[];
  ids: string[];
  status: boolean[];
  /** Target inclusion probabilities from usage stats. */
  pi: number[];
  w: Float64Array;
  k: number;
}

const PSEUDO = '__other';
export const isPseudoMove = (name: string) => name.startsWith(PSEUDO);

function esp(w: ArrayLike<number>, k: number, skip?: (i: number) => boolean): Float64Array {
  const e = new Float64Array(k + 1);
  e[0] = 1;
  for (let m = 0; m < w.length; m++) {
    if (skip?.(m)) continue;
    const x = w[m];
    for (let j = k; j >= 1; j--) e[j] += x * e[j - 1];
  }
  return e;
}

export function inclusion(w: ArrayLike<number>, k: number): Float64Array {
  const e = esp(w, k);
  const out = new Float64Array(w.length);
  for (let m = 0; m < w.length; m++) {
    const em = esp(w, k - 1, i => i === m);
    out[m] = (w[m] * em[k - 1]) / e[k];
  }
  return out;
}

function fitWeights(pi: number[], k: number): Float64Array {
  const w = Float64Array.from(pi, p => p / (1 - p));
  for (let iter = 0; iter < 200; iter++) {
    const inc = inclusion(w, k);
    let err = 0;
    let logSum = 0;
    for (let m = 0; m < w.length; m++) {
      const q = Math.min(Math.max(inc[m], 1e-9), 1 - 1e-9);
      err = Math.max(err, Math.abs(q - pi[m]));
      w[m] *= (pi[m] / (1 - pi[m])) / (q / (1 - q));
      logSum += Math.log(w[m]);
    }
    const scale = Math.exp(-logSum / w.length);
    for (let m = 0; m < w.length; m++) w[m] *= scale;
    if (err < 1e-5) break;
  }
  return w;
}

/**
 * @param moves [name, P(in set)] from usage stats
 * @param extra moves seen in battle that the stats don't list
 */
export function buildMoveModel(
  moves: [string, number][],
  isStatus: (name: string) => boolean,
  extra: string[] = [],
  k = 4,
): MoveModel {
  const entries = moves.map(([n, p]) => [n, Math.min(Math.max(p, 1e-4), 0.999)] as [string, number]);
  const known = new Set(entries.map(([n]) => toID(n)));
  for (const n of extra) {
    if (!known.has(toID(n))) {
      entries.push([n, 0.01]);
      known.add(toID(n));
    }
  }
  let total = entries.reduce((s, [, p]) => s + p, 0);
  const reserve = 0.01;
  if (total > k - reserve) {
    const scale = (k - reserve) / total;
    for (const e of entries) e[1] *= scale;
    total = k - reserve;
  }
  // Pad with pseudo-moves standing for everything the stats don't list.
  const leftover = k - total;
  const nPseudo = Math.max(1, Math.ceil(leftover / 0.8));
  for (let i = 0; i < nPseudo; i++) entries.push([`${PSEUDO}${i}`, leftover / nPseudo]);

  const pi = entries.map(([, p]) => p);
  return {
    names: entries.map(([n]) => n),
    ids: entries.map(([n]) => toID(n)),
    status: entries.map(([n]) => !isPseudoMove(n) && isStatus(n)),
    pi,
    w: fitWeights(pi, k),
    k,
  };
}

/**
 * Refit weights so that the item-weighted mixture, not the item-free model,
 * reproduces the usage stats: if 25% of Garchomp carry a Scarf and almost none
 * of those run Protect, the other 75% must run it more often than 69%.
 */
export function fitToItems(model: MoveModel, items: string[], itemP: number[]) {
  const groups = new Map<string, {f: Float64Array; p: number}>();
  items.forEach((item, i) => {
    const f = itemFactors(model, item);
    const key = f.join(',');
    const g = groups.get(key);
    if (g) g.p += itemP[i];
    else groups.set(key, {f, p: itemP[i]});
  });
  if (groups.size < 2) return;
  const {k, pi, w} = model;
  for (let iter = 0; iter < 150; iter++) {
    const q = new Float64Array(w.length);
    for (const {f, p} of groups.values()) {
      const inc = inclusion(w.map((x, m) => x * f[m]), k);
      for (let m = 0; m < w.length; m++) q[m] += p * inc[m];
    }
    let err = 0;
    let logSum = 0;
    for (let m = 0; m < w.length; m++) {
      const qm = Math.min(Math.max(q[m], 1e-9), 1 - 1e-9);
      err = Math.max(err, Math.abs(qm - pi[m]));
      // Damped, clamped update: some targets may be unreachable under the item rules.
      const ratio = (pi[m] / (1 - pi[m])) / (qm / (1 - qm));
      w[m] *= Math.min(5, Math.max(0.2, ratio)) ** 0.8;
      logSum += Math.log(w[m]);
    }
    const scale = Math.exp(-logSum / w.length);
    for (let m = 0; m < w.length; m++) w[m] = Math.min(1e8, Math.max(1e-8, w[m] * scale));
    if (err < 2e-4) break;
  }
}

const CHOICE = new Set(['Choice Band', 'Choice Specs', 'Choice Scarf']);
const CHOICE_FRIENDLY_STATUS = new Set(['trick', 'switcheroo']);
const CHOICE_OK_STATUS = new Set(['healingwish', 'lunardance', 'memento', 'partingshot']);
// Pointless while locked into one move: essentially never on Choice sets.
const PROTECTS = new Set([
  'protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'obstruct',
  'substitute', 'swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'bulkup', 'quiverdance', 'shellsmash',
]);

export const isChoiceItem = (item: string) => CHOICE.has(item);

/** How much more (or less) likely a move is to be in the set given the item. */
export function moveItemFactor(item: string, moveId: string, isStatus: boolean): number {
  // Assault Vest can't select status moves at all.
  if (item === 'Assault Vest') return isStatus ? 0 : 1;
  if (CHOICE.has(item)) {
    if (CHOICE_FRIENDLY_STATUS.has(moveId)) return 4;
    if (!isStatus) return 1;
    if (CHOICE_OK_STATUS.has(moveId)) return 0.6;
    return PROTECTS.has(moveId) ? 0.002 : 0.02;
  }
  return 1;
}

export function itemFactors(model: MoveModel, item: string): Float64Array {
  return Float64Array.from(model.ids, (id, i) => moveItemFactor(item, id, model.status[i]));
}

export function indexOfMove(model: MoveModel, name: string) {
  return model.ids.indexOf(toID(name));
}

/**
 * log P(all of `revealed` are in the set and none of `absent` are),
 * under weights w·factor.
 */
export function movesLogLik(
  model: MoveModel,
  revealed: number[],
  absent: number[],
  factor?: Float64Array,
): number {
  const {k} = model;
  const w = factor ? model.w.map((x, i) => x * factor[i]) : model.w;
  if (revealed.length > k) return Math.log(1e-9);
  const inR = new Set(revealed);
  const excluded = new Set([...revealed, ...absent]);
  const full = esp(w, k);
  const rest = esp(w, k - revealed.length, i => excluded.has(i));
  let num = rest[k - revealed.length];
  for (const m of revealed) num *= w[m];
  if (absent.some(m => inR.has(m))) return Math.log(1e-9);
  return num > 0 ? Math.log(num / full[k]) : -Infinity;
}

/** P(move m is in the set | revealed ⊆ set, absent ∩ set = ∅). Revealed moves get 1. */
export function predictMoves(
  model: MoveModel,
  revealed: number[],
  absent: number[],
  factor?: Float64Array,
): Float64Array {
  const {k} = model;
  const w = factor ? model.w.map((x, i) => x * factor[i]) : model.w;
  const out = new Float64Array(w.length);
  const excluded = new Set([...revealed, ...absent]);
  for (const m of revealed) out[m] = 1;
  const left = k - revealed.length;
  if (left <= 0) return out;
  const base = esp(w, left, i => excluded.has(i));
  if (base[left] <= 0) return out;
  for (let m = 0; m < w.length; m++) {
    if (excluded.has(m)) continue;
    const e = esp(w, left - 1, i => excluded.has(i) || i === m);
    out[m] = (w[m] * e[left - 1]) / base[left];
  }
  return out;
}
