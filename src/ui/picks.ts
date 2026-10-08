import {species as dexSpecies, toID, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';

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

/**
 * Map any species name (including Mega formes) to the name shown at team preview. `prefix`: a name that begins one
 * of the format's (typing "Lycan" for Lycanroc-Dusk) is that one.
 */
export function toPreviewName(fmt: FormatData, gen: Gen, raw: string, {prefix = true} = {}): string | null {
  const name = raw.trim().replace(/,.*$/, '').replace(/\*$/, '').trim();
  if (!name) return null;
  const id = toID(name);
  for (const [preview, formes] of Object.entries(fmt.preview)) {
    if (toID(preview) === id || formes.some(f => toID(f) === id)) return preview;
  }
  const prefixed = !prefix ? [] : Object.keys(fmt.preview).filter(p => toID(p).startsWith(id))
    .sort((a, b) => (fmt.previewUsage[b] ?? 0) - (fmt.previewUsage[a] ?? 0));
  if (prefixed.length) return prefixed[0];
  const sp = dexSpecies(gen, name);
  if (!sp) return null;
  return /-Mega/.test(sp.name) && sp.baseSpecies ? sp.baseSpecies : sp.name;
}
