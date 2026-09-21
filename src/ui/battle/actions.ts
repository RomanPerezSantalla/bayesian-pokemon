/**
 * Every change to a battle goes through here: it records an event (with an exact
 * undo snapshot) and advances the live state with the bookkeeping in engine/state.
 */
import {toID, type Gen} from '../../data/dex';
import type {FormatData} from '../../data/format';
import {uid} from '../../engine/battle';
import {
  applyAction, applyCheck, applyEndTurn, applyEntryAbilities, applyMega, applySwitch, type StateCtx,
} from '../../engine/state';
import {OTHER_ITEM} from '../../engine/prior';
import type {MonSummary} from '../../engine/worker';
import {
  monKey, sameMon, type ActionEvent, type Battle, type BattleEvent, type CheckEvent, type MonRef, type RevealEvent,
  type SideID, type Snapshot,
} from '../../engine/types';

/** Before any beliefs exist (battle start): the entry ability from the usage prior. */
function priorAbility(fmt: FormatData, preview: string) {
  // The base forme's entry carries the entry-ability split for Mega-capable species too.
  const top = (fmt.species[preview] ?? fmt.species[fmt.preview[preview]?.[0] ?? ''])?.abilities[0];
  return top ? {name: top[0], p: top[1]} : undefined;
}

export function stateCtx(fmt: FormatData, gen: Gen, battle: Battle, mons: (MonSummary | null)[] | undefined): StateCtx {
  return {
    fmt, gen, battle,
    oppAbility: (slot, mega) => {
      const m = mons?.[slot];
      if (mega && m) {
        // After Mega Evolving the ability is the Mega's own, known once the forme is.
        const forme = m.formes.find(x => x.p > 0.5 && m.megaAbilityOf[x.name]);
        if (forme) return {name: m.megaAbilityOf[forme.name], p: forme.p};
      }
      if (!m) return priorAbility(fmt, battle.oppPreview[slot]);
      const a = m.abilities.find(x => x.p > 0);
      return a ? {name: a.name, p: a.p} : undefined;
    },
    oppItem: slot => {
      const i = mons?.[slot]?.items[0];
      return i?.certain && i.name !== OTHER_ITEM ? i.name : undefined;
    },
  };
}

function push(b: Battle, ev: BattleEvent, live: Snapshot, turn = b.turn): Battle {
  return {...b, events: [...b.events, {...ev, undo: {live: b.live, turn: b.turn}}], live, turn};
}

export function endTurn(ctx: StateCtx, b: Battle): Battle {
  const ev: BattleEvent = {kind: 'endTurn', id: uid(), turn: b.turn};
  return push(b, ev, applyEndTurn(ctx, b.live), b.turn + 1);
}

export function actedThisTurn(b: Battle, ref: MonRef) {
  return b.events.some(e => e.kind === 'action' && e.turn === b.turn && sameMon(e.actor, ref));
}

/** A turn's actions, in the order they happened (= the order they were logged). */
export function turnActions(b: Battle, turn = b.turn): ActionEvent[] {
  return b.events.filter((e): e is ActionEvent => e.kind === 'action' && e.turn === turn);
}

/** Where this Pokémon's move fell in the turn (1 = first), if it has moved. */
export function orderInTurn(b: Battle, ref: MonRef): {n: number; ev: ActionEvent} | null {
  const acts = turnActions(b);
  const i = acts.findIndex(e => sameMon(e.actor, ref));
  return i < 0 ? null : {n: i + 1, ev: acts[i]};
}

export const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

/**
 * Came in this turn, so it can't also move in it: switching in by choice uses the turn, and
 * one arriving mid-turn (U-turn, Eject Button, a faint) waits for the next. Only a replacement
 * for a fainted Pokémon sent in before anyone moved (the end of last turn) gets to act.
 */
export function cameInThisTurn(b: Battle, ref: MonRef): boolean {
  let moved = false;
  for (const e of b.events) {
    if (e.turn !== b.turn) continue;
    if (e.kind === 'action') moved = true;
    else if (e.kind === 'switch' && e.side === ref.side && e.slotIn === ref.slot) {
      const out = e.slotOut;
      const replacedFainted = out === null || (e.undo?.live.mons[`${e.side}${out}`]?.hp ?? 1) <= 0;
      if (moved || !replacedFainted) return true;
    }
  }
  return false;
}

/** Hit by Fake Out before it moved: it flinched (unless it moves anyway). */
function flinched(acts: ActionEvent[], ref: MonRef) {
  for (const a of acts) {
    if (sameMon(a.actor, ref)) return false;
    if (toID(a.move) === 'fakeout' && !a.failed && a.hits.some(h => sameMon(h.target, ref) && !h.noEffect && !h.fainted && !h.unread)) return true;
  }
  return false;
}

/** Pokémon on the field that haven't moved this turn and still can (not just switched in, not flinched). */
export function stillToMove(b: Battle): MonRef[] {
  const acts = turnActions(b);
  const out: MonRef[] = [];
  for (const side of ['me', 'opp'] as const) {
    for (const slot of b.live.active[side]) {
      if (slot === null) continue;
      const ref = {side, slot};
      if ((b.live.mons[monKey(ref)]?.hp ?? 1) <= 0) continue;
      if (acts.some(a => sameMon(a.actor, ref)) || cameInThisTurn(b, ref) || flinched(acts, ref)) continue;
      out.push(ref);
    }
  }
  return out;
}

/** Everyone on the field has moved, or can't this turn: time to end it. */
export function everyoneMoved(b: Battle): boolean {
  return turnActions(b).length > 0 && stillToMove(b).length === 0;
}

/**
 * The move a Choice item locks it into: the last one it used since coming in, while it still
 * holds the item. `item` is its item when known for certain.
 */
export function choiceLockedMove(b: Battle, ref: MonRef, item: string | undefined): string | null {
  if (!item || !/^Choice (Band|Specs|Scarf)$/.test(item) || b.live.mons[monKey(ref)]?.itemGone) return null;
  let last: string | null = null;
  for (const e of b.events) {
    if (e.kind === 'switch' && e.side === ref.side && (e.slotIn === ref.slot || e.slotOut === ref.slot)) last = null;
    if (e.kind === 'action' && sameMon(e.actor, ref) && toID(e.move) !== 'struggle') last = e.move;
  }
  return last;
}

/** Helping Hand from the actor's partner earlier this turn. */
export function helpedThisTurn(b: Battle, ref: MonRef) {
  return b.events.some(e => e.kind === 'action' && e.turn === b.turn && e.actor.side === ref.side
    && e.actor.slot !== ref.slot && e.move === 'Helping Hand' && !e.failed);
}

export type ActionDraft = Omit<ActionEvent, 'kind' | 'id' | 'turn' | 'before'>;

export function logAction(ctx: StateCtx, b: Battle, draft: ActionDraft): Battle {
  // Someone moving twice, or moving after coming in this turn, means a new turn started: end the old one.
  let cur = actedThisTurn(b, draft.actor) || cameInThisTurn(b, draft.actor) ? endTurn(ctx, b) : b;
  ctx = {...ctx, battle: cur};
  const ev: ActionEvent = {...draft, kind: 'action', id: uid(), turn: cur.turn, before: structuredClone(cur.live)};
  cur = push(cur, ev, applyAction(ctx, cur.live, ev));
  return cur;
}

export function logSwitch(ctx: StateCtx, b: Battle, side: SideID, position: number, slotIn: number | null, entryAbility = true): Battle {
  const ev: BattleEvent = {kind: 'switch', id: uid(), turn: b.turn, side, position, slotIn, slotOut: b.live.active[side][position]};
  return push(b, ev, applySwitch(ctx, b.live, side, position, slotIn, entryAbility));
}

/** Send out both sides' leads, then trigger their entry abilities together. */
export function logLeads(ctx: StateCtx, b: Battle, leads: MonRef[]): Battle {
  let cur = b;
  const positions = {me: 0, opp: 0};
  for (const ref of leads) cur = logSwitch({...ctx, battle: cur}, cur, ref.side, positions[ref.side]++, ref.slot, false);
  return {...cur, live: applyEntryAbilities({...ctx, battle: cur}, cur.live, leads)};
}

function revealState(live: Snapshot, ev: RevealEvent): Snapshot {
  const next = structuredClone(live);
  const c = next.mons[monKey(ev.mon)];
  if (c && !ev.negate && ev.what === 'tera') c.tera = ev.value;
  return next;
}

export function logReveal(b: Battle, ref: MonRef, what: RevealEvent['what'], value: string, negate = false): Battle {
  const ev: RevealEvent = {kind: 'reveal', id: uid(), turn: b.turn, mon: ref, what, value, negate};
  return push(b, ev, revealState(b.live, ev));
}

/** The new forme's ability (Drought, Sand Stream…) applies as it evolves. */
function megaState(ctx: StateCtx, live: Snapshot, ref: MonRef, forme: string): Snapshot {
  const ability = Object.values(ctx.gen.species.get(toID(forme))?.abilities ?? {})[0] as string | undefined;
  const ctx2: StateCtx = {
    ...ctx,
    oppAbility: (slot, mega) => (slot === ref.slot && mega && ability ? {name: ability, p: 1} : ctx.oppAbility(slot, mega)),
  };
  return applyMega(ctx2, live, ref);
}

/** Mega Evolution. `forme` is which Mega it became (for mine it follows from the stone). */
export function logMega(ctx: StateCtx, b: Battle, ref: MonRef, forme: string): Battle {
  const ev: RevealEvent = {kind: 'reveal', id: uid(), turn: b.turn, mon: ref, what: 'forme', value: forme, negate: false};
  return push(b, ev, megaState(ctx, b.live, ref, forme));
}

/** Answer a "what did the game show?" prompt (entry ability, Intimidate reaction). */
export function logCheck(ctx: StateCtx, b: Battle, check: Omit<CheckEvent, 'kind' | 'id' | 'turn'>): Battle {
  const ev: CheckEvent = {...check, kind: 'check', id: uid(), turn: b.turn};
  return push(b, ev, applyCheck(ctx, b.live, ev));
}

// --- fixing the order of a turn --------------------------------------------------

/** "Order unsure": keep the action, but don't learn Speed from where it sits in the turn. */
export function setOrdered(b: Battle, id: string, ordered: boolean): Battle {
  return {...b, events: b.events.map(e => (e.id === id && e.kind === 'action' ? {...e, ordered} : e))};
}

/** An action plus its own Mega Evolution logged right before it (they move together). */
interface Block {
  start: number;
  end: number;
}

function blockOf(events: BattleEvent[], i: number): Block | null {
  const ev = events[i];
  if (ev?.kind !== 'action') return null;
  let start = i;
  while (start > 0) {
    const p = events[start - 1];
    if (p.kind === 'reveal' && p.what === 'forme' && p.turn === ev.turn && sameMon(p.mon, ev.actor)) start--;
    else break;
  }
  return {start, end: i};
}

/** Whose HP an action sets: the Pokémon it hit, plus the user when it took recoil. */
function hpTouched(b: Battle, ev: ActionEvent): Set<string> {
  const out = new Set(ev.hits.filter(h => !h.noEffect).map(h => monKey(h.target)));
  const dealt = ev.hits.some(h => !h.noEffect);
  const lifeOrb = ev.actor.side === 'me' ? dealt && b.myTeam[ev.actor.slot]?.item === 'Life Orb' : ev.actorTriggers.includes('lifeorb');
  if (lifeOrb || ev.actorTriggers.includes('helmet')) out.add(monKey(ev.actor));
  return out;
}

export type MoveCheck = {ok: true; first: Block; second: Block; between: number[]} | {ok: false; why: string};

/**
 * Can this action trade places with the neighbouring action of its turn? Answered prompts and
 * reveals in between are fine (they happened before the moves anyway); a switch is not. Two
 * moves that both changed one Pokémon's HP can't be swapped: the HP typed in only fits the
 * order they were logged in.
 */
export function canMoveAction(b: Battle, id: string, dir: -1 | 1): MoveCheck {
  const events = b.events;
  const self = blockOf(events, events.findIndex(e => e.id === id));
  if (!self) return {ok: false, why: ''};
  const turn = events[self.end].turn;
  const rest = dir < 0 ? events.slice(0, self.start) : events.slice(self.end + 1);
  if (!rest.some(e => e.kind === 'action' && e.turn === turn)) {
    return {ok: false, why: dir < 0 ? 'already first this turn' : 'already last this turn'};
  }
  const between: number[] = [];
  let other: Block | null = null;
  let j = dir < 0 ? self.start - 1 : self.end + 1;
  while (j >= 0 && j < events.length && events[j].turn === turn) {
    const e = events[j];
    const block = e.kind === 'action' ? blockOf(events, j) : null;
    // Walking forward, a Mega logged right before the next action belongs to that action.
    const ahead = dir > 0 && e.kind === 'reveal' && e.what === 'forme'
      ? blockOf(events, events.findIndex((x, k) => k > j && x.kind === 'action'))
      : null;
    if (block || (ahead && ahead.start === j && events[ahead.end].turn === turn)) {
      other = block ?? ahead;
      break;
    }
    if (e.kind !== 'check' && !(e.kind === 'reveal' && e.what !== 'forme')) {
      return {ok: false, why: e.kind === 'switch' ? 'a switch is logged in between' : 'something else is logged in between'};
    }
    between.push(j);
    j += dir;
  }
  if (!other) return {ok: false, why: dir < 0 ? 'already first this turn' : 'already last this turn'};
  const [first, second] = dir < 0 ? [other, self] : [self, other];
  const a = events[first.end] as ActionEvent;
  const c = events[second.end] as ActionEvent;
  const touched = hpTouched(b, c);
  if ([...hpTouched(b, a)].some(k => touched.has(k))) {
    return {ok: false, why: 'both changed the same Pokémon’s HP, so undo and log them again in order'};
  }
  return {ok: true, first, second, between: between.sort((x, y) => x - y)};
}

/** Re-run one logged event on a state. */
function reapply(ctx: StateCtx, live: Snapshot, ev: BattleEvent): Snapshot {
  switch (ev.kind) {
    case 'action':
      return applyAction(ctx, live, ev);
    case 'check':
      return applyCheck(ctx, live, ev);
    case 'reveal':
      return ev.what === 'forme' && !ev.negate ? megaState(ctx, live, ev.mon, ev.value) : revealState(live, ev);
    default:
      return live;
  }
}

/**
 * Swap an action with the neighbouring one in its turn (it actually went earlier/later).
 * The swapped stretch is re-run from the state before it, so the snapshots the inference
 * reads (and undo) stay exact; the two moves touch different Pokémon, so what comes after
 * is unchanged.
 */
export function moveAction(ctx: StateCtx, b: Battle, id: string, dir: -1 | 1): Battle {
  const chk = canMoveAction(b, id, dir);
  if (!chk.ok) return b;
  const {first, second, between} = chk;
  const events = b.events.slice();
  const range = (x: Block) => events.slice(x.start, x.end + 1);
  // Prompts and reveals in between go first: they belong to the start of the turn.
  const window = [...between.map(i => events[i]), ...range(second), ...range(first)];
  const start = first.start;
  const before = events[start].undo;
  if (!before) return b;
  let live = before.live;
  const c = {...ctx, battle: b};
  const redone = window.map(ev => {
    const out: BattleEvent = {...ev, undo: {live, turn: before.turn}};
    if (out.kind === 'action') out.before = structuredClone(live);
    live = reapply(c, live, out);
    return out;
  });
  events.splice(start, redone.length, ...redone);
  const atEnd = second.end === b.events.length - 1;
  return {...b, events, live: atEnd ? live : b.live};
}

export function undo(b: Battle): Battle {
  const last = b.events[b.events.length - 1];
  if (!last) return b;
  const events = b.events.slice(0, -1);
  if (!last.undo) return {...b, events};
  return {...b, events, live: last.undo.live, turn: last.undo.turn};
}

/** Direct edits (HP, stat stages…) that aren't observations. */
export function editLive(b: Battle, fn: (live: Snapshot) => void): Battle {
  const live = structuredClone(b.live);
  fn(live);
  return {...b, live};
}
