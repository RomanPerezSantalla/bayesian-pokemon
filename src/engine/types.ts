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
}

export type Weather = 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Harsh Sunshine' | 'Heavy Rain' | 'Strong Winds';
export type Terrain = 'Electric' | 'Grassy' | 'Psychic' | 'Misty';

export interface SideCondition {
  tailwind: boolean;
  reflect: boolean;
  lightScreen: boolean;
  auroraVeil: boolean;
  friendGuard: boolean;
}

export interface FieldCondition {
  weather?: Weather;
  terrain?: Terrain;
  trickRoom: boolean;
  gravity: boolean;
  me: SideCondition;
  opp: SideCondition;
  /** Turns left (counting the current one) for timed effects, e.g. "weather", "trickRoom", "opp.tailwind". */
  turns?: Record<string, number>;
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
  /** HP right after the hit, before any berry heal. */
  hpAfter: number;
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
  /** Targets of a non-damaging move (Spore, Parting Shot…). */
  targetRefs?: MonRef[];
  /** The move failed / was blocked (still counts for turn order and move reveal). */
  failed?: boolean;
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
   * Logged by voice: only the messages said count. Nothing was checked off, so a message not
   * mentioned (Life Orb recoil, a berry…) is no evidence that it didn't appear.
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
  context: 'entry' | 'intimidate';
  /** The event that prompted it (a switch-in). */
  about: string;
  /** The ability or item named on screen; null when nothing was shown. */
  seen: string | null;
  seenKind?: 'ability' | 'item';
  /** Not looked at: resolves the prompt without evidence. */
  skipped?: boolean;
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
  /** My team slots brought to this battle (all six if unset). */
  brought?: number[];
  events: BattleEvent[];
  live: Snapshot;
  turn: number;
  settings: BattleSettings;
}
