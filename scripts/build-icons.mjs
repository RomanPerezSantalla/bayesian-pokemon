#!/usr/bin/env node
// The icon table the screen reader matches their six against at team preview: `npm run data:icons`.
//
// Team preview shows the opponent's six as small 3D renders with their types, and no names. Showdown hosts renders
// that look the same, shiny ones too (sprites/home-centered/, sprites/home-centered-shiny/); they're fetched once into
// .cache/icons and .cache/icons-shiny (about 20 KB each; Showdown sends no CORS headers, which is why this runs at build
// time) and boiled down to src/data/icons.gen.json.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import calc from '@smogon/calc';
import {BINS, colourHistogram, iconMask, packColours} from '../src/screen/preview.ts';

const {Generations, toID} = calc;
const gen = Generations.get(0); // Pokémon Champions in @smogon/calc
const gen9 = Generations.get(9);

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'icons.gen.json');
const VARIANTS = {
  normal: {dir: path.join(ROOT, '.cache', 'icons'), url: 'https://play.pokemonshowdown.com/sprites/home-centered/'},
  shiny: {dir: path.join(ROOT, '.cache', 'icons-shiny'), url: 'https://play.pokemonshowdown.com/sprites/home-centered-shiny/'},
};

/** Formes that only exist in battle, shown at team preview as their regular forme. */
const BATTLE_ONLY = /-(Mega|Gmax|Blade|Both|Hero|Busted|Hangry|Sunny|Rainy|Snowy)(-|$)/;
const SPRITE_IDS = {'Aegislash-Shield': 'aegislash'};

/** Showdown's sprite name for a species: its regular forme's, then the forme's, as in src/data/dex.ts. */
function spriteIds(name) {
  if (SPRITE_IDS[name]) return [SPRITE_IDS[name]];
  const sp = gen.species.get(toID(name));
  const base = [sp?.baseSpecies, gen9.species.get(toID(name))?.baseSpecies].find(b => b && name.startsWith(`${b}-`));
  if (!base) return [toID(name)];
  return [`${toID(base)}-${toID(name.slice(base.length + 1))}`, toID(base)];
}

export function roster() {
  return [...gen.species].map(s => s.name).filter(n => !BATTLE_ONLY.test(n)).sort();
}

async function fetchIcon(name, variant) {
  const {dir, url} = VARIANTS[variant];
  for (const id of spriteIds(name)) {
    const file = path.join(dir, `${id}.png`);
    if (fs.existsSync(file)) return {name, id, file};
    const res = await fetch(`${url}${id}.png`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return {name, id, file, fetched: true};
  }
  return {name, missing: true};
}

async function fetchAll(names, variant) {
  fs.mkdirSync(VARIANTS[variant].dir, {recursive: true});
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      out.push(await fetchIcon(name, variant));
    }
  };
  await Promise.all(Array.from({length: 4}, worker));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A PNG (8 bits a channel, not interlaced: Showdown's renders) as RGBA pixels. */
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, ct = 0, palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      [width, height, ct] = [body.readUInt32BE(0), body.readUInt32BE(4), body[9]];
      if (body[8] !== 8 || body[12] !== 0) throw new Error(`PNG with ${body[8]} bits or interlaced`);
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? rows[dst + x - ch] : 0, b = y ? rows[dst - stride + x] : 0, c = y && x >= ch ? rows[dst - stride + x - ch] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      rows[dst + x] = (raw[src + x] + pred) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, d = i * 4;
    if (ct === 3) {
      const k = rows[s];
      data.set([palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2], trns && k < trns.length ? trns[k] : 255], d);
    } else if (ct >= 2 && ct !== 4) data.set([rows[s], rows[s + 1], rows[s + 2], ct === 6 ? rows[s + 3] : 255], d);
    else data.set([rows[s], rows[s], rows[s], ct === 4 ? rows[s + 1] : 255], d);
  }
  return {width, height, data};
}

/**
 * A render as team preview shows it: at half size (the game's icons are some 90 pixels high at 1080) on the slots'
 * crimson, so it's cut out by the same rule as the game's.
 */
function asShown(png) {
  const PANEL = [125, 5, 47];
  const W = png.width >> 1, H = png.height >> 1, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sum = [0, 0, 0];
    let alpha = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const i = ((2 * y + dy) * png.width + 2 * x + dx) * 4, a = png.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) sum[c] += png.data[i + c] * a;
      alpha += a;
    }
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) data[o + c] = sum[c] / 4 + PANEL[c] * (1 - alpha / 4);
    data[o + 3] = 255;
  }
  return {width: W, height: H, data};
}

function colours(file) {
  const px = asShown(decodePng(fs.readFileSync(file)));
  return packColours(colourHistogram(px, iconMask(px)).map(Math.sqrt));
}

const found = {};
for (const variant of Object.keys(VARIANTS)) {
  const icons = await fetchAll(roster(), variant);
  const fetched = icons.filter(i => i.fetched).length;
  const missing = icons.filter(i => i.missing).map(i => i.name);
  console.log(`${variant}: ${icons.length} species, ${fetched} fetched, ${icons.length - fetched - missing.length} cached${missing.length ? `, missing: ${missing.join(', ')}` : ''}`);
  found[variant] = new Map(icons.filter(i => i.file).map(i => [i.name, i.file]));
}

const icons = [];
for (const name of roster()) {
  const normal = found.normal.get(name);
  if (!normal) continue;
  const sp = gen.species.get(toID(name));
  icons.push({
    name,
    types: sp.types,
    ...(sp.gender ? {gender: sp.gender} : {}),
    normal: colours(normal),
    shiny: colours(found.shiny.get(name) ?? normal),
  });
}
const table = {
  source: "Showdown's renders (play.pokemonshowdown.com/sprites/home-centered, home-centered-shiny): see scripts/build-icons.mjs",
  bins: [BINS.L, BINS.a, BINS.b],
  icons,
};
fs.writeFileSync(OUT, `${JSON.stringify(table)}
`);
console.log(`${path.relative(ROOT, OUT)}: ${icons.length} species, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
