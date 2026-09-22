/**
 * App state. Everything lives in this browser, like Showdown's teambuilder: no accounts, no
 * server. Teams are small and sit in localStorage; battles go to IndexedDB (db.ts), one record
 * each, and only the battle on screen is held in full.
 */
import {create} from 'zustand';
import type {PokemonSet} from '../data/paste';
import {uid} from '../engine/battle';
import type {Battle} from '../engine/types';
import {indexedDBStore, memoryStore, type BattleStore} from './db';
import {testLog, testLogBattle} from '../testlog';
import {battleInfo, packBattle, type BattleInfo, type PackedBattle} from './pack';

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
  /** Every saved battle, newest first: what lists need. */
  battles: BattleInfo[];
  /** The battle on screen, in full. */
  current: Battle | null;
  /** The battle list has been read from storage. */
  ready: boolean;
  view: View;
  storageError: string | null;
  setView(v: View): void;
  saveTeam(t: Omit<SavedTeam, 'id' | 'updated'> & {id?: string}): string;
  deleteTeam(id: string): void;
  addBattle(b: Battle): void;
  /** Loads a saved battle as the current one. */
  openBattle(id: string): Promise<void>;
  updateBattle(id: string, fn: (b: Battle) => Battle): void;
  deleteBattle(id: string): void;
}

/**
 * Teams, as `{teams}`. Versions before IndexedDB kept every battle here too (`{teams, battles}`),
 * which filled the browser's 5 MB after a few dozen battles; those move to IndexedDB on load.
 */
const KEY = 'bayesian-battle:v2';
/** v1 battles used Showdown-only formats; teams carry over unchanged. */
const OLD_KEY = 'bayesian-battle:v1';

/** Battles still in localStorage from an earlier version, until they're safely in IndexedDB. */
let legacyBattles: Battle[] | null = null;

function loadTeams(): SavedTeam[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.battles) && parsed.battles.length) legacyBattles = parsed.battles;
      return parsed.teams ?? [];
    }
    const old = localStorage.getItem(OLD_KEY);
    if (old) return JSON.parse(old).teams ?? [];
  } catch {
    // Private mode, blocked storage or corrupt data: start empty.
  }
  return [];
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

const newestFirst = (list: BattleInfo[]) => [...list].sort((a, b) => b.created - a.created);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Battles changed but not yet written, by id: saves are batched, and a reopened battle is taken from here first. */
const pending = new Map<string, Battle>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  teams: loadTeams(),
  battles: [],
  current: null,
  ready: false,
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
  addBattle: b => {
    set({current: b, battles: [battleInfo(b), ...get().battles.filter(i => i.id !== b.id)]});
    queueSave(b);
    keepStorage();
  },
  openBattle: async id => {
    if (get().current?.id === id) return;
    const db = await storage;
    const b = pending.get(id) ?? (await db.get(id));
    // Only if it's still the battle wanted (another may have been opened meanwhile).
    const view = get().view;
    if (b && view.page === 'battle' && view.battleId === id && get().current?.id !== id) set({current: b});
  },
  // Synchronous on purpose: voice and auto-advance read the result right after.
  updateBattle: (id, fn) => {
    const cur = get().current;
    if (cur?.id !== id) return;
    const b = {...fn(cur), updated: Date.now()};
    set({current: b, battles: get().battles.map(i => (i.id === id ? battleInfo(b) : i))});
    queueSave(b);
  },
  deleteBattle: id => {
    pending.delete(id);
    set({battles: get().battles.filter(i => i.id !== id), current: get().current?.id === id ? null : get().current});
    storage.then(db => db.remove(id)).catch(err => useStore.setState({storageError: `Couldn't delete the battle (${message(err)}).`}));
  },
}));

/** The battle on screen, if it's this one. */
export const battleById = (id: string): Battle | undefined => {
  const b = useStore.getState().current;
  return b?.id === id ? b : undefined;
};

/** Once the saved battles are listed (a restore compares against them). */
export const storageReady = async () => {
  await storage;
};

/**
 * Everything a backup needs, with unsaved changes written first. What couldn't be written (saving
 * is failing: the reason to make a backup) comes from memory, so the backup has it either way.
 */
export async function allBattles(): Promise<PackedBattle[]> {
  await flushSaves();
  let saved: PackedBattle[] = [];
  let failed: unknown;
  try {
    saved = await (await storage).all();
  } catch (err) {
    failed = err;
  }
  const byId = new Map(saved.map(b => [b.id, b]));
  const cur = useStore.getState().current;
  for (const b of [...pending.values(), ...(cur ? [cur] : [])]) byId.set(b.id, packBattle(b));
  if (failed && !byId.size) throw failed;
  return [...byId.values()];
}

/** Saves battles from a backup (packed or not), replacing those with the same id, and refreshes the list. */
export async function putBattles(list: (Battle | PackedBattle)[]) {
  if (!list.length) return;
  const db = await storage;
  await flushSaves();
  await db.put(list);
  const cur = useStore.getState().current;
  const reloaded = cur && list.some(b => b.id === cur.id) ? await db.get(cur.id) : undefined;
  useStore.setState({battles: newestFirst(await db.list()), ...(reloaded ? {current: reloaded} : {})});
  keepStorage();
}

export function replaceTeams(teams: SavedTeam[]) {
  useStore.setState({teams});
}

function queueSave(b: Battle) {
  pending.set(b.id, b);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSaves(), 250);
}

const SAVE_FAILED = 'Couldn\'t save the battle';

export async function flushSaves() {
  clearTimeout(saveTimer);
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  try {
    const packed = batch.map(packBattle);
    await (await storage).put(packed);
    for (const p of packed) testLogBattle(p);
    if (useStore.getState().storageError?.startsWith(SAVE_FAILED)) useStore.setState({storageError: null});
  } catch (err) {
    // Kept for the next try, unless something newer came in meanwhile; tried again shortly even if nothing changes.
    for (const b of batch) if (!pending.has(b.id)) pending.set(b.id, b);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSaves(), 5000);
    useStore.setState({storageError: `${SAVE_FAILED} to this browser's storage (${message(err)}). Save a backup from the Battles page.`});
    testLog('error', {what: 'save', error: message(err)});
  }
}

/**
 * Asks the browser not to clear this site's data when space runs low (Chrome decides by itself;
 * Firefox asks once). Only once there's a battle worth keeping.
 */
let asked = false;
function keepStorage() {
  if (asked || typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  asked = true;
  navigator.storage.persisted().then(yes => yes || navigator.storage.persist()).catch(() => {});
}

/** Opens IndexedDB, moves battles over from earlier versions, and reads the list. */
async function openStorage(): Promise<BattleStore> {
  let db: BattleStore;
  try {
    db = await indexedDBStore();
  } catch (err) {
    db = memoryStore(legacyBattles ?? []);
    useStore.setState({
      storageError: `This browser won't keep battles (${message(err)}): they last until the page is closed. Save a backup from the Battles page.`,
    });
  }
  if (db.kind === 'indexeddb' && legacyBattles) {
    try {
      // Newer copies already in IndexedDB win (the old version still open in another tab).
      const have = new Map((await db.list()).map(i => [i.id, i.updated]));
      const move = legacyBattles.flatMap(b => {
        if (!b?.id || !Array.isArray(b.events) || (have.get(b.id) ?? -1) >= b.updated) return [];
        try {
          return [packBattle(b)];
        } catch (err) {
          console.warn('Skipping a damaged saved battle:', b.id, err);
          return [];
        }
      });
      await db.put(move);
      legacyBattles = null;
      saveTeams(useStore.getState().teams);
    } catch (err) {
      console.warn('Moving battles to IndexedDB failed; they stay in localStorage for now:', err);
    }
  }
  try {
    useStore.setState({battles: newestFirst(await db.list())});
  } catch (err) {
    useStore.setState({storageError: `Couldn't read saved battles (${message(err)}).`});
  }
  useStore.setState({ready: true});
  return db;
}

// Tests have no browser storage; the app opens it once, at load.
const storage: Promise<BattleStore> = typeof window === 'undefined' ? Promise.resolve(memoryStore()) : openStorage();

function saveTeams(teams: SavedTeam[]) {
  try {
    // Battles not yet moved to IndexedDB stay where they are.
    localStorage.setItem(KEY, JSON.stringify(legacyBattles ? {teams, battles: legacyBattles} : {teams}));
    if (useStore.getState().storageError?.startsWith('Couldn\'t save your teams')) useStore.setState({storageError: null});
  } catch (err) {
    useStore.setState({storageError: `Couldn't save your teams to this browser's storage (${message(err)}).`});
  }
}

let teamsTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((state, prev) => {
  if (state.teams === prev.teams) return;
  clearTimeout(teamsTimer);
  teamsTimer = setTimeout(() => saveTeams(useStore.getState().teams), 250);
});

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => useStore.setState({view: viewFromHash()}));
  // Leaving the app (switching apps, locking the phone) writes what's pending straight away.
  window.addEventListener('pagehide', () => void flushSaves());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSaves();
  });
}
