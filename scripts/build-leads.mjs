#!/usr/bin/env node
// Leads in Champions VGC, from Showdown's public replays: the two of their six players lead with, and the two they
// bring in the back. Replays are fetched once into .cache/replays (one request at a time, a few a second), then
// counted into public/data/leads-doubles.json (the model that reads it: src/engine/leads.ts).
//
//   npm run data:leads                       about 3000 battles of the current regulation (fetching what isn't cached)
//   npm run data:leads -- --battles=5000     more
//   npm run data:leads -- --offline          only what's cached
//   npm run data:leads -- --formats=gen9championsvgc2026regmc,gen9championsvgc2026regmcbo3
import fs from 'node:fs';
import path from 'node:path';
import calc from '@smogon/calc';
import {Dex} from '@pkmn/dex';
import {backOdds, backOddsByRates, eachOdds, leadId, leadName, leadOdds, leadOddsByRates} from '../src/engine/leads.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'replays');
const OUT = path.join(ROOT, 'public', 'data', 'leads-doubles.json');
const SEARCH = 'https://replay.pokemonshowdown.com/search.json';
const LOG = id => `https://replay.pokemonshowdown.com/${id}.log`;
/** The current regulation, its best-of-one and best-of-three ladders. */
const FORMATS = ['gen9championsvgc2026regmc', 'gen9championsvgc2026regmcbo3'];
/** Between requests: Showdown's replay server is shared. */
const PAUSE_MS = 300;
/** Players whose sides are held out to measure the model on, before it's counted from all of them. */
const HOLDOUT = 0.2;

const champions = calc.Generations.get(0);
const fullSpecies = name => {
  const s = Dex.species.get(name);
  return s.exists ? s : undefined;
};
const folded = new Map();
/** The name a species is counted under (see leadName). */
const fold = name => folded.get(name) ?? folded.set(name, leadName(fullSpecies, name)).get(name);

// --- a battle's two sides: their six, the two that led, the ones brought --------------------------------------

const speciesOf = details => details.split(',')[0].trim();

/** The one of the six a switch names: itself, else the one it's a forme of (a Mega coming back in as one). */
function ofSix(six, species) {
  if (six.includes(species)) return species;
  const base = champions.species.get(leadId(species))?.baseSpecies;
  if (base && six.includes(base)) return base;
  return six.filter(x => species.startsWith(`${x}-`)).sort((a, b) => b.length - a.length)[0] ?? species;
}

/** Each side of one battle with team preview: its player, six, the two that led, the ones brought. */
export function sidesOf(log) {
  const sides = {};
  for (const p of ['p1', 'p2']) sides[p] = {player: '', six: [], leads: [], seen: new Map()};
  /** Who's in each place now, and whether it led there. */
  const at = {};
  let started = false;
  for (const line of log.split('\n')) {
    const parts = line.split('|');
    const kind = parts[1];
    if (kind === 'player' && sides[parts[2]] && parts[3]) sides[parts[2]].player = parts[3];
    else if (kind === 'poke' && sides[parts[2]]) sides[parts[2]].six.push(speciesOf(parts[3]));
    else if (kind === 'turn' && parts[2] === '1') started = true;
    else if (kind === 'switch' || kind === 'drag' || kind === 'replace') {
      const place = parts[2].split(':')[0];
      const side = sides[place.slice(0, 2)];
      if (!side) continue;
      const species = ofSix(side.six, speciesOf(parts[3]));
      const was = at[place];
      if (kind === 'replace' && was) {
        // Illusion seen through: the one it was posing as never came in.
        const n = (side.seen.get(was.species) ?? 1) - 1;
        if (n > 0) side.seen.set(was.species, n);
        else side.seen.delete(was.species);
        if (was.lead) side.leads[side.leads.indexOf(was.species)] = species;
      } else if (!started) side.leads.push(species);
      side.seen.set(species, (side.seen.get(species) ?? 0) + 1);
      at[place] = {species, lead: kind === 'replace' ? !!was?.lead : !started};
    }
  }
  const out = [];
  for (const s of Object.values(sides)) {
    const brought = [...s.seen.keys()];
    const ok = s.six.length === 6 && new Set(s.six).size === 6 && s.leads.length === 2 && s.leads[0] !== s.leads[1]
      && brought.length <= 4 && brought.every(x => s.six.includes(x));
    if (!ok) {
      out.push({rejected: s.six.length !== 6 ? 'six' : s.leads.length !== 2 ? 'leads' : brought.length > 4 ? 'over four'
        : `unmatched ${brought.filter(x => !s.six.includes(x)).join(', ')}`});
      continue;
    }
    out.push({player: s.player, six: s.six.map(fold), leads: s.leads.map(fold), brought: brought.map(fold), complete: brought.length === 4});
  }
  return out;
}

// --- counting --------------------------------------------------------------------------------------------------

const key = ([a, b]) => (leadId(a) < leadId(b) ? `${leadId(a)}|${leadId(b)}` : `${leadId(b)}|${leadId(a)}`);
const restOf = s => s.six.filter(x => !s.leads.includes(x));
const backOf = s => restOf(s).filter(x => s.brought.includes(x));
const teamOf = s => `${s.player}#${[...s.six].sort().join(',')}`;

/** Formes of Champions' species counted as another. */
function aliases() {
  const out = {};
  for (const sp of champions.species) if (leadId(fold(sp.name)) !== sp.id) out[sp.id] = leadId(fold(sp.name));
  return out;
}

/**
 * The table, from these sides. Each player's team counts once in all, however many games it played: a few players
 * play most of the games, and their habits don't carry over to the next player (held out by player, the counts
 * weighed so came out better on every measure).
 */
function count(sides, tuning, {pairs = true, links = true} = {}) {
  const games = new Map();
  for (const s of sides) games.set(teamOf(s), (games.get(teamOf(s)) ?? 0) + 1);
  const w = s => 1 / games.get(teamOf(s));
  const species = {};
  for (const s of sides) {
    for (const x of s.six) {
      const e = (species[leadId(x)] ??= [0, 0, 0, 0]);
      e[0] += w(s);
      if (s.leads.includes(x)) e[1] += w(s);
      if (s.complete && !s.leads.includes(x)) {
        e[2] += w(s);
        if (s.brought.includes(x)) e[3] += w(s);
      }
    }
  }
  const t = {species, pairs: {}, links: {}, aliases: aliases(), tuning};
  // Pairs: how often they led (or went in the back) together, against what the rates alone expect.
  if (pairs) for (const s of sides) {
    for (const {pair, p} of leadOddsByRates(t, s.six)) (t.pairs[key(pair)] ??= [0, 0, 0, 0])[1] += p * w(s);
    t.pairs[key(s.leads)][0] += w(s);
    if (!s.complete) continue;
    for (const {pair, p} of backOddsByRates(t, restOf(s))) t.pairs[key(pair)][3] += p * w(s);
    t.pairs[key(backOf(s))][2] += w(s);
  }
  // Links: how often one was in the back with this one leading, against what the rates and pairs expect.
  if (links) for (const s of sides) {
    if (!s.complete) continue;
    const each = eachOdds(backOdds(t, s.six, s.leads));
    for (const lead of s.leads) for (const x of restOf(s)) {
      const l = (t.links[`${leadId(lead)}>${leadId(x)}`] ??= [0, 0]);
      l[1] += (each.get(x) ?? 0) * w(s);
      if (s.brought.includes(x)) l[0] += w(s);
    }
  }
  return t;
}

/** Rounded, and without the entries that move their lift off 1 by little, so the file stays small. */
function pruned(t, cut = 0.05) {
  const pad = t.tuning.pad;
  const far = (seen, expected) => Math.abs(Math.log((seen + pad) / (expected + pad))) > cut;
  const round = x => Math.round(x * 100) / 100;
  const species = {};
  for (const [k, v] of Object.entries(t.species)) species[k] = v.map(round);
  const pairs = {};
  for (const [k, v] of Object.entries(t.pairs)) if (far(v[0], v[1]) || far(v[2], v[3])) pairs[k] = v.map(round);
  const links = {};
  for (const [k, v] of Object.entries(t.links)) if (far(v[0], v[1])) links[k] = v.map(round);
  return {...t, species, pairs, links};
}

/** How the model does on sides it wasn't counted from: where the true pair ranks, and the odds it gave it. */
function measure(t, sides) {
  const m = {sides: 0, complete: 0, leadTop1: 0, leadTop3: 0, leadTop5: 0, leadLog: 0, backTop1: 0, backTop2: 0, backLog: 0};
  for (const s of sides) {
    const odds = leadOdds(t, s.six);
    const rank = odds.findIndex(o => key(o.pair) === key(s.leads));
    m.sides++;
    m.leadTop1 += +(rank < 1);
    m.leadTop3 += +(rank < 3);
    m.leadTop5 += +(rank < 5);
    m.leadLog += Math.log(odds[rank].p);
    if (!s.complete) continue;
    const bodds = backOdds(t, s.six, s.leads);
    const brank = bodds.findIndex(o => key(o.pair) === key(backOf(s)));
    m.complete++;
    m.backTop1 += +(brank < 1);
    m.backTop2 += +(brank < 2);
    m.backLog += Math.log(bodds[brank].p);
  }
  return m;
}

/** Five folds by player: each fold's players measured on a table counted from the others'. */
function crossChecked(sides, tuning, opts, cut) {
  const fold = s => [...s.player].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 5;
  const sum = {};
  for (let k = 0; k < 5; k++) {
    const m = measure(pruned(count(sides.filter(s => fold(s) !== k), tuning, opts), cut), sides.filter(s => fold(s) === k));
    for (const [name, v] of Object.entries(m)) sum[name] = (sum[name] ?? 0) + v;
  }
  return {
    leadTop1: sum.leadTop1 / sum.sides, leadTop3: sum.leadTop3 / sum.sides, leadTop5: sum.leadTop5 / sum.sides,
    leadOdds: Math.exp(sum.leadLog / sum.sides),
    backTop1: sum.backTop1 / sum.complete, backTop2: sum.backTop2 / sum.complete, backOdds: Math.exp(sum.backLog / sum.complete),
  };
}

// --- the replays, cached ----------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const wait = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (k >= tries) throw err;
      await wait(2000 * k);
    }
  }
}

/** The newest replays of each format, then older pages, until there are `want` of each. */
async function listReplays(index, indexFile, formats, want) {
  for (const format of formats) {
    const known = (index[format] ??= []);
    const ids = new Set(known.map(r => r.id));
    let before = null;
    while (known.length < want) {
      const page = JSON.parse((await get(`${SEARCH}?format=${format}${before ? `&before=${before}` : ''}`)) ?? '[]');
      for (const r of page) if (!ids.has(r.id)) {
        ids.add(r.id);
        known.push({id: r.id, uploadtime: r.uploadtime});
      }
      fs.writeFileSync(indexFile, JSON.stringify(index));
      if (page.length < 51) break;
      before = page[page.length - 1].uploadtime;
      await wait(PAUSE_MS);
    }
    console.log(`${format}: ${known.length} replays listed`);
  }
}

async function fetchLogs(replays) {
  const todo = replays.filter(r => !fs.existsSync(path.join(CACHE, 'logs', `${r.id}.log`)));
  let done = 0;
  for (const r of todo) {
    const log = await get(LOG(r.id));
    fs.writeFileSync(path.join(CACHE, 'logs', `${r.id}.log`), log ?? '');
    if (++done % 250 === 0) console.log(`  ${done}/${todo.length} logs`);
    await wait(PAUSE_MS);
  }
  console.log(`${todo.length} logs fetched`);
}

// --- main ------------------------------------------------------------------------------------------------------

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const formats = opt('formats')?.split(',') ?? FORMATS;
  const share = Math.ceil(Number(opt('battles') ?? 3000) / formats.length);
  fs.mkdirSync(path.join(CACHE, 'logs'), {recursive: true});
  const indexFile = path.join(CACHE, 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  if (!args.includes('--offline')) await listReplays(index, indexFile, formats, share);
  const replays = formats.flatMap(f => (index[f] ?? []).slice(0, share));
  if (!args.includes('--offline')) await fetchLogs(replays);

  const battles = replays.filter(r => fs.existsSync(path.join(CACHE, 'logs', `${r.id}.log`)))
    .map(r => ({...r, sides: sidesOf(fs.readFileSync(path.join(CACHE, 'logs', `${r.id}.log`), 'utf8'))}));
  const rejected = battles.flatMap(b => b.sides).filter(s => s.rejected);
  const all = battles.flatMap(b => b.sides).filter(s => !s.rejected);
  const why = {};
  for (const s of rejected) why[s.rejected] = (why[s.rejected] ?? 0) + 1;
  console.log(`${battles.length} battles: ${all.length} sides (${all.filter(s => s.complete).length} with all four seen), `
    + `${rejected.length} left out ${JSON.stringify(why)}`);

  const times = battles.map(b => b.uploadtime).sort((a, b) => a - b);
  const day = t => new Date(t * 1000).toISOString().slice(0, 10);
  const source = {formats, battles: battles.length, sides: all.length, complete: all.filter(s => s.complete).length, from: day(times[0]), to: day(times.at(-1))};

  // The shrinkage that predicts players held out best (by the odds given to what they did), and how well it does.
  const pc = x => `${(x * 100).toFixed(1)}%`.padStart(6);
  const show = (label, c) => console.log(`  ${label.padEnd(22)} leads: 1st ${pc(c.leadTop1)}, top 3 ${pc(c.leadTop3)}, top 5 ${pc(c.leadTop5)}, `
    + `odds ${c.leadOdds.toFixed(4)} | back two: 1st ${pc(c.backTop1)}, top 2 ${pc(c.backTop2)}, odds ${c.backOdds.toFixed(4)}`);
  console.log('cross-checked on players held out (five folds):');
  show('rates alone', crossChecked(all, {prior: 10, pad: 3}, {pairs: false, links: false}));
  let best = null;
  for (const prior of [5, 10, 20]) for (const pad of [2, 3, 5, 8]) {
    const c = crossChecked(all, {prior, pad});
    show(`prior ${prior}, pad ${pad}`, c);
    const score = Math.log(c.leadOdds) + Math.log(c.backOdds);
    if (!best || score > best.score) best = {score, tuning: {prior, pad}, c};
  }
  console.log(`  ${'at random'.padEnd(22)} leads: 1st   6.7%, top 3  20.0%, top 5  33.3%, odds 0.0667 | back two: 1st  16.7%, top 2  33.3%, odds 0.1667`);
  const r3 = x => Math.round(x * 1000) / 1000;
  const checked = {leadTop1: r3(best.c.leadTop1), leadTop5: r3(best.c.leadTop5), backTop1: r3(best.c.backTop1), backTop2: r3(best.c.backTop2)};
  console.log(`chosen: prior ${best.tuning.prior}, pad ${best.tuning.pad}`);

  const table = {source, ...pruned(count(all, best.tuning)), checked};
  fs.writeFileSync(OUT, JSON.stringify(table));
  console.log(`${path.relative(ROOT, OUT)}: ${Object.keys(table.species).length} species, ${Object.keys(table.pairs).length} pairs, `
    + `${Object.keys(table.links).length} links, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}
