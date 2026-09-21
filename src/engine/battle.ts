/** Creating battles and keeping the "live" state in step with logged events. */
import {getGen, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import type {PokemonSet} from '../data/paste';
import {makePokemon} from './calc';
import {mySpec, defaultCondition} from './likelihood';
import {monKey, type ActionEvent, type Battle, type FieldCondition, type SideCondition, type Snapshot} from './types';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const emptySide = (): SideCondition => ({
  tailwind: false, reflect: false, lightScreen: false, auroraVeil: false, friendGuard: false,
});

export const emptyField = (): FieldCondition => ({trickRoom: false, gravity: false, me: emptySide(), opp: emptySide()});

export function myMaxHP(gen: Gen, fmt: FormatData, set: PokemonSet) {
  return makePokemon(gen, mySpec(gen, fmt, set)).maxHP();
}

export function initialSnapshot(fmt: FormatData, myTeam: PokemonSet[], oppCount: number): Snapshot {
  const gen = getGen(fmt.gen);
  const mons: Snapshot['mons'] = {};
  myTeam.forEach((set, i) => (mons[`me${i}`] = defaultCondition(myMaxHP(gen, fmt, set))));
  for (let i = 0; i < oppCount; i++) mons[`opp${i}`] = defaultCondition(100);
  const positions = fmt.gameType === 'doubles' ? 2 : 1;
  return {
    field: emptyField(),
    mons,
    active: {me: Array(positions).fill(null), opp: Array(positions).fill(null)},
  };
}

export function createBattle(fmt: FormatData, myTeam: PokemonSet[], oppPreview: string[], label: string): Battle {
  const now = Date.now();
  return {
    id: uid(),
    created: now,
    updated: now,
    formatId: fmt.id,
    label,
    myTeam,
    oppPreview,
    events: [],
    live: initialSnapshot(fmt, myTeam, oppPreview.length),
    turn: 1,
    settings: {hpMode: 'showdown', tolerance: 3},
  };
}

export const cloneSnapshot = (s: Snapshot): Snapshot => structuredClone(s);

/** After logging an action, carry its HP results into the live state. */
export function applyAction(live: Snapshot, ev: ActionEvent): Snapshot {
  const next = cloneSnapshot(live);
  for (const hit of ev.hits) {
    const c = next.mons[monKey(hit.target)];
    if (!c) continue;
    c.hp = hit.fainted ? 0 : hit.hpAfter;
    if (hit.triggers.some(t => t === 'berry' || t === 'sash' || t === 'sitrus' || t === 'wp')) c.itemGone = true;
    // Sitrus heals a quarter; for my side the user corrects the exact number.
    if (hit.target.side === 'opp' && hit.triggers.includes('sitrus')) c.hp = Math.min(100, c.hp + 25);
  }
  return next;
}
