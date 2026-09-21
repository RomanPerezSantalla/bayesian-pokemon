import type {MonSummary} from '../../engine/worker';
import type {Battle, MonRef, Snapshot} from '../../engine/types';

/** What to call a Pokémon on screen: nickname for mine, current forme for theirs. */
export function monLabel(battle: Battle, mons: (MonSummary | null)[] | undefined, ref: MonRef, live: Snapshot = battle.live) {
  if (ref.side === 'me') {
    const s = battle.myTeam[ref.slot];
    return s ? s.nickname || s.species : '?';
  }
  return oppSpecies(battle, mons, ref.slot, live);
}

/** The opponent's species to show: its Mega forme once it has Mega Evolved. */
export function oppSpecies(battle: Battle, mons: (MonSummary | null)[] | undefined, slot: number, live: Snapshot = battle.live) {
  const m = mons?.[slot];
  if (m && live.mons[`opp${slot}`]?.mega) {
    const mega = m.formes.find(f => f.p > 0.5 && /-Mega/.test(f.name));
    if (mega) return mega.name;
  }
  return battle.oppPreview[slot];
}
