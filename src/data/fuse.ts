/**
 * Fuse the official in-game Battle Data (primary: it *is* the ladder you play)
 * with Smogon's Showdown stats (secondary: structure the in-game data lacks).
 *
 * The in-game data is per base species with top-10 lists. Showdown's stats are per
 * Mega forme with full distributions and a joint alignment+spread table. So:
 *  - formes come from which Mega Stones are held (Charizardite Y 94% -> Mega Y 94%),
 *  - per-forme moves/spreads are the official ones tilted by how Showdown players of
 *    that forme differ from the species average,
 *  - each official spread gets alignments from Showdown's joint table when known,
 *    otherwise from the official alignment list filtered by what makes sense.
 */
import {getGen, natureMods, toID, STAT_IDS, type Gen} from './dex';
import type {Dist, FormatData, FormatInfo, SpeciesStats} from './format';
import type {OfficialEntry, OfficialSnapshot} from './official';

export interface Structure {
  smogonId: string;
  month: string;
  cutoff: number;
  battles: number;
  species: Record<string, SpeciesStats>;
  preview: Record<string, string[]>;
}

const ALIASES: Record<string, string> = {Aegislash: 'Aegislash-Shield'};

const spKey = (sp: ArrayLike<number>) => Array.from(sp).join('/');
const norm = (list: Dist): Dist => {
  const t = list.reduce((s, [, p]) => s + p, 0) || 1;
  return list.map(([n, p]) => [n, p / t]);
};

/** How plausible an alignment is for a spread when nobody told us. */
function alignmentFit(gen: Gen, nature: string, sp: number[]) {
  const [up, down] = natureMods(gen, nature);
  if (!up || !down) return 0.3;
  const u = STAT_IDS.indexOf(up);
  const d = STAT_IDS.indexOf(down);
  let c = 1;
  if (sp[d] >= 12) c *= 0.03;
  if (sp[u] >= 12) c *= 4;
  else if (up !== 'spe' && sp[u] === 0) c *= 0.3;
  return c;
}

function formesOf(gen: Gen, name: string, items: Dist): {base: string; megas: [string, string, number][]} {
  const dex = gen.species.get(toID(ALIASES[name] ?? name));
  const megas: [string, string, number][] = [];
  let base: string | undefined = dex?.name;
  for (const [item, p] of items) {
    const stone = gen.items.get(toID(item))?.megaStone as Record<string, string> | undefined;
    if (!stone) continue;
    const key = (base && (stone[base] ? base : dex?.baseSpecies && stone[dex.baseSpecies] ? dex.baseSpecies : undefined))
      ?? Object.keys(stone)[0];
    base ??= key;
    const forme = stone[key];
    if (forme && gen.species.get(toID(forme))) megas.push([forme, item, p]);
  }
  return {base: base ?? name, megas};
}

function lift<T>(
  structure: Structure, group: string[], forme: string, values: (s: SpeciesStats) => Map<T, number>,
): (x: T) => number {
  const present = group.filter(g => structure.species[g]);
  if (present.length < 2 || !structure.species[forme]) return () => 1;
  const own = values(structure.species[forme]);
  const mix = new Map<T, number>();
  let total = 0;
  for (const g of present) {
    const w = structure.species[g].weight;
    total += w;
    for (const [k, v] of values(structure.species[g])) mix.set(k, (mix.get(k) ?? 0) + w * v);
  }
  return x => ((own.get(x) ?? 0) + 0.03) / ((mix.get(x) ?? 0) / total + 0.03);
}

function officialStatMarginals(spreads: [string, number[], number][]): [number, number][][] {
  return STAT_IDS.map((_, i) => {
    const m = new Map<number, number>();
    for (const [, sp, p] of spreads) m.set(sp[i], (m.get(sp[i]) ?? 0) + p);
    const t = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    // Smooth over every legal value so the sampled tail can reach anything.
    for (let v = 0; v <= 32; v++) m.set(v, 0.85 * ((m.get(v) ?? 0) / t) + 0.15 / 33);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, p]) => [k, Number(p.toPrecision(3))] as [number, number]);
  });
}

function fuseEntry(
  gen: Gen, structure: Structure, name: string, e: OfficialEntry, out: Record<string, SpeciesStats>,
): string[] {
  const known = <T extends {name: string}>(store: {get(id: string): T | undefined}, n: string) => store.get(toID(n))?.name;
  // Shares come rounded to 0.1%: one listed at 0.0% was seen in ranked play, just rarely. Never impossible.
  const share = (p: number) => Math.max(p, 0.025) / 100;
  const items: Dist = e.held_item.map(([n, p]) => [known(gen.items, n), share(p)] as [string | undefined, number])
    .filter((x): x is [string, number] => !!x[0]);
  const {base, megas} = formesOf(gen, name, items);
  const stoneItems = new Set(megas.map(([, item]) => item));
  const megaMass = megas.reduce((s, [, , p]) => s + p, 0);
  const baseW = Math.max(0.005, 1 - megaMass);
  const group = structure.preview[name] ?? structure.preview[base] ?? [];

  const moves: Dist = e.move.map(([n, p]) => [known(gen.moves, n), share(p)] as [string | undefined, number])
    .filter((x): x is [string, number] => !!x[0]);
  const minOfficialMove = moves.length ? Math.min(...moves.map(([, p]) => p)) : 0.05;
  const abilities: Dist = norm(e.ability.map(([n, p]) => [known(gen.abilities, n), share(p)] as [string | undefined, number])
    .filter((x): x is [string, number] => !!x[0]));
  const natures: Dist = norm(e.stat_alignment.map(([n, p]) => [n, share(p)]));

  // Joint alignment+spread from Showdown for this species (all formes pooled).
  const joint = new Map<string, Map<string, number>>();
  for (const g of group) {
    const sd = structure.species[g];
    if (!sd) continue;
    for (const [nature, sp, p] of sd.spreads) {
      const m = joint.get(spKey(sp)) ?? new Map<string, number>();
      m.set(nature, (m.get(nature) ?? 0) + p * sd.weight);
      joint.set(spKey(sp), m);
    }
  }
  const officialSpreads = e.stat_points.filter(r => r.length >= 7).map(r => [r.slice(1, 7), r[0] / 100] as [number[], number]);

  const formes: [string, number][] = [[base, baseW], ...megas.map(([f, , p]) => [f, p] as [string, number])];
  const names: string[] = [];
  for (const [forme, w] of formes) {
    const dex = gen.species.get(toID(forme));
    if (!dex) continue;
    const isMega = forme !== base;
    const sd = structure.species[forme];

    const moveLift = lift(structure, group, forme, s => new Map(s.moves.map(([m, p]) => [m, p])));
    const fMoves: Dist = moves.map(([m, p]) => [m, Math.min(0.995, p * moveLift(m))]);
    for (const [m, p] of sd?.moves ?? []) {
      if (!fMoves.some(([x]) => x === m)) fMoves.push([m, Math.min(p, minOfficialMove) * 0.7]);
    }

    const fItems: Dist = isMega
      ? [[megas.find(([f]) => f === forme)![1], 1]]
      : items.filter(([i]) => !stoneItems.has(i)).map(([i, p]) => [i, p / baseW]);
    const itemsOther = isMega ? 0 : Math.max(0, 1 - fItems.reduce((s, [, p]) => s + p, 0));

    // The in-game data lists abilities as seen on entry: for a Mega that's its pre-Mega ability.
    // (The Mega's own ability is fixed by the forme; the prior adds it.)
    const fAbilities: Dist = abilities;

    const spreadLift = lift(structure, group, forme, s => {
      const m = new Map<string, number>();
      for (const [, sp, p] of s.spreads) m.set(spKey(sp), (m.get(spKey(sp)) ?? 0) + p);
      return m;
    });
    const spreads: [string, number[], number][] = [];
    let covered = 0;
    for (const [sp, p0] of officialSpreads) {
      const p = p0 * spreadLift(spKey(sp));
      covered += p;
      const seen = joint.get(spKey(sp));
      let pairs: Dist = seen && seen.size
        ? [...seen.entries()]
        : natures.map(([n, q]) => [n, (q + 0.001) * alignmentFit(gen, n, sp)]);
      pairs = norm(pairs).filter(([, q]) => q >= 0.02);
      for (const [n, q] of norm(pairs)) spreads.push([n, sp, p * q]);
    }
    // Rescale so the head keeps the official share of the whole distribution.
    const headShare = officialSpreads.reduce((s, [, p]) => s + p, 0);
    const scale = covered > 0 ? headShare / covered : 1;
    for (const s of spreads) s[2] *= scale;
    // The official list stops at 10; Showdown's fuller list shapes most of the rest.
    let extraMass = 0;
    const pool = sd ? [sd] : group.map(g => structure.species[g]).filter((x): x is SpeciesStats => !!x);
    const seen = new Set(spreads.map(([n, sp]) => `${n}:${spKey(sp)}`));
    const extra = pool.flatMap(x => x.spreads).filter(([n, sp]) => !seen.has(`${n}:${spKey(sp)}`));
    const extraTotal = extra.reduce((t, [, , p]) => t + p, 0);
    if (officialSpreads.length && extraTotal > 0) {
      extraMass = (1 - headShare) * 0.75;
      for (const [n, sp, p] of extra) spreads.push([n, sp, (p / extraTotal) * extraMass]);
    }

    const useOfficialSpreads = officialSpreads.length > 0 || !sd;
    out[forme] = {
      usage: 1 / e.position,
      weight: w * 1000,
      abilities: fAbilities,
      items: fItems,
      itemsOther,
      moves: fMoves,
      spreads: useOfficialSpreads ? spreads : sd!.spreads,
      spreadsCovered: useOfficialSpreads ? Math.min(0.98, headShare + extraMass) : sd!.spreadsCovered,
      statMarginals: sd?.statMarginals ?? officialStatMarginals(spreads),
      natures: natures.length ? natures.map(([n, p]) => [n, p] as [string, number]) : sd?.natures ?? [],
      teammates: sd?.teammates ?? [],
    };
    names.push(forme);
  }
  return names;
}

export function fuse(info: FormatInfo, structure: Structure, official: OfficialSnapshot | null): FormatData {
  const gen = getGen(info.gen);
  const species: Record<string, SpeciesStats> = {};
  const preview: Record<string, string[]> = {};
  const previewUsage: Record<string, number> = {};

  if (official) {
    for (const [name, entry] of Object.entries(official.pokemon)) {
      const formes = fuseEntry(gen, structure, name, entry, species);
      if (!formes.length) continue;
      preview[name] = formes.sort((a, b) => species[b].weight - species[a].weight);
      previewUsage[name] = 1 / entry.position;
    }
  }
  // Anything only Showdown has (or everything, when offline on first run).
  for (const [name, formes] of Object.entries(structure.preview)) {
    if (preview[name]) continue;
    preview[name] = formes;
    for (const f of formes) species[f] ??= structure.species[f];
    previewUsage[name] = formes.reduce((s, f) => s + (structure.species[f]?.usage ?? 0), 0) * (official ? 0.001 : 1);
  }
  return {
    ...info,
    species,
    preview,
    previewUsage,
    sources: {
      official: official ? {season: official.season, date: official.date} : null,
      structure: {smogonId: structure.smogonId, month: structure.month, cutoff: structure.cutoff, battles: structure.battles},
    },
  };
}
