import {useMemo} from 'react';
import {STAT_LABELS, usesStatPoints, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import type {Beliefs, MonBelief, StatBelief} from '../engine/posterior';
import {myMoveInto, oppMoveInto, speedMatchups} from '../engine/predict';
import {OTHER_ITEM} from '../engine/prior';
import type {Battle} from '../engine/types';
import {DistBars, DistRow, Sprite, pct} from './common';
import {oppDisplaySpecies} from './battleUtil';

function StatRow({s}: {s: StatBelief}) {
  const lo = Math.min(s.values[0]?.[0] ?? 0, s.priorLo);
  const hi = Math.max(s.values[s.values.length - 1]?.[0] ?? 0, s.priorHi);
  const bins = 24;
  const width = Math.max(1, hi - lo + 1);
  const hist = new Array(Math.min(bins, width)).fill(0);
  for (const [v, p] of s.values) hist[Math.min(hist.length - 1, Math.floor(((v - lo) / width) * hist.length))] += p;
  const top = Math.max(...hist, 1e-9);
  const sure = s.lo === s.hi;
  return (
    <div className="stat-row">
      <span className="muted">{STAT_LABELS[s.stat]}</span>
      <div className="hist" title={`range shown ${lo}–${hi}`}>
        {hist.map((p, i) => (
          <div key={i} style={{height: `${Math.max(2, (p / top) * 100)}%`, opacity: p > 0 ? 1 : 0.15}} />
        ))}
      </div>
      <span className="mono" title="most likely value (90% interval)">
        {sure ? <b>{s.mode}</b> : <>{s.mode} <span className="muted">({s.lo}–{s.hi})</span></>}
      </span>
    </div>
  );
}

function Matchups({fmt, gen, battle, belief}: {fmt: FormatData; gen: Gen; battle: Battle; belief: MonBelief}) {
  const live = battle.live;
  const mine = live.active.me.filter((s): s is number => s !== null);
  const mySlots = mine.length ? mine : battle.myTeam.map((_, i) => i).filter(i => (live.mons[`me${i}`]?.hp ?? 1) > 0).slice(0, 2);

  const data = useMemo(() => {
    const speed = speedMatchups(fmt, gen, battle, belief, live);
    const mineInto = mySlots.flatMap(slot =>
      battle.myTeam[slot].moves.map(m => ({slot, r: myMoveInto(fmt, gen, battle, belief, slot, m, live)})).filter(x => x.r));
    const theirMoves = belief.moves.filter(m => m.p > 0.15).slice(0, 5).map(m => m.name);
    const theirsInto = theirMoves.flatMap(m =>
      mySlots.map(slot => ({slot, r: oppMoveInto(fmt, gen, battle, belief, slot, m, live)})).filter(x => x.r));
    return {speed, mineInto, theirsInto};
  }, [fmt, gen, battle, belief, live, mySlots.join(',')]);

  const name = (slot: number) => battle.myTeam[slot].nickname || battle.myTeam[slot].species;
  const range = (r: {lo: number; hi: number}) => `${r.lo.toFixed(0)}–${r.hi.toFixed(0)}%`;
  return (
    <div className="matchups col">
      <div className="section-title"><h3>Speed</h3><span className="small muted">{live.field.trickRoom ? 'Trick Room is up: slower moves first' : 'current field & boosts'}</span></div>
      <table>
        <thead><tr><th>vs my</th><th>my Spe</th><th>it's faster</th></tr></thead>
        <tbody>
          {data.speed.map(s => (
            <tr key={s.mySlot}>
              <td>{name(s.mySlot)}</td>
              <td className="mono">{s.mySpeed}</td>
              <td>{pct(s.pFaster)}{s.pTie > 0.01 ? <span className="muted"> (tie {pct(s.pTie)})</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title"><h3>My moves into it</h3><span className="small muted">from its current HP</span></div>
      <table>
        <thead><tr><th>move</th><th>damage</th><th>KO</th></tr></thead>
        <tbody>
          {data.mineInto.map(({slot, r}) => (
            <tr key={`${slot}${r!.move}`}>
              <td>{name(slot)}: {r!.move}</td>
              <td className="mono">{range(r!)}</td>
              <td className={r!.ko > 0.9 ? 'good' : ''}>{pct(r!.ko)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title"><h3>Its likely moves into me</h3></div>
      <table>
        <thead><tr><th>move → my</th><th>damage</th><th>KO</th></tr></thead>
        <tbody>
          {data.theirsInto.map(({slot, r}) => (
            <tr key={`${slot}${r!.move}`}>
              <td>{r!.move} → {name(slot)}</td>
              <td className="mono">{range(r!)}</td>
              <td className={r!.ko > 0.5 ? 'bad' : ''}>{pct(r!.ko)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note">Damage is the 90% range over both damage rolls and what the opponent might be running.</div>
    </div>
  );
}

export function BeliefPanel({fmt, gen, battle, beliefs, slot}: {
  fmt: FormatData; gen: Gen; battle: Battle; beliefs: Beliefs; slot: number;
}) {
  const b = beliefs.mons[slot];
  if (!b) return <div className="panel empty">No data for this Pokémon.</div>;
  const unit = usesStatPoints(gen) ? 'SP' : 'EVs';
  const notes = beliefs.notes.filter(n => n.slot === slot);
  const species = oppDisplaySpecies(battle, beliefs, slot, battle.live);
  const statsFrom = b.space.formes.every(f => f.fromStats);
  const itemLabel = (n: string) => (n === OTHER_ITEM ? <span className="muted">other items</span> : n);

  return (
    <div className="col">
      <div className="panel col">
        <div className="row" style={{flexWrap: 'nowrap'}}>
          <Sprite gen={gen} species={species} />
          <div>
            <h2>{species}</h2>
            <div className="small muted">
              {statsFrom ? `${fmt.name} usage priors` : 'Not in usage stats: generic priors'}
              {b.choiceBroken && ' · switched moves without switching out (not Choice)'}
            </div>
          </div>
        </div>
        <div className="small muted">Bars are beliefs now; the thin tick is where the usage-stats prior started.</div>

        {b.formes.length > 1 && (
          <>
            <div className="section-title"><h3>Forme</h3></div>
            <DistBars entries={b.formes} max={4} />
          </>
        )}
        <div className="section-title"><h3>Item</h3></div>
        <DistBars entries={b.items} label={itemLabel} />
        <div className="section-title"><h3>Ability</h3></div>
        <DistBars entries={b.abilities} max={3} />
        {b.tera && (
          <>
            <div className="section-title"><h3>Tera type</h3></div>
            <DistBars entries={b.tera} max={4} />
          </>
        )}
        <div className="section-title"><h3>Moves</h3><span className="small muted">chance it's in the set</span></div>
        <div className="dist">
          {b.moves.slice(0, 10).map(m => (
            <DistRow key={m.name} name={m.revealed ? <b>✓ {m.name}</b> : m.name} p={m.p} prior={m.revealed ? undefined : m.prior} />
          ))}
        </div>
      </div>

      <div className="panel col">
        <div className="section-title"><h3>Stats</h3><span className="small muted">most likely (90% interval), {species.includes('-Mega') || b.formes[0]?.name.includes('-Mega') ? 'battle forme' : 'level ' + fmt.level}</span></div>
        {b.stats.map(s => (
          <StatRow key={s.stat} s={s} />
        ))}
        <div className="section-title"><h3>Likeliest spreads</h3></div>
        <table className="mono" style={{width: '100%', fontSize: 12}}>
          <tbody>
            {b.spreads.slice(0, 6).map((s, i) => (
              <tr key={i}>
                <td>{s.nature}</td>
                <td title={`${unit} HP/Atk/Def/SpA/SpD/Spe`}>{s.evs.join('/')}</td>
                <td className="muted">{s.stats.join('/')}</td>
                <td style={{textAlign: 'right'}}>{pct(s.p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <Matchups fmt={fmt} gen={gen} battle={battle} belief={b} />
      </div>

      {notes.length > 0 && (
        <div className="panel col">
          <h3>Evidence about it</h3>
          {notes.map((n, i) => (
            <div key={i} className={`note${n.consistent < 0.01 ? ' alert' : ''}`}>
              {n.kind}: {n.note}
              {n.kind !== 'reveal' && n.kind !== 'moves' && ` · ${pct(n.consistent)} of prior belief could produce this`}
              {n.consistent < 0.01 && ' ⚠ surprising: double-check crit, boosts, field or Helping Hand'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
