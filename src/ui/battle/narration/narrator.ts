/**
 * Turns narrated events into log entries. A move is held open while its details come in (HP,
 * crits, misses, faints, messages) and logged when the next one starts, on "end turn", or when
 * the screen commits it after a pause. Unknown stays unknown: a target whose HP wasn't said is
 * logged as "HP skipped", and messages not mentioned are no evidence (\`narrated\`).
 *
 * The game's lines can be read out just as they come. A stat change is checked against what
 * logging the move (or the switch-in, or the Intimidate) does already, so it's never counted
 * twice, and only what nothing logged explains (Moxie, Speed Boost, a seed) goes onto the board.
 * The field starting and ending, statuses ending, items going and HP read outside a move keep the
 * board as the game shows it. Champions writes nothing between turns: the first end-of-turn line
 * (sandstorm, burn, a Leftovers pop-up, the rain stopping…) ends one, and so does what only a new
 * turn starts with (a switch chosen for it, Mega Evolution, a Pokémon's turn coming again, a move
 * that can't come after one already made: Fake Out after an ordinary attack). What it heard goes
 * with the entries it was about when they're taken back (undo on the screen).
 */
import LEGAL_ABILITIES from '../../../data/abilities.gen.json';
import {isStatusMove, move as dexMove, STAT_LABELS, toID, type BoostID, type Gen} from '../../../data/dex';
import {BLOCKERS, DROP_REACT, SEEDS} from '../../../engine/abilities';
import {megaFormeOf, stoneForme} from '../../../engine/likelihood';
import {moveFx, RISES_BEFORE_HIT} from '../../../engine/moves';
import {maxHPOf, TERRAIN_ABILITY, typesOf, WEATHER_ABILITY, WEATHER_ROCK, type StateCtx} from '../../../engine/state';
import type {MonSummary} from '../../../engine/worker';
import {
  monKey, sameMon, type ActionEvent, type Battle, type Boosts, type HitResult, type MonRef, type SideID, type Snapshot, type Status,
  type Trigger, type Weather,
} from '../../../engine/types';
import {
  canMoveAction, editLive, endTurn, helpedThisTurn, logAction, logCheck, logMega, logReveal, logSwitch, moveAction, setOrdered, turnActions, undo,
  type ActionDraft,
} from '../actions';
import {openMoments, pendingChecks} from '../checks';
import {monLabel} from '../names';
import {applyNews, fieldAgrees, newsKey, type FieldNews} from './messages';
import type {NarrationEvent} from './parse';

export interface NarratorIO {
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
  /** A chance stat change the game showed (Moonblast's Sp. Atk drop…). */
  boosts?: Boosts;
  reaction?: string;
  /** The HP said came after its Sitrus Berry healed it. */
  healed?: boolean;
  /** Mentioned: for a single-target move, the one it hit. */
  said: boolean;
  /** Its own Protect (Detect, Spiky Shield…) earlier this turn stopped the move: nothing more to hear about it. */
  shielded?: boolean;
}

/** Moves that protect the user from others' moves for the turn. */
const PROTECTS = new Set(['protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'obstruct']);
/** Moves that get through Protect. */
const THROUGH_PROTECT = new Set(['feint', 'shadowforce', 'phantomforce', 'hyperspacehole', 'hyperspacefury', 'hyperdrill', 'mightycleave']);
/** Moves that switch their user out. */
const PIVOTS = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'batonpass', 'teleport', 'shedtail', 'chillyreception']);
/** Berries that restore HP when eaten mid-move ("…had its HP restored." after their pop-up). */
const HEALING_BERRIES = new Set(['Sitrus Berry', 'Oran Berry', 'Figy Berry', 'Wiki Berry', 'Mago Berry', 'Aguav Berry', 'Iapapa Berry']);
/** Items used up as their pop-up shows (besides berries, and those a hit or a reaction takes care of). */
const ONE_USE = new Set([...Object.values(SEEDS), 'Room Service', 'Booster Energy', 'Mental Herb', 'Power Herb', 'Mirror Herb',
  'Throat Spray', 'Eject Button', 'Eject Pack', 'Red Card', 'Blunder Policy', 'Absorb Bulb', 'Cell Battery', 'Luminous Moss', 'Snowball']);

/** A stat change the game showed, in stages. */
interface Heard {
  key: string;
  boosts: Boosts;
}

/** A stat stage something logged changed, which a "rose / fell" line may be about. */
interface Change {
  key: string;
  stat: BoostID;
  sign: number;
  /** By how many stages. */
  delta: number;
}

/** Straight onto the board, as the game shows it (not evidence). Each one can be made again safely. */
type Edit =
  | {kind: 'stage'; key: string; stat: BoostID; value: number}
  | {kind: 'status'; key: string; status: Status}
  | {kind: 'itemGone'; key: string}
  | {kind: 'hp'; key: string; hp: number}
  | {kind: 'field'; news: FieldNews}
  /** Its types as the game says they've become (none: its own again). */
  | {kind: 'types'; key: string; types?: string[]}
  | {kind: 'odd'; key: string}
  /** Ally Switch: the two of a side change places. */
  | {kind: 'places'; side: SideID}
  /**
   * A timed effect's setter, for what may stretch it (FieldCondition.mayLast: none, known now); `turns`: as long as it's
   * known to last.
   */
  | {kind: 'lasts'; key: string; by?: {slot: number; item: string}; turns?: number}
  /** A binding move let go of it; `hp`: as it was before the hurt the log gave it this turn, which it didn't take. */
  | {kind: 'unbound'; key: string; hp?: number};

interface Draft {
  actor: MonRef;
  move: string;
  spread: boolean;
  status: boolean;
  rows: Row[];
  actorTriggers: Trigger[];
  actorStatus?: Status;
  actorBoosts?: Boosts;
  /** Its own HP, read after the move (recoil, Life Orb, Rocky Helmet); 0 if it fainted. */
  actorHp?: number;
  quick?: 'Quick Claw' | 'Quick Draw';
  lastRow?: MonRef;
  /** "A critical hit!" before we know on whom. */
  crit?: boolean;
  failed?: boolean;
  hitCount?: number;
  /** A two-turn move's charge was said ("…absorbed electricity!"). */
  charging?: boolean;
  /** Stat changes the game showed while it was open: checked against what logging it does. */
  heard: Heard[];
  /** What came with or after the move but isn't part of it (the field, an item gone): made once it's logged. */
  later: Edit[];
}

const SELF_TARGETS = new Set(['self', 'allySide', 'allyTeam', 'all', 'allies', 'adjacentAllyOrSelf', 'foeSide', 'randomNormal']);
const RESIST_BERRY = /^(Occa|Passho|Wacan|Rindo|Yache|Chople|Kebia|Shuca|Coba|Payapa|Tanga|Charti|Kasib|Haban|Colbur|Babiri|Roseli|Chilan) Berry$/;
const ROW_ITEMS: Record<string, Trigger> = {'Sitrus Berry': 'sitrus', 'Focus Sash': 'sash', 'Weakness Policy': 'wp'};
const STAGES: BoostID[] = ['atk', 'def', 'spa', 'spd', 'spe'];
/** Moves that end a terrain or a side's screens as they're used, rather than at the end of the turn. */
const ENDS_TERRAIN = new Set(['steelroller', 'icespinner']);
const BREAKS_SCREENS = new Set(['brickbreak', 'psychicfangs', 'ragingbull']);
/** Pop-ups that show only at the end of a turn. */
const END_OF_TURN_ABILITIES = new Set([
  'Speed Boost', 'Moody', 'Poison Heal', 'Rain Dish', 'Ice Body', 'Solar Power', 'Harvest', 'Shed Skin', 'Hydration', 'Bad Dreams',
  'Cud Chew',
]);
const END_OF_TURN_ITEMS = new Set(['Leftovers', 'Black Sludge']);

/** Two-turn moves that charge and hit in the same turn in this weather. */
const FIRES_AT_ONCE: Record<string, readonly string[]> = {
  electroshot: ['Rain', 'Heavy Rain'], solarbeam: ['Sun', 'Harsh Sunshine'], solarblade: ['Sun', 'Harsh Sunshine'],
};

const clamp6 = (n: number) => Math.max(-6, Math.min(6, n));
const entries = (b: Boosts) => Object.entries(b) as [BoostID, number][];
/** Every stat the game named went the way this effect sends it. */
const agrees = (effect: Boosts, seen: Boosts) => entries(seen).length > 0 && entries(seen).every(([k, v]) => Math.sign(effect[k] ?? 0) === Math.sign(v));

function applyEdit(live: Snapshot, e: Edit) {
  if (e.kind === 'field') {
    applyNews(live.field, e.news);
    return;
  }
  if (e.kind === 'places') {
    live.active[e.side] = [...live.active[e.side]].reverse();
    return;
  }
  if (e.kind === 'lasts') {
    const may = {...(live.field.mayLast ?? {})};
    if (e.by) may[e.key] = {...e.by};
    else delete may[e.key];
    live.field.mayLast = may;
    if (e.turns) live.field.turns = {...(live.field.turns ?? {}), [e.key]: e.turns};
    return;
  }
  const c = live.mons[e.key];
  if (!c) return;
  if (e.kind === 'stage') {
    const boosts = {...c.boosts};
    if (e.value) boosts[e.stat] = e.value;
    else delete boosts[e.stat];
    c.boosts = boosts;
  }
  if (e.kind === 'status') c.status = e.status;
  if (e.kind === 'itemGone') c.itemGone = true;
  if (e.kind === 'hp') Object.assign(c, {hp: e.hp, hpUnknown: false, hpEstimated: false}, e.hp <= 0 ? {boosts: {}} : {});
  if (e.kind === 'types') {
    if (e.types) c.types = [...e.types];
    else delete c.types;
  }
  if (e.kind === 'odd') c.odd = true;
  if (e.kind === 'unbound') {
    delete c.bound;
    if (e.hp !== undefined) c.hp = e.hp;
  }
}

declare const saved: unique symbol;
/** What the narrator knew at one point (Narrator.save). */
export type NarratorState = {readonly [saved]: true};

export class Narrator {
  private draft: Draft | null = null;
  /** The last move logged, as it was while narrated: taken up again as it was if more about it comes. */
  private kept: {id: string; draft: Draft; extra: Edit[]} | null = null;
  private vacated: Partial<Record<SideID, number>> = {};
  private quick = new Map<string, 'Quick Claw' | 'Quick Draw'>();
  /** "X moved first" said before X's move was logged: where it goes once it is. */
  private pending = new Map<string, {place: 'first' | 'last'; other?: MonRef}>();
  /** Stat changes made by what was logged since the last move started, for the game's lines about them. */
  private explained: Change[] = [];
  /** The last ability pop-up, for the weather or terrain it sets (the line after it). */
  private shownAbility: {mon: MonRef; ability: string} | null = null;
  /** Theirs whose stat line turned a logged change round (see matchChange): Contrary, unless it's their Mega's. */
  private reversed = new Set<string>();
  /** Past the last move (a switch, one that couldn't move, the end of the turn): HP said now is where it's at. */
  private sealed = false;
  /** The end of the turn has come: the turn has been ended already. */
  private ending = false;
  /** Who the last end-of-turn or "couldn't move" line was about, for a number said after it. */
  private about?: MonRef;
  /** Those whose turn came but couldn't move, and the turn: moving in that turn means a new one has begun. */
  private couldnt = new Map<string, number>();
  /** The last entry in the log when the narrator last looked: gone means entries were taken back (undo). */
  private anchor: string | undefined;
  /** The turn this phrase has told of so far (a move said in it), for a move it brings up again. */
  private phraseTurn: number | null = null;
  /** A move told again: the targets said with it are the logged move's, not the open one's. */
  private retelling = false;
  /** The rest of the phrase, after what's being taken in now. */
  private ahead: NarrationEvent[] = [];
  /** The last thing taken in, if it was an item's pop-up: whose, and the item. */
  private popped: {key: string; item: string} | null = null;
  /** Made by an Encore to use its last move this turn ("…must do an encore!"): that move goes at the priority of the one chosen. */
  private encored = new Set<string>();
  /** Theirs whose Trace just showed: the ability pop-up next for it is the one it copied. */
  private traced: string | null = null;
  /** Made to move again this turn by an Instruct ("…followed …'s instructions!"): its next move isn't a new turn's. */
  private instructed = new Set<string>();

  constructor(private io: NarratorIO) {}

  /** Entries taken back since the narrator last looked: what it heard about them goes too. */
  private sync() {
    if (this.anchor && !this.io.battle().events.some(e => e.id === this.anchor)) {
      this.couldnt.clear();
      this.encored.clear();
      this.instructed.clear();
      this.pending.clear();
      this.quick.clear();
      this.explained = [];
      this.kept = null;
      this.vacated = {};
      this.sealed = false;
      this.ending = false;
      this.about = undefined;
    }
  }

  private mark() {
    this.anchor = this.io.battle().events.at(-1)?.id;
  }

  /** It couldn't move earlier this turn. */
  private couldntNow(ref: MonRef) {
    return this.couldnt.get(monKey(ref)) === this.io.battle().turn;
  }

  /**
   * The move is one logged this turn told again: the last thing logged (said twice), or one this phrase brings up
   * after telling of this turn ("…but Raichu had Protect"). Otherwise its Pokémon moving again is the next turn's.
   */
  /** A two-turn move that charged and won't hit until next turn (no rain for its Electro Shot…). */
  private chargeOnly(d: Draft): boolean {
    const weather = this.io.battle().live.field.weather;
    return !!d.charging && !(weather && FIRES_AT_ONCE[toID(d.move)]?.includes(weather));
  }

  private toldAgain(actor: MonRef, move: string) {
    const b = this.io.battle();
    // Another's move open since (an Instruct, its "…followed …'s instructions!"): its move once more, not told again.
    if (this.instructed.has(monKey(actor)) || (this.draft && !sameMon(this.draft.actor, actor))) return false;
    const same = turnActions(b).find(a => sameMon(a.actor, actor) && a.move === move);
    // After a charge, the move said again is its attack: the next turn's.
    if (!same || same.charged || !this.fits(same)) return false;
    if (this.phraseTurn === b.turn) return true;
    if (this.sealed) return false;
    for (let k = b.events.length - 1; k >= 0; k--) {
      const e = b.events[k];
      if (e.kind === 'action' || e.kind === 'switch' || e.kind === 'endTurn') return e.id === same.id;
    }
    return false;
  }

  /** What the phrase says with the move fits the open one: a target it has or can have, no other HP for one said. */
  private fitsOpen(d: Draft) {
    if (d.status) return true;
    const said = d.rows.filter(r => r.said);
    for (const e of this.ahead) {
      if (e.kind === 'use' || e.kind === 'endTurn') break;
      const m = e.kind === 'target' ? e.mon : e.kind === 'hp' ? e.mon ?? d.lastRow : undefined;
      if (!m || sameMon(m, d.actor)) continue;
      const row = d.rows.find(r => sameMon(r.ref, m));
      if (!row || (!d.spread && said.length && !row.said)) return false;
      if (e.kind === 'hp' && row.value !== undefined && row.value !== e.value) return false;
    }
    return true;
  }

  /**
   * What the phrase says with the move fits it as logged: no target it wasn't aimed at, no other HP for one it hit
   * (Moonblast into Charizard, then Moonblast into Incineroar: a second one).
   */
  private fits(a: ActionEvent) {
    const status = isStatusMove(this.io.gen, a.move);
    const hit = (m: MonRef) => a.hits.find(h => sameMon(h.target, m));
    // Also the ones it didn't reach (into a Protect, missed), as narrated, for the last move logged.
    const rows = this.kept?.id === a.id ? this.kept.draft.rows.filter(r => r.said) : [];
    const aimed = (m: MonRef) => !!hit(m) || [...(a.targetRefs ?? []), ...rows.map(r => r.ref)].some(r => sameMon(r, m));
    for (const e of this.ahead) {
      if (e.kind === 'use' || e.kind === 'endTurn') break;
      if (e.kind === 'target' && !sameMon(e.mon, a.actor) && !aimed(e.mon)) return false;
      if (e.kind === 'hp' && !status) {
        const m = e.mon ?? (a.hits.length === 1 ? a.hits[0].target : undefined);
        if (!m || sameMon(m, a.actor)) continue;
        const h = hit(m);
        if (h ? !h.unread && !h.fainted && h.hpAfter !== e.value : !aimed(m)) return false;
      }
    }
    return true;
  }

  /**
   * A single-target move that could have hit more than one, with none said: "Incineroar / Bellibolt" (not a question:
   * an HP or a faint said for one of them settles it, and nothing needs answering).
   */
  private whichOne(d: Draft): string | null {
    if (d.spread || d.status || d.failed || d.rows.length < 2 || d.rows.some(r => r.said)) return null;
    return d.rows.map(r => this.label(r.ref)).join(' / ');
  }

  private label(r: MonRef) {
    return monLabel(this.io.battle(), this.io.mons(), r);
  }

  get open() {
    return !!this.draft;
  }

  /** What it knows now, to go back to if the phrase about to be fed is taken back ("scratch that"). */
  save(): NarratorState {
    const {draft, kept, vacated, quick, pending, explained, sealed, ending, about, couldnt, anchor} = this;
    return structuredClone({draft, kept, vacated, quick, pending, explained, sealed, ending, about, couldnt, anchor}) as unknown as NarratorState;
  }

  /** Back to what it knew then; whoever takes the phrase back puts the battle back too. */
  load(s: NarratorState) {
    Object.assign(this, structuredClone(s));
  }

  /** The move being narrated, for the screen. */
  describe(): string {
    const d = this.draft;
    if (!d) return '';
    if (d.failed) return `${this.label(d.actor)} · ${d.move} → failed`;
    const which = this.whichOne(d);
    if (which) return `${this.label(d.actor)} · ${d.move} → ${which}`;
    const shown = d.rows.filter(r => r.said || d.spread);
    const bits = shown.map(r => {
      const what = r.missed ? (r.shielded ? 'protected' : 'missed') : r.fainted ? 'KO' : r.noEffect ? 'immune'
        : r.value !== undefined ? `${r.value}${r.ref.side === 'opp' ? '%' : ''}` : 'HP ?';
      return `${this.label(r.ref)} ${what}${r.crit ? ' crit' : ''}`;
    });
    return `${this.label(d.actor)} · ${d.move}${d.hitCount ? ` ×${d.hitCount}` : ''}${bits.length ? ` → ${bits.join(', ')}` : ''}`;
  }

  /** Apply what was heard; returns short notes of what was done. */
  feed(events: NarrationEvent[]): string[] {
    this.sync();
    this.phraseTurn = null;
    this.retelling = false;
    const notes: string[] = [];
    for (const [k, ev] of events.entries()) {
      this.ahead = events.slice(k + 1);
      for (const n of this.one(ev)) if (n) notes.push(n);
    }
    this.ahead = [];
    this.mark();
    return notes;
  }

  /** Log the move being narrated. */
  commit(): string | null {
    const d = this.draft;
    this.draft = null;
    if (!d) return null;
    const action = this.toAction(this.io.battle(), d);
    const changes = this.log((bb, c) => logAction(c, bb, action));
    const logged = this.io.battle().events.at(-1);
    // What the game said that logging it didn't do (Moxie, a Defiant not known yet…), and what came after it.
    const extra = this.settle(changes, d.heard);
    if (logged?.kind === 'action') this.kept = {id: logged.id, draft: d, extra};
    this.editNow([...extra, ...d.later], false);
    this.showReversed();
    // Its place in the turn was said before its move was ("Rillaboom moved first… Fake Out").
    const wanted = this.pending.get(monKey(d.actor));
    this.pending.delete(monKey(d.actor));
    const moved = wanted ? this.reorder(d.actor, wanted.place, wanted.other) : '';
    // Its priority isn't its own (an Encore made it), something else put it where it went (After You, Quash, Instruct), or
    // it's changed in a way the app doesn't follow: its place in the turn says nothing of its Speed.
    const odd = !!this.io.battle().live.mons[monKey(d.actor)]?.odd;
    if (logged?.kind === 'action' && (this.encored.has(monKey(d.actor)) || odd)) this.io.apply(bb => setOrdered(bb, logged.id, false));
    this.instructed.delete(monKey(d.actor));
    const which = this.whichOne(d);
    const hits = which ? [`${which} (not said): HP skipped`] : action.hits.map(h => `${this.label(h.target)} ${h.fainted ? 'KO' : h.noEffect ? 'immune'
      : h.unread ? 'HP skipped' : `${h.hpAfter}${h.target.side === 'opp' ? '%' : ''}`}${h.crit ? ' crit' : ''}`);
    const missed = which ? [] : d.rows.filter(r => r.missed && (r.shielded || r.said)).map(r => `${this.label(r.ref)} ${r.shielded ? 'protected' : 'missed'}`);
    const outcome = [...hits, ...missed];
    const done = `✓ ${this.label(d.actor)} · ${d.move}${d.failed ? ' → failed' : action.charged ? ' → charging' : outcome.length ? ` → ${outcome.join(', ')}` : ''}`;
    this.mark();
    return [done, moved].filter(Boolean).join(' · ');
  }

  /**
   * Something about a move heard after it was logged ("…it crit", "Dragapult 40"): the move is
   * taken back and reopened with what it had, to be logged again with this added. Only the last
   * thing logged this turn, only a narrated move (so taking it back is exact), and not once the
   * turn has moved on (a switch, the end of the turn).
   */
  private reopen(about?: MonRef, hitSomething = false): Draft | null {
    if (this.draft || this.sealed) return null;
    const b = this.io.battle();
    const last = b.events[b.events.length - 1];
    if (last?.kind !== 'action' || !last.narrated || last.turn !== b.turn) return null;
    if (hitSomething && !last.hits.some(h => !h.noEffect)) return null;
    const kept = this.kept?.id === last.id ? this.kept.draft : null;
    const involved = kept ? [kept.actor, ...kept.rows.map(r => r.ref)] : [last.actor, ...last.hits.map(h => h.target), ...(last.targetRefs ?? [])];
    if (about && !involved.some(r => sameMon(r, about))) return null;
    this.io.apply(bb => undo(bb));
    this.explained = [];
    this.kept = null;
    this.draft = kept ?? this.fromAction(last);
    return this.draft;
  }

  /** A logged move as a draft again. */
  private fromAction(ev: ActionEvent): Draft {
    const gen = this.io.gen;
    const status = isStatusMove(gen, ev.move);
    const target = moveFx(ev.move).tg ?? dexMove(gen, ev.move)?.target ?? 'normal';
    const spread = !status && (target === 'allAdjacentFoes' || target === 'allAdjacent');
    const rows: Row[] = ev.hits.map(h => ({
      ref: h.target,
      value: h.unread || h.fainted || h.noEffect ? undefined : h.hpAfter,
      fainted: h.fainted || undefined,
      noEffect: h.noEffect,
      crit: h.crit || undefined,
      triggers: [...h.triggers],
      status: h.status,
      boosts: h.boosts,
      reaction: h.reaction ?? undefined,
      healed: h.healed,
      said: true,
    }));
    for (const ref of ev.targetRefs ?? []) rows.push({ref, triggers: [], said: true});
    return {
      actor: ev.actor, move: ev.move, spread, status, rows, actorTriggers: [...ev.actorTriggers], actorStatus: ev.actorStatus,
      actorBoosts: ev.actorBoosts, actorHp: ev.actorHpAfter, quick: ev.quick ?? undefined, failed: ev.failed, hitCount: ev.hitCount,
      charging: ev.charged, lastRow: rows.length === 1 ? rows[0].ref : undefined, heard: [], later: [],
    };
  }

  /**
   * Moves a logged move to where it was said to go in the turn: first, last, or before or after
   * another's, a place at a time as long as the turn's other entries allow (as the log's "It went
   * earlier / later" does).
   */
  private reorder(mon: MonRef, place: 'first' | 'last', other?: MonRef): string {
    const name = this.label(mon);
    const find = (who: MonRef) => turnActions(this.io.battle()).findIndex(a => sameMon(a.actor, who));
    const mine = turnActions(this.io.battle()).find(a => sameMon(a.actor, mon));
    if (!mine) {
      this.pending.set(monKey(mon), {place, other});
      return `${name} ${place === 'first' ? 'first' : 'last'}: noted for when its move is logged`;
    }
    if (other && find(other) < 0) {
      // "…before X" with X still to move is already so; "…after X": X goes before it once it's logged.
      if (place === 'last') this.pending.set(monKey(other), {place: 'first', other: mon});
      return `${name} ${place === 'first' ? 'before' : 'after'} ${this.label(other)}: noted`;
    }
    const goal = () => {
      const at = find(mon);
      if (!other) return place === 'first' ? 0 : turnActions(this.io.battle()).length - 1;
      const o = find(other);
      return place === 'first' ? Math.min(at, o) : Math.max(at, o);
    };
    let why = '';
    let moved = false;
    for (let step = 0; step < 8; step++) {
      const at = find(mon);
      const to = goal();
      if (at === to) break;
      const dir = to < at ? -1 : 1;
      const chk = canMoveAction(this.io.battle(), mine.id, dir);
      if (!chk.ok) {
        why = chk.why;
        break;
      }
      this.io.apply((bb, c) => moveAction(c, bb, mine.id, dir));
      moved = true;
    }
    // Re-running the turn's moves rebuilt the board from them: what the game showed after the last goes on again.
    if (moved && this.kept) this.editNow([...this.kept.extra, ...this.kept.draft.later], false);
    const where = other ? `${place === 'first' ? 'before' : 'after'} ${this.label(other)}` : place;
    return find(mon) === goal() ? `${name} moved ${where} ✓` : `${name} ${where}? Can't move it: ${why}`;
  }

  discard() {
    this.draft = null;
  }

  private one(ev: NarrationEvent): (string | null)[] {
    const b = this.io.battle();
    // The pop-up just before this, if it was an item's (a Sitrus Berry's "…had its HP restored." follows it).
    const popped = this.popped;
    this.popped = ev.kind === 'item' && ev.mon ? {key: monKey(ev.mon), item: ev.item} : null;
    // Trace's copy shows straight after Trace: anything else between, and it's over.
    if (ev.kind !== 'ability') this.traced = null;
    switch (ev.kind) {
      case 'use': {
        // The move told again: said twice ("Raichu Protect… Raichu Protect?"), or brought up again as a phrase goes on
        // ("Fake Out into Raichu, but Raichu had Protect"). It's the one there is: not a second move, nor a new turn.
        if (this.draft && sameMon(this.draft.actor, ev.actor) && this.draft.move === ev.move && !this.chargeOnly(this.draft) && this.fitsOpen(this.draft)) {
          this.phraseTurn = b.turn;
          return [];
        }
        if (this.toldAgain(ev.actor, ev.move)) {
          this.retelling = true;
          this.phraseTurn = b.turn;
          return [`${this.label(ev.actor)} · ${ev.move}: logged already`];
        }
        this.retelling = false;
        const done = this.commit();
        this.nothingShown();
        // It couldn't move earlier this turn: the next turn's. (One that moved already this turn starts the next as it's
        // logged. A move said after ones it must have come before, Fake Out after an ordinary attack, is this turn's,
        // said out of order: it goes in its place once logged.)
        const turned = this.couldntNow(ev.actor) ? this.newTurn() : [];
        this.explained = [];
        this.sealed = false;
        this.ending = false;
        if (!this.io.battle().live.active[ev.actor.side].includes(ev.actor.slot)) {
          return [done, ...turned, `${this.label(ev.actor)} isn't on the field`];
        }
        this.draft = this.start(this.io.battle(), ev.actor, ev.move);
        this.phraseTurn = this.io.battle().turn;
        // Protect, Tailwind, Trick Room…: nothing more to hear.
        if (this.draft.status && !this.draft.rows.length) return [done, ...turned, this.commit()];
        return [done, ...turned];
      }
      case 'target': {
        const d = this.draft;
        if (!d || this.retelling || sameMon(ev.mon, d.actor)) return [];
        const row = this.row(d, ev.mon);
        if (row) {
          row.said = true;
          // Into a Protect: nothing happened to it, and nothing more is needed (no HP).
          if (this.shieldedFrom(ev.mon, d.move)) Object.assign(row, {missed: true, shielded: true});
          this.touch(d, row);
        }
        return [];
      }
      case 'hp': {
        const d = this.draft ?? this.reopen(ev.mon);
        if (!d) {
          // After the moves (the end of the turn, a switch-in, one that couldn't move), or said of one no move can take
          // it for any more ("Bellibolt 84" once another move has been logged since): where it's at now.
          const ref = ev.mon ?? (this.sealed ? this.about : undefined);
          if (ref) return this.reading(ref, ev.value);
          return [`HP ${ev.value} not placed (no move open)`];
        }
        const ref = ev.mon ?? this.hpTarget(d);
        if (!ref) return [`HP ${ev.value}: whose? Say the name with it`];
        const max = ref.side === 'opp' ? 100 : maxHPOf(this.io.ctx(b), b.live, ref);
        if (ev.value > max) return [`${this.label(ref)} ${ev.value}? Max is ${max}`];
        // Its own HP after the move: recoil, Life Orb, Rocky Helmet.
        if (sameMon(ref, d.actor)) {
          d.actorHp = ev.value;
          return [];
        }
        const row = this.row(d, ref);
        // Not hit by this move ("Bellibolt 84" for the move before, once this one's open), or a single-target move
        // whose target's been said already: where it's at now, not a second target.
        const hitAnother = !d.spread && d.rows.some(r => r.said && !sameMon(r.ref, ref));
        if (!row || (hitAnother && !row.said)) return this.reading(ref, ev.value);
        // Its HP read though the move missed it or it protected itself: unchanged, and no damage.
        if (row.missed) return [];
        if (row.triggers.includes('sitrus')) {
          // Said after its Sitrus Berry: what it settled on once healed. Said again after that: the same hit.
          if (row.value !== undefined) return [];
          // Under a quarter it can only be before the berry, which heals a quarter ("1%, Sitrus Berry").
          row.healed = ev.value > (ref.side === 'opp' ? 25 : Math.floor(max / 4));
        }
        // Higher than this move left it, read already: healed since (Leftovers, Grassy Terrain): where it's at now.
        if (row.value !== undefined && ev.value > row.value && !row.triggers.includes('sitrus')) return this.reading(ref, ev.value);
        // 0 is a KO: a fainted one's box shows 0 before "…fainted!" (or without it, the battle over).
        Object.assign(row, ev.value === 0 ? {value: undefined, fainted: true, said: true} : {value: ev.value, fainted: false, said: true});
        this.touch(d, row);
        return [];
      }
      case 'faint': {
        const d = this.draft ?? this.reopen(ev.mon);
        const ref = ev.mon ?? d?.lastRow ?? (d ? this.soleTarget(d) : undefined);
        if (!ref) return [];
        if (d && sameMon(ref, d.actor)) {
          // Recoil, Life Orb, Explosion, Destiny Bond…
          d.actorHp = 0;
          return [];
        }
        if (d) {
          const row = this.row(d, ref);
          if (row) {
            Object.assign(row, {fainted: true, said: true, missed: false});
            this.touch(d, row);
            return [];
          }
        }
        // Fainted outside a narrated hit (poison, sandstorm…): keep the board right.
        this.edit({kind: 'hp', key: monKey(ref), hp: 0});
        return [`${this.label(ref)} fainted`];
      }
      case 'crit': {
        const d = this.draft ?? this.reopen(ev.mon, true);
        if (!d) return ['A crit, but no move it could be on'];
        const on = ev.mon ? this.row(d, ev.mon) : null;
        if (on) {
          Object.assign(on, {crit: true, said: true});
          d.lastRow = on.ref;
          return [];
        }
        const row = d.lastRow ? this.row(d, d.lastRow) : null;
        if (row && row.said) row.crit = true;
        else d.crit = true;
        return [];
      }
      case 'effective': {
        // "It's super effective on the opposing Kingambit!": the move reached it.
        const d = this.draft;
        const row = d ? this.row(d, ev.mon) : null;
        if (d && row && !row.missed) {
          row.said = true;
          this.touch(d, row);
        }
        return [];
      }
      case 'miss': {
        // "X protected itself!" after its own Protect.
        if (ev.shield && ev.mon && this.isActor(ev.mon)) return [];
        const d = this.draft ?? this.reopen(ev.mon);
        if (!d) return [];
        if (!ev.mon || sameMon(ev.mon, d.actor)) {
          // "X's attack missed": whoever it was aimed at.
          const target = this.soleTarget(d);
          for (const r of d.rows) if (!target || sameMon(r.ref, target)) Object.assign(r, {missed: true, said: true});
          return [];
        }
        const row = this.row(d, ev.mon);
        if (row) Object.assign(row, {missed: true, said: true, ...(ev.shield ? {shielded: true} : {})});
        return [];
      }
      case 'immune': {
        const d = this.draft ?? this.reopen(ev.mon);
        if (!d) return [];
        const ref = ev.mon ?? this.soleTarget(d);
        const row = ref ? this.row(d, ref) : null;
        if (row) {
          Object.assign(row, {noEffect: true, said: true});
          this.touch(d, row);
        }
        return [];
      }
      case 'fail': {
        const d = this.draft ?? this.reopen();
        if (d) d.failed = true;
        return [];
      }
      case 'hits': {
        const d = this.draft ?? this.reopen(undefined, true);
        if (d && !d.status) d.hitCount = ev.n;
        return [];
      }
      case 'recoil': {
        const d = this.draft ?? this.reopen(ev.mon);
        // The pop-up ("…'s Life Orb") and "…lost some of its HP!" say the same recoil.
        if (d && d.actor.side === 'opp' && (!ev.mon || sameMon(ev.mon, d.actor)) && !d.actorTriggers.includes('lifeorb')) d.actorTriggers.push('lifeorb');
        return [];
      }
      case 'status': {
        if (!ev.mon) return [];
        const d = this.draft ?? this.reopen(ev.mon);
        if (d && this.involves(d, ev.mon)) {
          if (sameMon(ev.mon, d.actor)) {
            d.actorStatus = ev.status;
            return [];
          }
          const row = this.row(d, ev.mon);
          if (row && !row.missed) {
            Object.assign(row, {status: ev.status, said: true});
            return [];
          }
        }
        // Outside a move (a Toxic Orb, Yawn…): the board shows it too.
        const c = this.io.battle().live.mons[monKey(ev.mon)];
        if (c && !c.status && c.hp > 0) this.edit({kind: 'status', key: monKey(ev.mon), status: ev.status});
        return [];
      }
      case 'cant': {
        // "…flinched and couldn't move!" straight after a Fake Out with no target said: whom it hit.
        if (ev.flinch && ev.mon && this.draft && !this.draft.spread && !this.draft.rows.some(r => r.said)) {
          const row = this.row(this.draft, ev.mon);
          if (row) row.said = true;
        }
        // Its turn came and went: the move before is over. Its turn coming again means a new turn.
        const done = this.commit();
        const again = ev.mon && (this.couldntNow(ev.mon) || turnActions(this.io.battle()).some(a => sameMon(a.actor, ev.mon!)));
        const turned = again ? this.newTurn() : [];
        if (ev.mon) this.couldnt.set(monKey(ev.mon), this.io.battle().turn);
        this.sealed = true;
        this.about = ev.mon;
        const c = ev.mon ? this.io.battle().live.mons[monKey(ev.mon)] : undefined;
        if (ev.mon && ev.status && c && !c.status) this.edit({kind: 'status', key: monKey(ev.mon), status: ev.status});
        return [done, ...turned, ev.mon ? `${this.label(ev.mon)} couldn't move` : null];
      }
      case 'cure':
        if (!ev.mon) return [];
        this.edit({kind: 'status', key: monKey(ev.mon), status: ''});
        return [`${this.label(ev.mon)}: status over`];
      case 'stat':
        return ev.mon ? this.stat(ev.mon, ev.boosts, ev.limit) : [];
      case 'copyBoosts':
        return this.copyBoosts(ev.mon, ev.from, ev.invert);
      case 'outOfTurn':
        // After You, Quash, Instruct: its move this turn goes where they put it, so it says nothing of its Speed.
        this.encored.add(monKey(ev.mon));
        if (ev.again) this.instructed.add(monKey(ev.mon));
        return [];
      case 'types':
        return this.retype(ev);
      case 'onField': {
        // Its HP box is up where the log has another (its switch read wrong, or missed): it came in there.
        const now = this.io.battle();
        const {side, slot} = ev.mon;
        if (now.live.active[side].includes(slot) || ev.position >= now.live.active[side].length) return [];
        const done = this.commit();
        this.sealed = true;
        this.explained.push(...this.log((bb, c) => logSwitch(c, bb, side, ev.position, slot)));
        return [done, `${this.label(ev.mon)} is out (its HP box): logged as come in`];
      }
      case 'places':
        if (this.io.battle().live.active[ev.side].length !== 2) return [];
        this.edit({kind: 'places', side: ev.side});
        return [`${ev.side === 'me' ? 'yours' : 'theirs'} switched places`];
      case 'odd':
        this.edit({kind: 'odd', key: monKey(ev.mon)});
        return [`${this.label(ev.mon)} changed: what it does now isn't counted`];
      case 'unchanged':
        return this.unchanged(ev.mon, ev.stats);
      case 'field':
        return this.field(ev.news);
      case 'battleEnd':
        // "The battle has ended due to a forfeit.", "You lost to …!": the move still being told is logged.
        return this.endPhase();
      case 'charge': {
        // A two-turn move's charge ("…absorbed electricity!"), with its "…used" line or without: its stat rise (Electro
        // Shot's, Meteor Beam's) comes with the charge, so a Protect against the hit doesn't stop it. In the rain (Electro
        // Shot) or the sun (Solar Beam) the hit comes straight after; otherwise this was its turn, the attack the next.
        if (!ev.mon) return [];
        const notes = this.draft && sameMon(this.draft.actor, ev.mon) ? [] : this.one({kind: 'use', actor: ev.mon, move: ev.move});
        if (this.draft && sameMon(this.draft.actor, ev.mon)) {
          this.draft.charging = true;
          // The charge always comes with its rise: had even if its "…'s Sp. Atk rose!" isn't read.
          const rise = RISES_BEFORE_HIT[toID(ev.move)];
          if (rise && !this.draft.actorBoosts) this.draft.actorBoosts = {...rise};
        }
        return notes;
      }
      case 'encored': {
        // "…must do an encore!": whom the Encore being told was aimed at; its move this turn says nothing of its Speed.
        const d = this.draft;
        const row = d && ev.mon && toID(d.move) === 'encore' ? this.row(d, ev.mon) : null;
        if (row) row.said = true;
        if (ev.mon) this.encored.add(monKey(ev.mon));
        return [];
      }
      case 'trapped': {
        // The move being told reached it: logging it holds it (MonCondition.bound, seeded, salted).
        const d = this.draft;
        const row = d && ev.mon ? this.row(d, ev.mon) : null;
        if (row && !row.missed) row.said = true;
        return [];
      }
      case 'freed': {
        // At the end of a turn, instead of its hurt: the log, not knowing whether it was 4 turns or 5, gave it that.
        const notes = this.endPhase();
        if (!ev.mon) return notes;
        const key = monKey(ev.mon);
        const now = this.io.battle();
        const c = now.live.mons[key];
        if (!c?.bound) return notes;
        const max = maxHPOf(this.io.ctx(now), now.live, ev.mon);
        const back = ev.mon.side === 'me' ? Math.floor(max / 8) : 100 / 8;
        this.edit({kind: 'unbound', key, hp: c.bound.ticks >= 1 && c.hp > 0 ? Math.min(max, Math.round(c.hp + back)) : undefined});
        return [...notes, `${this.label(ev.mon)}: free of ${c.bound.move}`];
      }
      case 'residual': {
        // "…had its HP restored." straight after a healing berry of one in the move being told: part of the move. (After
        // anything else it's Leftovers or Grassy Terrain: the end of the turn.)
        const d = this.draft;
        const berry = !!popped && HEALING_BERRIES.has(popped.item) && !!ev.mon && popped.key === monKey(ev.mon);
        if (ev.heal && berry && d && ev.mon && (sameMon(d.actor, ev.mon) || d.rows.some(r => r.said && sameMon(r.ref, ev.mon!)))) {
          this.about = ev.mon;
          return [];
        }
        const notes = this.endPhase();
        this.about = ev.mon;
        if (ev.sand) notes.push(...this.field({what: 'weather', value: 'Sand', upkeep: true}));
        return notes;
      }
      case 'item': {
        if (ev.taken) {
          // "…stole and ate its target's Sitrus Berry!": the berry of whoever the move hit.
          const d = this.draft;
          const target = d ? d.lastRow ?? this.soleTarget(d) : turnActions(b).at(-1)?.hits.find(h => !h.noEffect)?.target;
          if (!target) return [];
          if (target.side === 'opp') this.io.apply(bb => logReveal(bb, target, 'item', ev.item));
          this.edit({kind: 'itemGone', key: monKey(target)});
          return target.side === 'opp' ? [`${this.label(target)}: ${ev.item}`] : [];
        }
        // Leftovers, Black Sludge: the end of the turn.
        const ended = END_OF_TURN_ITEMS.has(ev.item) ? this.endPhase() : [];
        const mon = ev.mon && this.popupOwner(ev.mon, 'item', ev.item);
        // One that goes with a hit (a berry, the Sash, Life Orb, Rocky Helmet): the move it was in.
        const withHit = !!ROW_ITEMS[ev.item] || RESIST_BERRY.test(ev.item) || ev.item === 'Life Orb' || ev.item === 'Rocky Helmet';
        const d = withHit ? this.draft ?? this.reopen(mon) : this.draft;
        const {notes, onHit} = this.item(d, mon, ev.item);
        // A berry the game names outside a hit was eaten (a Lum Berry curing, a Sitrus at the end of the turn).
        const gone = ev.gone ?? (!onHit && (/Berry$/.test(ev.item) || ONE_USE.has(ev.item)));
        if (gone && mon) this.edit({kind: 'itemGone', key: monKey(mon)});
        return [...ended, ...notes];
      }
      case 'order': {
        // The open move is logged first, so it can be moved too.
        const done = this.commit();
        return [done, this.reorder(ev.mon, ev.place, ev.other)];
      }
      case 'ability': {
        // Speed Boost, Poison Heal…: the end of the turn.
        const notes = END_OF_TURN_ABILITIES.has(ev.ability) ? this.endPhase() : [];
        const mon = this.popupOwner(ev.mon, 'ability', ev.ability);
        this.shownAbility = mon ? {mon, ability: ev.ability} : null;
        return [...notes, ...this.ability(this.io.battle(), this.draft, mon, ev.ability)];
      }
      case 'mega': {
        if (!ev.mon) return ['Mega Evolution: whose?'];
        const forme = this.megaForme(ev.mon, ev.suffix);
        if (!forme) return [`${this.label(ev.mon)} can't Mega Evolve`];
        if (b.live.mons[monKey(ev.mon)]?.mega) return [];
        // Mega Evolution comes before a turn's moves: any logged this turn were the last turn's.
        const done = this.commit();
        const turned = this.newTurn();
        this.explained.push(...this.log((bb, c) => logMega(c, bb, ev.mon!, forme)));
        return [done, ...turned, `${this.label(ev.mon)} Mega Evolved`];
      }
      case 'withdraw': {
        const done = this.commit();
        // A switch chosen for the turn is made before its moves: any logged this turn were the last turn's.
        const turned = ev.voluntary ? this.newTurn() : [];
        this.sealed = true;
        if (ev.mon) {
          const pos = this.io.battle().live.active[ev.mon.side].indexOf(ev.mon.slot);
          if (pos >= 0) this.vacated[ev.mon.side] = pos;
        }
        return [done, ...turned];
      }
      case 'sendOut':
      case 'dragged': {
        const done = this.commit();
        this.sealed = true;
        const now = this.io.battle();
        const {side, slot} = ev.mon;
        const active = now.live.active[side];
        if (active.includes(slot)) return [done];
        this.about = ev.mon;
        const fainted = active.findIndex(s => s === null || (now.live.mons[`${side}${s}`]?.hp ?? 1) <= 0);
        // Dragged out: in for the one the last move hit (Roar, Dragon Tail, Red Card).
        const hit = ev.kind === 'dragged' ? this.lastHit(side) : -1;
        const pos = hit >= 0 ? hit : this.vacated[side] ?? (fainted >= 0 ? fainted : active.length === 1 ? 0 : this.pivoted(side));
        delete this.vacated[side];
        if (pos < 0) {
          this.io.askSwitch(side, slot);
          return [done, `${this.label(ev.mon)} came in: tap which one it replaced`];
        }
        this.explained.push(...this.log((bb, c) => logSwitch(c, bb, side, pos, slot)));
        return [done, `${this.label(ev.mon)} came in`];
      }
      case 'endTurn': {
        const done = this.commit();
        // The moves being chosen: what came in has shown what it had.
        this.nothingShown();
        this.pending.clear();
        this.couldnt.clear();
        this.encored.clear();
        this.instructed.clear();
        this.sealed = true;
        // The turn already ended with its first end-of-turn line.
        if (this.ending) return [done];
        this.ending = true;
        const now = this.io.battle();
        if (!turnActions(now).length) return [done];
        this.log((bb, c) => endTurn(c, bb));
        return [done, `— end of turn ${now.turn} —`];
      }
    }
  }

  /**
   * Where one coming in goes with no place free: the place of the last of that side, still out, to use a move
   * that switches it out this turn (Baton Pass, U-turn, Parting Shot…). Yours choose who comes in on the party
   * screen, so the game writes no "…, come back!" for them.
   */
  private pivoted(side: SideID): number {
    const b = this.io.battle();
    const acts = turnActions(b);
    for (let k = acts.length - 1; k >= 0; k--) {
      const a = acts[k];
      if (a.actor.side !== side || a.failed || !PIVOTS.has(toID(a.move))) continue;
      const pos = b.live.active[side].indexOf(a.actor.slot);
      if (pos >= 0) return pos;
    }
    return -1;
  }

  /**
   * "…'s Attack was not lowered!": an ability or item stopped the drop (Scrappy, Clear Body, Clear
   * Amulet…). Said while the move is open, its drop comes off again once it's logged; said after,
   * the latest drop logged this turn (the Intimidate it came in to, a move's) goes back. Nothing
   * lowered: what was logged already.
   */
  private unchanged(mon: MonRef, stats: BoostID[]): string[] {
    const b = this.io.battle();
    const key = monKey(mon);
    const c = b.live.mons[key];
    if (!c || c.hp <= 0) return [];
    const said = `${this.label(mon)}: ${stats.map(s => STAT_LABELS[s]).join(', ')} not lowered`;
    const d = this.draft;
    if (d && this.involves(d, mon) && !sameMon(d.actor, mon)) {
      for (const stat of stats) d.later.push({kind: 'stage', key, stat, value: c.boosts[stat] ?? 0});
      return [`${said} ✓`];
    }
    const back: BoostID[] = [];
    for (const stat of stats) {
      let drop = 0;
      for (let k = b.events.length - 1; k >= 0 && !drop && b.events[k].turn === b.turn; k--) {
        const before = b.events[k].undo?.live.mons[key]?.boosts[stat] ?? 0;
        const after = (b.events[k + 1]?.undo?.live ?? b.live).mons[key]?.boosts[stat] ?? 0;
        if (after < before) drop = before - after;
      }
      if (!drop) continue;
      this.edit({kind: 'stage', key, stat, value: clamp6((c.boosts[stat] ?? 0) + drop)});
      const at = this.explained.findIndex(x => x.key === key && x.stat === stat && x.sign < 0);
      if (at >= 0) this.explained.splice(at, 1);
      back.push(stat);
    }
    if (!back.length) return [`${said} ✓`];
    // Yours stopped it though its ability as logged wouldn't: a Mega's that wasn't said (Mega Lopunny's Scrappy)?
    const set = mon.side === 'me' ? b.myTeam[mon.slot] : undefined;
    const mega = set && !c.mega ? megaFormeOf(this.io.gen, set) : undefined;
    const megaAbility = mega ? Object.values(this.io.gen.species.get(toID(mega))?.abilities ?? {})[0] as string | undefined : undefined;
    const hint = megaAbility && BLOCKERS.has(megaAbility) && !BLOCKERS.has(set!.ability ?? '') ? ` (has it Mega Evolved? ${megaAbility} would stop it)` : '';
    return [`${said}: put back${hint}`];
  }

  /**
   * Champions writes nothing between turns: a new one shows by its switches, its Mega Evolution, or
   * a Pokémon's turn coming again. The turn logged so far ends then, unless its end came already.
   */
  private newTurn(): (string | null)[] {
    if (this.ending || !turnActions(this.io.battle()).length) return [];
    return this.endPhase();
  }

  /** The first line from the end of the turn: the moves are over, so the turn ends (its timers and residual damage with it). */
  private endPhase(): (string | null)[] {
    if (this.ending) return [];
    const done = this.commit();
    this.ending = true;
    this.sealed = true;
    this.pending.clear();
    this.couldnt.clear();
    this.encored.clear();
    this.instructed.clear();
    const now = this.io.battle();
    if (!turnActions(now).length) return [done];
    this.log((bb, c) => endTurn(c, bb));
    return [done, `— end of turn ${now.turn} —`];
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
    // A spread move's targets that protected themselves this turn: untouched.
    const rows: Row[] = cands.map(ref => ({ref, triggers: [], said: false,
      ...(spread && this.shieldedFrom(ref, move) ? {missed: true, shielded: true} : {})}));
    return {actor, move, spread, status, rows, actorTriggers: [], quick, heard: [], later: []};
  }

  /** It protected itself earlier this turn (Protect, Detect…), and this move doesn't get through that. */
  private shieldedFrom(ref: MonRef, move: string): boolean {
    if (THROUGH_PROTECT.has(toID(move))) return false;
    return turnActions(this.io.battle()).some(a => sameMon(a.actor, ref) && PROTECTS.has(toID(a.move)) && !a.failed);
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

  private involves(d: Draft, ref: MonRef) {
    return sameMon(d.actor, ref) || d.rows.some(r => sameMon(r.ref, ref));
  }

  /**
   * The pop-ups ("Incineroar's Intimidate", "Incineroar's Sitrus Berry") don't say whose. With the
   * same species out on both sides, it's theirs if it doesn't fit yours, or if theirs is the one the
   * game was asked about (it just came in).
   */
  private popupOwner(mon: MonRef, kind: 'ability' | 'item', name: string): MonRef {
    if (mon.side !== 'me') return mon;
    const b = this.io.battle();
    const set = b.myTeam[mon.slot];
    const gen = this.io.gen;
    const base = (s: string) => gen.species.get(toID(s))?.baseSpecies ?? s;
    const twin = b.live.active.opp.find(s => s !== null && set && base(b.oppPreview[s]) === base(set.species));
    if (twin === undefined || twin === null) return mon;
    const theirs: MonRef = {side: 'opp', slot: twin};
    const mega = megaFormeOf(gen, set);
    const mine = kind === 'item' ? [set.item] : [set.ability, ...(mega ? Object.values(gen.species.get(toID(mega))?.abilities ?? {}) : [])];
    const asked = pendingChecks(b, this.io.mons(), this.io.ctx(b)).some(c => sameMon(c.mon, theirs) && c.options.some(o => o.name === name));
    return !mine.includes(name) || asked ? theirs : mon;
  }

  /** Using the move being narrated, or the one just logged. */
  private isActor(ref: MonRef) {
    if (this.draft) return sameMon(this.draft.actor, ref);
    const last = this.io.battle().events.at(-1);
    return last?.kind === 'action' && sameMon(last.actor, ref);
  }

  /** Where on its side the last move hit a Pokémon (for one dragged out in its place). */
  private lastHit(side: SideID): number {
    const b = this.io.battle();
    const last = turnActions(b).at(-1);
    const hit = [...(last?.hits.filter(h => !h.noEffect).map(h => h.target) ?? []), ...(last?.targetRefs ?? [])]
      .find(r => r.side === side && b.live.active[side].includes(r.slot));
    return hit ? b.live.active[side].indexOf(hit.slot) : -1;
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
  /**
   * Whose a bare HP is: the one said, unless the move hit others too and that one's HP is in already ("Lopunny 49,
   * … 8": the 8 is someone else's, a name misheard), when it isn't guessed.
   */
  private hpTarget(d: Draft): MonRef | undefined {
    const ref = this.soleTarget(d);
    return ref && d.rows.length > 1 && this.row(d, ref)?.value !== undefined ? undefined : ref;
  }

  private soleTarget(d: Draft): MonRef | undefined {
    const said = d.rows.filter(r => r.said);
    if (said.length === 1) return said[0].ref;
    return d.rows.length === 1 ? d.rows[0].ref : d.lastRow;
  }

  /**
   * "…'s Attack rose!" and the like. What logging something did already (a move's own boosts and
   * drops, Intimidate on the way in, Sticky Web…) is only confirmed; a chance effect of the move
   * being narrated goes with it (the target's drop, its own boost), which also says whom it hit;
   * anything else goes onto the board as the game shows it.
   */
  private stat(mon: MonRef, boosts: Boosts, limit?: boolean): string[] {
    // What was heard, confirmed ("Charizard: Atk −1 ✓"), so a line that changes nothing still shows it was understood.
    const heard = `${this.label(mon)}: ${entries(boosts).map(([k, v]) => `${STAT_LABELS[k]} ${limit ? (v > 0 ? 'max' : 'min') : v > 0 ? `+${v}` : `−${-v}`}`).join(', ')} ✓`;
    const d = this.draft;
    if (d && this.involves(d, mon)) {
      this.heardInMove(d, mon, boosts, limit);
      return [heard];
    }
    if (limit) return this.board(mon, boosts, true);
    const rest = this.consume(monKey(mon), boosts);
    this.showReversed();
    if (!entries(rest).length) return [heard];
    const re = this.reopen(mon);
    if (re) {
      // Logged again, it's checked again then: by what the game said, all of it.
      this.heardInMove(re, mon, Object.fromEntries(entries(boosts).filter(([s]) => s in rest)) as Boosts);
      return [heard];
    }
    return this.board(mon, rest);
  }

  private heardInMove(d: Draft, mon: MonRef, boosts: Boosts, limit?: boolean) {
    const fx = moveFx(d.move);
    const key = monKey(mon);
    if (sameMon(mon, d.actor)) {
      // Its own chance boost (Meteor Mash, Ancient Power, Charge Beam…), or a charge's rise before its hit (Electro Shot).
      const s = (fx.sec ?? []).find(x => x.ch < 100 && x.sb && agrees(x.sb, boosts))?.sb ?? RISES_BEFORE_HIT[toID(d.move)];
      if (s && agrees(s, boosts) && !limit) d.actorBoosts = {...s};
    } else {
      const row = this.row(d, mon);
      if (row && !row.missed && !row.noEffect) {
        // A stat change on it means the move reached it: for a single-target move, that's who it hit.
        row.said = true;
        const s = (fx.sec ?? []).find(x => x.ch < 100 && x.b && agrees(x.b, boosts));
        if (s && !limit && !d.status) row.boosts = {...s.b};
        // Defiant or Competitive answering the move's drop, before its ability is known.
        const reaction = boosts.atk === 2 && entries(boosts).length === 1 ? 'Defiant'
          : boosts.spa === 2 && entries(boosts).length === 1 ? 'Competitive' : undefined;
        if (reaction && !d.status && !row.reaction && this.drops(d, row) && this.mayHave(mon, reaction)) row.reaction = reaction;
      }
    }
    if (limit) d.later.push(...entries(boosts).map(([stat, v]) => ({kind: 'stage' as const, key, stat, value: 6 * Math.sign(v)})));
    else d.heard.push({key, boosts});
  }

  /** The move lowers this target's stats (for sure, or by the chance the game showed). */
  private drops(d: Draft, row: Row): boolean {
    const fx = moveFx(d.move);
    const lowers = (b?: Boosts) => !!b && entries(b).some(([, v]) => v < 0);
    return (fx.sec ?? []).some(s => lowers(s.b) && s.ch >= 100) || lowers(row.boosts);
  }

  /** Theirs could have this ability (mine are known, and the log handles them already). */
  private mayHave(mon: MonRef, ability: string): boolean {
    return mon.side === 'opp' && !!this.io.mons()?.[mon.slot]?.abilities.some(a => a.name === ability && a.p > 0);
  }

  /**
   * Take the stat changes something logged made off what the game said; what's left wasn't. By as much as the game
   * says, whatever the move's data has: Champions' Make It Rain lowers Sp. Atk by 2 where Scarlet and Violet's lowered
   * it by 1, and a Simple Pokémon's changes are doubled.
   */
  private consume(key: string, boosts: Boosts): Boosts {
    const rest: Boosts = {};
    for (const [stat, v] of entries(boosts)) {
      const made = this.matchChange(this.explained, key, stat, v)?.delta ?? 0;
      if (made !== v) rest[stat] = v - made;
    }
    return rest;
  }

  /**
   * The logged change a stat line is about, taken off the list: one of the same sign, else, on one of theirs that may
   * have Contrary, the one it turns round exactly ("…'s Defense and Sp. Def rose!" after its Close Combat logged as
   * drops), which the game's line then replaces. Only then: a Competitive's "sharply rose" after a drop it was never
   * told isn't a drop turned round.
   */
  private matchChange(list: Change[], key: string, stat: BoostID, v: number): Change | undefined {
    let at = list.findIndex(c => c.key === key && c.stat === stat && c.sign === Math.sign(v));
    if (at < 0 && this.mayReverse(key)) at = list.findIndex(c => c.key === key && c.stat === stat && c.delta === -v);
    if (at < 0) return undefined;
    const [c] = list.splice(at, 1);
    if (c.sign !== Math.sign(v)) this.reversed.add(key);
    return c;
  }

  /** A change turned round on one of theirs that may have entered with Contrary: that's its ability, shown. */
  private showReversed() {
    for (const key of this.reversed) {
      const slot = Number(key.slice(3));
      const known = this.io.mons()?.[slot]?.abilities.find(a => a.name === 'Contrary');
      if (known && known.p < 1) this.io.apply(bb => logReveal(bb, {side: 'opp', slot}, 'ability', 'Contrary'));
    }
    this.reversed.clear();
  }

  /** One of theirs that may have Contrary (as it entered, or as the Mega it may be). */
  private mayReverse(key: string): boolean {
    if (!key.startsWith('opp')) return false;
    const slot = Number(key.slice(3));
    const m = this.io.mons()?.[slot];
    return this.mayHave({side: 'opp', slot}, 'Contrary') || Object.values(m?.megaAbilityOf ?? {}).includes('Contrary');
  }

  /**
   * Once a move is logged: the stat changes the game showed while it was open that logging it
   * didn't make are made as said, and the ones it made by as much as said (see consume); the ones
   * it made that the game hasn't shown yet may still be.
   */
  private settle(changes: Change[], heard: Heard[]): Edit[] {
    const left = [...changes];
    const out: Edit[] = [];
    const live = this.io.battle().live;
    const now = new Map<string, number>();
    for (const h of heard) {
      for (const [stat, v] of entries(h.boosts)) {
        const made = this.matchChange(left, h.key, stat, v)?.delta ?? 0;
        if (made === v) continue;
        const k = `${h.key}.${stat}`;
        const value = clamp6((now.get(k) ?? live.mons[h.key]?.boosts[stat] ?? 0) + v - made);
        now.set(k, value);
        out.push({kind: 'stage', key: h.key, stat, value});
      }
    }
    this.explained.push(...left);
    return out;
  }

  /** A stat change nothing logged explains, onto the board as the game shows it. */
  private board(mon: MonRef, boosts: Boosts, limit?: boolean): string[] {
    const c = this.io.battle().live.mons[monKey(mon)];
    if (!c || c.hp <= 0) return [];
    const bits: string[] = [];
    for (const [stat, v] of entries(boosts)) {
      const value = limit ? 6 * Math.sign(v) : clamp6((c.boosts[stat] ?? 0) + v);
      if (value === (c.boosts[stat] ?? 0)) continue;
      this.edit({kind: 'stage', key: monKey(mon), stat, value});
      bits.push(`${STAT_LABELS[stat]} ${value > 0 ? '+' : ''}${value}`);
    }
    return bits.length ? [`${this.label(mon)}: ${bits.join(', ')}`] : [];
  }

  /**
   * Psych Up: its stat stages become the other's, as the game says (the move names no target the log could use).
   * Topsy-Turvy (`invert`): its own, the other way round.
   */
  private copyBoosts(mon: MonRef, from: MonRef, invert?: boolean): string[] {
    const b = this.io.battle();
    const src = b.live.mons[monKey(from)];
    const c = b.live.mons[monKey(mon)];
    if (!src || !c || c.hp <= 0) return [];
    const bits: string[] = [];
    for (const stat of STAGES) {
      const value = (invert ? -1 : 1) * (src.boosts[stat] ?? 0);
      if ((c.boosts[stat] ?? 0) === value) continue;
      this.edit({kind: 'stage', key: monKey(mon), stat, value});
      bits.push(`${STAT_LABELS[stat]} ${value > 0 ? '+' : ''}${value}`);
    }
    const what = invert ? 'stat changes inverted' : `copied ${this.label(from)}'s stat changes`;
    return [`${this.label(mon)}: ${what}${bits.length ? ` (${bits.join(', ')})` : ''}`];
  }

  /** Its types as the game says they've become: Protean, Libero, Soak, Reflect Type, Trick-or-Treat, Burn Up… */
  private retype(ev: Extract<NarrationEvent, {kind: 'types'}>): string[] {
    const b = this.io.battle();
    const ctx = this.io.ctx(b);
    const now = typesOf(ctx, b.live, ev.mon);
    let types: string[] | undefined;
    if (ev.to) types = [ev.to];
    else if (ev.like) types = typesOf(ctx, b.live, ev.like);
    else if (ev.add) types = now.includes(ev.add) ? now : [...now, ev.add];
    else if (ev.lose) types = now.filter(t => t !== ev.lose);
    // Burn Up on a Pokémon that's only Fire leaves it with no type, which the calc has no way to take.
    if (types && !types.length) return [];
    this.edit({kind: 'types', key: monKey(ev.mon), types});
    return [`${this.label(ev.mon)}: ${types ? types.join('/') : 'its own types again'}`];
  }

  /**
   * What came in showed no ability or item on its way in (no Intimidate, no Drought, no Air Balloon…), and what my
   * Intimidate met didn't react: with every line of the game read, that's the answer, not a question left open. Once the
   * moment has passed (a move used, the moves being chosen). A pop-up logged as a plain reveal (the beliefs not in yet to
   * match it to the question) is the answer instead; the weather or terrain changing with no ability shown for it leaves
   * the question to be answered.
   */
  private nothingShown() {
    const b = this.io.battle();
    for (const o of openMoments(b)) {
      const key = monKey(o.mon);
      const c = b.live.mons[key];
      if (!c) continue;
      const since = b.events.slice(b.events.findIndex(e => e.id === o.about) + 1);
      const shown = since.filter(e => e.kind === 'reveal' && (e.what === 'ability' || e.what === 'item') && !e.negate && sameMon(e.mon, o.mon)).at(-1);
      // The terrain up as it came in: its seed would have gone off too. The weather and terrain up before: an ability
      // that would set them again says nothing.
      const terrain = o.context === 'entry' ? b.live.field.terrain : undefined;
      const already = o.context === 'entry' && o.before ? {weather: o.before.field.weather, terrain: o.before.field.terrain} : undefined;
      if (shown?.kind === 'reveal') {
        this.explained.push(...this.log((bb, cx) => logCheck(cx, bb, {
          mon: o.mon, context: o.context, about: o.about, seen: shown.value, seenKind: shown.what === 'item' ? 'item' : 'ability',
          // An item it showed (a seed, used up as it went off) it held then.
          mega: !!c.mega, itemGone: shown.what === 'item' ? false : !!c.itemGone, applied: true, terrain, already,
        })));
        continue;
      }
      const before = o.before;
      if (o.context === 'entry' && before) {
        const changed = before.field.weather !== b.live.field.weather || before.field.terrain !== b.live.field.terrain;
        const shown = since.some(e => (e.kind === 'reveal' && e.what === 'ability') || (e.kind === 'check' && e.seenKind === 'ability' && !!e.seen));
        if (changed && !shown) continue;
      }
      // My Intimidate taken as it comes: its Attack a stage down from before (else something answered it).
      if (o.context === 'intimidate' && before && (c.boosts.atk ?? 0) !== Math.max(-6, (before.mons[key]?.boosts.atk ?? 0) - 1)) continue;
      this.explained.push(...this.log((bb, cx) => logCheck(cx, bb, {
        mon: o.mon, context: o.context, about: o.about, seen: null, mega: !!c.mega, itemGone: !!c.itemGone, terrain, already,
      })));
    }
    this.seedsShown();
    this.stretchShown();
  }

  /**
   * Their screen, weather or terrain up still past its 5th turn, and no line saying it's over: its setter holds what
   * makes it last 8 (6 Oct: Sableye's Light Screen wore off after 8 turns, and had been taken off after 5).
   */
  private stretchShown() {
    for (const [key, m] of Object.entries(this.io.battle().live.field.mayLast ?? {})) {
      if (!m.past) continue;
      // Shown to hold something else since: it can't be.
      if (this.io.mons()?.[m.slot]?.items.find(i => i.name === m.item)?.p === 0) continue;
      this.io.apply(bb => logReveal(bb, {side: 'opp', slot: m.slot}, 'item', m.item));
      this.edit({kind: 'lasts', key});
    }
  }

  /**
   * Weather or terrain the ability just shown set ("…'s Drizzle", "It started to rain!"): 8 turns where its holder's
   * Damp Rock (Terrain Extender…) is known, and where it's theirs with an item not known, maybe (see FieldCondition.mayLast).
   */
  private setBy(news: FieldNews): Edit | null {
    const by = this.shownAbility;
    if (!by || !news.value || (news.what !== 'weather' && news.what !== 'terrain')) return null;
    const sets = news.what === 'weather' ? WEATHER_ABILITY[by.ability] : TERRAIN_ABILITY[by.ability];
    if (sets !== news.value) return null;
    this.shownAbility = null;
    const stretcher = news.what === 'weather' ? WEATHER_ROCK[news.value as Weather] : 'Terrain Extender';
    if (!stretcher) return null;
    const known = by.mon.side === 'me'
      ? this.io.battle().myTeam[by.mon.slot]?.item ?? null
      : this.io.mons()?.[by.mon.slot]?.items.find(i => i.p >= 1)?.name;
    if (known !== undefined) return known === stretcher ? {kind: 'lasts', key: news.what, turns: 8} : null;
    return {kind: 'lasts', key: news.what, by: {slot: by.mon.slot, item: stretcher}};
  }

  /** Over right at the end of its 5th turn: its setter doesn't hold what would have made it last 8. */
  private stretchOver(news: FieldNews) {
    const key = newsKey(news);
    const f = this.io.battle().live.field;
    const m = key ? f.mayLast?.[key] : undefined;
    if (m?.past && !news.value && f.turns?.[key!] === 3) {
      this.io.apply(bb => logReveal(bb, {side: 'opp', slot: m.slot}, 'item', m.item, true));
    }
  }

  /**
   * A terrain up with one of theirs out: its seed would have gone off, on its way in (its entry, answered above) or as
   * the terrain started. Once for each stay on the field and terrain.
   */
  private seedsShown() {
    const b = this.io.battle();
    const terrain = b.live.field.terrain;
    if (!terrain) return;
    const seed = SEEDS[terrain];
    for (const slot of b.live.active.opp) {
      if (slot === null) continue;
      const mon: MonRef = {side: 'opp', slot};
      const c = b.live.mons[monKey(mon)];
      let at = -1;
      b.events.forEach((e, k) => {
        if (e.kind === 'switch' && e.side === 'opp' && e.slotIn === slot) at = k;
      });
      if (!c || c.hp <= 0 || at < 0) continue;
      const about = `${b.events[at].id}:${terrain}`;
      const since = b.events.slice(at + 1);
      if (since.some(e => e.kind === 'check' && sameMon(e.mon, mon) && (e.context === 'terrain' ? e.about === about : e.context === 'entry' && e.terrain === terrain))) continue;
      const shown = since.some(e => e.kind === 'reveal' && e.what === 'item' && e.value === seed && sameMon(e.mon, mon));
      if (c.itemGone && !shown) continue;
      this.explained.push(...this.log((bb, cx) => logCheck(cx, bb, {
        mon, context: 'terrain', about, terrain, seen: shown ? seed : null, seenKind: shown ? 'item' : undefined,
        mega: !!c.mega, itemGone: shown ? false : !!c.itemGone, applied: shown || undefined,
      })));
    }
  }

  /** The field as a line describes it: ending the turn if it's an end-of-turn line, then made so if it isn't already. */
  private field(news: FieldNews): (string | null)[] {
    const notes = this.endsTurn(news) ? this.endPhase() : [];
    const f = this.io.battle().live.field;
    // A line that doesn't say whose side: the side it can be about.
    if ('side' in news && !news.side) {
      const n = news;
      const sides = (['me', 'opp'] as const).filter(s => !fieldAgrees(f, {...n, side: s}));
      if (sides.length !== 1 || n.value) return notes;
      news = {...n, side: sides[0]};
    }
    this.stretchOver(news);
    if (fieldAgrees(f, news)) return [...notes, `${fieldNote(news)} ✓`];
    this.edit({kind: 'field', news});
    const set = this.setBy(news);
    if (set) this.edit(set);
    return [...notes, fieldNote(news)];
  }

  /**
   * Weather ending or carrying on, Tailwind or Gravity ending: only at the end of a turn. A room,
   * terrain or screens ending: then too, unless the move just used ended them (Trick Room again,
   * Steel Roller, Defog, Brick Break).
   */
  private endsTurn(n: FieldNews): boolean {
    if (n.what === 'weather') return n.value === null || !!n.upkeep;
    if (n.value) return false;
    if (n.what === 'tailwind' || n.what === 'gravity') return true;
    const move = toID(this.draft?.move ?? turnActions(this.io.battle()).at(-1)?.move ?? '');
    const fx = moveFx(move);
    if (n.what === 'terrain') return !ENDS_TERRAIN.has(move) && fx.clr !== 'defog';
    if (n.what === 'trickRoom' || n.what === 'magicRoom' || n.what === 'wonderRoom') return fx.pw !== n.what.toLowerCase();
    if (n.what === 'reflect' || n.what === 'lightScreen' || n.what === 'auroraVeil') return fx.clr !== 'defog' && !BREAKS_SCREENS.has(move);
    return false;
  }

  /** HP read outside a move: where it's at now (not evidence). */
  private reading(ref: MonRef, value: number): string[] {
    const b = this.io.battle();
    if (!b.live.active[ref.side].includes(ref.slot)) return [`${this.label(ref)} isn't on the field`];
    const max = ref.side === 'opp' ? 100 : maxHPOf(this.io.ctx(b), b.live, ref);
    if (value > max) return [`${this.label(ref)} ${value}? Max is ${max}`];
    const c = b.live.mons[monKey(ref)];
    if (c && c.hp === value && !c.hpUnknown && !c.hpEstimated) return [];
    this.edit({kind: 'hp', key: monKey(ref), hp: value});
    return [`${this.label(ref)} ${value}${ref.side === 'opp' ? '%' : ''}`];
  }

  /** Onto the board: once the move being narrated is logged, or now (and again if the move just logged is taken up again). */
  private edit(e: Edit) {
    if (this.draft) {
      this.draft.later.push(e);
      return;
    }
    this.editNow([e]);
  }

  private editNow(edits: Edit[], keep = true) {
    if (!edits.length) return;
    this.io.apply(bb => editLive(bb, live => {
      for (const e of edits) applyEdit(live, e);
    }));
    if (keep && this.kept && this.io.battle().events.at(-1)?.id === this.kept.id) {
      for (const e of edits) if (!this.kept.draft.later.includes(e)) this.kept.draft.later.push(e);
    }
  }

  /** Log something, and note the stat stages it changed (the game's "rose / fell" lines about them follow). */
  private log(fn: (b: Battle, c: StateCtx) => Battle): Change[] {
    const before = this.io.battle().live.mons;
    this.io.apply(fn);
    const out: Change[] = [];
    for (const [key, c] of Object.entries(this.io.battle().live.mons)) {
      const was = before[key];
      if (!was || c.hp <= 0) continue;
      for (const stat of STAGES) {
        const d = (c.boosts[stat] ?? 0) - (was.boosts[stat] ?? 0);
        if (d) out.push({key, stat, sign: Math.sign(d), delta: d});
      }
    }
    return out;
  }

  /** An item the game named. `onHit`: it went with the move being narrated (a berry, the Sash, Life Orb…). */
  private item(d: Draft | null, mon: MonRef | undefined, item: string): {notes: (string | null)[]; onHit?: boolean} {
    if (item === 'Quick Claw' && mon) {
      this.quick.set(monKey(mon), 'Quick Claw');
      return {notes: []};
    }
    // An open "what did the game show?" question it answers (an Air Balloon on the way in, White Herb after Intimidate).
    const b = this.io.battle();
    const check = mon && mon.side === 'opp' ? pendingChecks(b, this.io.mons(), this.io.ctx(b))
      .find(c => sameMon(c.mon, mon) && c.options.some(o => o.kind === 'item' && o.name === item)) : undefined;
    if (mon && check) {
      const c0 = b.live.mons[monKey(mon)];
      this.explained.push(...this.log((bb, c) => logCheck(c, bb, {
        mon, context: check.context, about: check.about, seen: item, seenKind: 'item', mega: !!c0?.mega, itemGone: !!c0?.itemGone,
      })));
      return {notes: [`${this.label(mon)}: ${item}`]};
    }
    // White Herb undoing the drop the move being narrated made; else (its own Close Combat…) straight on the board.
    if (item === 'White Herb' && mon) {
      const row = d && !d.status ? d.rows.find(r => sameMon(r.ref, mon)) : undefined;
      if (d && row && !row.reaction && this.drops(d, row)) {
        row.reaction = 'White Herb';
        return {notes: [], onHit: true};
      }
      const c = b.live.mons[monKey(mon)];
      for (const [stat, v] of entries(c?.boosts ?? {})) if (v < 0) this.edit({kind: 'stage', key: monKey(mon), stat, value: 0});
    }
    if (d) {
      if (item === 'Life Orb' && (!mon || sameMon(mon, d.actor))) {
        if (d.actor.side === 'opp' && !d.actorTriggers.includes('lifeorb')) d.actorTriggers.push('lifeorb');
        return {notes: [], onHit: true};
      }
      if (item === 'Rocky Helmet' && d.actor.side === 'me') {
        d.actorTriggers.push('helmet');
        return {notes: [], onHit: true};
      }
      const trig = ROW_ITEMS[item] ?? (RESIST_BERRY.test(item) ? 'berry' : undefined);
      const ref = mon ?? d.lastRow ?? this.soleTarget(d);
      const row = trig && ref ? this.row(d, ref) : null;
      if (row && trig) {
        if (!row.triggers.includes(trig)) row.triggers.push(trig);
        row.said = true;
        return {notes: [], onHit: true};
      }
    }
    // Anything else of theirs that the game named (Leftovers, Booster Energy…) is a reveal.
    if (mon?.side === 'opp') {
      this.io.apply(bb => logReveal(bb, mon, 'item', item));
      return {notes: [`${this.label(mon)}: ${item}`]};
    }
    return {notes: []};
  }

  private ability(b: Battle, d: Draft | null, mon: MonRef, ability: string): (string | null)[] {
    if (mon.side === 'me') return [];
    // Trace's pop-up, then the one it copied ("…'s Prankster", from your Grimmsnarl): that one isn't its own.
    if (this.traced === monKey(mon)) {
      this.traced = null;
      return [`${this.label(mon)}: traced ${ability}`];
    }
    if (ability === 'Trace') this.traced = monKey(mon);
    // One none of its formes can have (Trace's copy read without Trace's own pop-up, a Skill Swap…): not its own.
    if (!this.canHave(mon, ability)) return [`${this.label(mon)}: ${ability} (not its own)`];
    if (ability === 'Quick Draw') this.quick.set(monKey(mon), 'Quick Draw');
    // An open "what did the game show?" question about it (entry abilities, Intimidate reactions).
    const ctx = this.io.ctx(b);
    const check = pendingChecks(b, this.io.mons(), ctx)
      .find(c => sameMon(c.mon, mon) && c.options.some(o => o.name === ability));
    if (check) {
      const c0 = b.live.mons[monKey(mon)];
      this.explained.push(...this.log((bb, c) => logCheck(c, bb, {
        mon, context: check.context, about: check.about, seen: ability, seenKind: 'ability',
        mega: !!c0?.mega, itemGone: !!c0?.itemGone,
      })));
      return [`${this.label(mon)}: ${ability}`];
    }
    // Defiant, Competitive… reacting to this move's stat drop (a status move has no hit to hang it on).
    const row = d && !d.status && DROP_REACT.has(ability) ? this.row(d, mon) : null;
    if (row) {
      row.reaction = ability;
      return [];
    }
    this.io.apply(bb => logReveal(bb, mon, 'ability', ability));
    return [`${this.label(mon)}: ${ability}`];
  }

  /** One of theirs can have this ability: one of its formes' (a Mega's own too). */
  private canHave(mon: MonRef, ability: string): boolean {
    const b = this.io.battle();
    const species = b.oppPreview[mon.slot];
    if (!species) return true;
    const formes = this.io.ctx(b).fmt.preview[species] ?? [species];
    return formes.some(f => {
      const legal = (LEGAL_ABILITIES as Record<string, string[]>)[toID(f)] ?? [];
      return legal.includes(ability) || (Object.values(this.io.gen.species.get(toID(f))?.abilities ?? {}) as string[]).includes(ability);
    });
  }

  private megaForme(mon: MonRef, suffix?: string): string | undefined {
    const b = this.io.battle();
    if (mon.side === 'me') return megaFormeOf(this.io.gen, b.myTeam[mon.slot]);
    // The stone it was shown with ("…'s Garchompite Z is reacting to …'s Omni Ring!") says which: the line after calls
    // Garchomp's Z forme plain "Mega Garchomp".
    const species = b.oppPreview[mon.slot];
    for (let k = b.events.length - 1; k >= 0; k--) {
      const e = b.events[k];
      if (e.kind !== 'reveal' || e.what !== 'item' || e.negate || !sameMon(e.mon, mon)) continue;
      const forme = stoneForme(this.io.gen, species, e.value);
      if (forme) return forme;
    }
    // What it can be: as believed, or (beliefs not in yet) the formes the format lists for it.
    const believed = (this.io.mons()?.[mon.slot]?.formes ?? []).filter(f => /-Mega/.test(f.name)).sort((x, y) => y.p - x.p);
    const listed = (this.io.ctx(b).fmt.preview[species] ?? []).filter(f => /-Mega/.test(f)).map(name => ({name, p: 0}));
    const megas = believed.length ? believed : listed;
    const said = suffix ? megas.find(f => f.name.endsWith(`-${suffix}`)) : undefined;
    if (said) return said.name;
    // X or Y not said (and not known): just "Mega" ("Raichu-Mega"), which the damage it does will tell apart.
    const known = megas.find(f => f.p >= 0.99);
    if (megas.length > 1 && !known) return megas[0].name.replace(/-[XY]$/, '');
    return megas[0]?.name;
  }

  private toAction(b: Battle, d: Draft): ActionDraft {
    const said = d.rows.filter(r => r.said);
    const common = {
      actor: d.actor, move: d.move, helpingHand: helpedThisTurn(b, d.actor), actorTriggers: d.actorTriggers,
      actorStatus: d.actorStatus, ordered: true, narrated: true, quick: d.quick,
      actorBoosts: d.actorBoosts, actorHpAfter: d.actorHp, hitCount: d.hitCount,
      ...(this.instructed.has(monKey(d.actor)) ? {again: true} : {}),
    };
    if (d.failed) return {...common, hits: [], targets: 1, targetRefs: [], failed: true};
    if (this.chargeOnly(d)) return {...common, hits: [], targets: 1, targetRefs: [], charged: true};
    if (d.status) {
      const reached = said.filter(r => !r.missed && !r.noEffect).map(r => r.ref);
      const targetRefs = said.length ? reached : d.rows.length === 1 ? [d.rows[0].ref] : [];
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
    const base = {target: r.ref, hpBefore: before, crit: !!r.crit, triggers: r.triggers, status: r.status, boosts: r.boosts, reaction: r.reaction};
    if (r.noEffect) return {...base, hpAfter: before, fainted: false, noEffect: true};
    if (r.fainted) return {...base, hpAfter: 0, fainted: true, beforeUnknown: c?.hpUnknown || undefined};
    if (r.value !== undefined) {
      return {
        ...base, hpAfter: r.value, fainted: false, healed: r.healed,
        beforeApprox: r.ref.side === 'opp' && c?.hpEstimated ? true : undefined,
        beforeUnknown: c?.hpUnknown || undefined,
      };
    }
    // Hit, HP not said.
    return {...base, hpAfter: before, fainted: false, unread: true};
  }
}

function fieldNote(n: FieldNews): string {
  const label: Record<string, string> = {
    trickRoom: 'Trick Room', magicRoom: 'Magic Room', wonderRoom: 'Wonder Room', gravity: 'Gravity', tailwind: 'Tailwind', reflect: 'Reflect',
    lightScreen: 'Light Screen', auroraVeil: 'Aurora Veil', stealthRock: 'Stealth Rock', spikes: 'Spikes', toxicSpikes: 'Toxic Spikes',
    stickyWeb: 'Sticky Web',
  };
  if (n.what === 'weather') return n.value ?? 'weather over';
  if (n.what === 'terrain') return n.value ? `${n.value} Terrain` : 'terrain over';
  const whose = 'side' in n && n.side ? `${n.side === 'me' ? 'your' : 'their'} ` : '';
  return `${whose}${label[n.what]}${n.value ? '' : ' over'}`;
}
