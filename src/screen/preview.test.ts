import {describe, expect, it} from 'vitest';
import ICONS from '../data/icons.gen.json';
import {
  colourDistance, colourHistogram, cutOut, genderMark, iconMask, iconTable, IN_SLOT, isPanel, lookAt, packColours,
  previewScreen, rankIcons, SLOT, SLOTS, symbolType, TYPE_NAMES, unpackColours, type IconEntry, type StoredIcon,
  type TypeName,
} from './preview';
import type {Pixels} from './vision';

type RGB = [number, number, number];
const PANEL: RGB = [125, 5, 47];
/** Scarlet and Violet's type colours, which the game's symbols are. */
const TYPE_COLOUR: Record<TypeName, RGB> = {
  Normal: [159, 161, 159], Fire: [230, 40, 41], Water: [41, 128, 239], Electric: [250, 192, 0], Grass: [63, 161, 41],
  Ice: [61, 206, 243], Fighting: [255, 128, 0], Poison: [145, 65, 203], Ground: [145, 81, 33], Flying: [129, 185, 239],
  Psychic: [239, 65, 121], Bug: [145, 161, 25], Rock: [175, 169, 129], Ghost: [112, 65, 112], Dragon: [80, 96, 225],
  Dark: [80, 64, 64], Steel: [96, 161, 184], Fairy: [239, 112, 239],
};

/** A picture of one colour, with rectangles (and discs: [x, y, r, colour]) painted on it. */
function picture(w: number, h: number, fill: RGB, rects: [number, number, number, number, RGB][] = [], discs: [number, number, number, RGB][] = []): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...fill, 255], i * 4);
  for (const [x, y, rw, rh, c] of rects) for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) data.set([...c, 255], (yy * w + xx) * 4);
  for (const [cx, cy, r, c] of discs) {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) data.set([...c, 255], (yy * w + xx) * 4);
  }
  return {width: w, height: h, data};
}

/** A type symbol: its colour, a white glyph in the middle. */
const symbol = (c: RGB) => picture(46, 45, c, [[15, 12, 16, 20, [255, 255, 255]]]);

/** One of their slots: the panel, its symbols (one type on the right), a gender mark, an icon of colour blocks. */
function slot(types: RGB[], gender: RGB | null, icon: [number, number, number, number, RGB][]): Pixels {
  const px = picture(SLOT.w, SLOT.h, PANEL);
  const paint = (src: Pixels, at: {x: number; y: number}) => {
    for (let y = 0; y < src.height; y++) px.data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((at.y + y) * SLOT.w + at.x) * 4);
  };
  types.forEach((c, k) => paint(symbol(c), IN_SLOT.types[types.length === 1 ? 1 : k]));
  if (gender) paint(picture(IN_SLOT.gender.w, IN_SLOT.gender.h, PANEL, [], [[13, 12, 11, gender]]), IN_SLOT.gender);
  paint(picture(IN_SLOT.icon.w, IN_SLOT.icon.h, PANEL, icon), IN_SLOT.icon);
  return px;
}

/** The colours (square roots) of an icon made of these blocks, as the table keeps them. */
function coloursOf(icon: [number, number, number, number, RGB][]): string {
  const px = picture(IN_SLOT.icon.w, IN_SLOT.icon.h, PANEL, icon);
  return packColours(colourHistogram(px, iconMask(px)).map(Math.sqrt));
}

const YELLOW_MOUSE: [number, number, number, number, RGB][] = [[40, 20, 50, 60, [240, 200, 60]], [50, 80, 30, 20, [250, 240, 220]]];
const BLUE_DOG: [number, number, number, number, RGB][] = [[30, 30, 70, 50, [40, 70, 160]], [40, 80, 20, 20, [240, 200, 60]]];

describe('team preview: which screen', () => {
  const area = {x: 0, y: 0, w: 1920, h: 1080};
  const screenOf = (at: {x: number; y: number}) => {
    const rects: [number, number, number, number, RGB][] = [0, 1, 2, 3, 4, 5].map(k => [at.x, at.y + SLOT.pitch * k, SLOT.w, SLOT.h, PANEL]);
    const px = picture(1920, 1080, [10, 10, 20], rects);
    return previewScreen(box => cutOut(px, box), area);
  };

  it('their six down the right (choosing), or nearer the middle (standing by)', () => {
    expect(screenOf(SLOTS.theirs.select)).toBe('select');
    expect(screenOf(SLOTS.theirs.standby)).toBe('standby');
  });

  it('nothing like it: neither', () => {
    const px = picture(1920, 1080, [10, 10, 20], [[1190, 47, 250, 52, [200, 40, 90]]]);
    expect(previewScreen(box => cutOut(px, box), area)).toBeNull();
  });

  it('one crimson panel across where both sides\' slots are (the info screen on a Pokémon in battle, 5 Oct): neither', () => {
    const px = picture(1920, 1080, [10, 10, 20], [[110, 220, 1700, 760, PANEL]]);
    expect(previewScreen(box => cutOut(px, box), area)).toBeNull();
  });
});

describe('team preview: one of their slots', () => {
  it("the panel's crimson, not a Pokémon's reds or a laser's pink", () => {
    expect(isPanel(...PANEL)).toBe(true);
    expect(isPanel(91, 2, 34)).toBe(true);
    expect(isPanel(200, 40, 50)).toBe(false); // Incineroar
    expect(isPanel(190, 30, 40)).toBe(false); // Scizor
    expect(isPanel(240, 120, 200)).toBe(false);
  });

  it('every type symbol read by its colour; the panel alone is no symbol', () => {
    for (const type of TYPE_NAMES) expect(symbolType(symbol(TYPE_COLOUR[type]))?.type).toBe(type);
    expect(symbolType(picture(46, 45, PANEL))).toBeNull();
  });

  it('the gender mark: blue ♂, red ♀, none', () => {
    const mark = (c: RGB | null) => genderMark(picture(26, 25, PANEL, [], c ? [[13, 12, 11, c]] : []));
    expect(mark([24, 77, 219])).toBe('M');
    expect(mark([225, 25, 45])).toBe('F');
    expect(mark(null)).toBe('N');
  });

  it("the icon cut out of the panel, a laser's line across it left out", () => {
    const px = picture(132, 110, PANEL, [[40, 20, 40, 50, [200, 180, 60]], [0, 90, 132, 2, [240, 120, 200]]]);
    const m = iconMask(px);
    expect(m[45 * 132 + 60]).toBe(1);
    expect(m[90 * 132 + 10]).toBe(0);
    expect(m[5 * 132 + 5]).toBe(0);
  });

  it('colours: the same icon alike, another not', () => {
    const a = picture(132, 110, PANEL, YELLOW_MOUSE);
    const b = picture(132, 110, PANEL, BLUE_DOG);
    const roots = (px: Pixels) => colourHistogram(px, iconMask(px)).map(Math.sqrt);
    expect(colourDistance(roots(a), roots(a))).toBeLessThan(0.01);
    expect(colourDistance(roots(a), roots(b))).toBeGreaterThan(0.5);
    // Kept a byte a bin, they come back as they were.
    expect(colourDistance(unpackColours(packColours(roots(a))), roots(a))).toBeLessThan(0.02);
  });
});

describe('team preview: their six matched to species', () => {
  const table: IconEntry[] = iconTable([
    {name: 'Raichu', types: ['Electric'], normal: coloursOf(YELLOW_MOUSE), shiny: coloursOf(BLUE_DOG)},
    {name: 'Manectric', types: ['Electric'], normal: coloursOf(BLUE_DOG), shiny: coloursOf(BLUE_DOG)},
    {name: 'Basculegion', types: ['Water', 'Ghost'], gender: 'M', normal: coloursOf(YELLOW_MOUSE), shiny: coloursOf(YELLOW_MOUSE)},
  ]);

  it('by its colours among those of its types', () => {
    const look = lookAt(slot([TYPE_COLOUR.Electric], [24, 77, 219], YELLOW_MOUSE), 1);
    const [best, next] = rankIcons(look, table);
    expect(best).toMatchObject({name: 'Raichu', shiny: false});
    expect(best.cost).toBeLessThan(0.1);
    expect(next.name).toBe('Manectric');
    // A species of other types is far behind, however alike its colours.
    expect(rankIcons(look, table).find(g => g.name === 'Basculegion')!.cost).toBeGreaterThan(2);
  });

  it('a shiny by its shiny colours', () => {
    const look = lookAt(slot([TYPE_COLOUR.Electric], [24, 77, 219], BLUE_DOG), 1);
    // Raichu's shiny is blue here, as Manectric is: it's down to the ladder (autoBattle.ts) between those two.
    expect(rankIcons(look, table).slice(0, 2).map(g => [g.name, g.shiny])).toEqual(expect.arrayContaining([['Raichu', true], ['Manectric', false]]));
  });

  it('the gender mark against a species of one gender', () => {
    const female = lookAt(slot([TYPE_COLOUR.Water, TYPE_COLOUR.Ghost], [225, 25, 45], YELLOW_MOUSE), 1);
    const male = lookAt(slot([TYPE_COLOUR.Water, TYPE_COLOUR.Ghost], [24, 77, 219], YELLOW_MOUSE), 1);
    const cost = (look: typeof male) => rankIcons(look, table).find(g => g.name === 'Basculegion')!.cost;
    expect(cost(female) - cost(male)).toBeCloseTo(1, 1);
  });

  it("the table: every species in Champions' roster that team preview shows, normal and shiny", () => {
    const icons = iconTable(ICONS.icons as StoredIcon[]);
    expect(icons.length).toBeGreaterThan(250);
    const names = new Set(icons.map(e => e.name));
    for (const n of ['Raichu', 'Raichu-Alola', 'Gengar', 'Basculegion-F', 'Aegislash-Shield', 'Rotom-Wash']) expect(names.has(n)).toBe(true);
    expect([...names].some(n => /-Mega/.test(n))).toBe(false);
    for (const e of icons) {
      expect(e.types.every(t => (TYPE_NAMES as readonly string[]).includes(t))).toBe(true);
      expect(Math.hypot(...e.normal)).toBeCloseTo(1, 3);
      expect(Math.hypot(...e.shiny)).toBeCloseTo(1, 3);
    }
  });
});
