/**
 * App state. Everything lives in this browser's localStorage, like Showdown's
 * teambuilder: no accounts, no server.
 */
import {create} from 'zustand';
import type {PokemonSet} from '../data/paste';
import {uid} from '../engine/battle';
import type {Battle} from '../engine/types';

export interface SavedTeam {
  id: string;
  name: string;
  formatId?: string;
  paste: string;
  sets: PokemonSet[];
  updated: number;
}

export type View =
  | {page: 'teams'; teamId?: string}
  | {page: 'battles'}
  | {page: 'new'; teamId?: string}
  | {page: 'battle'; battleId: string};

interface State {
  teams: SavedTeam[];
  battles: Battle[];
  view: View;
  storageError: string | null;
  setView(v: View): void;
  saveTeam(t: Omit<SavedTeam, 'id' | 'updated'> & {id?: string}): string;
  deleteTeam(id: string): void;
  addBattle(b: Battle): void;
  updateBattle(id: string, fn: (b: Battle) => Battle): void;
  deleteBattle(id: string): void;
}

const KEY = 'bayesian-battle:v1';

function load(): Pick<State, 'teams' | 'battles'> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {teams: parsed.teams ?? [], battles: parsed.battles ?? []};
    }
  } catch {
    // Private mode, blocked storage or corrupt data: start empty.
  }
  return {teams: [], battles: []};
}

// The view lives in the URL hash so reloads and the Back button keep your place.
function viewFromHash(): View {
  const [page, id] = (typeof location === 'undefined' ? '' : location.hash).replace(/^#\/?/, '').split('/');
  if (page === 'battle' && id) return {page: 'battle', battleId: id};
  if (page === 'battles') return {page: 'battles'};
  if (page === 'new') return {page: 'new', teamId: id || undefined};
  return {page: 'teams', teamId: id || undefined};
}

function hashFromView(v: View): string {
  switch (v.page) {
    case 'battle': return `#/battle/${v.battleId}`;
    case 'battles': return '#/battles';
    case 'new': return v.teamId ? `#/new/${v.teamId}` : '#/new';
    case 'teams': return v.teamId ? `#/teams/${v.teamId}` : '#/teams';
  }
}

export const useStore = create<State>((set, get) => ({
  ...load(),
  view: viewFromHash(),
  storageError: null,
  setView: view => {
    const hash = hashFromView(view);
    if (typeof location !== 'undefined' && location.hash !== hash) history.pushState(null, '', hash);
    set({view});
  },
  saveTeam: t => {
    const id = t.id ?? uid();
    const team: SavedTeam = {...t, id, updated: Date.now()};
    const teams = get().teams.some(x => x.id === id)
      ? get().teams.map(x => (x.id === id ? team : x))
      : [team, ...get().teams];
    set({teams});
    return id;
  },
  deleteTeam: id => set({teams: get().teams.filter(t => t.id !== id)}),
  addBattle: b => set({battles: [b, ...get().battles]}),
  updateBattle: (id, fn) => set({battles: get().battles.map(b => (b.id === id ? {...fn(b), updated: Date.now()} : b))}),
  deleteBattle: id => set({battles: get().battles.filter(b => b.id !== id)}),
}));

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => useStore.setState({view: viewFromHash()}));
}

let timer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe(state => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({teams: state.teams, battles: state.battles.slice(0, 100)}));
      if (state.storageError) useStore.setState({storageError: null});
    } catch (err) {
      const msg = `Couldn't save to this browser's storage (${(err as Error).message}).`;
      if (state.storageError !== msg) useStore.setState({storageError: msg});
    }
  }, 250);
});
