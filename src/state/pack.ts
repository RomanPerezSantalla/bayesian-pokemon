/**
 * The saved form of a battle. In memory every logged entry keeps whole copies of the battle
 * state (for undo, and for what the inference saw when it happened); saved, each copy is just
 * what changed since the one before, which makes a battle about ten times smaller. Unpacking
 * gives back exactly the battle that was packed, down to the key order.
 */
import type {Battle, BattleEvent, Snapshot} from '../engine/types';

/** A place in a snapshot and the value it takes there; the empty path replaces the whole. */
type Op = [path: string[], value: unknown];

/** A logged entry as saved: `undo` and `before` hold changes instead of snapshots. */
type PackedEvent = Record<string, unknown> & {
  undo?: {changes: Op[]; turn: number};
  before?: Op[];
};

export interface PackedBattle extends Omit<Battle, 'events' | 'live'> {
  packed: 1;
  events: PackedEvent[];
  /** The live state, as changes from the last entry's undo state. */
  live: Op[];
}

/** What lists show, without loading the whole battle. */
export interface BattleInfo {
  id: string;
  label: string;
  formatId: string;
  turn: number;
  entries: number;
  created: number;
  updated: number;
}

export const battleInfo = (b: Battle | PackedBattle): BattleInfo => ({
  id: b.id, label: b.label, formatId: b.formatId, turn: b.turn, entries: b.events.length, created: b.created, updated: b.updated,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** Equal, with objects' keys in the same order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return sameKeys(ka, Object.keys(b)) && ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * The changes that turn `a` into `b`. An object whose keys changed is replaced whole, which keeps
 * key order exact; so is one where a value became undefined, which JSON (a backup file) can't hold.
 */
export function diff(a: unknown, b: unknown, path: string[] = [], out: Op[] = []): Op[] {
  if (same(a, b)) return out;
  if (isObject(a) && isObject(b) && sameKeys(Object.keys(a), Object.keys(b)) && !Object.keys(b).some(k => b[k] === undefined)) {
    for (const k of Object.keys(b)) diff(a[k], b[k], [...path, k], out);
  } else {
    out.push([path, b]);
  }
  return out;
}

/** A fresh copy of `base` with the changes applied. */
export function patch<T>(base: T | undefined, changes: Op[]): T {
  let out: unknown = structuredClone(base);
  for (const [path, value] of changes) {
    if (!path.length) {
      out = structuredClone(value);
      continue;
    }
    let o = out as Record<string, unknown>;
    for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>;
    o[path[path.length - 1]] = structuredClone(value);
  }
  return out as T;
}

export const isPackedBattle = (x: unknown): x is PackedBattle =>
  isObject(x) && x.packed === 1 && typeof x.id === 'string' && Array.isArray(x.events) && Array.isArray(x.live);

export function packBattle(b: Battle): PackedBattle {
  // Each undo state is saved as the changes from the previous one (the first in full).
  let prev: Snapshot | undefined;
  const events = b.events.map(ev => {
    // Replaced in place, so the keys keep their order.
    const out = {...ev} as unknown as PackedEvent;
    if (ev.undo) {
      out.undo = {changes: diff(prev, ev.undo.live), turn: ev.undo.turn};
      prev = ev.undo.live;
    }
    // What the inference saw: the same as the undo state, nearly always.
    if (ev.kind === 'action' && ev.before) out.before = diff(ev.undo?.live ?? prev, ev.before);
    return out;
  });
  return {...b, events, live: diff(prev, b.live), packed: 1};
}

export function unpackBattle(p: PackedBattle): Battle {
  let prev: Snapshot | undefined;
  const events = p.events.map(pe => {
    const ev = {...pe} as unknown as BattleEvent;
    if (pe.undo) {
      prev = patch(prev, pe.undo.changes);
      ev.undo = {live: prev, turn: pe.undo.turn};
    }
    if (ev.kind === 'action' && pe.before) ev.before = patch(ev.undo?.live ?? prev, pe.before);
    return ev;
  });
  const out: Record<string, unknown> = {...p, events, live: patch(prev, p.live)};
  delete out.packed;
  return out as unknown as Battle;
}
