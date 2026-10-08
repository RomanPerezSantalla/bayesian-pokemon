import {describe, expect, it} from 'vitest';
import {boxShown, ctcText, gameArea, hpNumber, place, REGIONS, samePrint, textLines, textMask, textPrint, type Pixels} from './vision';

/** A frame of one colour, with rectangles painted on it. */
function frame(w: number, h: number, fill: [number, number, number], rects: [number, number, number, number, [number, number, number]][] = []): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...fill, 255], i * 4);
  for (const [x, y, rw, rh, c] of rects) {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) data.set([...c, 255], (yy * w + xx) * 4);
  }
  return {width: w, height: h, data};
}

describe("the game's picture in a captured window", () => {
  it('BlueStacks: the title bar and the side toolbar cut off, the rest 16:9', () => {
    // 1954×1114, a 33 px title bar and a 34 px toolbar in its flat navy; the game in between, busy.
    const navy: [number, number, number] = [31, 35, 53];
    const px = frame(1954, 1114, navy, [[0, 33, 1920, 1081, [120, 60, 30]], [400, 300, 300, 200, [250, 250, 250]]]);
    const a = gameArea(px);
    expect(Math.abs(a.y - 33)).toBeLessThan(1);
    expect(a.x).toBeCloseTo(0, 0);
    expect(a.w).toBeCloseTo(1920, -1);
    expect(a.w / a.h).toBeCloseTo(16 / 9, 2);
  });

  it('a border line of another colour along the edges (BlueStacks draws one) is chrome too', () => {
    const navy: [number, number, number] = [33, 38, 67];
    const px = frame(1954, 1114, navy, [[0, 33, 1920, 1081, [120, 60, 30]], [0, 0, 1954, 1, [54, 59, 88]], [1953, 0, 1, 1114, [0, 0, 0]]]);
    const a = gameArea(px);
    expect(a.x).toBeCloseTo(0, 0);
    expect(Math.abs(a.y - 33)).toBeLessThan(1);
    expect(a.w).toBeCloseTo(1920, -1);
  });

  it('a region placed on it, in frame pixels', () => {
    expect(place({x: 0, y: 33, w: 1920, h: 1080}, REGIONS.message)).toEqual({x: 200, y: 812, w: 1520, h: 80});
    // Half the size: half the pixels.
    expect(place({x: 0, y: 0, w: 960, h: 540}, REGIONS.message)).toEqual({x: 100, y: 390, w: 760, h: 40});
  });
});

describe('white text', () => {
  it('found line by line, specks aside', () => {
    const white: [number, number, number] = [240, 240, 240];
    const px = frame(400, 120, [20, 20, 40], [[50, 10, 200, 30, white], [30, 60, 300, 35, white], [380, 110, 2, 2, white]]);
    expect(textLines(textMask(px)).map(b => [b.y, b.h])).toEqual([[4, 42], [54, 47]]);
  });

  it('the same text with a pixel of jitter is the same; another is not', () => {
    const white: [number, number, number] = [240, 240, 240];
    const a = textPrint(textMask(frame(400, 80, [0, 0, 0], [[50, 20, 200, 30, white]])));
    const b = textPrint(textMask(frame(400, 80, [0, 0, 0], [[51, 20, 200, 30, white]])));
    const c = textPrint(textMask(frame(400, 80, [0, 0, 0], [[50, 20, 120, 30, white]])));
    expect(samePrint(a, b)).toBe(true);
    expect(samePrint(a, c)).toBe(false);
  });
});

describe('HP boxes', () => {
  const name = (bg: [number, number, number]) => frame(250, 50, bg, [[20, 12, 120, 22, [245, 245, 245]]]);
  it('theirs pink, yours violet, grey once fainted; the scene behind is none', () => {
    expect(boxShown(name([175, 51, 105]), 'opp')).toBe('live');
    expect(boxShown(name([100, 98, 197]), 'me')).toBe('live');
    expect(boxShown(name([88, 88, 95]), 'me')).toBe('fainted');
    // Violet isn't theirs, and no name in it is no box.
    expect(boxShown(name([100, 98, 197]), 'opp')).toBeNull();
    expect(boxShown(frame(250, 50, [175, 51, 105]), 'opp')).toBeNull();
    // The stadium in the rain, a bluish grey dotted with lights: not a fainted one's grey box.
    expect(boxShown(name([78, 94, 102]), 'opp')).toBeNull();
    expect(boxShown(name([65, 77, 87]), 'me')).toBeNull();
  });

  it("where the numbers are (measured on 5 Oct's frames, at 1080): all of one, none of the slash or the next box", () => {
    const area = {x: 0, y: 0, w: 1920, h: 1080};
    const span = (r: (typeof REGIONS.hpValue.me)[number]) => {
      const p = place(area, r);
      return [p.x, p.x + p.w];
    };
    // Yours: a three-digit number from 255 (651 in the right box) to 333 (729); the slash from 339 (735). "4 /202" read
    // as 47 before, the slash's start taken for a 7.
    for (const [k, [from, to, slash]] of [[255, 333, 339], [651, 729, 735]].entries()) {
      const [a, b] = span(REGIONS.hpValue.me[k]);
      expect(a <= from && b > to && b < slash, `yours ${k}: ${a}–${b}`).toBe(true);
    }
    // Theirs: "100%" from 1339 to 1434 (1735 to 1830); the right box's edge from 1464 ("100% 1" before).
    const [a0, b0] = span(REGIONS.hpValue.opp[0]);
    expect(a0 <= 1339 && b0 > 1434 && b0 < 1464, `theirs 0: ${a0}–${b0}`).toBe(true);
    const [a1, b1] = span(REGIONS.hpValue.opp[1]);
    expect(a1 <= 1735 && b1 > 1830, `theirs 1: ${a1}–${b1}`).toBe(true);
  });

  it('the number: theirs a %, yours the HP left of the slash (its start read as a digit dropped)', () => {
    expect(hpNumber('90%', 100)).toBe(90);
    expect(hpNumber('100%', 100)).toBe(100);
    expect(hpNumber('1597', 159)).toBe(159);
    expect(hpNumber('3 /', 198)).toBe(3);
    expect(hpNumber('2O%', 100)).toBe(20);
    // A fainted one's grey "0%", read as a letter.
    expect(hpNumber('.O:', 100)).toBe(0);
    expect(hpNumber('', 100)).toBe(null);
    expect(hpNumber('100%.', 100)).toBe(100);
    // The scene behind read as a box: letters, or digits with no %.
    for (const junk of ['8b1', '8R1', '0R1', '8o1', '8bE', 'N']) expect(hpNumber(junk, 100)).toBe(null);
  });
});

it("the recogniser's answer: repeats and blanks collapsed", () => {
  const dict = ['a', 'b'];
  // Steps over classes [blank, a, b, space]: a a blank a b space b.
  const steps = [1, 1, 0, 1, 2, 3, 2];
  const logits = new Float32Array(steps.length * 4);
  steps.forEach((c, t) => (logits[t * 4 + c] = 1));
  expect(ctcText(logits, steps.length, 4, dict)).toEqual({text: 'aab b', conf: 1});
});

it("light in the scene behind isn't text; the game's outlined text is", () => {
  // A bright patch on a bright background (no dark edge), and white letters on a dark band.
  const px = frame(300, 60, [200, 200, 160], [[20, 10, 80, 30, [250, 250, 250]], [150, 5, 140, 50, [30, 30, 40]], [170, 15, 100, 30, [245, 245, 245]]]);
  const lines = textLines(textMask(px));
  expect(lines).toHaveLength(1);
  expect(lines[0].x).toBeGreaterThan(150);
});

it('HP read from a box caught moving, or a fainted one', () => {
  expect(hpNumber('o', 194)).toBe(0);
  expect(hpNumber(' O ', 100)).toBe(0);
  expect(hpNumber('900180', 100)).toBe(null);
  expect(hpNumber('12345', 194)).toBe(null);
});
