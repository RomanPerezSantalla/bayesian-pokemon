/// <reference lib="webworker" />
/**
 * The screen reader's eyes, off the main thread: each frame of the game, its regions (vision.ts) looked at, and the
 * text of those that changed and held still read with PP-OCRv5's English recogniser (ONNX Runtime, WebAssembly,
 * one thread). What's read goes back as readings: a message, a pop-up, an HP box, the move-select screen, and before
 * the battle, team preview (preview.ts).
 */
import * as ort from 'onnxruntime-web/wasm';
import ICONS from '../data/icons.gen.json';
import {
  gameBox, HEADER, iconTable, IN_OUR_SLOT, lookAt, medianOf, previewScreen, rankIcons, slotBox, type IconEntry,
  type IconGuess, type PreviewScreen, type StoredIcon,
} from './preview';
import {
  alike, boxShown, ctcText, gameArea, hpNumber, MESSAGE_LEFT, place, recInput, REGIONS, samePrint, textAmount, textLines,
  textMask, textPrint, type Mask, type Pixels, type Rect,
} from './vision';

export type Side = 'me' | 'opp';

export type Reading =
  | {kind: 'message'; text: string}
  | {kind: 'popup'; side: Side; text: string}
  /** An HP box, `screen` 0 the left one: the name in it, and the number (theirs %, yours HP). */
  | {kind: 'hp'; side: Side; screen: number; name: string; value: number | null; raw: string}
  /** Moves being chosen for the next turn; the field's timers as shown then. */
  | {kind: 'command'; field: string}
  /**
   * Team preview: each of their six's likeliest species, best first; the header ("Ranked Battles Double Battle"); and
   * on our side, the names (choosing) or each one's number once picked (standing by; null: not brought).
   */
  | {kind: 'preview'; screen: PreviewScreen; theirs: IconGuess[][]; header: string; names?: string[]; picks?: (number | null)[]};

export type OcrIn =
  | {type: 'load'; base: string}
  | {type: 'frame'; t: number; frame: ImageBitmap};

export type OcrOut =
  | {type: 'ready'; ms: number}
  | {type: 'error'; message: string}
  /** `area`: where the game's picture is in the frame, when that has just been worked out. */
  | {type: 'read'; t: number; items: Reading[]; ms: number; area?: Rect};

const post = (m: OcrOut) => (self as DedicatedWorkerGlobalScope).postMessage(m);

let session: ort.InferenceSession | null = null;
let dict: string[] = [];

async function load(base: string) {
  const t0 = performance.now();
  const get = async (file: string) => {
    const res = await fetch(new URL(`ocr/${file}`, base));
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res;
  };
  ort.env.wasm.wasmBinary = await (await get('ort-wasm-simd-threaded.wasm')).arrayBuffer();
  ort.env.wasm.numThreads = 1;
  const lines = (await (await get('dict.txt')).text()).split(/\r?\n/);
  dict = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  session = await ort.InferenceSession.create(new Uint8Array(await (await get('rec.onnx')).arrayBuffer()), {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  post({type: 'ready', ms: Math.round(performance.now() - t0)});
}

interface Read {
  text: string;
  conf: number;
}

/** A line of text in a region, read, with how sure the recogniser was. */
async function recognize(px: Pixels, box: Rect): Promise<Read> {
  const input = recInput(px, box);
  const s = session!;
  const out = (await s.run({[s.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, 48, input.width])}))[s.outputNames[0]];
  const r = ctcText(out.data as Float32Array, out.dims[1], out.dims[2], dict);
  return {text: r.text.trim(), conf: r.conf};
}

async function readEach(px: Pixels, boxes: Rect[]): Promise<Read[]> {
  const out: Read[] = [];
  for (const box of boxes) {
    const r = await recognize(px, box);
    if (r.text) out.push(r);
  }
  return out;
}

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

/**
 * Text followed over the frames it's up in (a message fading in over a moving scene never stands pixel-still): its
 * readings, the print they were read from, and whether it's been reported.
 */
interface Track {
  readings: Read[];
  print: Uint16Array | null;
  told: boolean;
}
const tracks = new Map<string, Track>();
/** Readings this alike are the same text. */
const SAME = 0.95;
/** A text up for one clean frame only is reported if read this surely. */
const SURE_ALONE = 0.9;

/** Its likeliest reading, if it isn't reported yet and was read twice, or once surely enough. */
function likeliest(tr: Track): string | null {
  if (tr.told || !tr.readings.length) return null;
  if (tr.readings.length === 1) return tr.readings[0].conf >= SURE_ALONE ? tr.readings[0].text : null;
  let best: {r: Read; votes: number} | null = null;
  for (const r of tr.readings) {
    const votes = tr.readings.filter(o => alike(o.text, r.text) >= SAME).length;
    if (!best || votes > best.votes || (votes === best.votes && r.conf > best.r.conf)) best = {r, votes};
  }
  return best!.r.text;
}

/**
 * The text in a region this frame (`print`, and how to read it; null: none up): reported once read the same twice
 * running; or, when it goes or another takes its place straight away, its likeliest reading.
 */
async function follow(key: string, print: Uint16Array | null, read: () => Promise<Read | null>): Promise<string[]> {
  const tr = tracks.get(key) ?? {readings: [], print: null, told: false};
  if (!print) {
    tracks.delete(key);
    const last = likeliest(tr);
    return last ? [last] : [];
  }
  tracks.set(key, tr);
  // Unchanged since the last reading: that reading again.
  const prev = tr.readings.at(-1);
  const r = prev && samePrint(print, tr.print) ? prev : await read();
  tr.print = print;
  if (!r) return [];
  const out: string[] = [];
  if (prev && alike(prev.text, r.text) < 0.5) {
    // Another text straight after: the last one ends here.
    const last = likeliest(tr);
    if (last) out.push(last);
    tr.readings = [];
    tr.told = false;
  }
  tr.readings.push(r);
  const before = tr.readings.at(-2);
  if (!tr.told && before && alike(before.text, r.text) >= SAME) {
    out.push(r.text);
    tr.told = true;
  }
  return out;
}

/** What was last seen in each region, coarsely: to read its text once it has changed and then held still. */
const seen = new Map<string, {print: Uint16Array | null; read: Uint16Array | null}>();

/** Whether this text (`print`; null: none there) is new and has held still since the last frame (then it's taken as read). */
function fresh(key: string, print: Uint16Array | null): boolean {
  let w = seen.get(key);
  if (!w) seen.set(key, (w = {print: null, read: null}));
  if (!print) {
    // Gone: the same text coming back is read again.
    w.print = null;
    w.read = null;
    return false;
  }
  const still = samePrint(print, w.print);
  w.print = print;
  if (!still || samePrint(print, w.read)) return false;
  w.read = print;
  return true;
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
/** Where the game's picture is in the frame, once found the same twice running; and where it was found last. */
let area: Rect | null = null;
let found: Rect | null = null;
let areaAt = 0;
/** The area just changed (it's sent with the reading, for the log). */
let areaNew = false;
const sameArea = (a: Rect, b: Rect) => Math.abs(a.x - b.x) <= 3 && Math.abs(a.y - b.y) <= 3 && Math.abs(a.w - b.w) <= 4 && Math.abs(a.h - b.h) <= 4;
/** The move-select screen is showing (it was reported when it came up). */
let choosing = false;
/** The names in the HP boxes, as read, by where they're shown: read again only when the name strip changes. */
const names = new Map<string, {print: Uint16Array; text: string}>();
/** Each HP box up: its number as last seen and as last read, and what it showed while still changing. */
const hpBoxes = new Map<string, {print: Uint16Array | null; read: Uint16Array | null; pending: {value: Pixels; name: Pixels} | null}>();

/** Team preview's screen as seen last frame (it's taken as up when seen twice running). */
let previewLast: PreviewScreen | null = null;
/** Team preview up: their slots over its last few frames, and what's been read and told. */
let preview: {screen: PreviewScreen; frames: number; slots: Pixels[][]; told: string; header: string; names?: string[]; picks?: (number | null)[]} | null = null;
let icons: IconEntry[] | null = null;
/** Their slots are compared over this many frames (lasers sweep across them), and looked at again as often. */
const PREVIEW_FRAMES = 8;

async function frame(t: number, bmp: ImageBitmap) {
  const t0 = performance.now();
  if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas = new OffscreenCanvas(bmp.width, bmp.height);
    ctx = canvas.getContext('2d', {willReadFrequently: true});
    area = null;
    found = null;
  }
  ctx!.drawImage(bmp, 0, 0);
  bmp.close();
  // Where the game's picture is, on the whole frame (to the pixel: team preview's type symbols are small): every frame
  // until it's found the same twice running, then every few seconds, changing only when the new place is found twice
  // running too (a dark scene, Draco Meteor's, can look like the emulator's frame round the picture).
  areaNew = false;
  if (!area || t - areaAt > 10_000) {
    const now = gameArea(ctx!.getImageData(0, 0, canvas.width, canvas.height));
    areaAt = t;
    if (found && sameArea(now, found) && !(area && sameArea(now, area))) {
      area = now;
      areaNew = true;
    }
    found = now;
  }
  const a = area ?? found!;
  // The game's picture's height over 1080: what's measured at 1080 scales by it.
  const s = a.h / 1080;
  const edge = Math.max(3, Math.round(3 * s));
  const grabBox = (p: Rect): Pixels => ctx!.getImageData(p.x, p.y, Math.max(1, p.w), Math.max(1, p.h));
  const grab = (r: Rect): Pixels => grabBox(place(a, r));
  /** Lines of text at least 18 px high at 1080. */
  const linesOf = (m: Mask) => textLines(m, Math.round(14 * s)).filter(b => b.h >= 18 * s);
  const items: Reading[] = [];

  const readHp = async (side: Side, screen: number, value: Pixels, nameStrip: Pixels): Promise<Reading> => {
    const key = `hp-${side}${screen}`;
    const vm = textMask(value, edge);
    const raw = (await readEach(value, linesOf(vm).slice(0, 1))).map(r => r.text).join(' ');
    // The name on its box's colour (theirs pink, lighter at the left; yours violet): not as dark as the outline the mask
    // looks for over the scene, but a box is known to be there.
    const nm = textMask(nameStrip, edge, 165);
    const print = textPrint(nm);
    let name = names.get(key);
    if (!name || !samePrint(print, name.print)) names.set(key, (name = {print, text: (await readEach(nameStrip, linesOf(nm).slice(0, 1))).map(r => r.text).join(' ')}));
    const read = hpNumber(raw, side === 'opp' ? 100 : 999);
    // A grey box is a fainted one's: 0, or it's the scene behind taken for one.
    return {kind: 'hp', side, screen, name: name.text, value: boxShown(nameStrip, side) === 'fainted' && read !== 0 ? null : read, raw};
  };

  // Pop-ups and HP boxes before the message line: an HP that goes with a move is read before the next move's line.
  for (const side of ['me', 'opp'] as const) {
    // A pop-up: two lines ("Raichu's" over "Electric Surge") aligned to its side, the first whose ("…'s").
    const pop = grab(REGIONS.popup[side]);
    const pm = textMask(pop, edge);
    const lines = linesOf(pm);
    const aligned = lines.length === 2 && (side === 'me' ? lines.every(b => b.x <= 40 * s) : lines.every(b => b.x + b.w >= pop.width - 30 * s));
    const popups = await follow(`popup-${side}`, aligned ? textPrint(pm) : null, async () => {
      const [whose, what] = await readEach(pop, lines);
      const ok = whose && what && /s\s*$/i.test(whose.text) && letters(whose.text) >= 3 && letters(what.text) >= 3;
      return ok ? {text: `${whose.text} ${what.text}`, conf: Math.min(whose.conf, what.conf)} : null;
    });
    for (const text of popups) items.push({kind: 'popup', side, text});
    for (const screen of [0, 1]) {
      const key = `hp-${side}${screen}`;
      const box = hpBoxes.get(key) ?? {print: null, read: null, pending: null};
      const nameStrip = grab(REGIONS.hpName[side][screen]);
      if (!boxShown(nameStrip, side)) {
        // Gone: what it showed last, if that was never read (a number up for a moment only).
        if (box.pending) items.push(await readHp(side, screen, box.pending.value, box.pending.name));
        hpBoxes.delete(key);
        continue;
      }
      hpBoxes.set(key, box);
      const value = grab(REGIONS.hpValue[side][screen]);
      const vm = textMask(value, edge);
      if (textAmount(vm) < 30 * s * s) continue;
      const print = textPrint(vm);
      const still = samePrint(print, box.print);
      box.print = print;
      if (samePrint(print, box.read)) {
        box.pending = null;
      } else if (still) {
        // The number has stopped (HP drains as a count): read.
        items.push(await readHp(side, screen, value, nameStrip));
        box.read = print;
        box.pending = null;
      } else {
        box.pending = {value, name: nameStrip};
      }
    }
  }

  // The message line: the line starting at its fixed left margin (light in the scene behind, or a panel's text running
  // in from further left, doesn't), compared on its own, so the scene moving behind it doesn't hide that it's still.
  const msg = grab(REGIONS.message);
  // White, or the yellow of "A critical hit!".
  const mm = textMask(msg, edge, undefined, true);
  const left = (MESSAGE_LEFT - 6) * s;
  const line = linesOf(mm).find(b => Math.abs(b.x - left) < 25 * s && b.w > 120 * s);
  // Its print on a fixed grid (from the margin on): the same text gives the same print, whatever specks come and go.
  const messages = await follow('message', line ? textPrint(mm, {x: Math.round(left), y: 0, w: msg.width - Math.round(left), h: msg.height}) : null,
    async () => {
      const r = await recognize(msg, line!);
      return letters(r.text) >= 6 && /\p{L}{2,}\W+\p{L}/u.test(r.text) ? r : null;
    });
  for (const text of messages) items.push({kind: 'message', text});

  await readPreview(grabBox, a, items);

  // The move-select screen coming up: once, until it goes.
  const mt = grab(REGIONS.moveTime);
  const tm = textMask(mt, edge);
  if (textAmount(tm) < 60 * s * s) {
    choosing = false;
    fresh('moveTime', null);
  } else if (!choosing && fresh('moveTime', textPrint(tm))) {
    const text = (await readEach(mt, linesOf(tm).slice(0, 1))).map(r => r.text).join(' ');
    if (/move\s*time/i.test(text)) {
      choosing = true;
      const field = grab(REGIONS.field);
      items.push({kind: 'command', field: (await readEach(field, linesOf(textMask(field, edge)).slice(0, 1))).map(r => r.text).join(' ')});
    }
  }
  post({type: 'read', t, items, ms: Math.round(performance.now() - t0), ...(areaNew ? {area: a} : {})});
}

/**
 * Team preview, if it's up: their six (each slot over the last few frames, so lasers sweeping across are gone) matched
 * against the icon table, our names or picks read once, and told when first read and whenever the guesses change.
 */
async function readPreview(grabBox: (r: Rect) => Pixels, a: Rect, items: Reading[]) {
  const screen = previewScreen(grabBox, a);
  const seenBefore = previewLast === screen;
  previewLast = screen;
  if (!screen || !seenBefore) {
    if (!screen) preview = null;
    return;
  }
  if (!preview || preview.screen !== screen) preview = {screen, frames: 0, slots: [[], [], [], [], [], []], told: '', header: ''};
  const pv = preview;
  pv.frames++;
  for (let k = 0; k < 6; k++) {
    pv.slots[k].push(grabBox(slotBox(a, 'theirs', screen, k)));
    if (pv.slots[k].length > PREVIEW_FRAMES) pv.slots[k].shift();
  }
  // Read once three frames are in (under a second), then every few seconds while it's up (the guesses told if changed).
  if (pv.frames !== 3 && pv.frames % PREVIEW_FRAMES !== 0) return;
  const whole = (px: Pixels) => ({x: 0, y: 0, w: px.width, h: px.height});
  const readBox = async (box: Rect) => {
    const px = grabBox(box);
    return (await recognize(px, whole(px))).text;
  };
  if (pv.frames === 3) {
    pv.header = await readBox(gameBox(a, HEADER));
    if (screen === 'select') {
      pv.names = [];
      for (let k = 0; k < 6; k++) pv.names.push(await readBox(slotBox(a, 'ours', screen, k, IN_OUR_SLOT.name)));
    } else {
      pv.picks = [];
      for (let k = 0; k < 6; k++) {
        const digit = /[1-4]/.exec(await readBox(slotBox(a, 'ours', screen, k, IN_OUR_SLOT.pick)));
        pv.picks.push(digit ? Number(digit[0]) : null);
      }
    }
  }
  icons ??= iconTable(ICONS.icons as StoredIcon[]);
  const theirs = pv.slots.map(frames => rankIcons(lookAt(medianOf(frames), a.w / 1920), icons!));
  const key = JSON.stringify([theirs.map(g => g[0]?.name), pv.names, pv.picks]);
  if (key === pv.told) return;
  pv.told = key;
  items.push({kind: 'preview', screen, theirs, header: pv.header, ...(pv.names ? {names: pv.names} : {}), ...(pv.picks ? {picks: pv.picks} : {})});
}

let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<OcrIn>) => {
  const m = e.data;
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') await load(m.base);
      else if (session) await frame(m.t, m.frame);
      else m.frame.close();
    } catch (err) {
      post({type: 'error', message: err instanceof Error ? err.message : String(err)});
    }
  });
};
