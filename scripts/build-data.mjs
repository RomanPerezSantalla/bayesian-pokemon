#!/usr/bin/env node
// Build-time data for the app. Run with `npm run data` (monthly is plenty).
//
// 1. src/data/moves.gen.json: compact move effects (stat changes, statuses,
//    weather, screens…) so the app can update the battle state automatically.
// 2. public/data/structure-{doubles,singles}.json: Smogon's Showdown usage stats
//    for the newest Pokémon Champions regulation. The official in-game ladder data
//    (fetched live by the app) is the primary prior; these only supply structure the
//    in-game Battle Data lacks: per-Mega-forme moves/spreads, which stat alignment
//    goes with which spread, and the long tail of spreads.
//
// Smogon's stats server has no CORS headers, which is why this runs at build time.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import calc from '@smogon/calc';
import {Dex} from '@pkmn/dex';

const {Generations, toID} = calc;
const gen = Generations.get(0); // Pokémon Champions in @smogon/calc

const STATS_ROOT = 'https://www.smogon.com/stats';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, '.cache');

const FORMATS = [
  {id: 'champions-doubles', name: 'Ranked Doubles', official: 'Doubles', gameType: 'doubles', bring: 4, smogonPrefix: 'gen9championsvgc'},
  {id: 'champions-singles', name: 'Ranked Singles', official: 'Singles', gameType: 'singles', bring: 3, smogonPrefix: 'gen9championsbss'},
];
const CUTOFF = 1760;

const MIN_ITEM = 0.002;
const MIN_ABILITY = 0.002;
const MIN_MOVE = 0.002;
const MIN_TEAMMATE = 0.01;
const SPREAD_COVERAGE = 0.9;
const MAX_SPREADS = 160;
const MIN_SPECIES_WEIGHT = 1;
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const SPECIES_ALIASES = {Aegislash: 'Aegislash-Shield'};

const round = (x, digits = 5) => Number(x.toPrecision(digits));

// --- Move effects ------------------------------------------------------------

// Effects Showdown implements in code rather than data.
const MOVE_OVERRIDES = {
  partingshot: {tb: {atk: -1, spa: -1}},
  direclaw: {sec: [{ch: 50, any: ['psn', 'par', 'slp']}]},
  triattack: {sec: [{ch: 20, any: ['brn', 'par', 'frz']}]},
  scaleshot: {sb: {def: -1, spe: 1}},
  bittermalice: {sec: [{ch: 100, b: {atk: -1}}]},
  spicyextract: {tb: {atk: 2, def: -2}},
  chillyreception: {w: 'snow'},
  shedtail: {},
};

function compactBoosts(b) {
  if (!b) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(b)) if (v && ['atk', 'def', 'spa', 'spd', 'spe'].includes(k)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function buildMoves() {
  const d = Dex.forGen(9);
  const out = {};
  const names = new Set([...gen.moves].map(m => m.id));
  for (const m of d.moves.all()) names.add(m.id);
  for (const id of names) {
    const m = d.moves.get(id);
    const c = gen.moves.get(id);
    if (!m.exists && !c) continue;
    const e = {};
    if (m.exists) {
      if (m.flags?.contact) e.ct = 1;
      if (m.flags?.sound) e.snd = 1;
      if (m.flags?.punch) e.pun = 1;
      if (m.target === 'self') e.self = 1;
      // The calc leaves status moves without a target; the action sheet needs it to skip "Target?".
      if (m.target && m.target !== 'normal') e.tg = m.target;
      if (m.status) e.st = m.status;
      const self = compactBoosts(m.self?.boosts);
      if (self) e.sb = self;
      const own = compactBoosts(m.boosts);
      if (own) (m.target === 'self' || m.target === 'adjacentAllyOrSelf' || m.target === 'allies' ? (e.sb = {...e.sb, ...own}) : (e.tb = own));
      const secs = (m.secondaries || []).map(s => {
        const x = {ch: s.chance ?? 100};
        if (s.status) x.st = s.status;
        const b = compactBoosts(s.boosts);
        if (b) x.b = b;
        const sb = compactBoosts(s.self?.boosts);
        if (sb) x.sb = sb;
        if (s.volatileStatus === 'flinch') x.fl = 1;
        return x;
      }).filter(x => x.st || x.b || x.sb || x.fl);
      if (secs.length) e.sec = secs;
      const weather = {sunnyday: 'sun', raindance: 'rain', sandstorm: 'sand', snowscape: 'snow', hail: 'snow'}[m.weather?.toLowerCase?.()];
      if (weather) e.w = weather;
      if (m.terrain) e.tr = m.terrain.replace('terrain', '');
      if (['tailwind', 'reflect', 'lightscreen', 'auroraveil'].includes(m.sideCondition)) e.sc = m.sideCondition;
      if (['trickroom', 'gravity'].includes(m.pseudoWeather)) e.pw = m.pseudoWeather;
      if (m.drain) e.dr = m.drain;
      if (m.recoil) e.rc = m.recoil;
      if (m.selfSwitch) e.sw = 1;
      if (m.flags?.heal || m.heal) e.heal = 1;
    }
    Object.assign(e, MOVE_OVERRIDES[id] || {});
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}

/** Every legal ability per species (the calc only knows the first one). */
function buildAbilities() {
  const d = Dex.forGen(9);
  const out = {};
  for (const sp of gen.species) {
    const rec = d.species.get(sp.id);
    // Megas have exactly one ability, and @pkmn/dex only has placeholders for the new
    // Champions formes ("Future"): for those the calc (updated for Champions) is the authority.
    const useCalc = !rec?.exists || rec.name !== sp.name || rec.isNonstandard === 'Future' || /-Mega/.test(sp.name);
    const list = useCalc ? Object.values(sp.abilities ?? {}) : Object.values(rec.abilities);
    if (list.length) out[sp.id] = [...new Set(list)];
  }
  return out;
}

// --- Smogon structure --------------------------------------------------------

async function listChaosFiles(month) {
  const html = await (await fetch(`${STATS_ROOT}/${month}/chaos/`)).text();
  return [...html.matchAll(/href="([^"]+\.json\.gz)"/g)].map(m => m[1].replace(/\.json\.gz$/, ''));
}

async function latestMonth() {
  const html = await (await fetch(`${STATS_ROOT}/`)).text();
  const months = [...html.matchAll(/href="(\d{4}-\d{2})\/"/g)].map(m => m[1]).sort();
  return months[months.length - 1];
}

async function fetchChaos(month, file) {
  const cached = path.join(CACHE_DIR, month, `${file}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  const url = `${STATS_ROOT}/${month}/chaos/${file}.json.gz`;
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  fs.mkdirSync(path.dirname(cached), {recursive: true});
  fs.writeFileSync(cached, text);
  return JSON.parse(text);
}

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

function compileSpecies(name, raw, warnings) {
  const total = Object.values(raw.Abilities).reduce((s, w) => s + w, 0);
  if (total < MIN_SPECIES_WEIGHT) return null;
  const renamed = (obj, store) => {
    const merged = new Map();
    for (const [id, w] of Object.entries(obj)) {
      if (id === '') continue;
      const n = id === 'nothing' ? '(none)' : store.get(id)?.name;
      if (!n) {
        warnings.add(`${name}: unknown id "${id}"`);
        continue;
      }
      merged.set(n, (merged.get(n) || 0) + w);
    }
    return [...merged.entries()];
  };
  const abilities = normalize(renamed(raw.Abilities, gen.abilities), total, MIN_ABILITY);
  const items = normalize(renamed(raw.Items, gen.items), total, MIN_ITEM);
  const moves = normalize(renamed(raw.Moves, gen.moves), total, MIN_MOVE);

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
    .map(([t, w]) => [SPECIES_ALIASES[t] || t, w / total])
    .filter(([, p]) => p >= MIN_TEAMMATE)
    .sort((a, b) => b[1] - a[1])
    .map(([t, p]) => [t, round(p, 3)]);

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
  };
}

function previewName(name) {
  const alias = Object.entries(SPECIES_ALIASES).find(([, v]) => v === name);
  if (alias) return alias[0];
  const sp = gen.species.get(toID(name));
  if (!sp?.baseSpecies) return sp?.name ?? name;
  return /-Mega/.test(sp.name) ? sp.baseSpecies : sp.name;
}

/** Newest regulation (then Bo1 over Bo3) available for a Smogon format prefix. */
function pickRegulation(files, prefix) {
  const candidates = files
    .filter(f => f.startsWith(prefix) && f.endsWith(`-${CUTOFF}`) && !f.includes('bo3'))
    .map(f => f.replace(`-${CUTOFF}`, ''))
    .sort();
  return candidates[candidates.length - 1];
}

async function buildStructure(month, files, format) {
  const smogonId = pickRegulation(files, format.smogonPrefix);
  if (!smogonId) throw new Error(`no ${format.smogonPrefix}* stats in ${month}`);
  const chaos = await fetchChaos(month, `${smogonId}-${CUTOFF}`);
  const warnings = new Set();
  const species = {};
  for (const [statsName, raw] of Object.entries(chaos.data)) {
    const name = SPECIES_ALIASES[statsName] || statsName;
    if (!gen.species.get(toID(name))) {
      warnings.add(`species not in calc data: ${name}`);
      continue;
    }
    const compiled = compileSpecies(name, raw, warnings);
    if (compiled) species[name] = compiled;
  }
  const preview = {};
  for (const name of Object.keys(species)) (preview[previewName(name)] ||= []).push(name);
  for (const formes of Object.values(preview)) formes.sort((a, b) => species[b].weight - species[a].weight);

  const out = {smogonId, month, cutoff: CUTOFF, battles: chaos.info['number of battles'], species, preview};
  const file = path.join(OUT_DIR, `structure-${format.gameType}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`  ${format.name}: ${smogonId} (${month}), ${Object.keys(species).length} formes, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  for (const w of [...warnings].slice(0, 6)) console.log(`    warn: ${w}`);
  return {smogonId, month, cutoff: CUTOFF, battles: out.battles};
}

/**
 * Where each Champions item sits on Showdown's icon sheet (sprites/itemicons-sheet.png, rows of
 * 16 icons of 24px). Only Showdown's client data has these numbers; @pkmn/dex drops them.
 */
async function buildItemIcons() {
  const res = await fetch('https://play.pokemonshowdown.com/data/items.js');
  if (!res.ok) throw new Error(`items.js: HTTP ${res.status}`);
  const sandbox = {exports: {}};
  vm.runInNewContext(await res.text(), sandbox);
  const all = sandbox.exports.BattleItems;
  const out = {};
  for (const item of gen.items) {
    const num = all[item.id]?.spritenum;
    if (num) out[item.id] = num;
  }
  return out;
}

/**
 * Type symbols in the style of the Switch games: partywhale's MIT-licensed recreation
 * (github.com/partywhale/pokemon-type-icons), pinned. The circle each icon sits on becomes the
 * tab's background colour; the symbol's shapes keep their own fills (some have details drawn
 * in shades of the background).
 */
const TYPE_ICON_BASE = 'https://cdn.jsdelivr.net/gh/partywhale/pokemon-type-icons@fcbe6978c61c359680bc07636c3f9bdc0f346b43/icons';
const TYPE_NAMES = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground', 'Flying',
  'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'];
const SVG_SHAPES = new Set(['path', 'polygon', 'polyline', 'circle', 'ellipse', 'rect']);
const SVG_KEEP = new Set(['d', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'transform', 'fill-rule', 'clip-rule']);

async function buildTypeIcons() {
  const out = {};
  for (const type of TYPE_NAMES) {
    const res = await fetch(`${TYPE_ICON_BASE}/${type.toLowerCase()}.svg`);
    if (!res.ok) throw new Error(`${type} icon: HTTP ${res.status}`);
    const svg = await res.text();
    const fills = Object.fromEntries([...svg.matchAll(/\.([\w-]+)\s*\{\s*fill:\s*(#[0-9a-fA-F]{3,8})/g)].map(m => [m[1], m[2]]));
    let color = '';
    const shapes = [];
    for (const [, tag, attrText] of svg.matchAll(/<(\w+)\b([^>]*?)\/?>/g)) {
      if (!SVG_SHAPES.has(tag)) continue;
      const attrs = Object.fromEntries([...attrText.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      const fill = fills[attrs.class] ?? attrs.fill ?? '#ffffff';
      if (!color && tag === 'circle' && attrs.r === '128') {
        color = fill;
        continue;
      }
      shapes.push([tag, {...Object.fromEntries(Object.entries(attrs).filter(([k]) => SVG_KEEP.has(k))), fill}]);
    }
    if (!color || !shapes.length) throw new Error(`${type} icon: unexpected SVG`);
    out[type] = {color, shapes};
  }
  return out;
}

async function main() {
  // `--tables` rebuilds just the move/ability/item tables (no Smogon stats, priors untouched).
  const args = process.argv.slice(2);
  const tablesOnly = args.includes('--tables');
  fs.mkdirSync(OUT_DIR, {recursive: true});
  const moves = buildMoves();
  fs.writeFileSync(path.join(ROOT, 'src', 'data', 'moves.gen.json'), JSON.stringify(moves));
  console.log(`Move effects: ${Object.keys(moves).length} moves`);
  const abilities = buildAbilities();
  fs.writeFileSync(path.join(ROOT, 'src', 'data', 'abilities.gen.json'), JSON.stringify(abilities));
  console.log(`Legal abilities: ${Object.keys(abilities).length} species`);
  const icons = await buildItemIcons();
  fs.writeFileSync(path.join(ROOT, 'src', 'data', 'items.gen.json'), JSON.stringify(icons));
  console.log(`Item icons: ${Object.keys(icons).length} items`);
  const typeIcons = await buildTypeIcons();
  fs.writeFileSync(path.join(ROOT, 'src', 'data', 'types.gen.json'), JSON.stringify(typeIcons));
  console.log(`Type icons: ${Object.keys(typeIcons).length} types`);
  if (tablesOnly) return;

  const month = args.find(a => !a.startsWith('--')) || await latestMonth();
  console.log(`Smogon structure from ${month}`);
  const files = await listChaosFiles(month);
  const index = [];
  for (const format of FORMATS) {
    const structure = await buildStructure(month, files, format);
    const {smogonPrefix: _unused, ...info} = format;
    index.push({...info, gen: 0, level: 50, itemClause: true, structure});
  }
  fs.writeFileSync(path.join(OUT_DIR, 'formats.json'), JSON.stringify({generated: new Date().toISOString(), formats: index}, null, 2));
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith('gen9')) fs.unlinkSync(path.join(OUT_DIR, f)); // formats from the Showdown-first version
  }
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
