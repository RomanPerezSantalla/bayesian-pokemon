/**
 * Every item in Pokémon Champions, one test each: it's either one the app handles (Mega Stones,
 * resist berries, type boosts, status berries and the rest, each checked for what it does) or
 * listed below as not modelled, with why, so a new item can't slip by unexamined. And voice reads
 * each one.
 */
import fs from 'node:fs';
import path from 'node:path';
import {Dex} from '@pkmn/dex';
import {describe, expect, it} from 'vitest';
import {getGen, toID} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import {reactionEffect} from './abilities';
import {createBattle, emptyField, uid} from './battle';
import {finalSpeed, makeField, makeMove, makePokemon, quickChances, runCalc, typeEffectiveness} from './calc';
import {berryApplies, megaFormeOf, myHitLikelihood, usesInARow} from './likelihood';
import {applyAction, applyEndTurn, CURES, type StateCtx} from './state';
import type {ActionEvent, Battle, HitResult, MonRef, Status} from './types';
import {parseNarration} from '../ui/battle/voice/parse';

const gen = getGen(0);
const dex = Dex.forGen(9);
const ITEMS = [...gen.items].map(i => i.name).sort();

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);

const ZERO = [0, 0, 0, 0, 0, 0];
const mon = (species: string, ability: string, item?: string, evs = ZERO) =>
  makePokemon(gen, {species, level: 50, nature: 'Serious', evs, ability, item});
const field = (terrain?: 'Electric' | 'Grassy' | 'Psychic' | 'Misty') => makeField('doubles', {...emptyField(), terrain}, 'me');
const top = (attacker: ReturnType<typeof mon>, defender: ReturnType<typeof mon>, move: string, f = field(), metronome?: number) =>
  Math.max(...runCalc(gen, attacker, defender, makeMove(gen, move, {targets: 1, metronome}), f).dist.keys());

/** A plain attack of each type, for the damage checks. */
const MOVE_OF: Record<string, string> = {
  Normal: 'Body Slam', Fire: 'Flamethrower', Water: 'Surf', Electric: 'Thunderbolt', Grass: 'Energy Ball', Ice: 'Ice Beam',
  Fighting: 'Brick Break', Poison: 'Sludge Bomb', Ground: 'Earth Power', Flying: 'Air Slash', Psychic: 'Psychic', Bug: 'Bug Buzz',
  Rock: 'Rock Slide', Ghost: 'Shadow Ball', Dragon: 'Dragon Pulse', Dark: 'Dark Pulse', Steel: 'Flash Cannon', Fairy: 'Moonblast',
};

/** A Pokémon in Champions this type hits super effectively (or, for Normal, at all). */
function weakTo(type: string): string {
  for (const s of gen.species) {
    const eff = typeEffectiveness(gen, type, s.types);
    if (type === 'Normal' ? eff === 1 : eff === 2) return s.name;
  }
  throw new Error(`nobody weak to ${type}`);
}

// Your two against their two; yours at slot 0 holds the item.
function battleWith(item: string, species = 'Snorlax') {
  const team = parseTeam(`${species} @ ${item}\nAbility: Immunity\n- Tackle\n\nKangaskhan\nAbility: Early Bird\n- Tackle`);
  const b = createBattle(fmt, team, ['Metagross', 'Garchomp'], 'items');
  b.live.active = {me: [0, 1], opp: [0, 1]};
  const ctx: StateCtx = {fmt, gen, battle: b, oppAbility: () => undefined, oppItem: () => undefined};
  return {b, ctx, max: b.live.mons.me0.hp};
}

const ME: MonRef = {side: 'me', slot: 0};
const FOE: MonRef = {side: 'opp', slot: 0};

function act(b: Battle, actor: MonRef, move: string, hits: HitResult[] = [], extra: Partial<ActionEvent> = {}): ActionEvent {
  return {
    kind: 'action', id: uid(), turn: b.turn, actor, move, hits, targets: Math.max(1, hits.length), helpingHand: false,
    actorTriggers: [], before: structuredClone(b.live), ordered: true, ...extra,
  };
}

const hitMe = (b: Battle, hpAfter: number, extra: Partial<HitResult> = {}): HitResult =>
  ({target: ME, hpBefore: b.live.mons.me0.hp, hpAfter, fainted: false, crit: false, triggers: [], ...extra});

// --- what each kind of item does -----------------------------------------------------------------

const shortDesc = (item: string) => dex.items.get(item).shortDesc ?? '';
const resistType = (item: string) => shortDesc(item).match(/supereffective (\w+)-type|damage taken from a (Normal)-type/)?.slice(1).find(Boolean);
const boostType = (item: string) => shortDesc(item).match(/^Holder's (\w+)-type attacks have 1\.2x power/)?.[1];

/** Items with a rule of their own: what it is, checked. */
const HANDLED: Record<string, () => void> = {
  'Life Orb': () => {
    expect(top(mon('Kangaskhan', 'Early Bird', 'Life Orb'), mon('Snorlax', 'Immunity'), 'Body Slam') / top(mon('Kangaskhan', 'Early Bird'), mon('Snorlax', 'Immunity'), 'Body Slam')).toBeCloseTo(1.3, 1);
    const {b, ctx, max} = battleWith('Life Orb');
    const after = applyAction(ctx, b.live, act(b, ME, 'Tackle', [{target: FOE, hpBefore: 100, hpAfter: 80, fainted: false, crit: false, triggers: []}]));
    expect(max - after.mons.me0.hp, 'recoil: a tenth of its HP').toBe(Math.floor(max / 10));
  },
  Leftovers: () => {
    const {b, ctx, max} = battleWith('Leftovers');
    b.live.mons.me0.hp = 50;
    expect(applyEndTurn(ctx, b.live).mons.me0.hp).toBe(50 + Math.floor(max / 16));
  },
  'Sitrus Berry': () => {
    const {b, ctx, max} = battleWith('Sitrus Berry');
    const after = applyAction(ctx, b.live, act(b, FOE, 'Tackle', [hitMe(b, Math.floor(max / 2) - 1)]));
    expect(after.mons.me0.hp).toBe(Math.floor(max / 2) - 1 + Math.floor(max / 4));
    expect(after.mons.me0.itemGone).toBe(true);
  },
  'Oran Berry': () => {
    const {b, ctx, max} = battleWith('Oran Berry');
    const after = applyAction(ctx, b.live, act(b, FOE, 'Tackle', [hitMe(b, Math.floor(max / 2) - 1)]));
    expect(after.mons.me0.hp).toBe(Math.floor(max / 2) - 1 + 10);
  },
  'Air Balloon': () => {
    expect(top(mon('Kangaskhan', 'Early Bird'), mon('Snorlax', 'Immunity', 'Air Balloon'), 'Earthquake'), 'floats').toBe(0);
    const {b, ctx} = battleWith('Air Balloon');
    expect(applyAction(ctx, b.live, act(b, FOE, 'Tackle', [hitMe(b, 150)])).mons.me0.itemGone, 'pops when hit').toBe(true);
  },
  'Focus Sash': () => {
    const kill = new Map([[500, 1]]);
    expect(myHitLikelihood(kill, {...hitMe(battleWith('Focus Sash').b, 1), hpBefore: 200}, 200, true)).toBe(1);
  },
  'Focus Band': () => {
    const kill = new Map([[500, 1]]);
    const {b} = battleWith('Focus Band');
    expect(myHitLikelihood(kill, {...hitMe(b, 1), hpBefore: 120}, 200, false, true), 'hangs on one time in ten').toBeCloseTo(0.1);
    expect(myHitLikelihood(kill, {...hitMe(b, 0), hpBefore: 120, fainted: true}, 200, false, true)).toBeCloseTo(0.9);
  },
  'Choice Scarf': () => {
    const f = field();
    expect(finalSpeed(gen, mon('Garchomp', 'Rough Skin', 'Choice Scarf'), f)).toBe(Math.floor(finalSpeed(gen, mon('Garchomp', 'Rough Skin'), f) * 1.5));
  },
  'Iron Ball': () => {
    const f = field();
    expect(finalSpeed(gen, mon('Garchomp', 'Rough Skin', 'Iron Ball'), f)).toBe(Math.floor(finalSpeed(gen, mon('Garchomp', 'Rough Skin'), f) / 2));
  },
  'Quick Claw': () => expect(quickChances(gen, 'Tackle', 'Early Bird', 'Quick Claw').claw).toBeCloseTo(0.2),
  'Rocky Helmet': () => {
    const {b, ctx, max} = battleWith('Rocky Helmet');
    const after = applyAction(ctx, b.live, act(b, ME, 'Tackle', [{target: FOE, hpBefore: 100, hpAfter: 80, fainted: false, crit: false, triggers: []}], {actorTriggers: ['helmet']}));
    expect(max - after.mons.me0.hp, "a helmet's sixth, when the game says so").toBe(Math.floor(max / 6));
  },
  'White Herb': () => expect(reactionEffect('White Herb', {atk: -1, def: -1})).toEqual({boosts: {atk: 1, def: 1}, itemGone: true}),
  'Heat Rock': () => lasts('Heat Rock', 'Sunny Day', 'weather', 8),
  'Damp Rock': () => lasts('Damp Rock', 'Rain Dance', 'weather', 8),
  'Smooth Rock': () => lasts('Smooth Rock', 'Sandstorm', 'weather', 8),
  'Icy Rock': () => lasts('Icy Rock', 'Snowscape', 'weather', 8),
  'Light Clay': () => lasts('Light Clay', 'Reflect', 'me.reflect', 8),
  'Terrain Extender': () => lasts('Terrain Extender', 'Grassy Terrain', 'terrain', 8),
  Metronome: () => {
    const a = mon('Kangaskhan', 'Early Bird', 'Metronome');
    const t = mon('Snorlax', 'Immunity');
    expect(top(a, t, 'Body Slam', field(), 1) / top(a, t, 'Body Slam'), 'a second use in a row').toBeCloseTo(1.2, 1);
    const {b} = battleWith('Metronome');
    const first = act(b, ME, 'Body Slam');
    const second = {...act(b, ME, 'Body Slam'), turn: 2};
    b.events.push(first, second);
    expect(usesInARow(b, second)).toBe(1);
  },
  'Normal Gem': () => {
    expect(top(mon('Kangaskhan', 'Early Bird', 'Normal Gem'), mon('Snorlax', 'Immunity'), 'Body Slam') / top(mon('Kangaskhan', 'Early Bird'), mon('Snorlax', 'Immunity'), 'Body Slam')).toBeCloseTo(1.3, 1);
    const {b, ctx} = battleWith('Normal Gem');
    expect(applyAction(ctx, b.live, act(b, ME, 'Body Slam', [{target: FOE, hpBefore: 100, hpAfter: 60, fainted: false, crit: false, triggers: []}])).mons.me0.itemGone, 'used up').toBe(true);
  },
  'Expert Belt': () => ratio('Expert Belt', 'Brick Break', 'Snorlax', 1.2),
  'Muscle Band': () => ratio('Muscle Band', 'Body Slam', 'Snorlax', 1.1),
  'Wise Glasses': () => ratio('Wise Glasses', 'Flamethrower', 'Snorlax', 1.1),
  'Light Ball': () => {
    const t = mon('Snorlax', 'Immunity');
    expect(top(mon('Pikachu', 'Static', 'Light Ball'), t, 'Thunderbolt') / top(mon('Pikachu', 'Static'), t, 'Thunderbolt')).toBeCloseTo(2, 0);
  },
  'Electric Seed': () => seed('Electric Seed', 'Electric', 'Body Slam'),
  'Grassy Seed': () => seed('Grassy Seed', 'Grassy', 'Body Slam'),
  'Psychic Seed': () => seed('Psychic Seed', 'Psychic', 'Flamethrower'),
  'Misty Seed': () => seed('Misty Seed', 'Misty', 'Flamethrower'),
};

/** Items with nothing the app works out from them, and why. */
const NOT_MODELLED: Record<string, string> = {
  'Big Root': 'extra healing from draining: drain already leaves the HP to be read',
  'Binding Band': 'partial-trapping damage is not tracked',
  'Bright Powder': 'a miss is logged when it happens',
  'Wide Lens': 'a miss or a hit is logged when it happens',
  'Zoom Lens': 'a miss or a hit is logged when it happens',
  "King's Rock": 'a flinch is seen, not predicted',
  'Scope Lens': 'crits are logged when they happen',
  Leek: 'crits are logged when they happen',
  'Eject Button': 'the switch it causes is logged as a switch',
  'Red Card': 'the switch it causes is logged as a switch',
  'Shed Shell': 'trapping is not tracked',
  'Mental Herb': 'Taunt, Encore and the like are not tracked',
  'Shell Bell': 'the healing is a share of damage dealt, so the HP is read, not worked out',
  'Leppa Berry': 'PP are not tracked',
  'Persim Berry': 'confusion is not tracked',
};

function lasts(item: string, move: string, key: string, turns: number) {
  const {b, ctx} = battleWith(item);
  const after = applyAction(ctx, b.live, act(b, ME, move, []));
  expect(after.field.turns?.[key], `${move} with ${item}`).toBe(turns);
}

function ratio(item: string, move: string, defender: string, want: number) {
  const t = mon(defender, 'Immunity');
  expect(top(mon('Kangaskhan', 'Early Bird', item), t, move) / top(mon('Kangaskhan', 'Early Bird'), t, move)).toBeCloseTo(want, 1);
}

function seed(item: string, terrain: 'Electric' | 'Grassy' | 'Psychic' | 'Misty', move: string) {
  const a = mon('Kangaskhan', 'Early Bird');
  const f = field(terrain);
  expect(top(a, mon('Snorlax', 'Immunity', item), move, f), 'a stage up on its terrain').toBeLessThan(top(a, mon('Snorlax', 'Immunity'), move, f));
}

describe('every item in Champions', () => {
  it('is here: 166 items', () => expect(ITEMS.length).toBe(166));

  describe.each(ITEMS)('%s', item => {
    const it_ = gen.items.get(toID(item))!;
    const megas = (it_ as {megaStone?: Record<string, string>}).megaStone;

    it('is handled, or listed as not modelled with why', () => {
      const kinds = [megas && 'mega', resistType(item) && 'resist', boostType(item) && 'boost', CURES[item] && 'cure',
        HANDLED[item] && 'handled', NOT_MODELLED[item] && 'not modelled'].filter(Boolean);
      expect(kinds.length, `${item}: ${shortDesc(item)}`).toBe(1);
    });

    it.runIf(!!megas)('turns its Pokémon into a Mega forme that exists, with one ability', () => {
      for (const [species, forme] of Object.entries(megas!)) {
        const f = gen.species.get(toID(forme));
        expect(f, forme).toBeTruthy();
        expect(f!.baseStats.hp).toBeGreaterThan(0);
        expect(Object.values(f!.abilities ?? {}).filter(Boolean)).toHaveLength(1);
        expect(megaFormeOf(gen, {species, item, moves: [], evs: ZERO, ivs: undefined} as never)).toBe(forme);
      }
    });

    it.runIf(!!resistType(item))('halves a super-effective hit of its type (Chilan: any Normal hit)', () => {
      const type = resistType(item)!;
      expect(berryApplies(item, type, type === 'Normal' ? 1 : 2)).toBe(true);
      expect(berryApplies(item, type === 'Fire' ? 'Water' : 'Fire', 2), 'and no other type').toBe(false);
      const target = weakTo(type);
      const a = mon('Kangaskhan', 'Early Bird');
      const [plain, held] = [mon(target, ''), mon(target, '', item)];
      expect(top(a, held, MOVE_OF[type]) / top(a, plain, MOVE_OF[type])).toBeCloseTo(0.5, 1);
    });

    it.runIf(!!boostType(item))('powers up attacks of its type by 1.2x, and no others', () => {
      const type = boostType(item)!;
      const other = type === 'Fire' ? 'Water' : 'Fire';
      const [a, plain] = [mon('Kangaskhan', 'Early Bird', item), mon('Kangaskhan', 'Early Bird')];
      const on = mon(weakTo(type), '');
      // 1.2x on the power; the rounding of whole HP moves it a little either way.
      const r = top(a, on, MOVE_OF[type]) / top(plain, on, MOVE_OF[type]);
      expect(r).toBeGreaterThan(1.12);
      expect(r).toBeLessThan(1.28);
      expect(top(a, mon('Snorlax', 'Immunity'), MOVE_OF[other])).toBe(top(plain, mon('Snorlax', 'Immunity'), MOVE_OF[other]));
    });

    it.runIf(!!CURES[item])('cures its status the moment it lands, and is used up', () => {
      for (const st of CURES[item] as Status[]) {
        const {b, ctx} = battleWith(item);
        const after = applyAction(ctx, b.live, act(b, FOE, 'Tackle', [hitMe(b, 150, {status: st})]));
        expect(after.mons.me0.status, st).toBe('');
        expect(after.mons.me0.itemGone).toBe(true);
      }
    });

    it.runIf(!!HANDLED[item])('does what it does', () => HANDLED[item]());

    it('is read by voice', () => {
      const {b} = battleWith('Leftovers');
      const got = parseNarration(`The opposing Metagross's ${item}`, {battle: b, gen, mons: undefined}).find(e => e.kind === 'item');
      expect(got && 'item' in got ? got.item : undefined).toBe(item);
    });
  });
});
