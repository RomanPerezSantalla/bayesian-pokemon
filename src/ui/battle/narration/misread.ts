/**
 * Their six as read off team preview can be wrong (an icon taken for another of the same colours): the battle's text
 * naming one of theirs that isn't among them says so. Later says wins: it goes in place of one the battle hasn't shown
 * yet (one read as possibly it, else one of its types, else one not read surely, else any), and the line is then
 * read again with it there. A battle that knows fewer than six of theirs (team preview missed) adds it instead.
 */
import {toID, writtenName, type Gen} from '../../../data/dex';
import {defaultCondition} from '../../../engine/likelihood';
import type {Battle, MonRef} from '../../../engine/types';
import {norm, rankAt, squash, type Named} from './text';

/** A name read this alike to a species' is it… */
const SURE = 0.85;
/** …if it's this much closer to it than to any of their six. */
const AHEAD = 0.1;

/** Their Pokémon the battle has shown: out now, or in anything logged. */
export function seenTheirs(b: Battle): Set<number> {
  const seen = new Set<number>(b.live.active.opp.filter((s): s is number => s !== null));
  const add = (r?: MonRef) => r?.side === 'opp' && seen.add(r.slot);
  for (const e of b.events) {
    if (e.kind === 'switch') {
      if (e.side === 'opp' && e.slotIn !== null) seen.add(e.slotIn);
    } else if (e.kind === 'action') {
      add(e.actor);
      for (const t of e.targetRefs ?? []) add(t);
    } else if (e.kind === 'reveal' || e.kind === 'check') {
      add(e.mon);
    }
  }
  return seen;
}

/**
 * One of theirs named in a line of the game's text ("The opposing Raichu used…", "Kim sent out Raichu and Sylveon!")
 * that isn't among their six: the species, and the slot it must be instead. `species`: every species there is.
 */
export function misread(b: Battle, gen: Gen, species: readonly string[], text: string): {slot: number; name: string} | null {
  const words = norm(text).split(' ').filter(Boolean);
  const at: number[] = [];
  words.forEach((w, i) => {
    if (w === 'opposing') at.push(i + 1);
    if (w === 'out' && words[i - 1] === 'sent') {
      at.push(i + 1);
      const and = words.indexOf('and', i + 1);
      if (and > 0) at.push(and + 1);
    }
  });
  if (!at.length) return null;
  // The game writes a species' own name, a forme's too ("Raichu" for Alolan Raichu, "Floette" for Floette-Eternal): those
  // are compared.
  const base = (name: string) => writtenName(gen, name);
  const named = (list: readonly string[]): Named<string>[] => [...new Set(list.map(base))].map(n => ({key: squash(n), value: n}));
  const all = named(species);
  const six = named(b.oppPreview);
  const theirs = new Set(six.map(n => n.value));
  for (const i of at) {
    const [top] = rankAt(words, i, all);
    if (!top || top.score < SURE || theirs.has(top.value)) continue;
    const near = rankAt(words, i, six)[0];
    if (near && top.score - near.score < AHEAD) continue;
    const slot = slotFor(b, gen, speciesOf(gen, species, top.value), base);
    if (slot) return slot;
  }
  return null;
}

/** The species a name as written is: itself where it's one ("Ninetales"), else its forme that is (Floette-Eternal), not a Mega. */
function speciesOf(gen: Gen, species: readonly string[], name: string): string {
  if (gen.species.get(toID(name))) return name;
  return species.find(s => writtenName(gen, s) === name && !/-(Mega|Gmax)/.test(s)) ?? name;
}

/** Where one named that isn't among their six goes (see the top), as which forme. */
function slotFor(b: Battle, gen: Gen, name: string, base: (n: string) => string): {slot: number; name: string} | null {
  // Not all six known: one more of them.
  if (b.oppPreview.length < 6) return {slot: b.oppPreview.length, name};
  const seen = seenTheirs(b);
  const open = b.oppPreview.map((_, k) => k).filter(k => !seen.has(k));
  if (!open.length) return null;
  // Read as possibly it: the forme it was read as.
  for (const k of open) {
    const alt = b.oppRead?.[k]?.alts.find(a => base(a) === base(name));
    if (alt) return {slot: k, name: alt};
  }
  const types = (n: string) => gen.species.get(toID(n))?.types.join('/') ?? '';
  const k = open.find(j => types(b.oppPreview[j]) === types(name))
    ?? open.find(j => b.oppRead?.[j] && !b.oppRead[j].sure)
    ?? open[0];
  return {slot: k, name};
}

/** The battle with one of their six put right (or, one past those known, added). */
export function putRight(b: Battle, slot: number, name: string): Battle {
  const oppPreview = b.oppPreview.map((n, k) => (k === slot ? name : n));
  const added = slot === b.oppPreview.length;
  if (added) oppPreview.push(name);
  return {
    ...b,
    oppPreview,
    ...(b.oppRead ? {oppRead: added ? [...b.oppRead, {alts: [], sure: true}] : b.oppRead.map((r, k) => (k === slot ? {alts: [], sure: true} : r))} : {}),
    ...(added ? {live: {...b.live, mons: {...b.live.mons, [`opp${slot}`]: defaultCondition(100)}}} : {}),
    label: b.label.startsWith('vs ') ? `vs ${oppPreview.slice(0, 3).join(', ')}` : b.label,
  };
}
