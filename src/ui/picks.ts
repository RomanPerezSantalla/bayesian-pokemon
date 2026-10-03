import {toID, type Gen} from '../data/dex';

function speciesOf(gen: Gen, name: string): string {
  const sp = gen.species.get(toID(name));
  return sp ? toID(sp.baseSpecies ?? sp.name) : toID(name);
}

/**
 * Their picks at team preview with `name` added. Another forme of one already there replaces it, never joins it: a
 * team has one of each species (Species Clause), so "Goodra", then "Goodra-Hisui", or the other way round, is going
 * back on it.
 */
export function addTheirs(theirs: readonly string[], name: string, gen: Gen): {theirs: string[]; said?: string; note?: string} {
  if (theirs.includes(name)) return {theirs: [...theirs], note: `${name} is in already`};
  const k = theirs.findIndex(t => speciesOf(gen, t) === speciesOf(gen, name));
  if (k >= 0) return {theirs: [...theirs.filter((_, j) => j !== k), name], said: `${theirs[k]} → ${name}`};
  if (theirs.length >= 6) return {theirs: [...theirs], note: `their six are in already, not ${name}`};
  return {theirs: [...theirs, name], said: name};
}
