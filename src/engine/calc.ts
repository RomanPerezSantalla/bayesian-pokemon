/** Thin adapter between our battle model and @smogon/calc. */
import {Field, Move, Pokemon, calculate, type Result} from '@smogon/calc';
import {getFinalSpeed, getMoveEffectiveness} from '@smogon/calc/dist/mechanics/util';
import {STAT_IDS, isSpreadMove, move as dexMove, toID, type Gen} from '../data/dex';
import {moveFx} from './moves';
import {NO_ITEM, OTHER_ITEM} from './prior';
import type {FieldCondition, MonCondition, SideID} from './types';

export interface MonSpec {
  species: string;
  level: number;
  nature?: string;
  evs: ArrayLike<number>;
  ivs?: ArrayLike<number>;
  item?: string;
  ability?: string;
}

const QP = new Set(['Protosynthesis', 'Quark Drive']);
// Abilities the calc only applies when `abilityOn` is set. Intimidate is
// deliberately absent: its effect is already in the logged boosts.
const TOGGLED = new Set(['Flash Fire', 'Slow Start', 'Stakeout', 'Electromorphosis', 'Plus', 'Minus', 'Teraform Zero']);

const table = (v: ArrayLike<number>) => Object.fromEntries(STAT_IDS.map((s, i) => [s, v[i]]));

export function makePokemon(gen: Gen, spec: MonSpec, cond?: MonCondition, alliesFainted = 0, curHP?: number) {
  const ability = spec.ability;
  let item: string | undefined = spec.item;
  if (!item || item === NO_ITEM || item === OTHER_ITEM) item = undefined;
  const qp = !!ability && QP.has(ability);
  // A consumed Booster Energy keeps its boost until the holder leaves the field.
  if (cond?.itemGone && !(qp && item === 'Booster Energy' && cond.abilityOn)) item = undefined;

  let abilityOn = false;
  if (ability === 'Unburden') abilityOn = !!cond?.itemGone;
  else if (ability && TOGGLED.has(ability)) abilityOn = !!cond?.abilityOn;

  // Stance Change: Aegislash attacks, and is hit after attacking, as Aegislash-Blade (140 Attack, 50 defences).
  const species = cond?.blade && /^aegislash/.test(toID(spec.species)) ? 'Aegislash-Blade' : spec.species;
  const p = new Pokemon(gen, species, {
    level: spec.level,
    nature: spec.nature,
    evs: table(spec.evs),
    ivs: spec.ivs ? table(spec.ivs) : undefined,
    item,
    ability,
    abilityOn,
    boostedStat: qp ? 'auto' : undefined,
    boosts: cond?.boosts,
    status: cond?.status || '',
    teraType: cond?.tera as never,
    alliesFainted,
    curHP,
  } as ConstructorParameters<typeof Pokemon>[2]);
  return cond?.types ? retyped(p, cond.types) : p;
}

/** Moves the calc gives their charge's Sp. Atk rise in the hit itself. */
const CHARGE_RISE = new Set(['Electro Shot', 'Meteor Beam']);

/**
 * The attacker as the calc should see it for a hit the log has its stages for: Electro Shot and Meteor Beam's rise is
 * in them already (the game said "…'s Sp. Atk rose!"), and the calc adds it again (5 Oct: every Electro Shot was
 * taken at +2, and Archaludon's hits came out impossible).
 */
export function asLogged(attacker: Pokemon, move: Move): Pokemon {
  if (!CHARGE_RISE.has(move.name)) return attacker;
  const a = attacker.clone();
  a.boosts.spa = (a.boosts.spa ?? 0) - (a.hasAbility('Contrary') ? -1 : 1);
  return a;
}

/**
 * The Pokémon with these types (Protean, Soak…), in its copies too: the calc copies it for every calculation, from its
 * species merged over the dex's, which can't make two types one.
 */
function retyped(p: Pokemon, types: string[]): Pokemon {
  const t = types as Pokemon['types'];
  p.types = t;
  p.species = {...p.species, types: t};
  const copy = p.clone.bind(p);
  p.clone = () => retyped(copy(), types);
  return p;
}

export function makeField(
  gameType: 'singles' | 'doubles',
  field: FieldCondition,
  attackerSide: SideID,
  opts: {helpingHand?: boolean; fairyAura?: boolean; darkAura?: boolean} = {},
) {
  const side = (s: SideID, attacker: boolean) => ({
    isTailwind: field[s].tailwind,
    isReflect: field[s].reflect,
    isLightScreen: field[s].lightScreen,
    isAuroraVeil: field[s].auroraVeil,
    isFriendGuard: field[s].friendGuard,
    isHelpingHand: attacker && !!opts.helpingHand,
  });
  const defenderSide: SideID = attackerSide === 'me' ? 'opp' : 'me';
  return new Field({
    gameType: gameType === 'doubles' ? 'Doubles' : 'Singles',
    weather: field.weather,
    terrain: field.terrain,
    isGravity: field.gravity,
    isMagicRoom: !!field.magicRoom,
    isWonderRoom: !!field.wonderRoom,
    isFairyAura: opts.fairyAura,
    isDarkAura: opts.darkAura,
    attackerSide: side(attackerSide, true),
    defenderSide: side(defenderSide, false),
  } as ConstructorParameters<typeof Field>[0]);
}

/** `bp`: its base power as the battle so far makes it (see power.ts), where the calc's is its own. */
export function makeMove(gen: Gen, name: string, opts: {crit?: boolean; hits?: number; targets?: number; metronome?: number; bp?: number} = {}) {
  const overrides = {
    ...(isSpreadMove(gen, name) && (opts.targets ?? 2) < 2 ? {target: 'normal'} : {}),
    ...(opts.bp ? {basePower: opts.bp} : {}),
  };
  return new Move(gen, name, {
    isCrit: opts.crit,
    hits: opts.hits,
    // Uses of it just before, in a row: a Metronome holder hits harder each time.
    timesUsedWithMetronome: opts.metronome,
    overrides: (Object.keys(overrides).length ? overrides : undefined) as never,
  });
}

/** Damage → probability, convolving independent rolls for multi-hit moves. */
export function damageDistribution(damage: Result['damage']): Map<number, number> {
  if (typeof damage === 'number') return new Map([[damage, 1]]);
  const lists: number[][] = typeof damage[0] === 'number' ? [damage as number[]] : (damage as number[][]);
  let dist = new Map<number, number>([[0, 1]]);
  for (const rolls of lists) {
    const next = new Map<number, number>();
    const p = 1 / rolls.length;
    for (const [d, q] of dist) {
      for (const r of rolls) next.set(d + r, (next.get(d + r) ?? 0) + q * p);
    }
    dist = next;
  }
  return dist;
}

export interface DamageOutcome {
  dist: Map<number, number>;
  /** Final move type after Weather Ball, -ate abilities, Tera Blast etc. */
  moveType: string;
  /** The type multiplier the hit lands with (see landedEffectiveness). */
  effectiveness: number;
  maxHP: number;
}

/**
 * `times`: what the damage is multiplied by on top (2 on one open after its Glaive Rush). The game chains it with the
 * hit's other final modifiers before it rounds, so the product can be a point either side.
 */
export function runCalc(gen: Gen, attacker: Pokemon, defender: Pokemon, move: Move, field: Field, times = 1): DamageOutcome {
  const res = calculate(gen, attacker, defender, move, field);
  let dist = damageDistribution(res.damage);
  if (times !== 1) {
    const scaled = new Map<number, number>();
    const add = (d: number, p: number) => scaled.set(d, (scaled.get(d) ?? 0) + p);
    for (const [d, p] of dist) {
      if (d <= 0) add(d, p);
      else for (const [k, q] of [[-1, 0.25], [0, 0.5], [1, 0.25]]) add(d * times + k, p * q);
    }
    dist = scaled;
  }
  return {
    dist,
    moveType: res.move.type,
    effectiveness: landedEffectiveness(gen, res),
    maxHP: defender.maxHP(),
  };
}

/**
 * The type multiplier as the calc applies it (its gen 7–9 rules), not the chart alone: Scrappy and
 * Mind's Eye hit Ghosts with Normal and Fighting moves (Mega Lopunny's Close Combat on Froslass is
 * ×2, not ×0), Gravity and an Iron Ball ground, Ring Target, Thousand Arrows, Freeze-Dry, Flying
 * Press, Strong Winds. For the move as it lands, on the defender as the calc had it.
 */
export function landedEffectiveness(gen: Gen, res: Result): number {
  const {attacker, defender, move, field} = res;
  const revealed = attacker.hasAbility('Scrappy') || attacker.hasAbility('Mind\'s Eye') || field.defenderSide.isForesight;
  const ring = defender.hasItem('Ring Target') && !defender.hasAbility('Klutz');
  const one = (type: string) => getMoveEffectiveness(gen, move, type as never, revealed, field.isGravity, ring);
  let eff = defender.teraType && defender.teraType !== ('Stellar' as never)
    ? one(defender.teraType)
    : defender.types.reduce((e, t) => e * one(t), 1);
  if (eff === 0 && move.hasType('Ground') && defender.hasItem('Iron Ball') && !defender.hasAbility('Klutz')) eff = 1;
  if (eff === 0 && move.named('Thousand Arrows')) eff = 1;
  const flying = (gen.types.get(toID(move.type))?.effectiveness as Record<string, number> | undefined)?.Flying ?? 1;
  if (field.hasWeather('Strong Winds') && defender.hasType('Flying') && flying > 1) eff /= 2;
  return eff;
}

export function typeEffectiveness(gen: Gen, moveType: string, defTypes: readonly string[]) {
  const t = gen.types.get(toID(moveType));
  if (!t) return 1;
  let eff = 1;
  for (const d of defTypes) eff *= (t.effectiveness as Record<string, number>)[d] ?? 1;
  return eff;
}

export function finalSpeed(gen: Gen, mon: Pokemon, field: Field) {
  return getFinalSpeed(gen, mon, field, field.attackerSide);
}

/**
 * Move priority including ability-based modifiers. The calc has only the positive priorities;
 * the negative ones (Trick Room −7, Roar −6, Counter −5, Avalanche −4…) come from the move table.
 */
export function movePriority(gen: Gen, moveName: string, ability: string | undefined, hpFull: boolean, field: FieldCondition) {
  const m = dexMove(gen, moveName);
  if (!m) return 0;
  const fx = moveFx(m.name);
  let p = m.priority ?? fx.pr ?? 0;
  const status = m.category === 'Status' || (!m.category && !m.basePower);
  if (ability === 'Prankster' && status) p += 1;
  if (ability === 'Gale Wings' && m.type === 'Flying' && hpFull) p += 1;
  // Moves that heal (the draining ones too), as Showdown flags them.
  if (ability === 'Triage' && fx.heal) p += 3;
  if (m.id === 'grassyglide' && field.terrain === 'Grassy') p += 1;
  return p;
}

/** The chance Quick Draw / Quick Claw lets this move go first in its bracket (Quick Draw rolls first). */
export function quickChances(gen: Gen, moveName: string, ability: string | undefined, item: string | undefined): {draw: number; claw: number} {
  const m = dexMove(gen, moveName);
  const status = !m || m.category === 'Status' || (!m.category && !m.basePower);
  const draw = ability === 'Quick Draw' && !status ? 0.3 : 0;
  const claw = item === 'Quick Claw' && !(status && ability === 'Mycelium Might') ? (1 - draw) * 0.2 : 0;
  return {draw, claw};
}

/**
 * Order inside a priority bracket, as a fraction of a priority step: first when Quick Claw
 * or Quick Draw fired (the game says so), always last with Stall or Lagging Tail. Unlike
 * Speed, these aren't reversed by Trick Room.
 */
export function fractionalPriority(gen: Gen, moveName: string, ability: string | undefined, item: string | undefined, quick: boolean) {
  if (quick) return 0.1;
  const m = dexMove(gen, moveName);
  const status = !!m && (m.category === 'Status' || (!m.category && !m.basePower));
  if (ability === 'Stall' || item === 'Lagging Tail' || item === 'Full Incense' || (ability === 'Mycelium Might' && status)) return -0.1;
  return 0;
}
