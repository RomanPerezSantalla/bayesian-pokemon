/** Thin adapter between our battle model and @smogon/calc. */
import {Field, Move, Pokemon, calculate, type Result} from '@smogon/calc';
import {getFinalSpeed} from '@smogon/calc/dist/mechanics/util';
import {STAT_IDS, isSpreadMove, move as dexMove, toID, type Gen} from '../data/dex';
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

  return new Pokemon(gen, spec.species, {
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
    isFairyAura: opts.fairyAura,
    isDarkAura: opts.darkAura,
    attackerSide: side(attackerSide, true),
    defenderSide: side(defenderSide, false),
  } as ConstructorParameters<typeof Field>[0]);
}

export function makeMove(gen: Gen, name: string, opts: {crit?: boolean; hits?: number; targets?: number} = {}) {
  const overrides = isSpreadMove(gen, name) && (opts.targets ?? 2) < 2 ? {target: 'normal'} : undefined;
  return new Move(gen, name, {
    isCrit: opts.crit,
    hits: opts.hits,
    overrides: overrides as never,
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
  effectiveness: number;
  maxHP: number;
}

export function runCalc(gen: Gen, attacker: Pokemon, defender: Pokemon, move: Move, field: Field): DamageOutcome {
  const res = calculate(gen, attacker, defender, move, field);
  const moveType = res.move.type;
  return {
    dist: damageDistribution(res.damage),
    moveType,
    effectiveness: typeEffectiveness(gen, moveType, defender.teraType && defender.teraType !== ('Stellar' as never)
      ? [defender.teraType] : defender.types),
    maxHP: defender.maxHP(),
  };
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

const HEALING = new Set([
  'drainpunch', 'drainingkiss', 'gigadrain', 'hornleech', 'leechlife', 'paraboliccharge', 'oblivionwing', 'roost',
  'recover', 'softboiled', 'synthesis', 'moonlight', 'morningsun', 'slackoff', 'milkdrink', 'healorder', 'shoreup',
  'strengthsap', 'lifedew', 'junglehealing', 'floralhealing', 'healpulse', 'wish', 'rest', 'absorb', 'megadrain',
  'bitterblade', 'matchagotcha', 'lunarblessing', 'swallow', 'purify', 'drainingkiss', 'dreameater',
]);

/** Move priority including ability-based modifiers. */
export function movePriority(gen: Gen, moveName: string, ability: string | undefined, hpFull: boolean, field: FieldCondition) {
  const m = dexMove(gen, moveName);
  if (!m) return 0;
  let p = m.priority ?? 0;
  const status = m.category === 'Status' || (!m.category && !m.basePower);
  if (ability === 'Prankster' && status) p += 1;
  if (ability === 'Gale Wings' && m.type === 'Flying' && hpFull) p += 1;
  if (ability === 'Triage' && HEALING.has(m.id)) p += 3;
  if (m.id === 'grassyglide' && field.terrain === 'Grassy') p += 1;
  return p;
}
