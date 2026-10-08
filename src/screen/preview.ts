/**
 * Team preview read off the screen: which of its two screens is up (choosing the four to bring, then standing by
 * with them numbered), and on it their six, each shown as an icon (a small 3D render), its types and its gender,
 * never its name. The icon is told apart by its colours, which stay the same whatever its pose (the game's renders
 * aren't posed as Showdown's are), against a table built from Showdown's renders (scripts/build-icons.mjs).
 * Pure functions on RGBA pixels, like vision.ts, so they run in the worker, the build script and tests alike.
 */
import type {Pixels, Rect} from './vision';

export type PreviewScreen = 'select' | 'standby';

/** The game's picture at 1920×1080: where each thing is, as measured on BlueStacks. Six slots a side, 126 apart. */
export const SLOT = {w: 298, h: 114, pitch: 126};
/** The top left of the first of each side's slots, on each screen. */
export const SLOTS = {
  theirs: {select: {x: 1558, y: 155}, standby: {x: 1328, y: 175}},
  ours: {select: {x: 82, y: 163}, standby: {x: 295, y: 174}},
} as const;
/** In one of their slots: the type symbols (a single type takes the right one), the gender mark, the icon. */
export const IN_SLOT = {
  types: [{x: 190, y: 12, w: 46, h: 45}, {x: 241, y: 12, w: 46, h: 45}],
  gender: {x: 198, y: 74, w: 26, h: 25},
  /** Right of the warning badge the standby screen can put at a slot's top left. */
  icon: {x: 56, y: 2, w: 132, h: 110},
};
/** In one of ours: its name (while choosing; a nickname if it has one), its number once picked (standing by). */
export const IN_OUR_SLOT = {name: {x: 54, y: 6, w: 344, h: 40}, pick: {x: 8, y: 26, w: 64, h: 64}};
/** "Ranked Battles   Double Battle", at the top of both screens. */
export const HEADER = {x: 740, y: 22, w: 560, h: 44};

/** A place on the game's picture (at 1920×1080), in the frame's pixels: `area` is the picture in the frame. */
export function gameBox(area: Rect, r: Rect): Rect {
  const s = area.w / 1920;
  return {x: Math.round(area.x + r.x * s), y: Math.round(area.y + r.y * s), w: Math.round(r.w * s), h: Math.round(r.h * s)};
}

/** A box in one of a side's six slots (the whole slot by default), in the frame's pixels. */
export function slotBox(area: Rect, side: keyof typeof SLOTS, screen: PreviewScreen, slot: number, inSlot: Rect = {x: 0, y: 0, w: SLOT.w, h: SLOT.h}): Rect {
  const o = SLOTS[side][screen];
  return gameBox(area, {x: o.x + inSlot.x, y: o.y + SLOT.pitch * slot + inSlot.y, w: inSlot.w, h: inSlot.h});
}

export const TYPE_NAMES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
] as const;
export type TypeName = (typeof TYPE_NAMES)[number];

/**
 * Each type symbol's colour as symbolColour measures it: Scarlet and Violet's palette, which two recorded battles
 * matched to within a few levels, Dark a little darker. Normal, Fighting, Ice and Rock are the palette's (not seen yet).
 */
const TYPE_RGB: Record<TypeName, [number, number, number]> = {
  Normal: [159, 161, 159], Fire: [233, 41, 40], Water: [40, 128, 238], Electric: [248, 193, 2], Grass: [62, 160, 39],
  Ice: [61, 206, 243], Fighting: [255, 128, 0], Poison: [142, 64, 202], Ground: [143, 81, 32], Flying: [127, 184, 237],
  Psychic: [239, 65, 118], Bug: [146, 163, 36], Rock: [175, 169, 129], Ghost: [114, 70, 114], Dragon: [81, 97, 221],
  Dark: [80, 64, 64], Steel: [102, 162, 183], Fairy: [239, 122, 238],
};

/** A pixel of a slot's crimson panel (whatever shows through it). */
export function isPanel(r: number, g: number, b: number): boolean {
  return g <= 65 && b - g >= 10 && r >= 1.5 * b && r <= 3.3 * b && r >= 60;
}

/**
 * Which team preview screen a frame shows, if either: their six's slots, crimson down their left margins (a badge or
 * a laser over one or two aside), in the place one of the screens has them, each a panel of its own, with the stadium
 * between them, and none of ours crimson. The info screen on a Pokémon in battle (its stats and statuses) is one
 * crimson panel across all of that: on 5 Oct it passed for standing by, and opened a battle against six it made up.
 */
export function previewScreen(grab: (box: Rect) => Pixels, area: Rect): PreviewScreen | null {
  const crimson = (boxes: Rect[], early?: number) => {
    let hit = 0;
    let n = 0;
    for (const [k, box] of boxes.entries()) {
      const {data: d} = grab(box);
      for (let i = 0; i < d.length; i += 4) {
        n++;
        if (isPanel(d[i], d[i + 1], d[i + 2])) hit++;
      }
      // Not even the first: not this screen (the rest isn't looked at, mid-battle).
      if (k === 0 && early !== undefined && hit < early * n) return 0;
    }
    return n ? hit / n : 0;
  };
  const six = [0, 1, 2, 3, 4, 5];
  const is = (screen: PreviewScreen) => crimson(six.map(k => slotBox(area, 'theirs', screen, k, {x: 6, y: 58, w: 20, h: 46})), 0.3) > 0.7
    && crimson(six.slice(0, 5).map(k => slotBox(area, 'theirs', screen, k, {x: 40, y: 116, w: 200, h: 8}))) < 0.3
    && crimson(six.map(k => slotBox(area, 'ours', screen, k, {x: 10, y: 20, w: 40, h: 70}))) < 0.3;
  // The standby screen's slots overlap where the other screen has its margins (its type symbols): it's checked first.
  if (is('standby')) return 'standby';
  if (is('select')) return 'select';
  return null;
}

/** What's in a type symbol's place: its colour, and how much of it is white (its glyph). */
export interface TypeMark {
  rgb: [number, number, number];
  white: number;
}

/** A type symbol's place in a slot, looked at: the colour of the symbol there, if there is one. */
export function symbolColour(px: Pixels): TypeMark {
  const {width: W, height: H, data: d} = px;
  // Inside the symbol: its colour and its white glyph, blended at the glyph's edges.
  const inset = Math.round(W * 0.15);
  const cols: [number, number, number, number][] = [];
  for (let y = inset; y < H - inset; y++) for (let x = inset; x < W - inset; x++) {
    const i = (y * W + x) * 4;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    cols.push([r, g, b, (255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2]);
  }
  // The symbol's colour: the quarter of its pixels furthest from white (at most 70% of it is glyph).
  cols.sort((a, b) => b[3] - a[3]);
  const far = cols.slice(0, Math.max(1, cols.length >> 2));
  const rgb = [0, 1, 2].map(c => far.map(p => p[c]).sort((a, b) => a - b)[far.length >> 1]) as [number, number, number];
  const white = cols.filter(p => p[0] > 200 && p[1] > 200 && p[2] > 200).length / cols.length;
  return {rgb, white};
}

/** No symbol there, just the panel (theirs are on crimson). */
export const noSymbol = (s: TypeMark) => s.white < 0.1 && isPanel(...s.rgb);

/** How far a symbol's colour is from a type's. */
export const typeOff = (s: TypeMark, type: TypeName) => {
  const [r, g, b] = TYPE_RGB[type];
  return Math.hypot(r - s.rgb[0], g - s.rgb[1], b - s.rgb[2]);
};

/** A slot's type symbol, as the type nearest its colour, or null if there's none (just the panel). */
export function symbolType(px: Pixels): {type: TypeName; off: number} | null {
  const s = symbolColour(px);
  if (noSymbol(s)) return null;
  let best: {type: TypeName; off: number} | null = null;
  for (const type of TYPE_NAMES) {
    const off = typeOff(s, type);
    if (!best || off < best.off) best = {type, off};
  }
  return best;
}

/** The gender mark: ♂ blue, ♀ red, none (genderless). */
export function genderMark(px: Pixels): 'M' | 'F' | 'N' {
  const d = px.data;
  let blue = 0;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 2] > 150 && d[i] < 110 && d[i + 2] > d[i + 1] + 60) blue++;
    else if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 110 && d[i] > 2.2 * d[i + 2]) red++;
  }
  const n = d.length / 4;
  if (blue > 0.15 * n && blue > 2 * red) return 'M';
  if (red > 0.15 * n && red > 2 * blue) return 'F';
  return 'N';
}

/** Per pixel, the median of the frames' (the same box in each): lasers sweeping across the slots gone. */
export function medianOf(frames: readonly Pixels[]): Pixels {
  const {width: W, height: H} = frames[0];
  const data = new Uint8ClampedArray(W * H * 4);
  const v = new Uint8Array(frames.length);
  for (let i = 0; i < W * H * 4; i++) {
    if ((i & 3) === 3) {
      data[i] = 255;
      continue;
    }
    for (let k = 0; k < frames.length; k++) v[k] = frames[k].data[i];
    v.sort();
    data[i] = v[frames.length >> 1];
  }
  return {width: W, height: H, data};
}

/** Which pixels are the icon (1): not the panel, laser specks and stray bits taken off, its outer edge peeled. */
export function iconMask(px: Pixels): Uint8Array {
  const {width: W, height: H, data: d} = px;
  let m: Uint8Array = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = isPanel(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) ? 0 : 1;
  // Opened (eroded, then grown back): lines a few pixels thin go.
  m = grow(shrink(m, W, H, 1), W, H, 1);
  m = largestParts(m, W, H);
  // Its edge blends into the panel: colours are taken from inside it.
  return shrink(m, W, H, 1);
}

function shrink(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = r; y < H - r; y++) for (let x = r; x < W - r; x++) {
    let all = 1;
    for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r; dx++) if (!m[(y + dy) * W + x + dx]) {
      all = 0;
      break;
    }
    out[y * W + x] = all;
  }
  return out;
}

function grow(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy;
      const xx = x + dx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) out[yy * W + xx] = 1;
    }
  }
  return out;
}

/** The connected parts of a mask big enough to be the icon (a tenth of the biggest), the rest dropped. */
function largestParts(m: Uint8Array, W: number, H: number): Uint8Array {
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || label[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % W;
      const y = (j - x) / W;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) {
        if (k >= 0 && m[k] && label[k] < 0) {
          label[k] = id;
          stack.push(k);
        }
      }
    }
    sizes.push(size);
  }
  const big = Math.max(0, ...sizes);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (label[i] >= 0 && sizes[label[i]] >= Math.max(20, big / 10)) out[i] = 1;
  return out;
}

/** CIELAB from sRGB (D65). */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The colour histogram's bins: lightness, then the two colour axes, each soft-binned between its neighbours. */
export const BINS = {L: 6, a: 8, b: 8};
const L_STEP = 100 / (BINS.L - 1);
const AB_MIN = -64;
const AB_STEP = 128 / (BINS.a - 1);

/** An icon's colours: how much of it falls in each Lab bin (summing to 1). `mask`: its pixels (1). */
export function colourHistogram(px: Pixels, mask: Uint8Array): Float32Array {
  const hist = new Float32Array(BINS.L * BINS.a * BINS.b);
  const d = px.data;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const [L, A, B] = lab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const fl = Math.min(BINS.L - 1.001, Math.max(0, L / L_STEP));
    const fa = Math.min(BINS.a - 1.001, Math.max(0, (A - AB_MIN) / AB_STEP));
    const fb = Math.min(BINS.b - 1.001, Math.max(0, (B - AB_MIN) / AB_STEP));
    const [l0, a0, b0] = [Math.floor(fl), Math.floor(fa), Math.floor(fb)];
    const [tl, ta, tb] = [fl - l0, fa - a0, fb - b0];
    for (let dl = 0; dl < 2; dl++) for (let da = 0; da < 2; da++) for (let db = 0; db < 2; db++) {
      const w = (dl ? tl : 1 - tl) * (da ? ta : 1 - ta) * (db ? tb : 1 - tb);
      hist[((l0 + dl) * BINS.a + a0 + da) * BINS.b + b0 + db] += w;
    }
    n++;
  }
  if (n) for (let k = 0; k < hist.length; k++) hist[k] /= n;
  return hist;
}

/** A box of a picture, as a picture of its own. */
export function cutOut(px: Pixels, r: Rect): Pixels {
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * px.width + r.x) * 4;
    data.set(px.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return {width: r.w, height: r.h, data};
}

/** What one of their slots shows: its two type symbols' places (left, right), its gender mark, its icon's colours. */
export interface SlotLook {
  types: [TypeMark, TypeMark];
  gender: 'M' | 'F' | 'N';
  /** Its colour histogram's square roots. */
  colours: Float32Array;
  /** How many of the icon's pixels it's from. */
  size: number;
}

/** One of their slots looked at (`slot`: its picture, `scale`: the game's picture's width over 1920). */
export function lookAt(slot: Pixels, scale: number): SlotLook {
  const sub = (r: Rect) => cutOut(slot, {x: Math.round(r.x * scale), y: Math.round(r.y * scale), w: Math.round(r.w * scale), h: Math.round(r.h * scale)});
  const icon = sub(IN_SLOT.icon);
  const mask = iconMask(icon);
  return {
    types: [symbolColour(sub(IN_SLOT.types[0])), symbolColour(sub(IN_SLOT.types[1]))],
    gender: genderMark(sub(IN_SLOT.gender)),
    colours: roots(colourHistogram(icon, mask)),
    size: mask.reduce((n, v) => n + v, 0),
  };
}

const roots = (h: Float32Array) => h.map(Math.sqrt);

/** A species in the icon table: what team preview shows of it, and its colours (square roots), normal and shiny. */
export interface IconEntry {
  name: string;
  types: TypeName[];
  /** Its only gender ('N': none), or '' if it can be either. */
  gender: '' | 'M' | 'F' | 'N';
  normal: Float32Array;
  shiny: Float32Array;
}

/** As src/data/icons.gen.json keeps it: each histogram's square roots a byte a bin, zeros skipped, in base64. */
export interface StoredIcon {
  name: string;
  types: string[];
  gender?: string;
  normal: string;
  shiny: string;
}

/** Square roots (summing to 1 squared) as stored: pairs of (zero bins skipped, value in 255ths), in base64. */
export function packColours(r: ArrayLike<number>): string {
  const bytes: number[] = [];
  let skip = 0;
  for (let k = 0; k < r.length; k++) {
    const q = Math.round(r[k] * 255);
    if (!q) {
      skip++;
      continue;
    }
    for (; skip > 255; skip -= 256) bytes.push(255, 0);
    bytes.push(skip, q);
    skip = 0;
  }
  return btoa(String.fromCharCode(...bytes));
}

export function unpackColours(s: string, bins = BINS.L * BINS.a * BINS.b): Float32Array {
  const bytes = atob(s);
  const out = new Float32Array(bins);
  let k = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    k += bytes.charCodeAt(i);
    if (k < bins) out[k] = bytes.charCodeAt(i + 1) / 255;
    k++;
  }
  // Back to unit length (rounding to bytes moved it a little).
  const len = Math.hypot(...out) || 1;
  for (let j = 0; j < bins; j++) out[j] /= len;
  return out;
}

export function iconTable(stored: readonly StoredIcon[]): IconEntry[] {
  return stored.map(s => ({
    name: s.name,
    types: s.types as TypeName[],
    gender: (s.gender ?? '') as IconEntry['gender'],
    normal: unpackColours(s.normal),
    shiny: unpackColours(s.shiny),
  }));
}

/** How unlike two icons' colours are (their histograms' square roots): 0 the same, 1 nothing in common (Hellinger). */
export function colourDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let bc = 0;
  for (let k = 0; k < a.length; k++) bc += a[k] * b[k];
  return Math.sqrt(Math.max(0, 1 - bc));
}

/**
 * How badly a species' types fit the symbols shown: nothing for a colour within 20 levels of its type's, a point for
 * 60 off; two for a symbol where it has none, or none where it has one (a single type shows on the right).
 */
export function typeCost(look: SlotLook, types: readonly TypeName[]): number {
  const [left, right] = look.types;
  const off = (m: TypeMark, t: TypeName) => Math.max(0, typeOff(m, t) - 20) / 40;
  if (types.length === 1) return (noSymbol(left) ? 0 : 2) + off(right, types[0]);
  return (noSymbol(left) ? 2 : off(left, types[0])) + off(right, types[1]);
}

/** A point if the gender mark says it can't be that species (♂ on a female-only one, none on one that has a gender…). */
export function genderCost(mark: SlotLook['gender'], gender: IconEntry['gender']): number {
  if (mark === 'N') return gender === 'N' ? 0 : 1;
  return gender === '' || gender === mark ? 0 : 1;
}

/** A guess at one of their six: the species, whether shiny, and how badly it fits (lower is better). */
export interface IconGuess {
  name: string;
  shiny: boolean;
  cost: number;
}

/** The species that fit a slot best, best first: colours, types and gender mark added up, one guess a species. */
export function rankIcons(look: SlotLook, table: readonly IconEntry[], n = 5): IconGuess[] {
  const all: IconGuess[] = [];
  for (const e of table) {
    const fixed = typeCost(look, e.types) + genderCost(look.gender, e.gender);
    const normal = colourDistance(look.colours, e.normal);
    const shiny = colourDistance(look.colours, e.shiny);
    all.push({name: e.name, shiny: shiny < normal, cost: fixed + Math.min(normal, shiny)});
  }
  return all.sort((a, b) => a.cost - b.cost).slice(0, n);
}
