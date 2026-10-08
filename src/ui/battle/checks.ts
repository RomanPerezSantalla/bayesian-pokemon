/**
 * "What did the game show?" prompts, derived from the log so they survive reloads:
 * an opponent that just came in and might announce an ability (Intimidate, Drought,
 * Pressure, Air Balloon…), or opponents hit by my Intimidate that might react
 * (Defiant, Competitive, Clear Amulet…). Nothing is assumed from usage odds: only an
 * ability already known for certain is applied without asking. Long shots (<2%) aren't
 * worth a tap. A battle the screen reader logs answers them itself (narration/narrator.ts):
 * it reads every line, so a moment that showed nothing showed nothing.
 */
import {ENTRY_ANNOUNCE, INTIMIDATE_REACT, INTIMIDATE_REACT_ITEMS, entryItems} from '../../engine/abilities';
import type {StateCtx} from '../../engine/state';
import type {MonSummary} from '../../engine/worker';
import {monKey, type Battle, type MonRef, type Snapshot} from '../../engine/types';

export interface CheckOption {
  name: string;
  p: number;
  kind: 'ability' | 'item';
}

export interface PendingCheck {
  about: string;
  mon: MonRef;
  context: 'entry' | 'intimidate';
  options: CheckOption[];
}

const MIN_WORTH_ASKING = 0.02;

function options(m: MonSummary, abilities: Set<string>, items: Set<string>, itemGone: boolean): CheckOption[] {
  const out: CheckOption[] = [
    ...m.abilities.filter(a => a.p > 0 && abilities.has(a.name)).map(a => ({name: a.name, p: a.p, kind: 'ability' as const})),
    ...(itemGone ? [] : m.items.filter(i => i.p > 0 && items.has(i.name)).map(i => ({name: i.name, p: i.p, kind: 'item' as const}))),
  ];
  return out.sort((a, b) => b.p - a.p);
}

/** A moment that could have shown something, not answered yet. */
export interface OpenMoment {
  /** The switch-in it came with. */
  about: string;
  mon: MonRef;
  context: 'entry' | 'intimidate';
  /** The board just before that switch-in. */
  before?: Snapshot;
}

/**
 * The moments not answered yet: an opponent that came in (this turn or last) and is still out, unless it has Mega
 * Evolved since; and each opponent my Intimidate met on its way in.
 */
export function openMoments(battle: Battle): OpenMoment[] {
  const events = battle.events;
  const answered = new Set(events.filter(e => e.kind === 'check').map(e => `${e.about}|${e.mon.slot}|${e.context}`));
  const out: OpenMoment[] = [];
  events.forEach((ev, idx) => {
    if (ev.kind !== 'switch' || ev.slotIn === null || ev.turn < battle.turn - 1) return;
    // Only while that Pokémon is still the one that came in.
    const later = events.slice(idx + 1).some(e => e.kind === 'switch' && e.side === ev.side && (e.slotIn === ev.slotIn || e.slotOut === ev.slotIn));
    if (later || !battle.live.active[ev.side].includes(ev.slotIn)) return;
    if (ev.side === 'opp') {
      const c = battle.live.mons[`opp${ev.slotIn}`];
      if (c && !c.mega && !answered.has(`${ev.id}|${ev.slotIn}|entry`)) {
        out.push({about: ev.id, mon: {side: 'opp', slot: ev.slotIn}, context: 'entry', before: ev.undo?.live});
      }
      return;
    }
    // My Pokémon came in: if it has Intimidate, how each opponent took it.
    if (battle.myTeam[ev.slotIn]?.ability !== 'Intimidate') return;
    for (const slot of battle.live.active.opp) {
      if (slot === null) continue;
      const c = battle.live.mons[`opp${slot}`];
      if (c && c.hp > 0 && !answered.has(`${ev.id}|${slot}|intimidate`)) {
        out.push({about: ev.id, mon: {side: 'opp', slot}, context: 'intimidate', before: ev.undo?.live});
      }
    }
  });
  return out;
}

export function pendingChecks(battle: Battle, mons: (MonSummary | null)[] | undefined, ctx: StateCtx): PendingCheck[] {
  if (!mons) return [];
  const out: PendingCheck[] = [];
  for (const o of openMoments(battle)) {
    const m = mons[o.mon.slot];
    const c = battle.live.mons[monKey(o.mon)];
    if (!m || !c) continue;
    const entry = o.context === 'entry';
    // Known for certain: its effect was applied on entry (or its reaction to the Intimidate).
    const top = ctx.oppAbility(o.mon.slot, entry ? false : c.mega);
    if (top && top.p >= 1) continue;
    const opts = entry
      ? options(m, ENTRY_ANNOUNCE, entryItems(battle.live.field.terrain), c.itemGone)
      : options(m, INTIMIDATE_REACT, INTIMIDATE_REACT_ITEMS, c.itemGone);
    if (opts.reduce((s, x) => s + x.p, 0) >= MIN_WORTH_ASKING) out.push({about: o.about, mon: o.mon, context: o.context, options: opts});
  }
  return out;
}
