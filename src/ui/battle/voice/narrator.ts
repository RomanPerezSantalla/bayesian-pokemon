/**
 * Turns narrated events into log entries. A move is held open while its details come in (HP,
 * crits, misses, faints, messages) and logged when the next one starts, on "end turn", or when
 * the screen commits it after a pause. Unknown stays unknown: a target whose HP wasn't said is
 * logged as "HP skipped", and messages not mentioned are no evidence (\`narrated\`).
 */
import {isStatusMove, move as dexMove, type Gen} from '../../../data/dex';
import {DROP_REACT} from '../../../engine/abilities';
import {megaFormeOf} from '../../../engine/likelihood';
import {moveFx} from '../../../engine/moves';
import {maxHPOf, type StateCtx} from '../../../engine/state';
import type {MonSummary} from '../../../engine/worker';
import {
  monKey, sameMon, type Battle, type HitResult, type MonRef, type SideID, type Status, type Trigger,
} from '../../../engine/types';
import {
  editLive, endTurn, helpedThisTurn, logAction, logCheck, logMega, logReveal, logSwitch, turnActions, type ActionDraft,
} from '../actions';
import {pendingChecks} from '../checks';
import {monLabel} from '../names';
import type {VoiceEvent} from './parse';

export interface VoiceIO {
  gen: Gen;
  /** The battle as it is now (after everything applied so far). */
  battle(): Battle;
  mons(): (MonSummary | null)[] | undefined;
  ctx(b: Battle): StateCtx;
  apply(fn: (b: Battle, c: StateCtx) => Battle): void;
  /** A switch-in whose position isn't clear: let the user tap it. */
  askSwitch(side: SideID, slot: number): void;
}

interface Row {
  ref: MonRef;
  value?: number;
  fainted?: boolean;
  noEffect?: boolean;
  missed?: boolean;
  crit?: boolean;
  triggers: Trigger[];
  status?: Status;
  reaction?: string;
  /** Mentioned: for a single-target move, the one it hit. */
  said: boolean;
}

interface Draft {
  actor: MonRef;
  move: string;
  spread: boolean;
  status: boolean;
  rows: Row[];
  actorTriggers: Trigger[];
  actorStatus?: Status;
  quick?: 'Quick Claw' | 'Quick Draw';
  lastRow?: MonRef;
  /** "A critical hit!" before we know on whom. */
  crit?: boolean;
}

const SELF_TARGETS = new Set(['self', 'allySide', 'all', 'allies', 'adjacentAllyOrSelf', 'foeSide', 'randomNormal']);
const RESIST_BERRY = /^(Occa|Passho|Wacan|Rindo|Yache|Chople|Kebia|Shuca|Coba|Payapa|Tanga|Charti|Kasib|Haban|Colbur|Babiri|Roseli|Chilan) Berry$/;
const ROW_ITEMS: Record<string, Trigger> = {'Sitrus Berry': 'sitrus', 'Focus Sash': 'sash', 'Weakness Policy': 'wp'};

export class Narrator {
  private draft: Draft | null = null;
  private vacated: Partial<Record<SideID, number>> = {};
  private quick = new Map<string, 'Quick Claw' | 'Quick Draw'>();

  constructor(private io: VoiceIO) {}

  private label(r: MonRef) {
    return monLabel(this.io.battle(), this.io.mons(), r);
  }

  get open() {
    return !!this.draft;
  }

  /** The move being narrated, for the screen. */
  describe(): string {
    const d = this.draft;
    if (!d) return '';
    const shown = d.rows.filter(r => r.said || d.spread);
    const bits = shown.map(r => {
      const what = r.missed ? 'missed' : r.fainted ? 'KO' : r.noEffect ? 'immune'
        : r.value !== undefined ? `${r.value}${r.ref.side === 'opp' ? '%' : ''}` : 'HP ?';
      return `${this.label(r.ref)} ${what}${r.crit ? ' crit' : ''}`;
    });
    return `${this.label(d.actor)} · ${d.move}${bits.length ? ` → ${bits.join(', ')}` : ''}`;
  }

  /** Apply what was heard; returns short notes of what was done. */
  feed(events: VoiceEvent[]): string[] {
    const notes: string[] = [];
    for (const ev of events) {
      for (const n of this.one(ev)) if (n) notes.push(n);
    }
    return notes;
  }

  /** Log the move being narrated. */
  commit(): string | null {
    const d = this.draft;
    this.draft = null;
    if (!d) return null;
    const b = this.io.battle();
    const action = this.toAction(b, d);
    this.io.apply((bb, c) => logAction(c, bb, action));
    const hits = action.hits.map(h => `${this.label(h.target)} ${h.fainted ? 'KO' : h.noEffect ? 'immune' : h.unread ? 'HP skipped'
      : `${h.hpAfter}${h.target.side === 'opp' ? '%' : ''}`}${h.crit ? ' crit' : ''}`);
    return `✓ ${this.label(d.actor)} · ${d.move}${hits.length ? ` → ${hits.join(', ')}` : ''}`;
  }

  discard() {
    this.draft = null;
  }

  private one(ev: VoiceEvent): (string | null)[] {
    const b = this.io.battle();
    const d = this.draft;
    switch (ev.kind) {
      case 'use': {
        const done = this.commit();
        if (!this.io.battle().live.active[ev.actor.side].includes(ev.actor.slot)) {
          return [done, `${this.label(ev.actor)} isn't on the field`];
        }
        this.draft = this.start(this.io.battle(), ev.actor, ev.move);
        // Protect, Tailwind, Trick Room…: nothing more to hear.
        if (this.draft.status && !this.draft.rows.length) return [done, this.commit()];
        return [done];
      }
      case 'hp': {
        if (!d) return [`HP ${ev.value} not placed (no move open)`];
        const ref = ev.mon ?? this.soleTarget(d);
        if (!ref) return [`HP ${ev.value}: whose? Say the name with it`];
        if (sameMon(ref, d.actor)) return [];
        const max = ref.side === 'opp' ? 100 : maxHPOf(this.io.ctx(b), b.live, ref);
        if (ev.value > max) return [`${this.label(ref)} ${ev.value}? Max is ${max}`];
        const row = this.row(d, ref);
        if (!row) return [`${this.label(ref)} wasn't a target`];
        Object.assign(row, {value: ev.value, fainted: false, said: true});
        this.touch(d, row);
        return [];
      }
      case 'faint': {
        const ref = ev.mon ?? d?.lastRow ?? (d ? this.soleTarget(d) : undefined);
        if (!ref) return [];
        if (d && !sameMon(ref, d.actor)) {
          const row = this.row(d, ref);
          if (row) {
            Object.assign(row, {fainted: true, said: true});
            this.touch(d, row);
            return [];
          }
        }
        if (d && sameMon(ref, d.actor)) return [];
        // Fainted outside a narrated hit (poison, recoil…): keep the board right.
        this.io.apply(bb => editLive(bb, live => {
          const c = live.mons[monKey(ref)];
          if (c) c.hp = 0;
        }));
        return [`${this.label(ref)} fainted`];
      }
      case 'crit': {
        if (!d) return [];
        const row = d.lastRow ? this.row(d, d.lastRow) : null;
        if (row && row.said) row.crit = true;
        else d.crit = true;
        return [];
      }
      case 'miss': {
        if (!d) return [];
        if (!ev.mon || sameMon(ev.mon, d.actor)) {
          // "X's attack missed": whoever it was aimed at.
          const target = this.soleTarget(d);
          for (const r of d.rows) if (!target || sameMon(r.ref, target)) Object.assign(r, {missed: true, said: true});
          return [];
        }
        const row = this.row(d, ev.mon);
        if (row) Object.assign(row, {missed: true, said: true});
        return [];
      }
      case 'immune': {
        if (!d) return [];
        const ref = ev.mon ?? this.soleTarget(d);
        const row = ref ? this.row(d, ref) : null;
        if (row) {
          Object.assign(row, {noEffect: true, said: true});
          this.touch(d, row);
        }
        return [];
      }
      case 'recoil': {
        if (d && d.actor.side === 'opp' && (!ev.mon || sameMon(ev.mon, d.actor))) d.actorTriggers.push('lifeorb');
        return [];
      }
      case 'status': {
        if (!d || !ev.mon) return [];
        if (sameMon(ev.mon, d.actor)) {
          d.actorStatus = ev.status;
          return [];
        }
        const row = this.row(d, ev.mon);
        if (row) Object.assign(row, {status: ev.status, said: true});
        return [];
      }
      case 'item':
        return this.item(d, ev.mon, ev.item);
      case 'ability':
        return this.ability(b, d, ev.mon, ev.ability);
      case 'mega': {
        if (!ev.mon) return ['Mega Evolution: whose?'];
        const forme = this.megaForme(ev.mon, ev.suffix);
        if (!forme) return [`${this.label(ev.mon)} can't Mega Evolve`];
        if (b.live.mons[monKey(ev.mon)]?.mega) return [];
        this.io.apply((bb, c) => logMega(c, bb, ev.mon!, forme));
        return [`${this.label(ev.mon)} Mega Evolved`];
      }
      case 'withdraw': {
        const done = this.commit();
        if (ev.mon) {
          const pos = this.io.battle().live.active[ev.mon.side].indexOf(ev.mon.slot);
          if (pos >= 0) this.vacated[ev.mon.side] = pos;
        }
        return [done];
      }
      case 'sendOut': {
        const done = this.commit();
        const now = this.io.battle();
        const {side, slot} = ev.mon;
        const active = now.live.active[side];
        if (active.includes(slot)) return [done];
        const fainted = active.findIndex(s => s === null || (now.live.mons[`${side}${s}`]?.hp ?? 1) <= 0);
        const pos = this.vacated[side] ?? (fainted >= 0 ? fainted : active.length === 1 ? 0 : -1);
        delete this.vacated[side];
        if (pos < 0) {
          this.io.askSwitch(side, slot);
          return [done, `${this.label(ev.mon)} came in: tap which one it replaced`];
        }
        this.io.apply((bb, c) => logSwitch(c, bb, side, pos, slot));
        return [done, `${this.label(ev.mon)} came in`];
      }
      case 'endTurn': {
        const done = this.commit();
        const now = this.io.battle();
        if (!turnActions(now).length) return [done];
        this.io.apply((bb, c) => endTurn(c, bb));
        return [done, `— end of turn ${now.turn} —`];
      }
    }
  }

  private start(b: Battle, actor: MonRef, move: string): Draft {
    const gen = this.io.gen;
    const target = moveFx(move).tg ?? dexMove(gen, move)?.target ?? 'normal';
    const alive = (side: SideID) => b.live.active[side]
      .filter((s): s is number => s !== null && (b.live.mons[`${side}${s}`]?.hp ?? 1) > 0)
      .map(slot => ({side, slot}) as MonRef);
    const foes = alive(actor.side === 'me' ? 'opp' : 'me');
    const allies = alive(actor.side).filter(r => !sameMon(r, actor));
    const status = isStatusMove(gen, move);
    let spread = false;
    let cands: MonRef[];
    if (status && SELF_TARGETS.has(target)) cands = [];
    else if (target === 'allAdjacentFoes') [spread, cands] = [true, foes];
    else if (target === 'allAdjacent') [spread, cands] = [true, [...foes, ...allies]];
    else if (target === 'adjacentAlly') cands = allies;
    else cands = foes;
    const quick = this.quick.get(monKey(actor));
    this.quick.delete(monKey(actor));
    return {actor, move, spread, status, rows: cands.map(ref => ({ref, triggers: [], said: false})), actorTriggers: [], quick};
  }

  /** The row for a Pokémon in this move (an ally hit by a single-target move gets one too). */
  private row(d: Draft, ref: MonRef): Row | null {
    const found = d.rows.find(r => sameMon(r.ref, ref));
    if (found) return found;
    const b = this.io.battle();
    if (d.spread || sameMon(ref, d.actor) || !b.live.active[ref.side].includes(ref.slot)) return null;
    const row: Row = {ref, triggers: [], said: false};
    d.rows.push(row);
    return row;
  }

  /** Remember the latest target spoken about; a crit heard before it lands on it. */
  private touch(d: Draft, row: Row) {
    d.lastRow = row.ref;
    if (d.crit) {
      row.crit = true;
      d.crit = false;
    }
  }

  /** The only Pokémon this move can be about, if there's just one (or one already named). */
  private soleTarget(d: Draft): MonRef | undefined {
    const said = d.rows.filter(r => r.said);
    if (said.length === 1) return said[0].ref;
    return d.rows.length === 1 ? d.rows[0].ref : d.lastRow;
  }

  private item(d: Draft | null, mon: MonRef | undefined, item: string): (string | null)[] {
    if (item === 'Quick Claw' && mon) {
      this.quick.set(monKey(mon), 'Quick Claw');
      return [];
    }
    if (d) {
      if (item === 'Life Orb' && (!mon || sameMon(mon, d.actor))) {
        if (d.actor.side === 'opp') d.actorTriggers.push('lifeorb');
        return [];
      }
      if (item === 'Rocky Helmet' && d.actor.side === 'me') {
        d.actorTriggers.push('helmet');
        return [];
      }
      const trig = ROW_ITEMS[item] ?? (RESIST_BERRY.test(item) ? 'berry' : undefined);
      const ref = mon ?? d.lastRow ?? this.soleTarget(d);
      const row = trig && ref ? this.row(d, ref) : null;
      if (row && trig) {
        row.triggers.push(trig);
        row.said = true;
        return [];
      }
    }
    // Anything else of theirs that the game named (Leftovers, Booster Energy…) is a reveal.
    if (mon?.side === 'opp') {
      this.io.apply(bb => logReveal(bb, mon, 'item', item));
      return [`${this.label(mon)}: ${item}`];
    }
    return [];
  }

  private ability(b: Battle, d: Draft | null, mon: MonRef, ability: string): (string | null)[] {
    if (mon.side === 'me') return [];
    if (ability === 'Quick Draw') this.quick.set(monKey(mon), 'Quick Draw');
    // An open "what did the game show?" question about it (entry abilities, Intimidate reactions).
    const ctx = this.io.ctx(b);
    const check = pendingChecks(b, this.io.mons(), ctx)
      .find(c => sameMon(c.mon, mon) && c.options.some(o => o.name === ability));
    if (check) {
      const c0 = b.live.mons[monKey(mon)];
      this.io.apply((bb, c) => logCheck(c, bb, {
        mon, context: check.context, about: check.about, seen: ability, seenKind: 'ability',
        mega: !!c0?.mega, itemGone: !!c0?.itemGone,
      }));
      return [`${this.label(mon)}: ${ability}`];
    }
    // Defiant, Competitive… reacting to this move's stat drop.
    const row = d && DROP_REACT.has(ability) ? this.row(d, mon) : null;
    if (row) {
      row.reaction = ability;
      return [];
    }
    this.io.apply(bb => logReveal(bb, mon, 'ability', ability));
    return [`${this.label(mon)}: ${ability}`];
  }

  private megaForme(mon: MonRef, suffix?: string): string | undefined {
    const b = this.io.battle();
    if (mon.side === 'me') return megaFormeOf(this.io.gen, b.myTeam[mon.slot]);
    const megas = (this.io.mons()?.[mon.slot]?.formes ?? []).filter(f => /-Mega/.test(f.name)).sort((x, y) => y.p - x.p);
    return (suffix ? megas.find(f => f.name.endsWith(`-${suffix}`)) : undefined)?.name ?? megas[0]?.name;
  }

  private toAction(b: Battle, d: Draft): ActionDraft {
    const said = d.rows.filter(r => r.said);
    const common = {
      actor: d.actor, move: d.move, helpingHand: helpedThisTurn(b, d.actor), actorTriggers: d.actorTriggers,
      actorStatus: d.actorStatus, ordered: true, narrated: true, quick: d.quick,
    };
    if (d.status) {
      const targetRefs = said.length ? said.map(r => r.ref) : d.rows.length === 1 ? [d.rows[0].ref] : [];
      return {...common, hits: [], targets: 1, targetRefs};
    }
    // Spread moves hit every target; a single-target move hit the one named, or (none named) any of them.
    const rows = d.spread ? d.rows : said.length ? said : d.rows;
    if (d.crit) {
      const landed = rows.filter(r => !r.missed);
      if (landed.length === 1) landed[0].crit = true;
    }
    const hits = rows.filter(r => !r.missed).map(r => this.hit(b, r));
    return {...common, hits, targets: d.spread ? Math.max(1, d.rows.length) : 1};
  }

  private hit(b: Battle, r: Row): HitResult {
    const c = b.live.mons[monKey(r.ref)];
    const before = c?.hp ?? 0;
    const base = {target: r.ref, hpBefore: before, crit: !!r.crit, triggers: r.triggers, status: r.status, reaction: r.reaction};
    if (r.noEffect) return {...base, hpAfter: before, fainted: false, noEffect: true};
    if (r.fainted) return {...base, hpAfter: 0, fainted: true, beforeUnknown: c?.hpUnknown || undefined};
    if (r.value !== undefined) {
      return {
        ...base, hpAfter: r.value, fainted: false,
        beforeApprox: r.ref.side === 'opp' && c?.hpEstimated ? true : undefined,
        beforeUnknown: c?.hpUnknown || undefined,
      };
    }
    // Hit, HP not said.
    return {...base, hpAfter: before, fainted: false, unread: true};
  }
}
