/**
 * Reading Pokémon Champions' battle screen in a captured frame: where the game's picture is in the frame, where
 * each thing is on it, its white text found line by line and made ready for the recogniser, and the recogniser's
 * answer decoded. Pure functions on RGBA pixels (ImageData's shape), so they run in a worker and in tests alike.
 */

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A place on the game's 16:9 picture, measured on BlueStacks at 1920×1080 and kept as fractions of it. */
const at = (x: number, y: number, w: number, h: number): Rect => ({x: x / 1920, y: y / 1080, w: w / 1920, h: h / 1080});

export const REGIONS = {
  /** The message line ("The opposing Gholdengo used Shadow Ball!"): a message starts at MESSAGE_LEFT. */
  message: at(200, 779, 1520, 80),
  /** Ability and item pop-ups ("Raichu's" over "Electric Surge"), their text: yours from the left, theirs to the right. */
  popup: {me: at(40, 380, 580, 120), opp: at(1300, 380, 478, 120)},
  /** HP boxes as on screen, left then right: the name, and the number (theirs %, yours the HP left of the slash). */
  hpName: {opp: [at(1190, 47, 250, 52), at(1594, 47, 250, 52)], me: [at(150, 927, 250, 50), at(528, 927, 250, 50)]},
  hpValue: {opp: [at(1330, 115, 160, 58), at(1734, 115, 160, 58)], me: [at(200, 993, 157, 56), at(578, 993, 157, 56)]},
  /** "MOVE TIME 40": moves being chosen for the next turn. */
  moveTime: at(1570, 233, 320, 48),
  /** The field's timers ("Electric Terrain 4/5"). */
  field: at(300, 53, 560, 48),
};

/** Where a message's first letter is in the message region, at 1080 high (the game's text always starts there). */
export const MESSAGE_LEFT = 109;

/** A region of the game's picture, in frame pixels. */
export function place(area: Rect, r: Rect): Rect {
  return {x: Math.round(area.x + r.x * area.w), y: Math.round(area.y + r.y * area.h), w: Math.round(r.w * area.w), h: Math.round(r.h * area.h)};
}

/**
 * Where the game's 16:9 picture is in a frame (any scale): an emulator's title bar and side toolbar, flat-coloured
 * rows and columns at the frame's edges, cut off; what's left fitted to 16:9.
 */
export function gameArea(px: Pixels): Rect {
  const {width: W, height: H, data: d} = px;
  const near = (i: number, r: number, g: number, b: number) => Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 40;
  // The chrome's colour: the top right corner, which is title bar or toolbar wherever there's any.
  const c = (2 * W + (W - 3)) * 4;
  const [r, g, b] = [d[c], d[c + 1], d[c + 2]];
  const flatRow = (y: number) => {
    let n = 0;
    for (let x = 0; x < W; x++) if (near((y * W + x) * 4, r, g, b)) n++;
    return n / W > 0.6;
  };
  const flatCol = (x: number, y0: number) => {
    let n = 0;
    for (let y = y0; y < H; y++) if (near((y * W + x) * 4, r, g, b)) n++;
    return n / (H - y0) > 0.8;
  };
  let top = 0;
  while (top < H / 8 && flatRow(top)) top++;
  let right = 0;
  while (right < W / 8 && flatCol(W - 1 - right, top)) right++;
  let left = 0;
  while (left < W / 8 && flatCol(left, top)) left++;
  return fit({x: left, y: top, w: W - left - right, h: H - top});
}

/** The largest 16:9 box centred in `r`. */
function fit(r: Rect): Rect {
  const w = Math.min(r.w, (r.h * 16) / 9);
  const h = (w * 9) / 16;
  return {x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h};
}

/** The game's text: near-white, with a dark edge. */
const WHITE = 190;
const DARK = 110;
const isWhite = (d: Uint8ClampedArray, i: number) => d[i] > WHITE && d[i + 1] > WHITE && d[i + 2] > WHITE;

/** Which pixels of a region are the game's text (1), as a grid the region's size. */
export interface Mask {
  width: number;
  height: number;
  bits: Uint8Array;
}

/**
 * The game's text in a region: near-white pixels with something dark within `edge` pixels across or up and down (its
 * outline). Light in the scene behind mostly has no such edge, so moving scenery doesn't look like changing text.
 */
export function textMask(px: Pixels, edge = 3): Mask {
  const {width: W, height: H, data: d} = px;
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  const bits = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isWhite(d, i * 4)) continue;
      for (let k = 1; k <= edge; k++) {
        if ((x >= k && lum[i - k] < DARK) || (x + k < W && lum[i + k] < DARK) || (y >= k && lum[i - k * W] < DARK) || (y + k < H && lum[i + k * W] < DARK)) {
          bits[i] = 1;
          break;
        }
      }
    }
  }
  return {width: W, height: H, bits};
}

/** How many of a region's pixels are text. */
export function textAmount(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.bits.length; i++) n += m.bits[i];
  return n;
}

/**
 * The lines of text in a region, top to bottom: runs of rows with a few text pixels in them, at least `minHeight`
 * tall (stray specks aren't a line), each boxed to its text with a little margin.
 */
export function textLines(m: Mask, minHeight = 8): Rect[] {
  const {width: W, height: H, bits} = m;
  const rows = new Uint16Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rows[y] += bits[y * W + x];
  const out: Rect[] = [];
  for (let y = 0; y < H;) {
    if (rows[y] < 3) {
      y++;
      continue;
    }
    const y0 = y;
    while (y < H && rows[y] >= 3) y++;
    if (y - y0 < minHeight) continue;
    let x0 = W;
    let x1 = -1;
    for (let yy = y0; yy < y; yy++) for (let x = 0; x < W; x++) if (bits[yy * W + x]) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
    }
    const pad = 6;
    const bx = Math.max(0, x0 - pad);
    const by = Math.max(0, y0 - pad);
    out.push({x: bx, y: by, w: Math.min(W, x1 + pad + 1) - bx, h: Math.min(H, y + pad) - by});
  }
  return out;
}

/** Where the text is in a region (or a box in it), coarsely (text pixels counted on a grid): to tell whether it changed. */
export function textPrint(m: Mask, box: Rect = {x: 0, y: 0, w: m.width, h: m.height}, cols = 32, rows = 4): Uint16Array {
  const grid = new Uint16Array(cols * rows);
  const x1 = Math.min(m.width, box.x + box.w);
  const y1 = Math.min(m.height, box.y + box.h);
  for (let y = Math.max(0, box.y); y < y1; y++) {
    const gy = Math.min(rows - 1, Math.floor(((y - box.y) * rows) / box.h));
    for (let x = Math.max(0, box.x); x < x1; x++) {
      if (m.bits[y * m.width + x]) grid[gy * cols + Math.min(cols - 1, Math.floor(((x - box.x) * cols) / box.w))]++;
    }
  }
  return grid;
}

/** The same text, as far as the grid shows (a pixel or two of jitter aside). */
export function samePrint(a: Uint16Array | null, b: Uint16Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs(a[i] - b[i]);
    total += a[i] + b[i];
  }
  return diff <= Math.max(8, 0.06 * total);
}

/** The recogniser's input for a line: scaled to `height` (bilinear), BGR, (v / 255 − 0.5) / 0.5, channels first. */
export function recInput(px: Pixels, box: Rect, height = 48): {data: Float32Array; width: number} {
  const realW = Math.max(1, Math.round((box.w * height) / box.h));
  const W = Math.ceil(realW / 8) * 8;
  const out = new Float32Array(3 * height * W);
  const sx = box.w / realW;
  const sy = box.h / height;
  const {width: PW, height: PH, data: d} = px;
  for (let y = 0; y < height; y++) {
    const fy = box.y + (y + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(PH - 1, y0 + 1);
    const ay = fy - y0;
    for (let x = 0; x < realW; x++) {
      const fx = box.x + (x + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(PW - 1, x0 + 1);
      const ax = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (xx: number, yy: number) => d[(yy * PW + xx) * 4 + c];
        const v = (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
        out[(2 - c) * height * W + y * W + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
  return {data: out, width: W};
}

/**
 * The recogniser's answer (steps × classes of probabilities, class 0 the CTC blank, then the dictionary, then a space)
 * as text, with how sure it was (the mean probability of the characters it gave).
 */
export function ctcText(logits: Float32Array, steps: number, classes: number, dict: readonly string[]): {text: string; conf: number} {
  let text = '';
  let prev = -1;
  let sure = 0;
  let n = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bv = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = logits[t * classes + c];
      if (v > bv) {
        bv = v;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += best - 1 < dict.length ? dict[best - 1] : ' ';
      sure += bv;
      n++;
    }
    prev = best;
  }
  return {text, conf: n ? sure / n : 0};
}

/** How alike two readings are (0–1), on their letters and digits only. */
export function alike(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const y = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!x.length || !y.length) return x === y ? 1 : 0;
  let row = Array.from({length: y.length + 1}, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return 1 - row[y.length] / Math.max(x.length, y.length);
}

/**
 * An HP box is up: its name strip is the box's flat colour (theirs pink, yours violet; grey once it has fainted) with
 * the name in white on it, not whatever's behind.
 */
export function boxShown(px: Pixels, side: 'me' | 'opp'): boolean {
  const d = px.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let text = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 190) {
      text++;
      continue;
    }
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  // The name in white: some 5–12% of the strip (scenery behind has a few specks at most).
  if (!n || text < 0.04 * (n + text)) return false;
  [r, g, b] = [r / n, g / n, b / n];
  // Flat: the strip's colour varies little (the scene behind would).
  let spread = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 190) continue;
    spread += Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b);
  }
  if (spread / n > 130) return false;
  const grey = Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && r > 60 && r < 140;
  return grey || (side === 'opp' ? r > 140 && g < 90 && b > 60 && r > b : b > 140 && r < 150 && g < 140);
}

/** An HP box's number as read: theirs "90%" is 90, yours (the HP left of the slash) "159" is 159. */
export function hpNumber(text: string, max?: number): number | null {
  // A fainted one's "0", read as a letter: it's all there is in the box.
  if (/^[\s.:]*[oO][\s.:%/]*$/.test(text)) return 0;
  // Otherwise digits read as such ("O" among other marks is a smudge, not 0).
  if (!/[0-9]/.test(text)) return null;
  const m = /\d+/.exec(text.replace(/(?<=\d)[oO]|[oO](?=\d)/g, '0'));
  if (!m) return null;
  let digits = m[0];
  // At most three digits (yours a fourth, the slash read as one): more is a box caught moving.
  if (digits.length > ((max ?? 100) > 100 ? 4 : 3)) return null;
  // The slash's start read as a digit ("1597" of 159 /159): one digit too many.
  while (digits.length > 1 && Number(digits) > (max ?? 100)) digits = digits.slice(0, -1);
  return Number(digits);
}
