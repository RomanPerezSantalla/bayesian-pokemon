import type {Gen} from '../../data/dex';
import type {DamageMatchup, SpeedMatchup, SpeedProfile} from '../../engine/predict';
import type {InferResult} from '../../engine/worker';
import type {Battle} from '../../engine/types';
import {pBefore, predictedOrder} from './order';
import {Sprite, TypeTab, pct} from '../common';
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

/** One hit: type and multiplier, move (and how likely it has it), then HP bar, range and verdict. */
function DamageRow({r, cur, p}: {r: DamageMatchup; cur: number; p?: number}) {
  const verdict = hitVerdict(r, cur);
  return (
    <div className={`dmg-row${verdict.weak ? ' weak' : ''}`}>
      <TypeTab type={r.type} eff={r.eff} />
      <div className="dmg-label">
        <span className="nm">{r.move}</span>
        {p !== undefined && <small className="muted">{p < 1 ? pct(p) : '✓'}</small>}
      </div>
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
  /** Counted as Mega Evolving this turn (it hasn't yet). */
  asMega?: boolean;
  takes: DamageMatchup[];
  deals: DamageMatchup[];
}

/**
 * One card per Pokémon of yours on the field: what it takes from this opponent and what it
 * deals back, every move a row with the HP bar and roll zone. Likeliest threats and best hits
 * come first; hits needing four or more fade.
 */
export function MatchupCards({gen, cards, oppName, oppHp, moveP, speed, trickRoom}: {
  gen: Gen;
  cards: Card[];
  oppName: string;
  oppHp: number;
  moveP(move: string): number;
  speed: SpeedMatchup[];
  trickRoom: boolean;
}) {
  const threat = (r: DamageMatchup) => moveP(r.move) * (r.ko + r.hi / 1000);
  return (
    <div className="col">
      {cards.map(c => {
        const takes = [...c.takes].sort((x, y) => threat(y) - threat(x));
        const deals = [...c.deals].sort((x, y) => y.ko - x.ko || y.hi - x.hi);
        // How close a likely move comes to KOing it: colours the card's edge.
        const danger = Math.max(0, ...c.takes.map(r => r.ko * moveP(r.move)));
        const edge = danger >= 0.5 ? ' danger' : danger > 0.05 ? ' risk' : '';
        const sv = speedVerdict(speed.find(s => s.mySlot === c.slot), trickRoom, {mine: c.name, opp: oppName});
        return (
          <div key={c.slot} className={`mcard${edge}`}>
            <div className="mcard-head">
              <Sprite gen={gen} species={c.species} />
              <b className="mcard-name">{c.name}</b>
              {c.asMega && <span className="tag" title="Counted as Mega Evolving this turn">as Mega</span>}
              <span className="muted small mono">{c.hpText}</span>
              <span className="spacer" />
              {sv && <span className={`verdict ${sv.cls}`}>{sv.text}</span>}
            </div>
            {c.takes.length > 0 && <div className="mcard-label">takes from {oppName}</div>}
            {takes.map(r => <DamageRow key={`t${r.move}`} r={r} cur={c.hp} p={moveP(r.move)} />)}
            {c.deals.length > 0 && <div className="mcard-label">deals to {oppName}</div>}
            {deals.map(r => <DamageRow key={`d${r.move}`} r={r} cur={oppHp} />)}
          </div>
        );
      })}
    </div>
  );
}

/** Its Speed now, and who moves first against your Pokémon not shown in the cards (`skip`). */
export function SpeedVerdicts({battle, oppName, speed, profile, trickRoom, skip = []}: {
  battle: Battle; oppName: string; speed: SpeedMatchup[]; profile: SpeedProfile; trickRoom: boolean; skip?: number[];
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
            const mine = battle.myTeam[s.mySlot].nickname || battle.myTeam[s.mySlot].species;
            const sv = speedVerdict(s, trickRoom, {mine, opp: oppName})!;
            return (
              <span key={s.mySlot} className={`verdict ${sv.cls}`}>
                {mine} <span className="mono">{s.mySpeed}</span> · <b>{sv.text}</b>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Who moves first among everyone on the field (same-priority moves), at a glance. */
export function SpeedOrder({battle, result}: {battle: Battle; result: InferResult | null}) {
  const sorted = predictedOrder(battle, result);
  if (sorted.length < 2) return null;
  const tr = battle.live.field.trickRoom;
  return (
    <div className="order">
      <span className="small muted">{tr ? 'Order (Trick Room)' : 'Order'}</span>
      {sorted.map((r, i) => {
        const next = sorted[i + 1];
        const p = next ? pBefore(r, next, tr) : 1;
        return (
          <span key={`${r.ref.side}${r.ref.slot}`} className="order-item">
            <span className={`order-mon ${r.ref.side}`}>
              {monLabel(battle, result?.mons, r.ref)} <span className="mono">{r.lo === r.hi ? r.lo : `${r.lo}–${r.hi}`}</span>
            </span>
            {next && <span className={`order-sep${p > 0.98 ? '' : ' unsure'}`}>{p > 0.98 ? '›' : `› ${pct(p)}`}</span>}
          </span>
        );
      })}
    </div>
  );
}
