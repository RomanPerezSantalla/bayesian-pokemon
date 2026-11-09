/**
 * Base power a move takes from the battle so far, where @smogon/calc 0.12 keeps the move's own (it counts fainted
 * allies only for Supreme Overlord: on 6 Oct a Basculegion's Last Respects, at 100 with its Grimmsnarl down, was taken
 * at 50, and only a Life Orb could have made its KO).
 */
import {isDamagingMove, toID, type BoostID, type Gen} from '../data/dex';
import {sameMon, type ActionEvent, type Battle, type BattleEvent, type MonRef, type Snapshot} from './types';

/** The moves this knows; the rest are as the calc has them. */
const FROM_HISTORY = new Set([
  'lastrespects', 'ragefist', 'stompingtantrum', 'temperflare', 'avalanche', 'revenge', 'round', 'assurance', 'lashout',
  'ficklebeam', 'payback',
]);

/**
 * The hits each target took: Dragon Darts that struck two takes one dart each (two at one, its partner out of reach).
 * Undefined: the move's own number (the calc's), none said.
 */
export function hitsOn(ev: ActionEvent): number | undefined {
  if (toID(ev.move) === 'dragondarts') {
    const struck = new Set(ev.hits.filter(h => !h.noEffect).map(h => `${h.target.side}${h.target.slot}`));
    if (struck.size > 1) return 1;
  }
  return ev.hitCount;
}

/** Hurt by it: HP down, fainted, or a hit the HP wasn't read for. */
const hurt = (h: ActionEvent['hits'][number]) => !h.noEffect && (h.fainted || !!h.unread || h.hpAfter < h.hpBefore);

/**
 * The state as the turn began, for what has happened this turn: before its first move, or a switch made by choice before
 * that (one coming in for a fainted one came in before the turn: what it did, Intimidate, isn't this turn's).
 */
function turnStart(before: BattleEvent[], turn: number): Snapshot | undefined {
  for (const e of before) {
    if (e.turn !== turn) continue;
    if (e.kind === 'action') return e.before;
    if (e.kind === 'switch' && e.slotOut !== null && (e.undo?.live.mons[`${e.side}${e.slotOut}`]?.hp ?? 0) > 0) return e.undo?.live;
  }
  return undefined;
}

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
 * once its target has hurt it this turn. Round: doubled after its partner's this turn. Assurance: doubled once its
 * target was hurt this turn. Lash Out: doubled once a stat of its fell this turn (the calc means to, but its count
 * of the drops is only ever of rises). Fickle Beam: doubled when it went all out. Payback: doubled once its target has
 * moved this turn (the calc goes by Speed, which Trick Room and priority turn round). Undefined: as the calc has it.
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
        hits += e.hits.filter(h => sameMon(h.target, actor) && !h.noEffect).length * Math.max(1, hitsOn(e) ?? 1);
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
    case 'assurance': {
      // Hurt this turn by anything: a move of either side, or its own move's recoil, Life Orb or a Rocky Helmet.
      const on = target ?? ev?.hits[0]?.target;
      if (!ev || !on) return undefined;
      const was = before.some(e => e.kind === 'action' && e.turn === turn && (e.hits.some(h => sameMon(h.target, on) && hurt(h))
        || (sameMon(e.actor, on) && (e.actorTriggers.includes('lifeorb') || e.actorTriggers.includes('helmet')
          || (e.actorHpAfter !== undefined && e.actorHpAfter < (e.before.mons[`${on.side}${on.slot}`]?.hp ?? 0))))));
      return was ? base * 2 : undefined;
    }
    case 'lashout': {
      if (!ev) return undefined;
      const start = turnStart(before, turn)?.mons[`${actor.side}${actor.slot}`]?.boosts;
      const now = snap.mons[`${actor.side}${actor.slot}`]?.boosts;
      if (!start || !now) return undefined;
      const fell = (Object.keys(now) as BoostID[]).some(k => (now[k] ?? 0) < (start[k] ?? 0));
      return fell ? base * 2 : undefined;
    }
    case 'ficklebeam':
      return ev?.allOut ? base * 2 : undefined;
    case 'payback': {
      // Logged, its power is told either way: the calc's own guess from the Speeds would double it again.
      const on = target ?? ev?.hits[0]?.target;
      if (!ev || !on) return undefined;
      const moved = before.some(e => e.kind === 'action' && e.turn === turn && sameMon(e.actor, on));
      return moved ? base * 2 : base;
    }
  }
  return undefined;
}
