import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {getGen} from '../data/dex';
import type {FormatInfo} from '../data/format';
import {fuse, type Structure} from '../data/fuse';
import {parseTeam} from '../data/paste';
import {createBattle} from '../engine/battle';
import type {StateCtx} from '../engine/state';
import type {Battle, HitResult, MonRef} from '../engine/types';
import {
  editLive, endTurn, logAction, logCheck, logLeads, logMega, logReveal, logSwitch, moveAction, setOrdered, turnActions, undo,
} from '../ui/battle/actions';
import {mergeTeams, planImport, readFile} from './backup';
import {indexedDBStore} from './db';
import {battleInfo, diff, packBattle, patch, unpackBattle} from './pack';
import type {SavedTeam} from './store';

const data = (f: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data', f), 'utf8'));
const info = (data('formats.json').formats as FormatInfo[]).find(f => f.id === 'champions-doubles')!;
const fmt = fuse(info, data('structure-doubles.json') as Structure, null);
const gen = getGen(fmt.gen);

const TEAM = parseTeam(`Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 10 Def / 24 SpD
Careful Nature
- Fake Out
- Flare Blitz
- Parting Shot
- Throat Chop

Charizard @ Charizardite Y
Ability: Solar Power
EVs: 2 HP / 32 SpA / 32 Spe
Timid Nature
- Heat Wave
- Weather Ball
- Solar Beam
- Protect

Garchomp @ Life Orb
Ability: Rough Skin
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Earthquake
- Dragon Claw
- Rock Slide
- Protect

Sneasler @ Focus Sash
Ability: Unburden
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Fake Out
- Close Combat
- Dire Claw
- Protect`);

const me = (slot: number): MonRef => ({side: 'me', slot});
const opp = (slot: number): MonRef => ({side: 'opp', slot});
const ctx = (b: Battle): StateCtx => ({fmt, gen, battle: b, oppAbility: () => undefined, oppItem: () => undefined});
const hit = (target: MonRef, hpAfter: number, more: Partial<HitResult> = {}): HitResult =>
  ({target, hpBefore: 0, hpAfter, fainted: false, crit: false, triggers: [], ...more});
const act = (b: Battle, actor: MonRef, move: string, hits: HitResult[], more = {}) =>
  logAction(ctx(b), b, {actor, move, hits, targets: hits.length || 1, helpingHand: false, actorTriggers: [], ordered: true, ...more});

/** A battle that goes through every kind of entry: leads, prompts, moves, Mega, switches, fixes and undo. */
function played(turns = 8): Battle {
  let b = createBattle(fmt, TEAM, ['Garchomp', 'Incineroar', 'Kingambit', 'Whimsicott', 'Sinistcha', 'Sneasler'], 'vs Garchomp');
  b.brought = [0, 1, 2, 3];
  b = logLeads(ctx(b), b, [opp(0), opp(1), me(0), me(1)]);
  const lead = b.events.find(e => e.kind === 'switch' && e.side === 'opp')!;
  b = logCheck(ctx(b), b, {mon: opp(1), context: 'entry', about: lead.id, seen: 'Intimidate', seenKind: 'ability', mega: false, itemGone: false});
  b = logMega(ctx(b), b, me(1), 'Charizard-Mega-Y');
  for (let t = 0; t < turns; t++) {
    b = act(b, opp(0), 'Earthquake', [hit(me(0), Math.max(1, 180 - t * 15)), hit(opp(1), Math.max(1, 90 - t * 6))]);
    b = act(b, me(1), 'Heat Wave', [hit(opp(0), Math.max(1, 80 - t * 8), {crit: t === 2}), hit(opp(1), Math.max(1, 70 - t * 7))]);
    b = act(b, opp(1), 'Fake Out', [hit(me(1), Math.max(1, 140 - t * 10))], t === 3 ? {quick: null} : {});
    b = act(b, me(0), 'Parting Shot', [], {targetRefs: [opp(0)]});
    if (t === 1) b = logReveal(b, opp(0), 'item', 'Choice Scarf');
    if (t === 4) b = logSwitch(ctx(b), b, 'me', 0, 2);
    if (t === 5) b = editLive(b, live => {
      live.mons.me1.hp = 99;
      live.mons.opp0.hpUnknown = true;
    });
    b = endTurn(ctx(b), b);
  }
  // Fixes: a move that went earlier, one whose order is unsure, and an undo.
  b = act(b, me(1), 'Protect', []);
  b = act(b, opp(1), 'Flare Blitz', [hit(me(2), 120)]);
  const [first] = turnActions(b);
  b = moveAction(ctx(b), b, first.id, 1);
  b = setOrdered(b, turnActions(b)[0].id, false);
  b = act(b, me(2), 'Dragon Claw', [hit(opp(0), 20)]);
  b = undo(b);
  return b;
}

describe('saved battles', () => {
  it('unpack gives back exactly the battle that was packed', () => {
    const b = played();
    expect(unpackBattle(packBattle(b))).toStrictEqual(b);
  });

  it('survives a backup file (JSON) exactly, key order included', () => {
    const b = played();
    const viaFile = unpackBattle(JSON.parse(JSON.stringify(packBattle(b))));
    expect(JSON.stringify(viaFile)).toBe(JSON.stringify(b));
  });

  it('is several times smaller than the whole battle', () => {
    const b = played(12);
    const whole = JSON.stringify(b).length;
    const saved = JSON.stringify(packBattle(b)).length;
    expect(b.events.length).toBeGreaterThan(60);
    expect(saved / whole).toBeLessThan(0.25);
  });

  it('unpacked snapshots are independent copies', () => {
    const b = unpackBattle(packBattle(played(3)));
    const [a, c] = [b.events[4], b.events[5]];
    a.undo!.live.mons.me0.hp = -5;
    expect(c.undo!.live.mons.me0.hp).not.toBe(-5);
    expect(b.live.mons.me0.hp).not.toBe(-5);
  });

  it('a battle with nothing logged, and the list summary', () => {
    const b = createBattle(fmt, TEAM, ['Garchomp'], 'empty');
    expect(unpackBattle(packBattle(b))).toStrictEqual(b);
    const p = played(2);
    expect(battleInfo(packBattle(p))).toEqual(battleInfo(p));
    expect(battleInfo(p)).toMatchObject({id: p.id, label: 'vs Garchomp', entries: p.events.length, turn: p.turn});
  });

  it('diff keeps key order and values that went away', () => {
    const a = {x: 1, o: {p: 1, q: 2}, arr: [1, 2]};
    const b = {x: 2, o: {q: 2, p: 1, r: 3}, arr: [1, 2, 3]};
    const out = patch(a, diff(a, b));
    expect(JSON.stringify(out)).toBe(JSON.stringify(b));
    const gone = {o: {p: 1, q: undefined as number | undefined}};
    expect(patch({o: {p: 1, q: 5}}, diff({o: {p: 1, q: 5}}, gone))).toStrictEqual(gone);
    expect(JSON.parse(JSON.stringify(diff({o: {p: 1, q: 5}}, gone)))).toEqual([[['o'], {p: 1}]]);
    expect(diff(a, structuredClone(a))).toEqual([]);
  });
});

describe('backups', () => {
  const team = (id: string, updated: number, name = id): SavedTeam => ({id, name, paste: '', sets: [], updated});

  it('reads a backup, a bug report and a single battle', () => {
    const b = played(2);
    const backup = JSON.stringify({app: 'bayesian-battle-analyzer', version: 1, teams: [team('t1', 5)], battles: [packBattle(b)]});
    expect(readFile(backup)).toMatchObject({teams: [{id: 't1'}], battles: [{id: b.id, packed: 1}]});
    expect(readFile(JSON.stringify({report: 1, battle: packBattle(b)})).battles).toHaveLength(1);
    // A battle saved whole (an older version's data) is packed on the way in.
    const whole = readFile(JSON.stringify(b)).battles[0];
    expect(JSON.stringify(unpackBattle(whole))).toBe(JSON.stringify(b));
  });

  it('refuses files that are not backups', () => {
    expect(() => readFile('hello')).toThrow(/not JSON/);
    expect(() => readFile('{"teams": [{"nope": 1}]}')).toThrow(/no teams or battles/);
    expect(() => readFile('[1, 2]')).toThrow(/no teams or battles/);
  });

  it('keeps the newest copy of each', () => {
    const have = {teams: [team('a', 10), team('b', 10)], battles: [{...battleInfo(played(1)), id: 'x', updated: 50}]};
    const px = {...packBattle(played(1)), id: 'x', updated: 40};
    const py = {...packBattle(played(1)), id: 'y', updated: 40};
    const plan = planImport(have, {teams: [team('a', 20), team('b', 10), team('c', 1)], battles: [px, py]});
    expect(plan.teams.map(t => t.id)).toEqual(['a', 'c']);
    expect(plan.battles.map(b => b.id)).toEqual(['y']);
    expect(plan.skipped).toBe(2);
  });

  it('merges teams in place, new ones first', () => {
    const merged = mergeTeams([team('a', 1, 'old A'), team('b', 1)], [team('a', 2, 'new A'), team('c', 2)]);
    expect(merged.map(t => `${t.id}:${t.name}`)).toEqual(['c:c', 'a:new A', 'b:b']);
  });
});

describe('the battle database', () => {
  type Rec = {id: string};
  type Disk = Record<'battles' | 'info', Map<string, Rec>>;

  /** A stand-in IndexedDB connection that can be dropped (as Safari does) or refuse with a given error. */
  function fakeDB(disk: Disk, refuse?: string) {
    const db = {
      closed: false,
      onclose: null as null | (() => void),
      onversionchange: null as null | (() => void),
      close() {
        db.closed = true;
      },
      transaction() {
        if (db.closed || refuse) throw Object.assign(new Error('The database connection is closing.'), {name: refuse ?? 'InvalidStateError'});
        const tx = {
          error: null,
          oncomplete: null as null | (() => void),
          objectStore(name: keyof Disk) {
            const m = disk[name];
            const req = <T>(fn: () => T) => {
              const r = {result: undefined as T | undefined, error: null, onsuccess: null as null | (() => void)};
              setTimeout(() => {
                r.result = fn();
                r.onsuccess?.();
              });
              return r;
            };
            return {
              getAll: () => req(() => [...m.values()]),
              get: (id: string) => req(() => m.get(id)),
              put: (v: Rec) => req(() => void m.set(v.id, v)),
              delete: (id: string) => req(() => void m.delete(id)),
            };
          },
        };
        setTimeout(() => tx.oncomplete?.(), 1);
        return tx;
      },
    };
    return db;
  }

  function rig(refuse?: (n: number) => string | undefined) {
    const disk: Disk = {battles: new Map(), info: new Map()};
    const opened: ReturnType<typeof fakeDB>[] = [];
    const open = async () => {
      const db = fakeDB(disk, refuse?.(opened.length));
      opened.push(db);
      return db as unknown as IDBDatabase;
    };
    return {opened, store: indexedDBStore(open)};
  }

  it('saves on a fresh connection when the old one was dropped', async () => {
    const {opened, store: pending} = rig();
    const store = await pending;
    const b = played(2);
    opened[0].closed = true;
    await store.put([b]);
    expect(opened).toHaveLength(2);
    expect((await store.list()).map(i => i.id)).toEqual([b.id]);
    expect(await store.get(b.id)).toStrictEqual(b);
    // Closed abnormally: the next call reconnects without failing first.
    opened[1].onclose?.();
    opened[1].closed = true;
    expect(await store.all()).toHaveLength(1);
    expect(opened).toHaveLength(3);
  });

  it('two saves failing together open one new connection', async () => {
    const {opened, store: pending} = rig();
    const store = await pending;
    opened[0].closed = true;
    const [a, b] = [played(1), {...played(1), id: 'second'}];
    await Promise.all([store.put([a]), store.put([b])]);
    expect(opened).toHaveLength(2);
    expect((await store.list()).map(i => i.id).sort()).toEqual([a.id, 'second'].sort());
  });

  it("doesn't retry what reconnecting can't fix, and reports a second failure", async () => {
    const full = rig(() => 'QuotaExceededError');
    await expect((await full.store).put([played(1)])).rejects.toMatchObject({name: 'QuotaExceededError'});
    expect(full.opened).toHaveLength(1);
    const gone = rig(n => (n > 0 ? 'InvalidStateError' : undefined));
    const store = await gone.store;
    gone.opened[0].closed = true;
    await expect(store.put([played(1)])).rejects.toMatchObject({name: 'InvalidStateError'});
    expect(gone.opened).toHaveLength(2);
  });
});
