/**
 * Likelihoods P(observation | hypothesis) for everything the user logs.
 *
 * These are exact: a hypothesis that cannot produce an observation gets 0, so when
 * the logic is airtight the posterior is too (outsped a 189 Sneasler with no speed
 * modifiers on the field → Choice Scarf, 100%). A mis-entered observation that
 * contradicts everything is caught upstream (posterior.ts) and set aside instead of
 * wiping out the beliefs.
 */
import {toID, isDamagingMove, move as dexMove, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import type {PokemonSet} from '../data/paste';
import {
  finalSpeed, fractionalPriority, makeField, makeMove, makePokemon, movePriority, quickChances, runCalc,
  type DamageOutcome, type MonSpec,
} from './calc';
import {DROP_REACT, DROP_REACT_ITEMS, announceLikelihood} from './abilities';
import {CONTACT_PUNISH, attackerAbilityStatusChance, moveFx, moveStatusChance} from './moves';
import {NO_ITEM, type FormeSpace, type MonSpace} from './prior';
import {
  monKey, sameMon, type ActionEvent, type Battle, type BattleSettings, type HitResult, type MonCondition,
  type MonRef, type SideID, type Snapshot,
} from './types';

export interface Ctx {
  fmt: FormatData;
  gen: Gen;
  battle: Battle;
  spaces: (MonSpace | null)[];
}

export interface SlotLikelihood {
  slot: number;
  raw: Float64Array;
  /** What kind of evidence, for diagnostics. */
  kind: 'damage-taken' | 'damage-dealt' | 'speed' | 'trigger' | 'status';
  note: string;
}

export const defaultCondition = (hp: number): MonCondition => ({
  hp, boosts: {}, status: '', mega: false, abilityOn: false, itemGone: false,
});

export function condOf(snap: Snapshot, ref: MonRef, fallbackHp: number) {
  return snap.mons[monKey(ref)] ?? defaultCondition(fallbackHp);
}

function faintedCount(snap: Snapshot, side: SideID) {
  let n = 0;
  for (const [k, c] of Object.entries(snap.mons)) if (k.startsWith(side) && c.hp <= 0) n++;
  return n;
}

/** The Mega forme a set's stone turns it into, if any. */
export function megaFormeOf(gen: Gen, set: PokemonSet): string | undefined {
  if (!set.item) return undefined;
  const megas = gen.items.get(toID(set.item))?.megaStone as Record<string, string> | undefined;
  if (!megas) return undefined;
  const base = gen.species.get(toID(set.species));
  return megas[set.species] ?? (base?.baseSpecies ? megas[base.baseSpecies] : undefined) ?? Object.values(megas)[0];
}

/** My Pokémon as a calc spec, honouring Mega Evolution. */
export function mySpec(gen: Gen, fmt: FormatData, set: PokemonSet, cond?: MonCondition): MonSpec {
  const mega = cond?.mega ? megaFormeOf(gen, set) : undefined;
  const megaDex = mega ? gen.species.get(toID(mega)) : undefined;
  return {
    species: megaDex?.name ?? set.species,
    level: set.level ?? fmt.level,
    nature: set.nature,
    evs: set.evs,
    ivs: set.ivs,
    item: set.item,
    ability: megaDex ? (Object.values(megaDex.abilities ?? {})[0] as string | undefined) ?? set.ability : set.ability,
  };
}

export interface HypView {
  forme: FormeSpace;
  pre: boolean;
  spec: MonSpec;
  stats: number[];
  item: string;
  ability: string;
}

/** The calc-ready view of hypothesis h, given whether it has Mega Evolved yet. */
export function hypView(fmt: FormatData, space: MonSpace, h: number, cond: MonCondition): HypView {
  const forme = space.formes[space.f[h]];
  const s = space.s[h];
  const pre = !!forme.preMega && !cond.mega;
  const spread = forme.spreads[s];
  const item = forme.items[space.i[h]];
  // Before evolving it has its entry ability; afterwards the Mega's own.
  const ability = pre ? forme.abilities[space.a[h]] : forme.megaAbility ?? forme.abilities[space.a[h]];
  return {
    forme,
    pre,
    stats: pre ? forme.preStats![s] : forme.stats[s],
    item,
    ability,
    spec: {species: pre ? forme.preMega! : forme.species, level: fmt.level, nature: spread.nature, evs: spread.evs, item, ability},
  };
}

/** A representative true HP for a displayed %, for calcs that look at current HP (Multiscale, Eruption…). */
const curHPFromPct = (maxHP: number, pct: number) =>
  (pct >= 100 ? maxHP : Math.max(1, Math.min(maxHP - 1, Math.floor((maxHP * (pct + 0.5)) / 100))));

const QP = new Set(['Protosynthesis', 'Quark Drive']);

/** Which of the hypothesis' stats can change the result of this calc. */
function relevantStats(gen: Gen, moveName: string, role: 'attacker' | 'defender', ability: string): number[] {
  if (QP.has(ability)) return [0, 1, 2, 3, 4, 5];
  const id = toID(moveName);
  const out = role === 'attacker' ? [1, 3] : [0, 2, 4];
  if (role === 'attacker' && id === 'bodypress') out.push(2);
  if (role === 'attacker' && ['eruption', 'waterspout', 'dragonenergy'].includes(id)) out.push(0);
  if (role === 'defender' && id === 'foulplay') out.push(1);
  if (['gyroball', 'electroball'].includes(id)) out.push(5);
  if (!dexMove(gen, moveName)) return [0, 1, 2, 3, 4, 5];
  return out;
}

function auras(ctx: Ctx, snap: Snapshot) {
  const found = new Set<string>();
  for (const slot of snap.active.me) {
    if (slot === null) continue;
    const a = ctx.battle.myTeam[slot]?.ability;
    if (a) found.add(a);
  }
  for (const slot of snap.active.opp) {
    if (slot === null) continue;
    const space = ctx.spaces[slot];
    const cond = snap.mons[`opp${slot}`];
    if (!space || !cond?.mega) continue;
    for (const f of space.formes) if (f.megaAbility) found.add(f.megaAbility);
  }
  return {fairyAura: found.has('Fairy Aura'), darkAura: found.has('Dark Aura')};
}

/**
 * Items whose presence doesn't change this particular calc are collapsed into one
 * class so we only run the calc once for all of them.
 */
function itemClasses(
  space: MonSpace,
  run: (forme: number, item: string) => DamageOutcome,
  sticky: (item: string) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  space.formes.forEach((forme, fi) => {
    const sig = (o: DamageOutcome) => [...o.dist.entries()].map(e => e.join(':')).join(',');
    const baseSig = sig(run(fi, NO_ITEM));
    for (const item of forme.items) {
      const key = `${fi}|${item}`;
      if (item === NO_ITEM || (!sticky(item) && sig(run(fi, item)) === baseSig)) out.set(key, 'n');
      else out.set(key, item);
    }
  });
  return out;
}

// --- Observation models -----------------------------------------------------

/**
 * How Pokémon Champions shows HP%: rounded down, but never 0 while it's alive.
 * So 1 HP reads 1%, and only full HP reads 100% (one HP missing is 99%).
 * Showdown implements the same rule for its Champions formats (getHealth in sim/pokemon.ts).
 */
export function displayPct(hp: number, max: number) {
  if (hp <= 0) return 0;
  return Math.max(1, Math.floor((100 * hp) / max));
}

/** Could a Pokémon at `hp`/`max` be displayed as `shown`%? */
export function pctConsistent(hp: number, max: number, shown: number, settings: BattleSettings) {
  if (settings.hpMode === 'bar') return Math.abs((100 * hp) / max - shown) <= settings.tolerance;
  return displayPct(hp, max) === shown;
}

/** Every true HP that could be on screen as `pct`. */
export function hpCandidates(pct: number, max: number, settings: BattleSettings, approx = false): number[] {
  // An estimated "before" (after recoil, Leftovers…) gets a few extra points either way.
  const eff: BattleSettings = approx ? {hpMode: 'bar', tolerance: (settings.hpMode === 'bar' ? settings.tolerance : 1) + 3} : settings;
  const slack = eff.hpMode === 'bar' ? eff.tolerance + 1 : 2;
  const lo = Math.max(1, Math.floor((max * (pct - slack)) / 100));
  const hi = Math.min(max, Math.ceil((max * (pct + slack)) / 100));
  const out: number[] = [];
  for (let hp = lo; hp <= hi; hp++) if (pctConsistent(hp, max, pct, eff)) out.push(hp);
  if (!out.length) out.push(Math.min(max, Math.max(1, Math.round((max * pct) / 100))));
  return out;
}

/**
 * P(observed % change on an opponent | damage distribution, its max HP).
 * `sitrus`: the hypothesis holds an unused Sitrus Berry, which must have fired
 * exactly when the true HP dropped to half or less.
 */
export function oppHitLikelihood(
  dist: Map<number, number>, hit: HitResult, max: number, survives: boolean, settings: BattleSettings, sitrus = false,
) {
  if (hit.noEffect) return dist.get(0) ?? 0;
  const before = hpCandidates(hit.hpBefore, max, settings, hit.beforeApprox);
  const sawSitrus = hit.triggers.includes('sitrus');
  let total = 0;
  for (const hb of before) {
    for (const [roll, p] of dist) {
      if (roll === 0) continue;
      let ha = hb - roll;
      if (ha <= 0 && survives && hb === max) ha = 1;
      let ok: boolean;
      if (hit.fainted) ok = ha <= 0;
      else if (ha <= 0) ok = false;
      else {
        ok = pctConsistent(ha, max, hit.hpAfter, settings);
        if (ok && sitrus) ok = (ha <= Math.floor(max / 2)) === sawSitrus;
      }
      if (ok) total += p;
    }
  }
  return total / before.length;
}

/** P(observed exact HP change on my Pokémon | damage distribution). Off-by-one readings allowed, weakly. */
export function myHitLikelihood(dist: Map<number, number>, hit: HitResult, max: number, survives: boolean) {
  if (hit.noEffect) return dist.get(0) ?? 0;
  const b = hit.hpBefore;
  let total = 0;
  for (const [roll, p] of dist) {
    if (roll === 0) continue;
    let after = b - roll;
    if (after <= 0 && survives && b === max) after = 1;
    if (hit.fainted) {
      if (after <= 0) total += p;
      continue;
    }
    if (after <= 0) continue;
    const diff = Math.abs(after - hit.hpAfter);
    total += p * (diff === 0 ? 1 : diff === 1 ? 0.2 : 0);
  }
  return total;
}

// --- Items announced by in-game messages -----------------------------------

const RESIST_BERRIES: Record<string, string> = {
  'Occa Berry': 'Fire', 'Passho Berry': 'Water', 'Wacan Berry': 'Electric', 'Rindo Berry': 'Grass',
  'Yache Berry': 'Ice', 'Chople Berry': 'Fighting', 'Kebia Berry': 'Poison', 'Shuca Berry': 'Ground',
  'Coba Berry': 'Flying', 'Payapa Berry': 'Psychic', 'Tanga Berry': 'Bug', 'Charti Berry': 'Rock',
  'Kasib Berry': 'Ghost', 'Haban Berry': 'Dragon', 'Colbur Berry': 'Dark', 'Babiri Berry': 'Steel',
  'Roseli Berry': 'Fairy', 'Chilan Berry': 'Normal',
};

export function berryApplies(item: string, moveType: string, eff: number) {
  const t = RESIST_BERRIES[item];
  if (!t || t !== moveType) return false;
  return t === 'Normal' ? eff > 0 : eff > 1;
}

// --- Action events ------------------------------------------------------------

export function actionLikelihoods(ctx: Ctx, ev: ActionEvent): SlotLikelihood[] {
  const {gen, fmt, battle} = ctx;
  const snap = ev.before;
  const out: SlotLikelihood[] = [];
  const aura = auras(ctx, snap);
  const damaging = isDamagingMove(gen, ev.move);
  const moveData = dexMove(gen, ev.move);
  const fx = moveFx(ev.move);
  const contact = !!moveData?.flags?.contact || !!fx.ct;

  if (ev.actor.side === 'opp') {
    const slot = ev.actor.slot;
    const space = ctx.spaces[slot];
    if (!space) return out;
    const oppCond = condOf(snap, ev.actor, 100);
    const field = makeField(fmt.gameType, snap.field, 'opp', {helpingHand: ev.helpingHand, ...aura});

    // Quick Claw / Quick Draw name themselves when they fire; asked and not shown is evidence too.
    if (ev.quick !== undefined) {
      const raw = new Float64Array(space.n);
      for (let h = 0; h < space.n; h++) {
        const v = hypView(fmt, space, h, oppCond);
        const {draw, claw} = quickChances(gen, ev.move, v.ability, oppCond.itemGone ? undefined : v.item);
        raw[h] = ev.quick === 'Quick Draw' ? draw : ev.quick === 'Quick Claw' ? claw : 1 - draw - claw;
      }
      out.push({slot, raw, kind: 'trigger', note: ev.quick ? `${ev.quick} let it move first` : 'no Quick Claw / Quick Draw'});
    }

    for (const hit of ev.hits) {
      if (hit.target.side !== 'me' || !damaging || hit.unread) continue;
      const set = battle.myTeam[hit.target.slot];
      if (!set) continue;
      const myCond = condOf(snap, hit.target, hit.hpBefore);
      const spec = mySpec(gen, fmt, set, myCond);
      const defender = makePokemon(gen, spec, myCond, faintedCount(snap, 'me'), hit.hpBefore);
      const myMax = defender.maxHP();
      const survives = (!myCond.itemGone && set.item === 'Focus Sash') || spec.ability === 'Sturdy';
      const mv = makeMove(gen, ev.move, {crit: hit.crit, hits: ev.hitCount, targets: ev.targets});
      const multi = (ev.hitCount ?? 1) > 1;

      const repr = (fi: number, item: string) => {
        const forme = space.formes[fi];
        const pre = !!forme.preMega && !oppCond.mega;
        const spread = forme.spreads[0];
        const a = makePokemon(gen, {
          species: pre ? forme.preMega! : forme.species, level: fmt.level, nature: spread.nature, evs: spread.evs, item,
          ability: pre ? forme.abilities[0] : forme.megaAbility ?? forme.abilities[0],
        }, oppCond, faintedCount(snap, 'opp'));
        return runCalc(gen, a, defender, mv, field);
      };
      const classes = itemClasses(space, repr, () => false);

      const raw = new Float64Array(space.n);
      const memo = new Map<string, number>();
      for (let h = 0; h < space.n; h++) {
        const v = hypView(fmt, space, h, oppCond);
        const cls = classes.get(`${space.f[h]}|${v.item}`) ?? v.item;
        const rel = relevantStats(gen, ev.move, 'attacker', v.ability);
        const key = `${space.f[h]}|${v.pre}|${rel.map(i => v.stats[i]).join('/')}|${cls}|${v.ability}`;
        let lik = memo.get(key);
        if (lik === undefined) {
          const attacker = makePokemon(gen, cls === 'n' ? {...v.spec, item: NO_ITEM} : v.spec, oppCond,
            faintedCount(snap, 'opp'), curHPFromPct(v.stats[0], oppCond.hp));
          const res = runCalc(gen, attacker, defender, mv, field);
          lik = myHitLikelihood(res.dist, hit, myMax, survives && !multi);
          memo.set(key, lik);
        }
        raw[h] = lik;
      }
      // With the HP before unknown, the reading only resyncs it: no damage evidence.
      if (!hit.beforeUnknown) out.push({slot, raw, kind: 'damage-dealt', note: `${ev.move} → ${set.species}`});

      // A status the move can't cause on its own points at the attacker's ability.
      if (hit.status && !hit.noEffect) {
        const st = hit.status;
        const sraw = new Float64Array(space.n);
        for (let h = 0; h < space.n; h++) {
          const a = hypView(fmt, space, h, oppCond).ability;
          const pm = moveStatusChance(ev.move, st, a === 'Serene Grace');
          const pa = attackerAbilityStatusChance(a, st, contact);
          sraw[h] = 1 - (1 - pm) * (1 - pa);
        }
        out.push({slot, raw: sraw, kind: 'status', note: `${set.species} got ${st} from ${ev.move}`});
      }
    }

    // Life Orb announces itself after every damaging hit.
    const dealt = ev.hits.some(x => x.target.side === 'me' && !x.noEffect && !x.unread
      && (x.beforeUnknown || x.fainted || x.hpAfter < x.hpBefore));
    if (damaging && dealt) {
      const seen = ev.actorTriggers.includes('lifeorb');
      const raw = new Float64Array(space.n);
      for (let h = 0; h < space.n; h++) {
        const v = hypView(fmt, space, h, oppCond);
        const lo = v.item === 'Life Orb' && !oppCond.itemGone;
        const exempt = v.ability === 'Magic Guard' || (v.ability === 'Sheer Force' && !!moveData?.secondaries);
        raw[h] = seen ? (lo && !exempt ? 1 : 0) : (lo && !exempt ? 0 : 1);
      }
      out.push({slot, raw, kind: 'trigger', note: seen ? 'Life Orb recoil' : 'no Life Orb recoil'});
    }
    return out;
  }

  // My move on an opponent.
  const set = battle.myTeam[ev.actor.slot];
  if (!set || !damaging) return out;
  const myCond = condOf(snap, ev.actor, 1);
  const attacker = makePokemon(gen, mySpec(gen, fmt, set, myCond), myCond, faintedCount(snap, 'me'), myCond.hp || undefined);
  const field = makeField(fmt.gameType, snap.field, 'me', {helpingHand: ev.helpingHand, ...aura});
  const oppHits = ev.hits.filter(x => x.target.side === 'opp');

  for (const hit of oppHits) {
    const slot = hit.target.slot;
    const space = ctx.spaces[slot];
    if (!space || hit.unread) continue;
    const oppCond = condOf(snap, hit.target, hit.hpBefore);
    const mv = makeMove(gen, ev.move, {crit: hit.crit, hits: ev.hitCount, targets: ev.targets});
    const multi = (ev.hitCount ?? 1) > 1;
    const repr = (fi: number, item: string) => {
      const forme = space.formes[fi];
      const pre = !!forme.preMega && !oppCond.mega;
      const spread = forme.spreads[0];
      const stats = pre ? forme.preStats![0] : forme.stats[0];
      const d = makePokemon(gen, {
        species: pre ? forme.preMega! : forme.species, level: fmt.level, nature: spread.nature, evs: spread.evs, item,
        ability: pre ? forme.abilities[0] : forme.megaAbility ?? forme.abilities[0],
      }, oppCond, faintedCount(snap, 'opp'), curHPFromPct(stats[0], hit.hpBefore));
      return runCalc(gen, attacker, d, mv, field);
    };
    // Focus Sash changes survival and Sitrus is tied to the HP threshold: neither shows in the rolls.
    const classes = itemClasses(space, repr, item => item === 'Focus Sash' || item === 'Sitrus Berry');

    const raw = new Float64Array(space.n);
    const trig = new Float64Array(space.n);
    const memo = new Map<string, {lik: number; type: string; eff: number}>();
    for (let h = 0; h < space.n; h++) {
      const v = hypView(fmt, space, h, oppCond);
      const cls = classes.get(`${space.f[h]}|${v.item}`) ?? v.item;
      const rel = relevantStats(gen, ev.move, 'defender', v.ability);
      const key = `${space.f[h]}|${v.pre}|${rel.map(i => v.stats[i]).join('/')}|${cls}|${v.ability}`;
      let m = memo.get(key);
      if (!m) {
        const spec = cls === 'n' ? {...v.spec, item: NO_ITEM} : v.spec;
        const defender = makePokemon(gen, spec, oppCond, faintedCount(snap, 'opp'), curHPFromPct(v.stats[0], hit.hpBefore));
        const res = runCalc(gen, attacker, defender, mv, field);
        const has = !oppCond.itemGone;
        const survives = !multi && ((cls === 'Focus Sash' && has) || v.ability === 'Sturdy');
        m = {
          lik: oppHitLikelihood(res.dist, hit, res.maxHP, survives, battle.settings, cls === 'Sitrus Berry' && has),
          type: res.moveType,
          eff: res.effectiveness,
        };
        memo.set(key, m);
      }
      raw[h] = m.lik;

      // Messages the defender's item would have produced (their absence is evidence too).
      let t = 1;
      const has = !oppCond.itemGone;
      const tr = hit.triggers;
      const landed = !hit.noEffect;
      const berry = has && landed && berryApplies(v.item, m.type, m.eff);
      if (tr.includes('berry') !== berry) t = 0;
      const wp = has && landed && v.item === 'Weakness Policy' && m.eff > 1 && !hit.fainted;
      if (tr.includes('wp') !== wp) t = 0;
      if (tr.includes('sitrus') && !(has && v.item === 'Sitrus Berry')) t = 0;
      if (tr.includes('sash') && !((has && v.item === 'Focus Sash') || v.ability === 'Sturdy')) t = 0;
      // A guaranteed stat drop the user was asked about (Defiant, Competitive, Clear Amulet…).
      if (hit.reaction !== undefined && landed && !hit.fainted) {
        t *= announceLikelihood(hit.reaction, v.ability, has ? v.item : '', DROP_REACT, DROP_REACT_ITEMS);
      }
      if (contact && landed && oppHits.length === 1) {
        const helmet = has && v.item === 'Rocky Helmet';
        if (ev.actorTriggers.includes('helmet') !== helmet) t = 0;
        // Contact that left my attacker with a status: Flame Body, Static, Poison Point, Effect Spore.
        if (ev.actorStatus) t *= CONTACT_PUNISH[v.ability]?.[ev.actorStatus] ?? 0;
      }
      trig[h] = t;
    }
    if (!hit.beforeUnknown) out.push({slot, raw, kind: 'damage-taken', note: `${set.species}'s ${ev.move}`});
    if (trig.some(x => x !== 1)) out.push({slot, raw: trig, kind: 'trigger', note: 'item / ability messages'});
  }
  return out;
}

// --- Turn order ----------------------------------------------------------------

export interface OppPair {
  first: ActionEvent;
  second: ActionEvent;
  /** The field when the first of them moved (with this turn's Mega Evolutions in place). */
  snap: Snapshot;
}

/** Speed/priority info for opponent hypothesis h acting with `moveName` under `snap`. */
export function oppOrderKey(
  ctx: Ctx, space: MonSpace, h: number, ref: MonRef, moveName: string, snap: Snapshot, memo: Map<string, [number, number]>,
  quick = false,
): [priority: number, speed: number] {
  const {gen, fmt} = ctx;
  const cond = condOf(snap, ref, 100);
  const v = hypView(fmt, space, h, cond);
  const speedItem = v.item === 'Choice Scarf' || v.item === 'Iron Ball' || v.item === 'Lagging Tail' || v.item === 'Full Incense'
    || (QP.has(v.ability) && v.item === 'Booster Energy') ? v.item : 'n';
  const statKey = QP.has(v.ability) ? v.stats.join('/') : v.stats[5];
  const key = `${space.f[h]}|${v.pre}|${statKey}|${speedItem}|${v.ability}|${moveName}|${quick}`;
  let r = memo.get(key);
  if (!r) {
    const mon = makePokemon(gen, speedItem === 'n' ? {...v.spec, item: NO_ITEM} : v.spec, cond, faintedCount(snap, 'opp'));
    const field = makeField(fmt.gameType, snap.field, 'opp');
    const bracket = movePriority(gen, moveName, v.ability, cond.hp >= 100, snap.field)
      + fractionalPriority(gen, moveName, v.ability, cond.itemGone ? undefined : v.item, quick);
    r = [bracket, finalSpeed(gen, mon, field)];
    memo.set(key, r);
  }
  return r;
}

/** Mega Evolution happens before anyone moves, whenever in the turn it was logged. */
function withMegas(snap: Snapshot, megas: MonRef[]): Snapshot {
  const missing = megas.filter(r => snap.mons[monKey(r)] && !snap.mons[monKey(r)].mega);
  if (!missing.length) return snap;
  const out = structuredClone(snap);
  for (const r of missing) out.mons[monKey(r)].mega = true;
  return out;
}

/** 1 if `first` acting before `second` is consistent, 0.5 on a speed tie, 0 otherwise. */
export function orderConsistency(first: [number, number], second: [number, number], trickRoom: boolean) {
  if (first[0] !== second[0]) return first[0] > second[0] ? 1 : 0;
  if (first[1] === second[1]) return 0.5;
  const faster = first[1] > second[1];
  return (trickRoom ? !faster : faster) ? 1 : 0;
}

/**
 * Speed evidence from the order of actions within one turn: every pair, compared on the
 * field as it was when the earlier one moved (Speed changes apply mid-turn). `megas` are
 * this turn's Mega Evolutions. Pairs between two opponents are returned separately; they
 * are applied later with a mean-field approximation because both sides are uncertain.
 */
export function turnOrderLikelihoods(ctx: Ctx, actions: ActionEvent[], megas: MonRef[] = []): {mine: SlotLikelihood[]; oppPairs: OppPair[]} {
  const {gen, fmt, battle} = ctx;
  const mine: SlotLikelihood[] = [];
  const oppPairs: OppPair[] = [];
  const ordered = actions.filter(a => a.ordered);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const A = ordered[i];
      const B = ordered[j];
      if (sameMon(A.actor, B.actor) || (A.actor.side === 'me' && B.actor.side === 'me')) continue;
      const snap = withMegas(A.before, megas);
      if (A.actor.side === 'opp' && B.actor.side === 'opp') {
        oppPairs.push({first: A, second: B, snap});
        continue;
      }
      const opp = A.actor.side === 'opp' ? A : B;
      const me = opp === A ? B : A;
      const space = ctx.spaces[opp.actor.slot];
      const set = battle.myTeam[me.actor.slot];
      if (!space || !set) continue;
      const myCond = condOf(snap, me.actor, 1);
      const spec = mySpec(gen, fmt, set, myCond);
      const myMon = makePokemon(gen, spec, myCond, faintedCount(snap, 'me'));
      const myMax = myMon.maxHP();
      const mineKey: [number, number] = [
        movePriority(gen, me.move, spec.ability, myCond.hp >= myMax, snap.field)
          + fractionalPriority(gen, me.move, spec.ability, myCond.itemGone ? undefined : set.item, !!me.quick),
        finalSpeed(gen, myMon, makeField(fmt.gameType, snap.field, 'me')),
      ];
      const raw = new Float64Array(space.n);
      const memo = new Map<string, [number, number]>();
      for (let h = 0; h < space.n; h++) {
        const theirs = oppOrderKey(ctx, space, h, opp.actor, opp.move, snap, memo, !!opp.quick);
        raw[h] = opp === A
          ? orderConsistency(theirs, mineKey, snap.field.trickRoom)
          : orderConsistency(mineKey, theirs, snap.field.trickRoom);
      }
      mine.push({
        slot: opp.actor.slot,
        raw,
        kind: 'speed',
        note: opp === A ? `moved before ${set.species} (${mineKey[1]} Spe)` : `moved after ${set.species} (${mineKey[1]} Spe)`,
      });
    }
  }
  return {mine, oppPairs};
}
