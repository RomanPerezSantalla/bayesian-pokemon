import type {Beliefs} from '../engine/posterior';
import type {Battle, MonRef, Snapshot} from '../engine/types';

export function monName(battle: Battle, ref: MonRef): string {
  if (ref.side === 'me') {
    const s = battle.myTeam[ref.slot];
    return s ? s.nickname || s.species : `?${ref.slot}`;
  }
  return battle.oppPreview[ref.slot] ?? `?${ref.slot}`;
}

/** The species to draw for an opponent: its Mega forme once it has evolved. */
export function oppDisplaySpecies(battle: Battle, beliefs: Beliefs | null, slot: number, snap: Snapshot): string {
  const b = beliefs?.mons[slot];
  if (b && snap.mons[`opp${slot}`]?.mega) {
    const mega = b.formes.find(f => f.p > 0.5 && /-Mega/.test(f.name));
    if (mega) return mega.name;
  }
  return battle.oppPreview[slot];
}

export function activeRefs(snap: Snapshot): MonRef[] {
  const out: MonRef[] = [];
  for (const side of ['me', 'opp'] as const) {
    for (const slot of snap.active[side]) if (slot !== null) out.push({side, slot});
  }
  return out;
}

export function isActive(snap: Snapshot, ref: MonRef) {
  return snap.active[ref.side].includes(ref.slot);
}
