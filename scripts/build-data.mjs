#!/usr/bin/env node
// Downloads Smogon "chaos" usage statistics and compiles them into the compact
// prior files the app loads from public/data/.
//
//   npm run data                  # latest published month, all formats below
//   npm run data -- 2026-08       # a specific month
//
// Smogon's stats server does not send CORS headers, so the browser can't read
// it directly; this script is the bridge. Re-run it monthly to refresh priors.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import calc from '@smogon/calc';

const {Generations, toID} = calc;

const STATS_ROOT = 'https://www.smogon.com/stats';
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'public', 'data');
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');

// gen 0 is how @smogon/calc addresses Pokémon Champions (Stat Points, level 50).
const FORMATS = [
  {id: 'gen9championsvgc2026regmb', cutoff: 1760, name: 'Champions VGC 2026 Reg M-B', gen: 0, gameType: 'doubles', level: 50, itemClause: true, bring: 4},
  {id: 'gen9championsvgc2026regmbbo3', cutoff: 1760, name: 'Champions VGC 2026 Reg M-B (Bo3)', gen: 0, gameType: 'doubles', level: 50, itemClause: true, bring: 4},
  {id: 'gen9championsbssregmb', cutoff: 1760, name: 'Champions BSS Reg M-B', gen: 0, gameType: 'singles', level: 50, itemClause: true, bring: 3},
  {id: 'gen9championsou', cutoff: 1760, name: 'Champions OU', gen: 0, gameType: 'singles', level: 50, itemClause: false, bring: 6},
  {id: 'gen9ou', cutoff: 1695, name: 'SV OU', gen: 9, gameType: 'singles', level: 100, itemClause: false, bring: 6},
  {id: 'gen9doublesou', cutoff: 1695, name: 'SV Doubles OU', gen: 9, gameType: 'doubles', level: 100, itemClause: false, bring: 4},
];

// Formes the game hides at team preview: the opponent shows the base species
// and the forme only becomes known in battle.
const HIDDEN_FORME_BASES = new Set([
  'Urshifu', 'Arceus', 'Silvally', 'Genesect', 'Gourgeist', 'Pumpkaboo', 'Zacian', 'Zamazenta', 'Xerneas',
]);

// Keep enough of each distribution to be useful without shipping the long tail.
const MIN_ITEM = 0.002;
const MIN_ABILITY = 0.002;
const MIN_MOVE = 0.002;
const MIN_TERA = 0.005;
const MIN_TEAMMATE = 0.01;
const SPREAD_COVERAGE = 0.9;
const MAX_SPREADS = 160;
const MIN_SPECIES_WEIGHT = 1;

// Stats names that differ from the calc's species keys.
const SPECIES_ALIASES = {Aegislash: 'Aegislash-Shield'};

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

async function latestMonth() {
  const html = await (await fetch(`${STATS_ROOT}/`)).text();
  const months = [...html.matchAll(/href="(\d{4}-\d{2})\/"/g)].map(m => m[1]).sort();
  if (!months.length) throw new Error('Could not find any months on the Smogon stats index');
  return months[months.length - 1];
}

async function fetchChaos(month, format) {
  const file = `${format.id}-${format.cutoff}.json`;
  const cached = path.join(CACHE_DIR, month, file);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));

  const url = `${STATS_ROOT}/${month}/chaos/${file}.gz`;
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  fs.mkdirSync(path.dirname(cached), {recursive: true});
  fs.writeFileSync(cached, text);
  return JSON.parse(text);
}

const round = (x, digits = 5) => Number(x.toPrecision(digits));

function normalize(entries, total, min) {
  const out = [];
  let kept = 0;
  for (const [key, w] of entries.sort((a, b) => b[1] - a[1])) {
    const p = w / total;
    if (p < min) break;
    out.push([key, round(p)]);
    kept += p;
  }
  return {list: out, other: round(Math.max(0, 1 - kept), 4)};
}

function compileSpecies(gen, name, raw, warnings) {
  const abilityWeights = Object.entries(raw.Abilities);
  const total = abilityWeights.reduce((s, [, w]) => s + w, 0);
  if (total < MIN_SPECIES_WEIGHT) return null;

  const dexName = (store, id) => {
    if (id === 'nothing' || id === '') return id === 'nothing' ? '(none)' : null;
    const rec = store.get(id);
    if (!rec) warnings.add(`${name}: unknown id "${id}"`);
    return rec ? rec.name : id;
  };
  const renamed = (obj, store) => {
    const merged = new Map();
    for (const [id, w] of Object.entries(obj)) {
      const n = dexName(store, id);
      if (n) merged.set(n, (merged.get(n) || 0) + w);
    }
    return [...merged.entries()];
  };

  const abilities = normalize(renamed(raw.Abilities, gen.abilities), total, MIN_ABILITY);
  const items = normalize(renamed(raw.Items, gen.items), total, MIN_ITEM);
  // Moves: weight / total = probability the move is in the set (sums to ~4).
  const moves = normalize(renamed(raw.Moves, gen.moves), total, MIN_MOVE);

  // Spreads come as "Nature:hp/atk/def/spa/spd/spe" with EVs (or Stat Points
  // in Champions). Keep the head explicitly, plus per-stat marginals over the
  // whole distribution so the app can model the tail it doesn't see.
  const spreadEntries = Object.entries(raw.Spreads).sort((a, b) => b[1] - a[1]);
  const spreadTotal = spreadEntries.reduce((s, [, w]) => s + w, 0) || 1;
  const spreads = [];
  let covered = 0;
  const statMarginals = STATS.map(() => new Map());
  const natureMarginal = new Map();
  for (const [key, w] of spreadEntries) {
    const [nature, evText] = key.split(':');
    const evs = evText.split('/').map(Number);
    const p = w / spreadTotal;
    evs.forEach((ev, i) => statMarginals[i].set(ev, (statMarginals[i].get(ev) || 0) + p));
    natureMarginal.set(nature, (natureMarginal.get(nature) || 0) + p);
    if (covered < SPREAD_COVERAGE && spreads.length < MAX_SPREADS) {
      spreads.push([nature, evs, round(p, 4)]);
      covered += p;
    }
  }
  const sparse = (m, min = 0.001) =>
    [...m.entries()].filter(([, p]) => p >= min).sort((a, b) => b[1] - a[1]).map(([k, p]) => [k, round(p, 3)]);

  const teammates = Object.entries(raw.Teammates || {})
    .map(([t, w]) => [t, w / total])
    .filter(([, p]) => p >= MIN_TEAMMATE)
    .sort((a, b) => b[1] - a[1])
    .map(([t, p]) => [t, round(p, 3)]);

  const tera = raw['Tera Types'] ? normalize(
    Object.entries(raw['Tera Types']).filter(([t]) => t !== 'nothing')
      .map(([t, w]) => [t.charAt(0).toUpperCase() + t.slice(1), w]),
    total, MIN_TERA,
  ) : null;

  return {
    usage: round(raw.usage, 4),
    weight: round(total, 4),
    abilities: abilities.list,
    items: items.list,
    itemsOther: items.other,
    moves: moves.list,
    spreads,
    spreadsCovered: round(covered, 3),
    statMarginals: statMarginals.map(m => sparse(m)),
    natures: sparse(natureMarginal),
    teammates,
    tera: tera && tera.list.length ? tera.list : undefined,
  };
}

function previewName(gen, name) {
  const alias = Object.entries(SPECIES_ALIASES).find(([, v]) => v === name);
  if (alias) return alias[0];
  const sp = gen.species.get(toID(name));
  if (!sp) return name;
  const base = sp.baseSpecies;
  if (!base) return sp.name;
  if (/-(Mega|Primal)/.test(sp.name)) return base;
  if (HIDDEN_FORME_BASES.has(base)) return base;
  return sp.name;
}

async function buildFormat(month, format) {
  const gen = Generations.get(format.gen);
  const chaos = await fetchChaos(month, format);
  const warnings = new Set();
  const species = {};
  for (const [statsName, raw] of Object.entries(chaos.data)) {
    const name = SPECIES_ALIASES[statsName] || statsName;
    if (!gen.species.get(toID(name))) {
      warnings.add(`species not in calc data: ${name}`);
      continue;
    }
    const compiled = compileSpecies(gen, name, raw, warnings);
    if (compiled) species[name] = compiled;
  }

  // Team preview shows base species for Megas etc.; group formes under it.
  const preview = {};
  for (const name of Object.keys(species)) {
    const key = previewName(gen, name);
    (preview[key] ||= []).push(name);
  }
  for (const formes of Object.values(preview)) {
    formes.sort((a, b) => species[b].weight - species[a].weight);
  }
  const previewUsage = Object.fromEntries(Object.entries(preview).map(
    ([k, formes]) => [k, round(formes.reduce((s, f) => s + species[f].usage, 0), 4)],
  ));

  const out = {
    ...format,
    month,
    battles: chaos.info['number of battles'],
    species,
    preview,
    previewUsage,
  };
  const file = path.join(OUT_DIR, `${format.id}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${format.id}: ${Object.keys(species).length} species, ${Object.keys(preview).length} preview names, ${kb} KB`);
  for (const w of [...warnings].slice(0, 12)) console.log(`    warn: ${w}`);
  if (warnings.size > 12) console.log(`    ... ${warnings.size - 12} more warnings`);
  return {
    id: format.id, name: format.name, gen: format.gen, gameType: format.gameType, level: format.level,
    itemClause: format.itemClause, bring: format.bring, month, cutoff: format.cutoff, battles: out.battles,
  };
}

async function main() {
  const month = process.argv[2] || await latestMonth();
  console.log(`Building priors from Smogon stats for ${month}`);
  fs.mkdirSync(OUT_DIR, {recursive: true});
  const index = [];
  for (const format of FORMATS) {
    try {
      index.push(await buildFormat(month, format));
    } catch (err) {
      console.error(`  ${format.id}: skipped (${err.message})`);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'formats.json'), JSON.stringify({generated: new Date().toISOString(), formats: index}, null, 2));
  console.log(`Wrote ${index.length} formats to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
