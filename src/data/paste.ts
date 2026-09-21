import {STAT_IDS, type StatID} from './dex';

export interface PokemonSet {
  nickname?: string;
  species: string;
  gender?: 'M' | 'F';
  item?: string;
  ability?: string;
  level?: number;
  nature?: string;
  teraType?: string;
  /** hp, atk, def, spa, spd, spe — EVs, or Stat Points in Champions. */
  evs: number[];
  ivs: number[];
  moves: string[];
}

const STAT_ALIASES: Record<string, StatID> = {
  hp: 'hp', atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe',
  spatk: 'spa', spdef: 'spd', speed: 'spe', attack: 'atk', defense: 'def',
};

function parseStats(text: string, fill: number): number[] {
  const out = STAT_IDS.map(() => fill);
  for (const part of text.split('/')) {
    const m = part.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const stat = STAT_ALIASES[m[2].toLowerCase().replace(/[^a-z]/g, '')];
    if (stat) out[STAT_IDS.indexOf(stat)] = Number(m[1]);
  }
  return out;
}

function parseHeader(line: string): Pick<PokemonSet, 'nickname' | 'species' | 'gender' | 'item'> {
  let rest = line.trim();
  let item: string | undefined;
  const at = rest.lastIndexOf(' @ ');
  if (at >= 0) {
    item = rest.slice(at + 3).trim() || undefined;
    rest = rest.slice(0, at).trim();
  }
  let gender: 'M' | 'F' | undefined;
  const g = rest.match(/\s\((M|F)\)$/);
  if (g) {
    gender = g[1] as 'M' | 'F';
    rest = rest.slice(0, -4).trim();
  }
  let nickname: string | undefined;
  let species = rest;
  const paren = rest.match(/^(.*)\s\(([^()]+)\)$/);
  if (paren) {
    nickname = paren[1].trim() || undefined;
    species = paren[2].trim();
  }
  return {nickname, species, gender, item};
}

/** Parse Showdown's export format (what pokepast.es serves). */
export function parseTeam(text: string): PokemonSet[] {
  const sets: PokemonSet[] = [];
  let cur: PokemonSet | undefined;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('===')) {
      cur = undefined;
      continue;
    }
    if (!cur) {
      cur = {...parseHeader(line), evs: STAT_IDS.map(() => 0), ivs: STAT_IDS.map(() => 31), moves: []};
      sets.push(cur);
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('~ ')) {
      const mv = line.slice(2).trim();
      // "Hidden Power [Fire]" -> "Hidden Power Fire", the calc's spelling.
      if (mv && cur.moves.length < 4) cur.moves.push(mv.replace(/\s*\[(.+)]$/, ' $1'));
    } else if (/^Ability:/i.test(line)) {
      cur.ability = line.slice(line.indexOf(':') + 1).trim();
    } else if (/^Level:/i.test(line)) {
      cur.level = Number(line.slice(line.indexOf(':') + 1)) || undefined;
    } else if (/^Tera Type:/i.test(line)) {
      cur.teraType = line.slice(line.indexOf(':') + 1).trim();
    } else if (/^(EVs|SPs|Stat Points):/i.test(line)) {
      cur.evs = parseStats(line.slice(line.indexOf(':') + 1), 0);
    } else if (/^IVs:/i.test(line)) {
      cur.ivs = parseStats(line.slice(line.indexOf(':') + 1), 31);
    } else if (/^\w+ Nature$/i.test(line)) {
      cur.nature = line.split(/\s+/)[0];
    }
    // Shiny, Happiness, Pokeball, Gigantamax, Dynamax Level: irrelevant here.
  }
  return sets.filter(s => s.species);
}

const LABELS = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];

export function exportSet(set: PokemonSet): string {
  const lines: string[] = [];
  let head = set.nickname && set.nickname !== set.species ? `${set.nickname} (${set.species})` : set.species;
  if (set.gender) head += ` (${set.gender})`;
  if (set.item) head += ` @ ${set.item}`;
  lines.push(head);
  if (set.ability) lines.push(`Ability: ${set.ability}`);
  if (set.level && set.level !== 100 && set.level !== 50) lines.push(`Level: ${set.level}`);
  if (set.teraType) lines.push(`Tera Type: ${set.teraType}`);
  const evs = set.evs.map((v, i) => (v ? `${v} ${LABELS[i]}` : '')).filter(Boolean);
  if (evs.length) lines.push(`EVs: ${evs.join(' / ')}`);
  if (set.nature) lines.push(`${set.nature} Nature`);
  const ivs = set.ivs.map((v, i) => (v !== 31 ? `${v} ${LABELS[i]}` : '')).filter(Boolean);
  if (ivs.length) lines.push(`IVs: ${ivs.join(' / ')}`);
  for (const m of set.moves) lines.push(`- ${m}`);
  return lines.join('\n');
}

export const exportTeam = (sets: PokemonSet[]) => sets.map(exportSet).join('\n\n');

/** Extracts the paste id from any pokepast.es URL form. */
export function pokepasteId(input: string): string | null {
  const m = input.trim().match(/pokepast\.es\/([0-9a-f]{8,})/i);
  return m ? m[1] : null;
}

export interface Pokepaste {
  title: string;
  author: string;
  notes: string;
  paste: string;
}

/** pokepast.es serves JSON with permissive CORS, so this works from the browser. */
export async function fetchPokepaste(id: string): Promise<Pokepaste> {
  const res = await fetch(`https://pokepast.es/${id}/json`);
  if (!res.ok) throw new Error(`pokepast.es returned HTTP ${res.status}`);
  return res.json();
}
