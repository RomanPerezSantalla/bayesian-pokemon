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

export interface HitResult {
  target: MonRef;
  /** Same units as MonCondition.hp for the target's side. */
  hpBefore: number;
  /** HP right after the hit, before any berry heal. */
  hpAfter: number;
  fainted: boolean;
  crit: boolean;
  triggers: Trigger[];
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
  /** State right before this action. */
  before: Snapshot;
  /** Use this action's position in the turn for speed inference. */
  ordered: boolean;
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

export type BattleEvent = ActionEvent | RevealEvent | SwitchEvent;

export interface BattleSettings {
  /** 'showdown': HP% shown exactly as Showdown rounds it. 'approx': eyeballed from an HP bar. */
  hpMode: 'showdown' | 'approx';
  /** ± percentage points when hpMode is 'approx'. */
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
  events: BattleEvent[];
  live: Snapshot;
  turn: number;
  settings: BattleSettings;
}
