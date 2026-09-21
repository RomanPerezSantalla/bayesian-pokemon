import type {Gen} from '../../data/dex';
import type {DamageMatchup, SpeedMatchup, SpeedProfile} from '../../engine/predict';
import type {InferResult} from '../../engine/worker';
import type {Battle, MonRef} from '../../engine/types';
import {Sprite, pct} from '../common';
import {dmgRange, hitVerdict, speedVerdict} from './verdict';
import {monLabel} from './names';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * One HP bar that tells the whole story of a hit: what's surely left (solid),
 * the damage-roll spread (striped), and what's surely lost (faded). Fractions of max HP.
 */
export function DamageBar({hp, lo, hi}: {hp: number; lo: number; hi: number}) {
  const now = clamp01(hp);
  const worst = clamp01(now - hi);
  const best = clamp01(now - lo);
  const tone = worst > 0.5 ? 'g' : worst > 0.2 ? 'y' : 'r';
  return (
    <div className="dmg" title={`${Math.round(lo * 100)}–${Math.round(hi * 100)}% of max HP`}>
      <div className={`dmg-left ${tone}`} style={{width: `${worst * 100}%`}} />
      <div className="dmg-maybe" style={{left: `${worst * 100}%`, width: `${(best - worst) * 100}%`}} />
      <div className="dmg-lost" style={{left: `${best * 100}%`, width: `${(now - best) * 100}%`}} />
    </div>
  );
}

function DamageRow({label, sub, cur, r}: {label: string; sub?: string; cur: number; r: DamageMatchup}) {
  const verdict = hitVerdict(r, cur);
  return (
    <div className={`dmg-row${verdict.weak ? ' weak' : ''}`}>
      <div className="dmg-label"><span>{label}</span>{sub && <small className="muted"> {sub}</small>}</div>
      <DamageBar hp={cur / 100} lo={r.lo / 100} hi={r.hi / 100} />
      <span className="dmg-pct mono">{dmgRange(r.lo, r.hi)}</span>
      <span className={`ko ko-${verdict.cls}`} title={verdict.title}>{verdict.text}</span>
    </div>
  );
}

export interface Card {
  slot: number;
  name: string;
  species: string;
  /** Its HP now, % of max. */
  hp: number;
  hpText: string;
  takes: DamageMatchup[];
  deals: DamageMatchup[];
}

const TOP = 3;

/**
 * One card per Pokémon of yours on the field: what it takes from this opponent and what it
 * deals back, each as HP bars with the roll zone. The likeliest threats and your best hits
 * come first; `all` shows every move.
 */
export function MatchupCards({gen, cards, oppHp, moveP, speed, trickRoom, all, onAll}: {
  gen: Gen;
  cards: Card[];
  oppHp: number;
  moveP(move: string): number;
  speed: SpeedMatchup[];
  trickRoom: boolean;
  all: boolean;
  onAll(all: boolean): void;
}) {
  const threat = (r: DamageMatchup) => moveP(r.move) * (r.ko + r.hi / 1000);
  const sorted = cards.map(c => ({
    ...c,
    takes: [...c.takes].sort((a, b) => threat(b) - threat(a)),
    deals: [...c.deals].sort((a, b) => b.ko - a.ko || b.hi - a.hi),
  }));
  const hidden = sorted.reduce((n, c) => n + Math.max(0, c.takes.length - TOP) + Math.max(0, c.deals.length - TOP), 0);
  const cut = <T,>(list: T[]) => (all ? list : list.slice(0, TOP));
  return (
    <div className="col">
      {sorted.map(c => {
        // How close a likely move comes to KOing it: colours the card's edge.
        const danger = Math.max(0, ...c.takes.map(r => r.ko * moveP(r.move)));
        const edge = danger >= 0.5 ? ' danger' : danger > 0.05 ? ' risk' : '';
        const sv = speedVerdict(speed.find(s => s.mySlot === c.slot), trickRoom);
        return (
          <div key={c.slot} className={`mcard${edge}`}>
            <div className="mcard-head">
              <Sprite gen={gen} species={c.species} />
              <b className="mcard-name">{c.name}</b>
              <span className="muted small mono">{c.hpText}</span>
              <span className="spacer" />
              {sv && <span className={`verdict ${sv.cls}`}>{sv.text}</span>}
            </div>
            {c.takes.length > 0 && <div className="mcard-label">takes</div>}
            {cut(c.takes).map(r => (
              <DamageRow key={`t${r.move}`} label={r.move} sub={moveP(r.move) < 1 ? pct(moveP(r.move)) : '✓'} cur={c.hp} r={r} />
            ))}
            {c.deals.length > 0 && <div className="mcard-label">deals</div>}
            {cut(c.deals).map(r => <DamageRow key={`d${r.move}`} label={r.move} cur={oppHp} r={r} />)}
          </div>
        );
      })}
      {(hidden > 0 || all) && (
        <button className="btn sm ghost" onClick={() => onAll(!all)}>{all ? 'Fewer moves' : `All moves (${hidden} more)`}</button>
      )}
    </div>
  );
}

/** Its Speed now, and before/after for your Pokémon not shown in the cards (`skip`). */
export function SpeedVerdicts({battle, speed, profile, trickRoom, skip = []}: {
  battle: Battle; speed: SpeedMatchup[]; profile: SpeedProfile; trickRoom: boolean; skip?: number[];
}) {
  const pool = battle.brought ?? battle.myTeam.map((_, i) => i);
  const list = speed.filter(s => pool.includes(s.mySlot) && !skip.includes(s.mySlot)).sort((a, b) => b.mySpeed - a.mySpeed);
  const range = profile.lo === profile.hi ? `${profile.mode}` : `${profile.lo}–${profile.hi}`;
  return (
    <div className="col">
      <div className="small">Its Speed now: <b className="mono">{range}</b>{profile.lo !== profile.hi && <span className="muted"> (95%)</span>}
        {trickRoom && <span className="warn"> · Trick Room: slower moves first</span>}</div>
      {list.length > 0 && (
        <div className="chips">
          {list.map(s => {
            const sv = speedVerdict(s, trickRoom)!;
            return (
              <span key={s.mySlot} className={`verdict ${sv.cls}`}>
                <b>{battle.myTeam[s.mySlot].nickname || battle.myTeam[s.mySlot].species}</b> <span className="mono">{s.mySpeed}</span> · {sv.text}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Runner {
  ref: MonRef;
  label: string;
  dist: [number, number][];
  lo: number;
  hi: number;
  mid: number;
}

/** P(a moves before b) for independent speed distributions. */
function pBefore(a: Runner, b: Runner, trickRoom: boolean) {
  let p = 0;
  for (const [x, px] of a.dist) {
    for (const [y, py] of b.dist) {
      if (x === y) p += 0.5 * px * py;
      else if (trickRoom ? x < y : x > y) p += px * py;
    }
  }
  return p;
}

/** Who moves first among everyone on the field (same-priority moves), at a glance. */
export function SpeedOrder({battle, result}: {battle: Battle; result: InferResult | null}) {
  if (!result) return null;
  const tr = battle.live.field.trickRoom;
  const anyMatchup = Object.values(result.matchups)[0];
  if (!anyMatchup) return null;
  const runners: Runner[] = [];
  for (const slot of battle.live.active.me) {
    if (slot === null || (battle.live.mons[`me${slot}`]?.hp ?? 1) <= 0) continue;
    const s = anyMatchup.speed.find(x => x.mySlot === slot);
    if (!s) continue;
    runners.push({ref: {side: 'me', slot}, label: monLabel(battle, result.mons, {side: 'me', slot}), dist: [[s.mySpeed, 1]], lo: s.mySpeed, hi: s.mySpeed, mid: s.mySpeed});
  }
  for (const slot of battle.live.active.opp) {
    if (slot === null || (battle.live.mons[`opp${slot}`]?.hp ?? 1) <= 0) continue;
    const prof = result.matchups[slot]?.profile;
    if (!prof) continue;
    runners.push({ref: {side: 'opp', slot}, label: monLabel(battle, result.mons, {side: 'opp', slot}), dist: prof.dist, lo: prof.lo, hi: prof.hi, mid: prof.mode});
  }
  if (runners.length < 2) return null;
  // Order by who's more likely to move first, pair by pair (not by a single guess).
  const sorted: Runner[] = [];
  for (const r of runners) {
    let i = 0;
    while (i < sorted.length && pBefore(sorted[i], r, tr) >= 0.5) i++;
    sorted.splice(i, 0, r);
  }
  return (
    <div className="order">
      <span className="small muted">{tr ? 'Order (Trick Room)' : 'Order'}</span>
      {sorted.map((r, i) => {
        const next = sorted[i + 1];
        const p = next ? pBefore(r, next, tr) : 1;
        return (
          <span key={`${r.ref.side}${r.ref.slot}`} className="order-item">
            <span className={`order-mon ${r.ref.side}`}>
              {r.label} <span className="mono">{r.lo === r.hi ? r.lo : `${r.lo}–${r.hi}`}</span>
            </span>
            {next && <span className={`order-sep${p > 0.98 ? '' : ' unsure'}`}>{p > 0.98 ? '›' : `› ${pct(p)}`}</span>}
          </span>
        );
      })}
    </div>
  );
}
