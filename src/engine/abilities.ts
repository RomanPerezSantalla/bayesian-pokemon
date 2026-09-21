/** Abilities and items that announce themselves on screen, and what their reactions do. */
import type {Boosts} from './types';

/** Always named on screen as the Pokémon comes in, so no banner rules them out. */
export const ENTRY_ANNOUNCE = new Set([
  'Intimidate', 'Drought', 'Drizzle', 'Sand Stream', 'Snow Warning', 'Electric Surge', 'Grassy Surge',
  'Psychic Surge', 'Misty Surge', 'Pressure', 'Mold Breaker', 'Teravolt', 'Turboblaze', 'Unnerve', 'Air Lock',
  'Cloud Nine', 'Fairy Aura', 'Dark Aura', 'Aura Break', 'Neutralizing Gas', 'Sword of Ruin', 'Beads of Ruin',
  'Tablets of Ruin', 'Vessel of Ruin', 'Download', 'Intrepid Sword', 'Dauntless Shield', 'Slow Start', 'Comatose',
  'As One (Glastrier)', 'As One (Spectrier)', 'Frisk', 'Forewarn',
]);
export const ENTRY_ITEMS = new Set(['Air Balloon']);

/** Named on screen when the Pokémon is hit by an Intimidate. */
export const INTIMIDATE_REACT = new Set([
  'Defiant', 'Competitive', 'Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Mirror Armor',
  'Oblivious', 'Own Tempo', 'Inner Focus', 'Scrappy', 'Guard Dog', 'Rattled',
]);
export const INTIMIDATE_REACT_ITEMS = new Set(['Clear Amulet', 'White Herb', 'Adrenaline Orb']);

/** Named on screen when a foe's move lowers the Pokémon's stats. */
export const DROP_REACT = new Set(['Defiant', 'Competitive', 'Clear Body', 'White Smoke', 'Full Metal Body', 'Mirror Armor']);
export const DROP_REACT_ITEMS = new Set(['Clear Amulet', 'White Herb']);

const BLOCKERS = new Set([
  'Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Mirror Armor', 'Oblivious', 'Own Tempo',
  'Inner Focus', 'Scrappy', 'Clear Amulet',
]);

const negate = (b: Boosts): Boosts => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, -(v ?? 0)]));

/** Stat changes a reaction adds on top of a drop that was already applied (`drop`). */
export function reactionEffect(name: string, drop: Boosts): {boosts: Boosts; itemGone?: boolean} {
  if (name === 'Defiant') return {boosts: {atk: 2}};
  if (name === 'Competitive') return {boosts: {spa: 2}};
  if (name === 'Guard Dog') return {boosts: {...negate(drop), atk: 1 - (drop.atk ?? 0)}};
  if (name === 'Rattled') return {boosts: {spe: 1}};
  if (name === 'Adrenaline Orb') return {boosts: {spe: 1}, itemGone: true};
  if (name === 'White Herb') return {boosts: negate(drop), itemGone: true};
  if (BLOCKERS.has(name)) return {boosts: negate(drop), itemGone: name === 'Clear Amulet' ? false : undefined};
  return {boosts: {}};
}

/** Likelihood of what was shown (or not) given the Pokémon's ability and item. */
export function announceLikelihood(
  seen: string | null, ability: string, item: string, abilities: Set<string>, items: Set<string>,
): number {
  if (seen) return ability === seen || item === seen ? 1 : 0;
  return abilities.has(ability) || items.has(item) ? 0 : 1;
}
