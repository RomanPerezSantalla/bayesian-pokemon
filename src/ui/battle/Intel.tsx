import {useState} from 'react';
import {STAT_LABELS, usesStatPoints, type Gen} from '../../data/dex';
import type {FormatData} from '../../data/format';
import type {StatBelief} from '../../engine/posterior';
import {OTHER_ITEM} from '../../engine/prior';
import {maxHPOf} from '../../engine/state';
import type {InferResult, MonSummary} from '../../engine/worker';
import type {Battle} from '../../engine/types';
import {DistBars, DistRow, Sprite, pct} from '../common';
import {megaFormeOf} from '../../engine/likelihood';
import {oppSpecies} from './names';
import {MatchupCards, SpeedVerdicts, type Card} from './visuals';

/** 95% interval of a stat, drawn inside the prior's interval: it narrows as evidence comes in. */
function StatRow({s, unit}: {s: StatBelief; unit: string}) {
  const lo = Math.min(s.lo, s.priorLo);
  const hi = Math.max(s.hi, s.priorHi);
  const span = Math.max(1, hi - lo);
  const x = (v: number) => `${((v - lo) / span) * 100}%`;
  const w = (a: number, b: number) => `${Math.max(1.5, ((b - a) / span) * 100)}%`;
  const sure = s.lo === s.hi;
  const sp = s.sp.lo === s.sp.hi ? `${s.sp.mode}` : `${s.sp.lo}–${s.sp.hi}`;
  return (
    <div className="stat-row2">
      <span className="muted">{STAT_LABELS[s.stat]}</span>
      <div className="stat-ci" title={`prior 95%: ${s.priorLo}–${s.priorHi}`}>
        <div className="prior" style={{left: x(s.priorLo), width: w(s.priorLo, s.priorHi)}} />
        <div className={`post${sure ? ' sure' : ''}`} style={{left: x(s.lo), width: w(s.lo, s.hi)}} />
        <div className="mode" style={{left: x(s.mode)}} />
      </div>
      <span className="mono">
        {sure ? <b className="good">{s.mode} ✓</b> : <><b>{s.lo}–{s.hi}</b></>}
        <span className="muted"> · {sp} {unit}</span>
      </span>
    </div>
  );
}

/** One-line headline facts: what's certain, what's likely. */
export function headline(m: MonSummary, mega = false): string {
  const bits: string[] = [];
  const item = m.items.find(e => e.p > 0 && e.name !== OTHER_ITEM);
  if (item) bits.push(item.certain ? `${item.name} ✓` : `${item.name} ${pct(item.p)}`);
  const forme = m.formes.find(f => f.p > 0.5 && m.megaAbilityOf[f.name]);
  if (mega && forme) bits.push(`${m.megaAbilityOf[forme.name]} ✓`);
  else {
    const ab = m.abilities.find(e => e.p > 0);
    if (ab && (ab.certain || ab.p < 0.95)) bits.push(ab.certain ? `${ab.name} ✓` : `${ab.name} ${pct(ab.p)}`);
  }
  return bits.join(' · ');
}

function Abilities({m, mega}: {m: MonSummary; mega: boolean}) {
  const megas = m.formes.filter(f => f.p > 0 && m.megaAbilityOf[f.name]);
  if (!megas.length) {
    return (
      <div className="section">
        <h3>Ability</h3>
        <DistBars entries={m.abilities} max={3} />
      </div>
    );
  }
  // A Mega has two abilities in play: the one it came in with (uncertain) and its own (fixed).
  return (
    <div className="section col">
      <h3>{mega ? 'Ability (Mega)' : 'Ability if it Mega Evolves'}</h3>
      <div className="dist">
        {megas.map(f => (
          <DistRow key={f.name} name={<>{m.megaAbilityOf[f.name]} <span className="muted small">{f.name.replace(/^.*?-Mega/, 'Mega')}</span></>}
            p={f.p} certain={f.certain} />
        ))}
      </div>
      <h3>{mega ? 'Ability before Mega Evolving' : 'Ability now'}</h3>
      <DistBars entries={m.abilities} max={3} />
    </div>
  );
}

export function Intel({fmt, gen, battle, result, slot}: {
  fmt: FormatData; gen: Gen; battle: Battle; result: InferResult | null; slot: number;
}) {
  const [more, setMore] = useState(false);
  const [allMoves, setAllMoves] = useState(false);
  const m = result?.mons[slot];
  if (!m) return <div className="panel empty">Loading beliefs…</div>;
  const live = battle.live;
  const species = oppSpecies(battle, result.mons, slot);
  const mega = !!live.mons[`opp${slot}`]?.mega;
  const mu = result.matchups[slot];
  const notes = result.notes.filter(n => n.slot === slot || n.slot === -1);
  const conflicts = notes.filter(n => n.kind === 'conflict');
  const unit = usesStatPoints(gen) ? 'SP' : 'EVs';
  const stateCtx = {fmt, gen, battle, oppAbility: () => undefined, oppItem: () => undefined};
  const moveP = (name: string) => m.moves.find(x => x.name === name)?.p ?? 0;
  // One card per Pokémon of yours in the matchups: what it takes, what it deals.
  const cards: Card[] = mu
    ? [...new Set([...mu.theirs, ...mu.mine].map(x => x.slot))].map(s => {
      const set = battle.myTeam[s];
      const c = live.mons[`me${s}`];
      const max = maxHPOf(stateCtx, live, {side: 'me', slot: s});
      const hp = c?.hp ?? max;
      return {
        slot: s,
        name: set.nickname || set.species,
        species: c?.mega ? megaFormeOf(gen, set) ?? set.species : set.species,
        hp: (100 * hp) / max,
        hpText: `${hp}/${max}`,
        takes: mu.theirs.filter(x => x.slot === s).map(x => x.r),
        deals: mu.mine.filter(x => x.slot === s).map(x => x.r),
      };
    })
    : [];
  // Stats are for the forme it battles in: say so while a likely Mega hasn't evolved yet.
  const likelyMega = m.formes.find(f => f.p > 0.5 && m.megaAbilityOf[f.name]);
  const statsForme = !mega && likelyMega ? likelyMega.name : '';

  return (
    <div className="panel col intel">
      <div className="row" style={{flexWrap: 'nowrap'}}>
        <Sprite gen={gen} species={species} large />
        <div style={{minWidth: 0}}>
          <h2>{species}</h2>
          <div className="small muted">{headline(m, mega) || 'no evidence yet'}</div>
        </div>
      </div>
      {conflicts.map((n, i) => <div key={i} className="note alert">⚠ {n.note}</div>)}

      {mu && cards.length > 0 && (
        <div className="section col">
          <h3>Damage</h3>
          <MatchupCards gen={gen} cards={cards} oppHp={live.mons[`opp${slot}`]?.hp ?? 100} moveP={moveP}
            speed={mu.speed} trickRoom={live.field.trickRoom} all={allMoves} onAll={setAllMoves} />
          <div className="note">% of max HP (95% range over rolls and its possible sets). Bar: solid = HP surely left, striped = depends on the roll.</div>
        </div>
      )}

      {mu && (
        <div className="section col">
          <h3>Speed</h3>
          <SpeedVerdicts battle={battle} speed={mu.speed} profile={mu.profile} trickRoom={live.field.trickRoom} skip={cards.map(c => c.slot)} />
        </div>
      )}

      <div className="section">
        <h3>Item</h3>
        <DistBars entries={m.items} max={4} label={n => (n === OTHER_ITEM ? <span className="muted">other</span> : n)} />
      </div>
      <Abilities m={m} mega={mega} />
      {!mega && m.formes.filter(f => f.p > 0).length > 1 && (
        <div className="section">
          <h3>Forme</h3>
          <DistBars entries={m.formes} max={3} />
        </div>
      )}
      <div className="section">
        <h3>Moves</h3>
        <div className="dist">
          {m.moves.filter(x => x.p > 0).slice(0, 8).map(x => (
            <DistRow key={x.name} name={x.revealed ? <b>✓ {x.name}</b> : x.name} p={x.p} prior={x.revealed ? undefined : x.prior} certain={x.revealed} />
          ))}
        </div>
      </div>

      <button className="btn sm ghost" onClick={() => setMore(!more)}>{more ? 'hide details' : 'For after the battle: stats, spreads, evidence…'}</button>
      {more && (
        <>
          <div className="section col">
            <h3>Stats{statsForme ? ` as ${statsForme}` : ''} · 95% range (grey: before any evidence)</h3>
            {m.stats.map(s => <StatRow key={s.stat} s={s} unit={unit} />)}
          </div>
          <div className="section">
            <h3>Likeliest spreads ({unit}, level {fmt.level})</h3>
            <table className="t mono">
              <tbody>
                {m.spreads.filter(s => s.p > 0).slice(0, 6).map((s, i) => (
                  <tr key={i}>
                    <td>{s.nature}</td>
                    <td>{s.evs.join('/')}</td>
                    <td className="muted">{s.stats.join('/')}</td>
                    <td style={{textAlign: 'right'}}>{pct(s.p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="section col">
            <h3>Evidence</h3>
            {notes.length ? notes.map((n, i) => (
              <div key={i} className={`note${n.kind === 'conflict' ? ' alert' : ''}`}>
                {n.kind}: {n.note}{n.kind !== 'conflict' && n.consistent < 1 ? ` · ${pct(n.consistent)} of prior belief fit this` : ''}
              </div>
            )) : <div className="note">Nothing logged about it yet.</div>}
          </div>
          <div className="note">
            Priors: in-game ranked Battle Data{fmt.sources.official ? ` (season ${fmt.sources.official.season}, ${fmt.sources.official.date.replace(/_/g, '/')})` : ' (offline: using Showdown data)'},
            {' '}structure from Showdown {fmt.sources.structure.smogonId} {fmt.sources.structure.month}.
          </div>
        </>
      )}
    </div>
  );
}
