import type {BoostID} from '../data/dex';
import type {PokemonSet} from '../data/paste';

export type SideID = 'me' | 'opp';

/** A Pokémon in the battle: which side, and its index in that side's team of six. */
export interface MonRef {
  side: SideID;
  slot: number;
}
export const monKey = (r: MonRef) => `${r.side}${r.slot}`;
export const sameMon = (a: MonRef, b: MonRef) => a.side === b.side && a.slot === b.slot;

export type Status = '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
export type Boosts = Partial<Record<BoostID, number>>;

/** Volatile state of one Pokémon at a point in time. */
export interface MonCondition {
  /** Mine: exact HP. Opponent: HP% as the game displays it (0-100). */
  hp: number;
  boosts: Boosts;
  status: Status;
  /** Has Mega Evolved. */
  mega: boolean;
  /** Terastallized into this type (SV only). */
  tera?: string;
  /** Protosynthesis / Quark Drive / Flash Fire / Unburden etc. currently active. */
  abilityOn: boolean;
  /** Item consumed, knocked off or otherwise gone. */
  itemGone: boolean;
  /** Opponent HP% was computed (recoil, Leftovers…) rather than read off the screen. */
  hpEstimated?: boolean;
  /** A hit on it went unread ("skip HP"): its HP is unknown until the next reading. */
  hpUnknown?: boolean;
  /** Turns badly poisoned, for Toxic's growing damage. */
  toxic?: number;
  /** Its types, changed by a move or an ability (Protean, Soak, Burn Up…): until it leaves the field. */
  types?: string[];
  /**
   * The turn it used Glaive Rush, until it tries to move again: it takes double damage meanwhile (and every move hits
   * it).
   */
  exposed?: number;
  /**
   * Changed in a way the app doesn't follow (Transform, Power Trick…): until it leaves the field, what it deals and
   * takes and when it moves say nothing of its set.
   */
  odd?: boolean;
  /** Aegislash in its Blade forme: it attacked since it came in or last used King's Shield (Stance Change). */
  blade?: boolean;
  /**
   * Held by a binding move (Infestation, Fire Spin, Whirlpool, Sand Tomb, Wrap, Bind, Snap Trap): it can't switch out,
   * and loses 1/8 of its HP at the end of each turn (1/6 with its binder's Binding Band), 4 or 5 times (7 with a Grip
   * Claw), while its binder stays in. `ticks`: the times so far.
   */
  bound?: {move: string; by: MonRef; ticks: number};
  /** Leech Seed: 1/8 of its HP at the end of each turn, until it leaves the field. */
  seeded?: boolean;
  /** Salt Cure: 1/8 of its HP at the end of each turn (1/4 for a Water or Steel type), until it leaves the field. */
  salted?: boolean;
}

export type Weather = 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Harsh Sunshine' | 'Heavy Rain' | 'Strong Winds';
export type Terrain = 'Electric' | 'Grassy' | 'Psychic' | 'Misty';

export interface SideCondition {
  tailwind: boolean;
  reflect: boolean;
  lightScreen: boolean;
  auroraVeil: boolean;
  friendGuard: boolean;
  /** Entry hazards on this side (set by the other side). */
  stealthRock?: boolean;
  spikes?: number;
  toxicSpikes?: number;
  stickyWeb?: boolean;
}

export interface FieldCondition {
  weather?: Weather;
  terrain?: Terrain;
  trickRoom: boolean;
  gravity: boolean;
  /** Held items do nothing. */
  magicRoom?: boolean;
  /** Defense and Sp. Def swapped. */
  wonderRoom?: boolean;
  me: SideCondition;
  opp: SideCondition;
  /** Turns left (counting the current one) for timed effects, e.g. "weather", "trickRoom", "opp.tailwind". */
  turns?: Record<string, number>;
  /**
   * Timed effects one of theirs set whose item isn't known, which last 8 turns rather than 5 if it holds the item that
   * stretches them (Light Clay, a weather rock, Terrain Extender), by the key of their timer: who set it and that item.
   * `past` once its 5th turn is over: up still, as it would be with the item (the game says when it ends).
   */
  mayLast?: Record<string, {slot: number; item: string; past?: boolean}>;
}

/** Everything the likelihood of an observation may depend on. */
export interface Snapshot {
  field: FieldCondition;
  /** keyed by monKey */
  mons: Record<string, MonCondition>;
  /** Team slots currently on the field (null = empty position). */
  active: Record<SideID, (number | null)[]>;
}

/**
 * Messages the game shows that reveal (or, by their absence, rule out) items.
 * On the defender: resist berry, Focus Sash, Weakness Policy, Sitrus Berry.
 * On the attacker: Life Orb recoil, Rocky Helmet (on my attacker after contact).
 */
export type Trigger = 'berry' | 'sash' | 'wp' | 'sitrus' | 'lifeorb' | 'helmet';

export type BoostID5 = 'atk' | 'def' | 'spa' | 'spd' | 'spe';

export interface HitResult {
  target: MonRef;
  /** Same units as MonCondition.hp for the target's side. */
  hpBefore: number;
  /** HP right after the hit, before any berry heal (unless `healed`). */
  hpAfter: number;
  /** hpAfter was read once its Sitrus Berry had healed it: the HP the screen settled on. */
  healed?: boolean;
  fainted: boolean;
  crit: boolean;
  triggers: Trigger[];
  /** Status the hit inflicted on the target. */
  status?: Status;
  /** Chance-based stat changes that happened to the target (guaranteed ones are automatic). */
  boosts?: Boosts;
  /** "It doesn't affect…": immune, so the calc must give 0 damage. */
  noEffect?: boolean;
  /** hpBefore was estimated, so allow a wider window for it. */
  beforeApprox?: boolean;
  /** Logged without reading the HP ("skip HP"): no damage evidence, the target's HP becomes unknown. */
  unread?: boolean;
  /** Its HP before this hit was unknown (an earlier hit went unread): the reading after only resyncs the HP. */
  beforeUnknown?: boolean;
  /**
   * Reaction to this move's stat drop (Defiant, Competitive, Clear Amulet, White Herb…).
   * undefined: not asked. null: asked, nothing shown (evidence too).
   */
  reaction?: string | null;
}

export interface ActionEvent {
  kind: 'action';
  id: string;
  turn: number;
  actor: MonRef;
  move: string;
  hits: HitResult[];
  /** Number of Pokémon the move targeted; spread damage is reduced when > 1. */
  targets: number;
  /** Multi-hit moves: how many times it hit. */
  hitCount?: number;
  helpingHand: boolean;
  actorTriggers: Trigger[];
  /** Status the actor picked up (e.g. burned by Flame Body after a contact move). */
  actorStatus?: Status;
  /** Chance-based stat changes that happened to the actor (Meteor Mash, Ancient Power…; guaranteed ones are automatic). */
  actorBoosts?: Boosts;
  /** The actor's HP read after its move (recoil, drain, Life Orb, Rocky Helmet): resyncs it. 0: it fainted. */
  actorHpAfter?: number;
  /** Targets of a non-damaging move (Spore, Parting Shot…). */
  targetRefs?: MonRef[];
  /** The move failed / was blocked (still counts for turn order and move reveal). */
  failed?: boolean;
  /**
   * A two-turn move's first turn (Electro Shot outside the rain, Meteor Beam, Fly…): it charged, its stat rise with it,
   * and hit nothing yet. The attack is its move the next turn.
   */
  charged?: boolean;
  /** A move beyond its one for the turn (an Instruct made it move again): not the start of a new turn. */
  again?: boolean;
  /** State right before this action. */
  before: Snapshot;
  /** Use this action's position in the turn for speed inference ("order unsure" turns it off). */
  ordered: boolean;
  /**
   * The game said Quick Claw / Quick Draw let it move first in its bracket.
   * undefined: not asked. null: asked, nothing shown (evidence too).
   */
  quick?: 'Quick Claw' | 'Quick Draw' | null;
  /**
   * Logged from the battle text: only the messages read count. Nothing was checked off, so a
   * message not read (Life Orb recoil, a berry…) is no evidence that it didn't appear.
   */
  narrated?: boolean;
}

export interface RevealEvent {
  kind: 'reveal';
  id: string;
  turn: number;
  mon: MonRef;
  what: 'item' | 'ability' | 'move' | 'tera' | 'forme';
  value: string;
  /** "does NOT have" instead of "has". */
  negate: boolean;
}

export interface SwitchEvent {
  kind: 'switch';
  id: string;
  turn: number;
  side: SideID;
  position: number;
  slotIn: number | null;
  slotOut: number | null;
}

export interface EndTurnEvent {
  kind: 'endTurn';
  id: string;
  turn: number;
}

/**
 * What the game showed at a moment when an ability or item would announce itself:
 * a Pokémon coming in (Intimidate, Drought, Pressure, Air Balloon…) or being hit by an
 * Intimidate (Defiant, Competitive, Clear Body, Clear Amulet, White Herb…).
 */
export interface CheckEvent {
  kind: 'check';
  id: string;
  turn: number;
  mon: MonRef;
  /** `terrain`: a terrain started with it out (its seed would have gone off). */
  context: 'entry' | 'intimidate' | 'terrain';
  /** The event that prompted it (a switch-in; for a terrain, its switch-in and the terrain). */
  about: string;
  /** The terrain up then: its seed would have gone off. */
  terrain?: Terrain;
  /** The weather and terrain up as it came in: an ability that would set them again (Drought in the sun) says nothing. */
  already?: {weather?: Weather; terrain?: Terrain};
  /** The ability or item named on screen; null when nothing was shown. */
  seen: string | null;
  seenKind?: 'ability' | 'item';
  /** Not looked at: resolves the prompt without evidence. */
  skipped?: boolean;
  /** What was seen had its effect on the board already (read off the screen before the prompt was answered). */
  applied?: boolean;
  /** State of the Pokémon at that moment. */
  mega: boolean;
  itemGone: boolean;
}

export type BattleEvent = (ActionEvent | RevealEvent | SwitchEvent | EndTurnEvent | CheckEvent) & {
  /** Live state right before this event, so it can be undone exactly. */
  undo?: {live: Snapshot; turn: number};
};

export interface BattleSettings {
  /**
   * How the opponent's HP is read:
   * 'game' – the % the game shows, using its exact rule (floor, minimum 1% while alive),
   * 'bar'  – eyeballed from a bar, within ±tolerance.
   * Battles saved with older mode names are read as 'game'.
   */
  hpMode: 'game' | 'bar';
  /** ± percentage points when hpMode is 'bar'. */
  tolerance: number;
}

export interface Battle {
  id: string;
  created: number;
  updated: number;
  formatId: string;
  label: string;
  myTeam: PokemonSet[];
  /** Opponent team-preview names (base species for Megas). */
  oppPreview: string[];
  /** Optional open team sheet: known item/ability/moves per opponent slot. */
  oppSheet?: (PokemonSet | null)[];
  /**
   * Their six as the screen reader read them at team preview (src/ui/autoBattle.ts): per slot, the other species it
   * might be, and whether the one taken stood out. The battle's text naming another corrects it.
   */
  oppRead?: {alts: string[]; sure: boolean}[];
  /** My team slots brought to this battle (all six if unset). */
  brought?: number[];
  events: BattleEvent[];
  live: Snapshot;
  turn: number;
  settings: BattleSettings;
  /**
   * Who predictions count as Mega Evolving where you said otherwise than they would (the switch
   * on the Mega note and your cards): theirs by slot (true: as Mega, false: as it is); yours, the
   * slot, or null for none.
   */
  megaPlan?: {opp?: Record<number, boolean>; me?: number | null};
}
