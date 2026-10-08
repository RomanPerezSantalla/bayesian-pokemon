/**
 * Base power a move takes from the battle so far, where @smogon/calc 0.12 keeps the move's own (it counts fainted
 * allies only for Supreme Overlord: on 6 Oct a Basculegion's Last Respects, at 100 with its Grimmsnarl down, was taken
 * at 50, and only a Life Orb could have made its KO).
 */
import {isDamagingMove, toID, type Gen} from '../data/dex';
import {sameMon, type ActionEvent, type Battle, type MonRef, type Snapshot} from './types';

/** The moves this knows; the rest are as the calc has them. */
const FROM_HISTORY = new Set(['lastrespects', 'ragefist', 'stompingtantrum', 'temperflare', 'avalanche', 'revenge', 'round']);

/**
 * It came to nothing: "But it failed!", or none it went for could be affected. Blocked by a Protect isn't that (6 Oct:
 * a Garchomp's Stomping Tantrum the turn after Baneful Bunker stopped one did 78 to Toxapex, 75 power's 73–96, not
 * 150's 143–187), and a miss isn't told apart from a block in the log: neither counts.
 */
function cameToNothing(gen: Gen, e: ActionEvent): boolean {
  if (e.failed) return true;
  return isDamagingMove(gen, e.move) && !e.charged && e.hits.length > 0 && e.hits.every(h => h.noEffect);
}

/**
 * Last Respects: 50 more for each of its side fainted. Rage Fist: 50 more for each hit it has taken (to 350). Stomping
 * Tantrum, Temper Flare: doubled after a move of its that came to nothing the turn before. Avalanche, Revenge: doubled
 * once its target has hurt it this turn. Round: doubled after its partner's this turn. Undefined: as the calc has it.
 *
 * `ev`: the move logged (what came before it counts, in its state); none: a move now, after everything logged (the
 * ones that hang on this turn's order aren't known then).
 */
export function powerFromHistory(gen: Gen, battle: Battle, actor: MonRef, move: string, ev?: ActionEvent, target?: MonRef): number | undefined {
  const id = toID(move);
  if (!FROM_HISTORY.has(id)) return undefined;
  const base = gen.moves.get(id)?.basePower;
  if (!base) return undefined;
  const at = ev ? battle.events.findIndex(e => e.id === ev.id) : -1;
  const before = at >= 0 ? battle.events.slice(0, at) : battle.events;
  const turn = ev?.turn ?? battle.turn;
  const snap: Snapshot = ev?.before ?? battle.live;
  switch (id) {
    case 'lastrespects': {
      const fainted = Object.entries(snap.mons).filter(([k, c]) => k.startsWith(actor.side) && c.hp <= 0).length;
      return fainted ? base + 50 * fainted : undefined;
    }
    case 'ragefist': {
      let hits = 0;
      for (const e of before) {
        if (e.kind !== 'action' || !isDamagingMove(gen, e.move)) continue;
        hits += e.hits.filter(h => sameMon(h.target, actor) && !h.noEffect).length * Math.max(1, e.hitCount ?? 1);
      }
      return hits ? Math.min(350, base + 50 * hits) : undefined;
    }
    case 'stompingtantrum':
    case 'temperflare': {
      // Its move the turn before, if it has stayed in since.
      let last: ActionEvent | undefined;
      for (const e of before) {
        if (e.kind === 'switch' && e.side === actor.side && (e.slotIn === actor.slot || e.slotOut === actor.slot)) last = undefined;
        if (e.kind === 'action' && sameMon(e.actor, actor)) last = e;
      }
      return last && last.turn === turn - 1 && cameToNothing(gen, last) ? base * 2 : undefined;
    }
    case 'avalanche':
    case 'revenge': {
      const by = target ?? ev?.hits[0]?.target;
      if (!ev || !by) return undefined;
      const hurt = before.some(e => e.kind === 'action' && e.turn === turn && sameMon(e.actor, by)
        && e.hits.some(h => sameMon(h.target, actor) && !h.noEffect && (h.fainted || h.unread || h.hpAfter < h.hpBefore)));
      return hurt ? base * 2 : undefined;
    }
    case 'round': {
      if (!ev) return undefined;
      const partner = before.some(e => e.kind === 'action' && e.turn === turn && e.actor.side === actor.side && e.actor.slot !== actor.slot
        && toID(e.move) === 'round' && !e.failed);
      return partner ? base * 2 : undefined;
    }
  }
  return undefined;
}
