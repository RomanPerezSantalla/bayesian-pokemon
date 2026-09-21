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
import {
  DROP_REACT_ITEMS, ENTRY_ANNOUNCE, ENTRY_ITEMS, INTIMIDATE_REACT, INTIMIDATE_REACT_ITEMS, announceLikelihood,
} from './abilities';
import type {ActionEvent, Battle, BattleEvent, CheckEvent, MonRef, RevealEvent} from './types';


/** Each turn a Mega-capable Pokémon acted without Mega Evolving while it could (a habit, not a rule). */
const MEGA_SKIPPED = 0.35;

export interface DistEntry {
  name: string;
  p: number;
  prior: number;
  /** Logically certain: every alternative has been ruled out. */
  certain?: boolean;
}

export interface Interval {
  mode: number;
  /** 95% credible interval. */
  lo: number;
  hi: number;
  /** The same interval under the usage prior alone, to show how far it has shrunk. */
  priorLo: number;
  priorHi: number;
}

export interface StatBelief extends Interval {
  stat: StatID;
  /** [value, probability], ascending by value. */
  values: [number, number][];
  /** Stat points (or EVs) invested, same treatment. */
  sp: Interval;
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
  kind: SlotLikelihood['kind'] | 'reveal' | 'moves' | 'choice' | 'mega' | 'conflict';
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
  /** Each Mega forme's own ability (fixed per forme). `abilities` is the one it enters with. */
  megaAbilityOf: Record<string, string>;
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
      if (ev.quick) push(ev.quick === 'Quick Claw' ? facts.items : facts.abilities, ev.quick);
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
    } else if (ev.kind === 'check' && ev.mon.side === 'opp' && ev.mon.slot === slot && ev.seen) {
      push(ev.seenKind === 'item' ? facts.items : facts.abilities, ev.seen);
    } else if (ev.kind === 'action' && ev.actor.side === 'me') {
      for (const hit of ev.hits) {
        if (hit.target.side === 'opp' && hit.target.slot === slot && hit.reaction) {
          push(DROP_REACT_ITEMS.has(hit.reaction) ? facts.items : facts.abilities, hit.reaction);
        }
      }
    }
  }
  return facts;
}

/** What an announcement moment (switch-in, Intimidate) showed, given each hypothesis. */
function checkLikelihood(space: MonSpace, ev: CheckEvent): Float64Array {
  const raw = new Float64Array(space.n);
  const [abilities, items] = ev.context === 'entry'
    ? [ENTRY_ANNOUNCE, ENTRY_ITEMS]
    : [INTIMIDATE_REACT, INTIMIDATE_REACT_ITEMS];
  for (let h = 0; h < space.n; h++) {
    const forme = space.formes[space.f[h]];
    const ability = ev.mega && forme.megaAbility ? forme.megaAbility : forme.abilities[space.a[h]];
    const item = ev.itemGone ? '' : itemOf(space, h);
    raw[h] = announceLikelihood(ev.seen, ability, item, abilities, items);
  }
  return raw;
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
      case 'ability':
        // A banner shows either the ability it entered with or, once evolved, its Mega's.
        match = toID(forme.abilities[space.a[h]]) === want || (!!forme.megaAbility && toID(forme.megaAbility) === want);
        break;
      case 'forme':
        match = toID(forme.species) === want;
        break;
      default:
        return null;
    }
    if (ev.negate) match = !match;
    raw[h] = match ? 1 : 0;
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
function applyItemClause(mons: {space: MonSpace; post: Float64Array}[]): boolean {
  if (mons.length < 2) return true;
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
  if (Z <= 0) return false;

  mons.forEach(({space, post}, j) => {
    const ratio = new Map<string, number>();
    labels[j].forEach((l, k) => ratio.set(l, probs[j][k] > 0 ? acc[j][k] / Z / probs[j][k] : 1));
    for (let h = 0; h < space.n; h++) post[h] *= ratio.get(labelOfItem[j].get(itemOf(space, h))!) ?? 1;
    normalizeInPlace(post);
  });
  return true;
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
  const out: DistEntry[] = [...m.entries()].map(([name, [p, pr]]) => ({name, p, prior: pr})).sort((a, b) => b.p - a.p || b.prior - a.prior);
  if (out.length && out[0].p > 0 && out.slice(1).every(e => e.p === 0)) {
    out[0].certain = true;
    out[0].p = 1;
  }
  return out;
}

function quantile(values: [number, number][], q: number) {
  let c = 0;
  for (const [v, p] of values) {
    c += p;
    if (c >= q) return v;
  }
  return values.length ? values[values.length - 1][0] : 0;
}

function interval(space: MonSpace, post: Float64Array, prior: Float64Array, value: (h: number) => number) {
  const m = new Map<number, [number, number]>();
  for (let h = 0; h < space.n; h++) {
    const v = value(h);
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
    values, mode,
    lo: quantile(values, 0.025), hi: quantile(values, 0.975),
    priorLo: quantile(priorValues, 0.025), priorHi: quantile(priorValues, 0.975),
  };
}

/**
 * Marginals of the joint spread posterior, so the stat-point budget is built in:
 * pinning 32 SP in Atk and Spe leaves at most 2 for everything else.
 */
function statBeliefs(space: MonSpace, post: Float64Array, prior: Float64Array): StatBelief[] {
  return STAT_IDS.map((stat, k) => {
    const v = interval(space, post, prior, h => space.formes[space.f[h]].stats[space.s[h]][k]);
    const {values: _, ...sp} = interval(space, post, prior, h => space.formes[space.f[h]].spreads[space.s[h]].evs[k]);
    return {stat, ...v, sp};
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

  // Exact update. An observation nothing can explain (a typo, a forgotten Helping Hand,
  // an unmodelled mechanic) would zero everything out, so it is set aside and flagged.
  const apply = (eventId: string, slot: number, kind: EvidenceNote['kind'], note: string, raw: Float64Array) => {
    const lp = logPost[slot];
    if (!lp) return;
    const cur = normalizeLog(lp);
    let consistent = 0;
    for (let h = 0; h < raw.length; h++) if (raw[h] > 0) consistent += cur[h];
    if (!(consistent > 1e-12)) {
      const hint = kind === 'speed' ? ' (if the order is off, tap the move in the log to fix it)' : '';
      notes.push({eventId, slot, kind: 'conflict', note: `${note}: impossible given everything else, so it was ignored${hint}`, consistent: 0});
      return;
    }
    for (let h = 0; h < raw.length; h++) lp[h] += Math.log(raw[h]);
    notes.push({eventId, slot, kind, note, consistent});
  };

  // Damage, item messages and reveals, in log order.
  const turns = new Map<number, ActionEvent[]>();
  for (const ev of battle.events as BattleEvent[]) {
    if (ev.kind === 'action') {
      const likes = cached(likCache, `${ctxKey}|${JSON.stringify(ev)}`, () => actionLikelihoods(ctx, ev));
      for (const l of likes) apply(ev.id, l.slot, l.kind, l.note, l.raw);
      const list = turns.get(ev.turn) ?? [];
      list.push(ev);
      turns.set(ev.turn, list);
    } else if (ev.kind === 'reveal' && ev.mon.side === 'opp') {
      const space = spaces[ev.mon.slot];
      if (!space) continue;
      const raw = revealLikelihood(fmt, space, ev);
      if (raw) apply(ev.id, ev.mon.slot, 'reveal', `${ev.negate ? 'not ' : ''}${ev.value}`, raw);
    } else if (ev.kind === 'check' && ev.mon.side === 'opp' && !ev.skipped) {
      const space = spaces[ev.mon.slot];
      if (!space) continue;
      const what = ev.context === 'entry' ? 'on entry' : 'when Intimidated';
      apply(ev.id, ev.mon.slot, 'reveal', ev.seen ? `${ev.seen} ${what}` : `nothing shown ${what}`, checkLikelihood(space, ev));
    }
  }
  // Open team sheet entries act like reveals.
  battle.oppSheet?.forEach((set, j) => {
    const space = spaces[j];
    if (!set || !space) return;
    if (set.item) apply(`sheet${j}`, j, 'reveal', set.item, revealLikelihood(fmt, space, {kind: 'reveal', id: '', turn: 0, mon: {side: 'opp', slot: j}, what: 'item', value: set.item, negate: false})!);
    if (set.ability) apply(`sheet${j}`, j, 'reveal', set.ability, revealLikelihood(fmt, space, {kind: 'reveal', id: '', turn: 0, mon: {side: 'opp', slot: j}, what: 'ability', value: set.ability, negate: false})!);
  });

  // Turn order against my Pokémon (known speeds). Mega Evolutions count from the start of their turn.
  const megasOf = (turn: number): MonRef[] => (battle.events as BattleEvent[])
    .filter((e): e is RevealEvent => e.kind === 'reveal' && e.what === 'forme' && !e.negate && e.turn === turn)
    .map(e => e.mon);
  const oppPairs: OppPair[] = [];
  for (const [turn, actions] of turns) {
    const megas = megasOf(turn);
    const res = cached(orderCache, `${ctxKey}|${JSON.stringify(megas)}|${JSON.stringify(actions)}`, () => turnOrderLikelihoods(ctx, actions, megas));
    for (const l of res.mine) apply(`turn${turn}`, l.slot, l.kind, l.note, l.raw);
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
      if (max > -Infinity) for (let h = 0; h < space.n; h++) raw[h] = Math.exp(table[space.f[h]][space.i[h]] - max);
      apply(`moves${j}`, j, 'moves', `moves seen: ${f.moves.join(', ') || '—'}`, raw);
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
      for (let h = 0; h < space.n; h++) raw[h] = isChoiceItem(itemOf(space, h)) ? 0 : 1;
      apply(`choice${j}`, j, 'choice', 'used different moves without switching', raw);
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
        apply(`mega${j}`, j, 'mega', `acted ${n} turn${n > 1 ? 's' : ''} without Mega Evolving`, raw);
      }
    }
  });

  const post = logPost.map(lp => (lp ? normalizeLog(lp) : null));
  const active = spaces.map((space, j) => (space && post[j] ? {space, post: post[j]!} : null)).filter(x => x) as {space: MonSpace; post: Float64Array}[];
  if (fmt.itemClause && !applyItemClause(active)) {
    notes.push({eventId: 'itemclause', slot: -1, kind: 'conflict', note: 'Two opponents revealed with the same item (Item Clause forbids it); check the reveals', consistent: 0});
  }

  // Turn order between two opponents: mean-field against the other's posterior.
  if (oppPairs.length) {
    const firstPass = post.map(p => (p ? Float64Array.from(p) : null));
    for (const {first, second, snap} of oppPairs) {
      const a = first.actor.slot;
      const b = second.actor.slot;
      const sa = spaces[a];
      const sb = spaces[b];
      if (!sa || !sb || !firstPass[a] || !firstPass[b]) continue;
      const memoA = new Map<string, [number, number]>();
      const memoB = new Map<string, [number, number]>();
      const dist = (space: MonSpace, p: Float64Array, ev: ActionEvent, memo: Map<string, [number, number]>) => {
        const d = new Map<string, [[number, number], number]>();
        for (let h = 0; h < space.n; h++) {
          if (p[h] < 1e-7) continue;
          const k = oppOrderKey(ctx, space, h, ev.actor, ev.move, snap, memo, !!ev.quick);
          const id = k.join(',');
          const cur = d.get(id);
          if (cur) cur[1] += p[h];
          else d.set(id, [k, p[h]]);
        }
        return [...d.values()];
      };
      const dA = dist(sa, firstPass[a]!, first, memoA);
      const dB = dist(sb, firstPass[b]!, second, memoB);
      const tr = snap.field.trickRoom;
      const rawA = new Float64Array(sa.n);
      for (let h = 0; h < sa.n; h++) {
        const k = oppOrderKey(ctx, sa, h, first.actor, first.move, snap, memoA, !!first.quick);
        rawA[h] = dB.reduce((s, [kb, w]) => s + w * orderConsistency(k, kb, tr), 0);
      }
      const rawB = new Float64Array(sb.n);
      for (let h = 0; h < sb.n; h++) {
        const k = oppOrderKey(ctx, sb, h, second.actor, second.move, snap, memoB, !!second.quick);
        rawB[h] = dA.reduce((s, [ka, w]) => s + w * orderConsistency(ka, k, tr), 0);
      }
      for (const [slot, raw, note] of [[a, rawA, `moved before opposing ${previews[b]}`], [b, rawB, `moved after opposing ${previews[a]}`]] as const) {
        const p = post[slot]!;
        let consistent = 0;
        for (let h = 0; h < p.length; h++) if (raw[h] > 0) consistent += p[h];
        if (!(consistent > 1e-12)) {
          notes.push({eventId: `turn${first.turn}`, slot, kind: 'conflict', note: `${note}: impossible given everything else, so it was ignored (if the order is off, tap the move in the log to fix it)`, consistent: 0});
          continue;
        }
        for (let h = 0; h < p.length; h++) p[h] *= raw[h];
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
      megaAbilityOf: Object.fromEntries(space.formes.filter(fm => fm.megaAbility).map(fm => [fm.species, fm.megaAbility!])),
    };
  });
  return {mons, notes, ms: performance.now() - t0};
}

export {defaultCondition};
