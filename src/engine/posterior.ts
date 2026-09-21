/**
 * Turns a battle log into beliefs about every opponent Pokémon.
 *
 * posterior(h) ∝ prior(h) · Π_events P(event | h), recomputed from scratch on
 * every change (so editing or deleting an old event just works), with the
 * expensive per-event likelihoods cached.
 */
import {STAT_IDS, getGen, toID, type StatID} from '../data/dex';
import type {FormatData} from '../data/format';
import {hashString} from './rng';
import {
  actionLikelihoods, defaultCondition, oppOrderKey, orderConsistency, turnOrderLikelihoods, type Ctx, type OppPair,
  type SlotLikelihood,
} from './likelihood';
import {indexOfMove, isChoiceItem, isPseudoMove, itemFactors, movesLogLik, predictMoves} from './moveset';
import {NO_ITEM, OTHER_ITEM, buildMonSpace, type MonSpace} from './prior';
import type {ActionEvent, Battle, BattleEvent, RevealEvent} from './types';


/** Added to raw likelihoods: how much we trust any single observation. */
const FLOOR = 1e-4;
/** A direct reveal ("it has Leftovers") contradicted by a hypothesis. */
const HARD = 1e-6;
/** A Choice item that switched moves without switching out. */
const CHOICE_BROKEN = 0.002;
/** Each turn a Mega-capable Pokémon acted without Mega Evolving while it could. */
const MEGA_SKIPPED = 0.35;

export interface DistEntry {
  name: string;
  p: number;
  prior: number;
}

export interface StatBelief {
  stat: StatID;
  /** [value, probability], ascending by value. */
  values: [number, number][];
  mode: number;
  lo: number;
  hi: number;
  priorLo: number;
  priorHi: number;
}

export interface SpreadBelief {
  forme: string;
  nature: string;
  evs: number[];
  stats: number[];
  p: number;
  prior: number;
}

export interface MoveBelief {
  name: string;
  p: number;
  prior: number;
  revealed: boolean;
}

export interface EvidenceNote {
  eventId: string;
  slot: number;
  kind: SlotLikelihood['kind'] | 'reveal' | 'moves' | 'choice' | 'mega';
  note: string;
  /** Share of prior-to-event belief that could produce this observation at all. */
  consistent: number;
}

export interface Facts {
  items: string[];
  notItems: string[];
  abilities: string[];
  notAbilities: string[];
  moves: string[];
  notMoves: string[];
  formes: string[];
  tera?: string;
}

export interface MonBelief {
  slot: number;
  preview: string;
  space: MonSpace;
  post: Float64Array;
  prior: Float64Array;
  facts: Facts;
  formes: DistEntry[];
  items: DistEntry[];
  abilities: DistEntry[];
  tera?: DistEntry[];
  stats: StatBelief[];
  spreads: SpreadBelief[];
  moves: MoveBelief[];
  choiceBroken: boolean;
}

export interface Beliefs {
  mons: (MonBelief | null)[];
  notes: EvidenceNote[];
  ms: number;
}

// --- helpers -------------------------------------------------------------------

function normalizeLog(logp: Float64Array): Float64Array {
  let max = -Infinity;
  for (const x of logp) if (x > max) max = x;
  const out = new Float64Array(logp.length);
  let total = 0;
  for (let h = 0; h < logp.length; h++) {
    out[h] = Math.exp(logp[h] - max);
    total += out[h];
  }
  for (let h = 0; h < out.length; h++) out[h] /= total || 1;
  return out;
}

function normalizeInPlace(p: Float64Array) {
  let total = 0;
  for (const x of p) total += x;
  for (let h = 0; h < p.length; h++) p[h] /= total || 1;
}

const itemOf = (space: MonSpace, h: number) => space.formes[space.f[h]].items[space.i[h]];

function collectFacts(battle: Battle, slot: number): Facts {
  const facts: Facts = {items: [], notItems: [], abilities: [], notAbilities: [], moves: [], notMoves: [], formes: []};
  const push = (list: string[], v: string) => {
    if (v && !list.some(x => toID(x) === toID(v))) list.push(v);
  };
  const sheet = battle.oppSheet?.[slot];
  if (sheet) {
    if (sheet.item) push(facts.items, sheet.item);
    if (sheet.ability) push(facts.abilities, sheet.ability);
    for (const m of sheet.moves) push(facts.moves, m);
    if (sheet.teraType) facts.tera = sheet.teraType;
  }
  for (const ev of battle.events) {
    if (ev.kind === 'action' && ev.actor.side === 'opp' && ev.actor.slot === slot && toID(ev.move) !== 'struggle') {
      push(facts.moves, ev.move);
    } else if (ev.kind === 'reveal' && ev.mon.side === 'opp' && ev.mon.slot === slot) {
      const target = {
        item: [facts.items, facts.notItems],
        ability: [facts.abilities, facts.notAbilities],
        move: [facts.moves, facts.notMoves],
        forme: [facts.formes, facts.formes],
        tera: [[], []],
      }[ev.what][ev.negate ? 1 : 0];
      if (ev.what === 'tera' && !ev.negate) facts.tera = ev.value;
      else if (!(ev.what === 'forme' && ev.negate)) push(target, ev.value);
    }
  }
  return facts;
}

function revealLikelihood(fmt: FormatData, space: MonSpace, ev: RevealEvent): Float64Array | null {
  const raw = new Float64Array(space.n);
  const want = toID(ev.value);
  for (let h = 0; h < space.n; h++) {
    const forme = space.formes[space.f[h]];
    let match: boolean;
    switch (ev.what) {
      case 'item':
        match = toID(itemOf(space, h)) === want;
        break;
      case 'ability': {
        const own = toID(forme.abilities[space.a[h]]) === want;
        match = own || !!forme.preMegaAbilities?.some(a => toID(a) === want);
        break;
      }
      case 'forme':
        match = toID(forme.species) === want;
        break;
      default:
        return null;
    }
    if (ev.negate) match = !match;
    raw[h] = match ? 1 : HARD;
  }
  void fmt;
  return raw;
}

// --- caching -------------------------------------------------------------------

const likCache = new Map<string, SlotLikelihood[]>();
const orderCache = new Map<string, ReturnType<typeof turnOrderLikelihoods>>();
function cached<T>(cache: Map<string, T>, key: string, fn: () => T): T {
  let v = cache.get(key);
  if (v === undefined) {
    v = fn();
    if (cache.size > 3000) cache.clear();
    cache.set(key, v);
  }
  return v;
}

// --- item clause -----------------------------------------------------------------

const EXEMPT = new Set([OTHER_ITEM, NO_ITEM, '__rest']);

/**
 * Item Clause: no two Pokémon on a team share an item. Exact constrained
 * marginals by enumeration over each Pokémon's plausible items.
 */
function applyItemClause(mons: {space: MonSpace; post: Float64Array}[]) {
  if (mons.length < 2) return;
  const labels: string[][] = [];
  const probs: number[][] = [];
  const labelOfItem: Map<string, string>[] = [];
  for (const {space, post} of mons) {
    const q = new Map<string, number>();
    for (let h = 0; h < space.n; h++) {
      const it = itemOf(space, h);
      q.set(it, (q.get(it) ?? 0) + post[h]);
    }
    const sorted = [...q.entries()].sort((a, b) => b[1] - a[1]);
    const keep = sorted.filter(([it, p]) => !EXEMPT.has(it) && p >= 0.002).slice(0, 8);
    const map = new Map<string, string>();
    const ls: string[] = [];
    const ps: number[] = [];
    let rest = 0;
    for (const [it, p] of sorted) {
      if (keep.some(([k]) => k === it)) {
        map.set(it, it);
        ls.push(it);
        ps.push(p);
      } else {
        map.set(it, '__rest');
        rest += p;
      }
    }
    if (rest > 0) {
      ls.push('__rest');
      ps.push(rest);
    }
    labels.push(ls);
    probs.push(ps);
    labelOfItem.push(map);
  }

  const acc = labels.map(ls => new Float64Array(ls.length));
  const used = new Set<string>();
  const pick: number[] = [];
  let Z = 0;
  const dfs = (j: number, w: number) => {
    if (w < 1e-14) return;
    if (j === labels.length) {
      Z += w;
      pick.forEach((k, jj) => (acc[jj][k] += w));
      return;
    }
    for (let k = 0; k < labels[j].length; k++) {
      const it = labels[j][k];
      const exempt = EXEMPT.has(it);
      if (!exempt && used.has(it)) continue;
      if (!exempt) used.add(it);
      pick[j] = k;
      dfs(j + 1, w * probs[j][k]);
      if (!exempt) used.delete(it);
    }
  };
  dfs(0, 1);
  if (Z <= 0) return;

  mons.forEach(({space, post}, j) => {
    const ratio = new Map<string, number>();
    labels[j].forEach((l, k) => ratio.set(l, probs[j][k] > 0 ? acc[j][k] / Z / probs[j][k] : 1));
    for (let h = 0; h < space.n; h++) post[h] *= ratio.get(labelOfItem[j].get(itemOf(space, h))!) ?? 1;
    normalizeInPlace(post);
  });
}

// --- summaries -------------------------------------------------------------------

function aggregate(space: MonSpace, post: Float64Array, prior: Float64Array, key: (h: number) => string): DistEntry[] {
  const m = new Map<string, [number, number]>();
  for (let h = 0; h < space.n; h++) {
    const k = key(h);
    const cur = m.get(k) ?? [0, 0];
    cur[0] += post[h];
    cur[1] += prior[h];
    m.set(k, cur);
  }
  return [...m.entries()].map(([name, [p, pr]]) => ({name, p, prior: pr})).sort((a, b) => b.p - a.p || b.prior - a.prior);
}

function quantile(values: [number, number][], q: number) {
  let c = 0;
  for (const [v, p] of values) {
    c += p;
    if (c >= q) return v;
  }
  return values.length ? values[values.length - 1][0] : 0;
}

function statBeliefs(space: MonSpace, post: Float64Array, prior: Float64Array): StatBelief[] {
  return STAT_IDS.map((stat, k) => {
    const m = new Map<number, [number, number]>();
    for (let h = 0; h < space.n; h++) {
      const v = space.formes[space.f[h]].stats[space.s[h]][k];
      const cur = m.get(v) ?? [0, 0];
      cur[0] += post[h];
      cur[1] += prior[h];
      m.set(v, cur);
    }
    const sorted = [...m.entries()].sort((a, b) => a[0] - b[0]);
    const values = sorted.map(([v, [p]]) => [v, p] as [number, number]);
    const priorValues = sorted.map(([v, [, p]]) => [v, p] as [number, number]);
    let mode = values[0]?.[0] ?? 0;
    let best = -1;
    for (const [v, p] of values) if (p > best) [best, mode] = [p, v];
    return {
      stat, values, mode,
      lo: quantile(values, 0.05), hi: quantile(values, 0.95),
      priorLo: quantile(priorValues, 0.05), priorHi: quantile(priorValues, 0.95),
    };
  });
}

function spreadBeliefs(space: MonSpace, post: Float64Array, prior: Float64Array): SpreadBelief[] {
  const m = new Map<number, [number, number]>();
  for (let h = 0; h < space.n; h++) {
    const k = space.f[h] * 65536 + space.s[h];
    const cur = m.get(k) ?? [0, 0];
    cur[0] += post[h];
    cur[1] += prior[h];
    m.set(k, cur);
  }
  return [...m.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 10).map(([k, [p, pr]]) => {
    const forme = space.formes[Math.floor(k / 65536)];
    const s = k % 65536;
    return {forme: forme.species, ...forme.spreads[s], stats: forme.stats[s], p, prior: pr};
  });
}

function moveBeliefs(space: MonSpace, post: Float64Array, prior: Float64Array, facts: Facts): MoveBelief[] {
  const acc = new Map<string, [number, number]>();
  space.formes.forEach((forme, fi) => {
    const model = forme.moves;
    const revealed = facts.moves.map(m => indexOfMove(model, m)).filter(i => i >= 0);
    const absent = facts.notMoves.map(m => indexOfMove(model, m)).filter(i => i >= 0);
    forme.items.forEach((item, ii) => {
      let wPost = 0;
      let wPrior = 0;
      for (let h = 0; h < space.n; h++) {
        if (space.f[h] === fi && space.i[h] === ii) {
          wPost += post[h];
          wPrior += prior[h];
        }
      }
      if (wPost < 1e-6 && wPrior < 1e-6) return;
      const factor = itemFactors(model, item);
      const pp = predictMoves(model, revealed, absent, factor);
      const pr = predictMoves(model, [], [], factor);
      model.names.forEach((name, m) => {
        if (isPseudoMove(name)) return;
        const cur = acc.get(name) ?? [0, 0];
        cur[0] += wPost * pp[m];
        cur[1] += wPrior * pr[m];
        acc.set(name, cur);
      });
    });
  });
  const revealed = new Set(facts.moves.map(toID));
  return [...acc.entries()]
    .map(([name, [p, pr]]) => ({name, p: revealed.has(toID(name)) ? 1 : p, prior: pr, revealed: revealed.has(toID(name))}))
    .sort((a, b) => Number(b.revealed) - Number(a.revealed) || b.p - a.p);
}

// --- main ----------------------------------------------------------------------

export function computeBeliefs(fmt: FormatData, battle: Battle): Beliefs {
  const t0 = performance.now();
  const gen = getGen(fmt.gen);
  const previews = battle.oppPreview;
  const facts = previews.map((_, j) => collectFacts(battle, j));
  const spaces = previews.map((name, j) => (name
    ? buildMonSpace(fmt, gen, name, previews.filter((p, k) => k !== j && p), {
      items: facts[j].items, abilities: facts[j].abilities, moves: facts[j].moves,
    })
    : null));
  const ctx: Ctx = {fmt, gen, battle, spaces};
  const ctxKey = hashString(JSON.stringify([spaces.map(s => s?.key), battle.settings, battle.myTeam])).toString(36);

  const logPost = spaces.map(s => (s ? Float64Array.from(s.logPrior) : null));
  const notes: EvidenceNote[] = [];

  const apply = (eventId: string, slot: number, kind: EvidenceNote['kind'], note: string, raw: Float64Array, floor = FLOOR) => {
    const lp = logPost[slot];
    if (!lp) return;
    const cur = normalizeLog(lp);
    let consistent = 0;
    for (let h = 0; h < raw.length; h++) {
      if (raw[h] > 1e-9) consistent += cur[h];
      lp[h] += Math.log(raw[h] + floor);
    }
    notes.push({eventId, slot, kind, note, consistent});
  };

  // Damage, item messages and reveals, in log order.
  const turns = new Map<number, ActionEvent[]>();
  for (const ev of battle.events as BattleEvent[]) {
    if (ev.kind === 'action') {
      const likes = cached(likCache, `${ctxKey}|${JSON.stringify(ev)}`, () => actionLikelihoods(ctx, ev));
      // Item messages are as reliable as reveals; their raw values already encode the error rate.
      for (const l of likes) apply(ev.id, l.slot, l.kind, l.note, l.raw, l.kind === 'trigger' ? 0 : FLOOR);
      const list = turns.get(ev.turn) ?? [];
      list.push(ev);
      turns.set(ev.turn, list);
    } else if (ev.kind === 'reveal' && ev.mon.side === 'opp') {
      const space = spaces[ev.mon.slot];
      if (!space) continue;
      const raw = revealLikelihood(fmt, space, ev);
      if (raw) apply(ev.id, ev.mon.slot, 'reveal', `${ev.negate ? 'not ' : ''}${ev.value}`, raw, 0);
    }
  }
  // Open team sheet entries act like reveals.
  battle.oppSheet?.forEach((set, j) => {
    const space = spaces[j];
    if (!set || !space) return;
    if (set.item) apply(`sheet${j}`, j, 'reveal', set.item, revealLikelihood(fmt, space, {kind: 'reveal', id: '', turn: 0, mon: {side: 'opp', slot: j}, what: 'item', value: set.item, negate: false})!, 0);
    if (set.ability) apply(`sheet${j}`, j, 'reveal', set.ability, revealLikelihood(fmt, space, {kind: 'reveal', id: '', turn: 0, mon: {side: 'opp', slot: j}, what: 'ability', value: set.ability, negate: false})!, 0);
  });

  // Turn order against my Pokémon (known speeds).
  const oppPairs: OppPair[] = [];
  for (const [turn, actions] of turns) {
    const res = cached(orderCache, `${ctxKey}|${JSON.stringify(actions)}`, () => turnOrderLikelihoods(ctx, actions));
    for (const l of res.mine) apply(`turn${turn}`, l.slot, l.kind, l.note, l.raw, 0.01);
    oppPairs.push(...res.oppPairs);
  }

  const choiceBroken = previews.map(() => false);
  spaces.forEach((space, j) => {
    const lp = logPost[j];
    if (!space || !lp) return;
    const f = facts[j];

    // Moves seen: P(seen ⊆ set | forme, item).
    if (f.moves.length || f.notMoves.length) {
      const table = space.formes.map(forme => {
        const R = f.moves.map(m => indexOfMove(forme.moves, m)).filter(i => i >= 0);
        const N = f.notMoves.map(m => indexOfMove(forme.moves, m)).filter(i => i >= 0);
        return forme.items.map(item => movesLogLik(forme.moves, R, N, itemFactors(forme.moves, item)));
      });
      const raw = new Float64Array(space.n);
      let max = -Infinity;
      for (let h = 0; h < space.n; h++) max = Math.max(max, table[space.f[h]][space.i[h]]);
      for (let h = 0; h < space.n; h++) raw[h] = Math.exp(table[space.f[h]][space.i[h]] - max);
      apply(`moves${j}`, j, 'moves', `moves seen: ${f.moves.join(', ') || '—'}`, raw, 0);
    }

    // Choice lock: two different moves in one stint on the field.
    let last: string | null = null;
    for (const ev of battle.events) {
      if (ev.kind === 'switch' && ev.side === 'opp' && (ev.slotIn === j || ev.slotOut === j)) last = null;
      if (ev.kind !== 'action' || ev.actor.side !== 'opp' || ev.actor.slot !== j) continue;
      if (toID(ev.move) === 'struggle' || ev.before.mons[`opp${j}`]?.itemGone) {
        last = null;
        continue;
      }
      if (last && toID(last) !== toID(ev.move)) choiceBroken[j] = true;
      last = ev.move;
    }
    if (choiceBroken[j]) {
      const raw = new Float64Array(space.n);
      for (let h = 0; h < space.n; h++) raw[h] = isChoiceItem(itemOf(space, h)) ? CHOICE_BROKEN : 1;
      apply(`choice${j}`, j, 'choice', 'used different moves without switching', raw, 0);
    }

    // Didn't Mega Evolve when it could have.
    if (space.formes.some(fm => fm.preMega)) {
      const skipped = new Set<number>();
      for (const ev of battle.events) {
        if (ev.kind !== 'action' || ev.actor.side !== 'opp' || ev.actor.slot !== j) continue;
        const mons = ev.before.mons;
        const anyMega = Object.entries(mons).some(([k, c]) => k.startsWith('opp') && c.mega);
        if (!anyMega && !mons[`opp${j}`]?.mega) skipped.add(ev.turn);
      }
      const n = Math.min(2, skipped.size);
      if (n) {
        const raw = new Float64Array(space.n);
        for (let h = 0; h < space.n; h++) raw[h] = space.formes[space.f[h]].preMega ? MEGA_SKIPPED ** n : 1;
        apply(`mega${j}`, j, 'mega', `acted ${n} turn${n > 1 ? 's' : ''} without Mega Evolving`, raw, 0);
      }
    }
  });

  const post = logPost.map(lp => (lp ? normalizeLog(lp) : null));
  const active = spaces.map((space, j) => (space && post[j] ? {space, post: post[j]!} : null)).filter(x => x) as {space: MonSpace; post: Float64Array}[];
  if (fmt.itemClause) applyItemClause(active);

  // Turn order between two opponents: mean-field against the other's posterior.
  if (oppPairs.length) {
    const firstPass = post.map(p => (p ? Float64Array.from(p) : null));
    for (const {first, second} of oppPairs) {
      const a = first.actor.slot;
      const b = second.actor.slot;
      const sa = spaces[a];
      const sb = spaces[b];
      if (!sa || !sb || !firstPass[a] || !firstPass[b]) continue;
      const snap = first.before;
      const memoA = new Map<string, [number, number]>();
      const memoB = new Map<string, [number, number]>();
      const dist = (space: MonSpace, p: Float64Array, ref: typeof first.actor, mv: string, memo: Map<string, [number, number]>) => {
        const d = new Map<string, [[number, number], number]>();
        for (let h = 0; h < space.n; h++) {
          if (p[h] < 1e-7) continue;
          const k = oppOrderKey(ctx, space, h, ref, mv, snap, memo);
          const id = k.join(',');
          const cur = d.get(id);
          if (cur) cur[1] += p[h];
          else d.set(id, [k, p[h]]);
        }
        return [...d.values()];
      };
      const dA = dist(sa, firstPass[a]!, first.actor, first.move, memoA);
      const dB = dist(sb, firstPass[b]!, second.actor, second.move, memoB);
      const tr = snap.field.trickRoom;
      const rawA = new Float64Array(sa.n);
      for (let h = 0; h < sa.n; h++) {
        const k = oppOrderKey(ctx, sa, h, first.actor, first.move, snap, memoA);
        rawA[h] = dB.reduce((s, [kb, w]) => s + w * orderConsistency(k, kb, tr), 0);
      }
      const rawB = new Float64Array(sb.n);
      for (let h = 0; h < sb.n; h++) {
        const k = oppOrderKey(ctx, sb, h, second.actor, second.move, snap, memoB);
        rawB[h] = dA.reduce((s, [ka, w]) => s + w * orderConsistency(ka, k, tr), 0);
      }
      for (const [slot, raw, note] of [[a, rawA, `moved before opposing ${previews[b]}`], [b, rawB, `moved after opposing ${previews[a]}`]] as const) {
        const p = post[slot]!;
        let consistent = 0;
        for (let h = 0; h < p.length; h++) {
          if (raw[h] > 1e-9) consistent += p[h];
          p[h] *= raw[h] + 0.01;
        }
        normalizeInPlace(p);
        notes.push({eventId: `turn${first.turn}`, slot, kind: 'speed', note, consistent});
      }
    }
  }

  // Priors for comparison: usage stats + teammates + item clause, no evidence.
  const priors = spaces.map(s => (s ? normalizeLog(s.logPrior) : null));
  if (fmt.itemClause) {
    applyItemClause(spaces.map((s, j) => (s ? {space: s, post: priors[j]!} : null)).filter(x => x) as {space: MonSpace; post: Float64Array}[]);
  }

  const mons = spaces.map((space, j): MonBelief | null => {
    const p = post[j];
    const pr = priors[j];
    if (!space || !p || !pr) return null;
    const f = facts[j];
    const formeTera = new Map<string, [number, number]>();
    let tera: DistEntry[] | undefined;
    if (fmt.gen === 9) {
      const fp = aggregate(space, p, pr, h => String(space.f[h]));
      for (const {name, p: wp, prior: wpr} of fp) {
        for (const [t, q] of space.formes[Number(name)].tera ?? []) {
          const cur = formeTera.get(t) ?? [0, 0];
          cur[0] += wp * q;
          cur[1] += wpr * q;
          formeTera.set(t, cur);
        }
      }
      tera = f.tera
        ? [{name: f.tera, p: 1, prior: formeTera.get(f.tera)?.[1] ?? 0}]
        : [...formeTera.entries()].map(([name, [a, b]]) => ({name, p: a, prior: b})).sort((x, y) => y.p - x.p);
    }
    return {
      slot: j,
      preview: space.preview,
      space,
      post: p,
      prior: pr,
      facts: f,
      formes: aggregate(space, p, pr, h => space.formes[space.f[h]].species),
      items: aggregate(space, p, pr, h => itemOf(space, h)),
      abilities: aggregate(space, p, pr, h => space.formes[space.f[h]].abilities[space.a[h]]),
      tera,
      stats: statBeliefs(space, p, pr),
      spreads: spreadBeliefs(space, p, pr),
      moves: moveBeliefs(space, p, pr, f),
      choiceBroken: choiceBroken[j],
    };
  });
  return {mons, notes, ms: performance.now() - t0};
}

export {defaultCondition};
