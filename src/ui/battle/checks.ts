/**
 * "What did the game show?" prompts, derived from the log so they survive reloads:
 * an opponent that just came in and might announce an ability (Intimidate, Drought,
 * Pressure, Air Balloon…), or opponents hit by my Intimidate that might react
 * (Defiant, Competitive, Clear Amulet…). Nothing is assumed from usage odds: only an
 * ability already known for certain is applied without asking. Long shots (<2%) aren't
 * worth a tap.
 */
import {ENTRY_ANNOUNCE, ENTRY_ITEMS, INTIMIDATE_REACT, INTIMIDATE_REACT_ITEMS} from '../../engine/abilities';
import type {StateCtx} from '../../engine/state';
import type {MonSummary} from '../../engine/worker';
import type {Battle, MonRef} from '../../engine/types';

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

export function pendingChecks(battle: Battle, mons: (MonSummary | null)[] | undefined, ctx: StateCtx): PendingCheck[] {
  if (!mons) return [];
  const events = battle.events;
  const answered = new Set(events.filter(e => e.kind === 'check').map(e => `${e.about}|${e.mon.slot}|${e.context}`));
  const out: PendingCheck[] = [];
  events.forEach((ev, idx) => {
    if (ev.kind !== 'switch' || ev.slotIn === null || ev.turn < battle.turn - 1) return;
    // Only while that Pokémon is still the one that came in.
    const later = events.slice(idx + 1).some(e => e.kind === 'switch' && e.side === ev.side && (e.slotIn === ev.slotIn || e.slotOut === ev.slotIn));
    if (later || !battle.live.active[ev.side].includes(ev.slotIn)) return;

    if (ev.side === 'opp') {
      const m = mons[ev.slotIn];
      const c = battle.live.mons[`opp${ev.slotIn}`];
      if (!m || !c || c.mega || answered.has(`${ev.id}|${ev.slotIn}|entry`)) return;
      const top = ctx.oppAbility(ev.slotIn, false);
      if (top && top.p >= 1) return; // known for certain: its effect was applied on entry
      const opts = options(m, ENTRY_ANNOUNCE, ENTRY_ITEMS, c.itemGone);
      if (opts.reduce((s, o) => s + o.p, 0) >= MIN_WORTH_ASKING) {
        out.push({about: ev.id, mon: {side: 'opp', slot: ev.slotIn}, context: 'entry', options: opts});
      }
      return;
    }
    // My Pokémon came in: if it has Intimidate, ask how each opponent took it.
    if (battle.myTeam[ev.slotIn]?.ability === 'Intimidate') {
      for (const slot of battle.live.active.opp) {
        if (slot === null) continue;
        const m = mons[slot];
        const c = battle.live.mons[`opp${slot}`];
        if (!m || !c || c.hp <= 0 || answered.has(`${ev.id}|${slot}|intimidate`)) continue;
        const top = ctx.oppAbility(slot, c.mega);
        if (top && top.p >= 1) continue; // known for certain: its reaction was applied
        const opts = options(m, INTIMIDATE_REACT, INTIMIDATE_REACT_ITEMS, c.itemGone);
        if (opts.reduce((s, o) => s + o.p, 0) >= MIN_WORTH_ASKING) {
          out.push({about: ev.id, mon: {side: 'opp', slot}, context: 'intimidate', options: opts});
        }
      }
    }
  });
  return out;
}
