/**
 * Backups: every team and battle in one JSON file, to keep somewhere safe or move to another
 * device. Restoring merges by id, keeping whichever copy was changed last. A bug report (the
 * crash screen's "copy this battle") restores the same way.
 */
import type {Battle} from '../engine/types';
import {isPackedBattle, packBattle, type BattleInfo, type PackedBattle} from './pack';
import {allBattles, putBattles, replaceTeams, storageReady, useStore, type SavedTeam} from './store';

const APP = 'bayesian-battle-analyzer';

export interface Backup {
  app: typeof APP;
  version: 1;
  exported: string;
  teams: SavedTeam[];
  battles: PackedBattle[];
}

/** What a restore would add or replace. */
export interface ImportPlan {
  teams: SavedTeam[];
  battles: PackedBattle[];
  /** Already here, same age or newer. */
  skipped: number;
}

/** A bug report from the crash screen. */
export interface Report {
  app: typeof APP;
  report: 1;
  build: string;
  when: string;
  error: string;
  where?: string;
  browser: string;
  battle?: PackedBattle;
}

export async function makeBackup(): Promise<Backup> {
  return {app: APP, version: 1, exported: new Date().toISOString(), teams: useStore.getState().teams, battles: await allBattles()};
}

export function makeReport(error: unknown, where?: string, battle?: Battle | null): Report {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    app: APP, report: 1, build: __APP_BUILD__, when: new Date().toISOString(),
    error: `${e.name}: ${e.message}\n${e.stack ?? ''}`.trim(), where: where?.trim() || undefined,
    browser: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    battle: battle ? packBattle(battle) : undefined,
  };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isTeam = (x: unknown): x is SavedTeam =>
  isObject(x) && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.paste === 'string' && Array.isArray(x.sets);
/** A battle saved by any version: packed, or whole with its snapshots. */
const isBattle = (x: unknown): x is Battle | PackedBattle =>
  isObject(x) && typeof x.id === 'string' && typeof x.formatId === 'string' && Array.isArray(x.events)
  && Array.isArray(x.myTeam) && Array.isArray(x.oppPreview) && (isPackedBattle(x) || isObject(x.live));

/** The teams and battles in a backup, a bug report or a single battle; throws if it's none of those. */
export function readFile(text: string): {teams: SavedTeam[]; battles: PackedBattle[]} {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("that isn't a backup file (not JSON)");
  }
  const found = {teams: [] as SavedTeam[], battles: [] as (Battle | PackedBattle)[]};
  if (isObject(data) && (Array.isArray(data.teams) || Array.isArray(data.battles))) {
    found.teams = (Array.isArray(data.teams) ? data.teams : []).filter(isTeam);
    found.battles = (Array.isArray(data.battles) ? data.battles : []).filter(isBattle);
  } else if (isObject(data) && isBattle(data.battle)) {
    found.battles = [data.battle];
  } else if (isBattle(data)) {
    found.battles = [data];
  }
  if (!found.teams.length && !found.battles.length) throw new Error('no teams or battles in that file');
  return {teams: found.teams, battles: found.battles.map(b => (isPackedBattle(b) ? b : packBattle(b)))};
}

/** Newer copies win; the same age means it's already here. */
export function planImport(have: {teams: SavedTeam[]; battles: BattleInfo[]}, file: {teams: SavedTeam[]; battles: PackedBattle[]}): ImportPlan {
  const teamAge = new Map(have.teams.map(t => [t.id, t.updated]));
  const battleAge = new Map(have.battles.map(b => [b.id, b.updated]));
  const newer = (age: number | undefined, updated: number) => age === undefined || (updated ?? 0) > age;
  const teams = file.teams.filter(t => newer(teamAge.get(t.id), t.updated));
  const battles = file.battles.filter(b => newer(battleAge.get(b.id), b.updated));
  return {teams, battles, skipped: file.teams.length - teams.length + file.battles.length - battles.length};
}

/** Teams from the file replace their older copies in place; new ones go first, as if just added. */
export function mergeTeams(have: SavedTeam[], incoming: SavedTeam[]): SavedTeam[] {
  const byId = new Map(incoming.map(t => [t.id, t]));
  const kept = have.map(t => byId.get(t.id) ?? t);
  const known = new Set(have.map(t => t.id));
  return [...incoming.filter(t => !known.has(t.id)), ...kept];
}

export async function restore(text: string): Promise<ImportPlan> {
  const file = readFile(text);
  await storageReady();
  const s = useStore.getState();
  const plan = planImport({teams: s.teams, battles: s.battles}, file);
  if (plan.teams.length) replaceTeams(mergeTeams(useStore.getState().teams, plan.teams));
  await putBattles(plan.battles);
  return plan;
}

export const backupName = () => `battle-analyzer-backup-${new Date().toISOString().slice(0, 10)}.json`;

/**
 * iPhone and iPad, where files go out through the share sheet. Safari opens it only straight from
 * a tap, so anything slow (reading every battle) has to be ready before the tap.
 */
export const sharesFiles = () => typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * Hands a file to the person: the share sheet on iPhone and iPad (Save to Files, AirDrop…),
 * where a download from a home-screen app can go nowhere; a download everywhere else.
 */
export async function saveFile(name: string, text: string) {
  const file = new File([text], name, {type: 'application/json'});
  if (sharesFiles() && navigator.canShare?.({files: [file]})) {
    try {
      await navigator.share({files: [file]});
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
