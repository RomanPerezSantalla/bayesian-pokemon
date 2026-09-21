/** Move side effects (compiled from @pkmn/dex by scripts/build-data.mjs). */
import raw from '../data/moves.gen.json';
import {toID} from '../data/dex';
import type {Boosts, Status} from './types';

export interface Secondary {
  /** Percent chance. */
  ch: number;
  st?: Status;
  /** One of these statuses at random (Dire Claw, Tri Attack). */
  any?: Status[];
  b?: Boosts;
  sb?: Boosts;
  fl?: 1;
}

export interface MoveFx {
  ct?: 1;
  snd?: 1;
  pun?: 1;
  self?: 1;
  st?: Status;
  sb?: Boosts;
  tb?: Boosts;
  sec?: Secondary[];
  w?: 'sun' | 'rain' | 'sand' | 'snow';
  tr?: 'electric' | 'grassy' | 'psychic' | 'misty';
  sc?: 'tailwind' | 'reflect' | 'lightscreen' | 'auroraveil';
  pw?: 'trickroom' | 'gravity';
  dr?: [number, number];
  rc?: [number, number];
  sw?: 1;
  heal?: 1;
  /** Showdown target, when not "normal" (the calc only has it for damaging moves). */
  tg?: string;
}

const table = raw as unknown as Record<string, MoveFx>;
export const moveFx = (name: string): MoveFx => table[toID(name)] ?? {};

/** Chance a hit of this move inflicts `status` by itself (Serene Grace doubles it). */
export function moveStatusChance(name: string, status: Status, sereneGrace = false): number {
  const fx = moveFx(name);
  if (fx.st === status) return 1;
  let miss = 1;
  for (const s of fx.sec ?? []) {
    let p = 0;
    if (s.st === status) p = s.ch / 100;
    else if (s.any?.includes(status)) p = s.ch / 100 / s.any.length;
    if (sereneGrace) p = Math.min(1, p * 2);
    miss *= 1 - p;
  }
  return 1 - miss;
}

/** Status inflicted on a Pokémon that makes contact with one holding this ability. */
export const CONTACT_PUNISH: Record<string, Partial<Record<Status, number>>> = {
  'Flame Body': {brn: 0.3},
  Static: {par: 0.3},
  'Poison Point': {psn: 0.3},
  'Effect Spore': {psn: 0.1, par: 0.1, slp: 0.1},
};

/** Chance the attacker's ability inflicts `status` with this hit. */
export function attackerAbilityStatusChance(ability: string, status: Status, contact: boolean) {
  if (ability === 'Poison Touch' && status === 'psn' && contact) return 0.3;
  if (ability === 'Toxic Chain' && status === 'tox') return 0.3;
  return 0;
}
