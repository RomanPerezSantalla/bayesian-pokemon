import {useEffect, useMemo, useRef, useState} from 'react';
import {species as dexSpecies, toID, type Gen} from '../data/dex';
import {previewNamesByUsage, type FormatData} from '../data/format';
import {parseTeam, type PokemonSet} from '../data/paste';
import {createBattle} from '../engine/battle';
import {useStore} from '../state/store';
import {logLeads, stateCtx} from './battle/actions';
import {Sprite, useFormat, useFormatIndex} from './common';

const LAST_FORMAT = 'bayesian-battle:last-format';

/** Map any species name (including Mega formes) to the name shown at team preview. */
export function toPreviewName(fmt: FormatData, gen: Gen, raw: string): string | null {
  const name = raw.trim().replace(/,.*$/, '').replace(/\*$/, '').trim();
  if (!name) return null;
  const id = toID(name);
  for (const [preview, formes] of Object.entries(fmt.preview)) {
    if (toID(preview) === id || formes.some(f => toID(f) === id)) return preview;
  }
  const prefixed = Object.keys(fmt.preview).filter(p => toID(p).startsWith(id))
    .sort((a, b) => (fmt.previewUsage[b] ?? 0) - (fmt.previewUsage[a] ?? 0));
  if (prefixed.length) return prefixed[0];
  const sp = dexSpecies(gen, name);
  if (!sp) return null;
  return /-Mega/.test(sp.name) && sp.baseSpecies ? sp.baseSpecies : sp.name;
}

function parsePasted(fmt: FormatData, gen: Gen, text: string): {names: string[]; sheet: PokemonSet[] | null} {
  if (/ @ |Ability:|^- /m.test(text)) {
    const sets = parseTeam(text);
    return {names: sets.map(s => toPreviewName(fmt, gen, s.species) ?? s.species), sheet: sets};
  }
  const protocol = [...text.matchAll(/\|poke\|p\d\|([^|,]+)/g)].map(m => m[1]);
  const parts = protocol.length ? protocol : text.split(/[\n/,]+/);
  return {names: parts.map(p => toPreviewName(fmt, gen, p)).filter((n): n is string => !!n), sheet: null};
}

export function Setup({teamId}: {teamId?: string}) {
  const teams = useStore(s => s.teams);
  const addBattle = useStore(s => s.addBattle);
  const setView = useStore(s => s.setView);
  const {formats} = useFormatIndex();
  const [formatId, setFormatId] = useState(() => {
    try {
      return localStorage.getItem(LAST_FORMAT) ?? 'champions-doubles';
    } catch {
      return 'champions-doubles';
    }
  });
  const {fmt, gen, error} = useFormat(formatId);
  const [myTeamId, setMyTeamId] = useState(teamId ?? teams[0]?.id ?? '');
  const team = teams.find(t => t.id === myTeamId);
  const [opp, setOpp] = useState<string[]>([]);
  const [sheet, setSheet] = useState<PokemonSet[] | null>(null);
  const [query, setQuery] = useState('');
  const [paste, setPaste] = useState(false);
  const [step, setStep] = useState<'preview' | 'leads'>('preview');
  const [oppLeads, setOppLeads] = useState<number[]>([]);
  const [brought, setBrought] = useState<number[] | null>(null);
  const [myLeads, setMyLeads] = useState<number[]>([]);

  const ranked = useMemo(() => (fmt ? previewNamesByUsage(fmt) : []), [fmt]);
  // Picking the sixth moves straight on to leads, no scrolling for a button.
  const advanceOnSix = useRef(false);
  useEffect(() => {
    if (opp.length === 6 && advanceOnSix.current) setStep('leads');
    advanceOnSix.current = false;
  }, [opp.length]);
  const info = formats?.find(f => f.id === formatId);
  const positions = info?.gameType === 'singles' ? 1 : 2;
  const bring = info?.bring ?? 4;
  const pool = brought ?? (team ? team.sets.map((_, i) => i).slice(0, bring) : []);

  if (!teams.length) {
    return (
      <div className="panel empty">
        <p>Add your team first (paste it or import a pokepast.es link).</p>
        <button className="btn primary" onClick={() => setView({page: 'teams'})}>Add a team</button>
      </div>
    );
  }
  if (error) return <div className="panel empty bad">{error}</div>;

  const shown = query.length >= 1
    ? ranked.filter(n => toID(n).includes(toID(query))).slice(0, 30)
    : ranked.slice(0, 48);
  const togglePick = (name: string) => {
    setOpp(o => (o.includes(name) ? o.filter(x => x !== name) : o.length < 6 ? [...o, name] : o));
    setQuery('');
    advanceOnSix.current = true;
  };
  const toggleIn = (list: number[], i: number, cap: number) =>
    list.includes(i) ? list.filter(x => x !== i) : list.length < cap ? [...list, i] : [...list.slice(1), i];

  const start = () => {
    if (!fmt || !gen || !team) return;
    let b = createBattle(fmt, team.sets, opp, `vs ${opp.slice(0, 3).join(', ')}`);
    b.brought = pool;
    if (sheet) b.oppSheet = opp.map((_, i) => sheet[i] ?? null);
    const leads = [
      ...oppLeads.slice(0, positions).map(slot => ({side: 'opp' as const, slot})),
      ...myLeads.slice(0, positions).map(slot => ({side: 'me' as const, slot})),
    ];
    b = logLeads(stateCtx(fmt, gen, b, undefined), b, leads);
    addBattle(b);
    setView({page: 'battle', battleId: b.id});
  };

  return (
    <div className="col" style={{maxWidth: 900, margin: '0 auto'}}>
      <div className="panel col">
        <div className="row">
          <div className="seg">
            {(formats ?? []).map(f => (
              <button key={f.id} className={formatId === f.id ? 'on' : ''} onClick={() => {
                setFormatId(f.id);
                try {
                  localStorage.setItem(LAST_FORMAT, f.id);
                } catch {
                  // not important
                }
              }}>{f.name}</button>
            ))}
          </div>
          <select value={myTeamId} onChange={e => {
            setMyTeamId(e.target.value);
            setBrought(null);
            setMyLeads([]);
          }} style={{flex: 1, minWidth: 160}}>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {fmt && (
          <div className="small muted">
            Priors: {fmt.sources.official
              ? `in-game ranked Battle Data, season ${fmt.sources.official.season} (${fmt.sources.official.date.replace(/_/g, '/')})`
              : 'in-game data unavailable (offline?), using Showdown stats'}
          </div>
        )}
      </div>

      {step === 'preview' && fmt && gen && (
        <div className="panel col">
          <div className="row">
            <h2>Their team</h2>
            <span className="small muted">tap the six you see at team preview</span>
          </div>
          <div className="chosen">
            {Array.from({length: 6}, (_, i) => opp[i]).map((name, i) => (
              <div key={i} className={`slot${name ? ' filled' : ''}`} onClick={() => name && togglePick(name)}>
                {name ? <><Sprite gen={gen} species={name} /><span>{name}</span></> : <span className="muted">{i + 1}</span>}
              </div>
            ))}
          </div>
          <div className="row">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…" style={{flex: 1}}
              onKeyDown={e => e.key === 'Enter' && shown[0] && togglePick(shown[0])} />
            <button className="btn sm ghost" onClick={() => setPaste(!paste)}>paste</button>
          </div>
          {paste && (
            <textarea rows={3} placeholder="Names separated by / or newlines, Showdown |poke| lines, or an open team sheet"
              onChange={e => {
                const {names, sheet: s} = parsePasted(fmt, gen, e.target.value);
                if (names.length) {
                  setOpp(names.slice(0, 6));
                  setSheet(s);
                }
              }} />
          )}
          {sheet && <div className="small good">Open team sheet: items, abilities and moves are known.</div>}
          <div className="pick-grid">
            {shown.map(n => (
              <button key={n} className={`pick${opp.includes(n) ? ' on' : ''}`} onClick={() => togglePick(n)}>
                <Sprite gen={gen} species={n} />
                <span className="nm">{n}</span>
              </button>
            ))}
          </div>
          <div className="row sticky-bar">
            <button className="btn primary" disabled={!opp.length} onClick={() => setStep('leads')}>Next: leads ▸</button>
            <span className="small muted">{opp.length}/6 · picking the 6th moves on</span>
          </div>
        </div>
      )}

      {step === 'leads' && fmt && gen && team && (
        <div className="panel col">
          <h2>Their lead{positions > 1 ? 's' : ''}</h2>
          <div className="chosen">
            {opp.map((n, i) => (
              <div key={n} className={`slot filled${oppLeads.includes(i) ? ' lead' : ''}`} onClick={() => setOppLeads(l => toggleIn(l, i, positions))}>
                <Sprite gen={gen} species={n} /><span>{n}</span>
              </div>
            ))}
          </div>
          <h2>You brought ({pool.length}/{bring})</h2>
          <div className="chosen">
            {team.sets.map((s, i) => (
              <div key={i} className={`slot filled${pool.includes(i) ? ' lead' : ''}`} style={{opacity: pool.includes(i) ? 1 : 0.4}}
                onClick={() => {
                  const next = toggleIn(pool, i, bring).sort((a, b) => a - b);
                  setBrought(next);
                  setMyLeads(l => l.filter(x => next.includes(x)));
                }}>
                <Sprite gen={gen} species={s.species} /><span>{s.nickname || s.species}</span>
              </div>
            ))}
          </div>
          <h2>Your lead{positions > 1 ? 's' : ''}</h2>
          <div className="chosen">
            {pool.map(i => (
              <div key={i} className={`slot filled${myLeads.includes(i) ? ' lead' : ''}`} onClick={() => setMyLeads(l => toggleIn(l, i, positions))}>
                <Sprite gen={gen} species={team.sets[i].species} /><span>{team.sets[i].nickname || team.sets[i].species}</span>
              </div>
            ))}
          </div>
          <div className="row sticky-bar">
            <button className="btn" onClick={() => setStep('preview')}>‹ back</button>
            <button className="btn primary" onClick={start}>Start battle</button>
            <span className="small muted">Leads can also be set on the battle screen.</span>
          </div>
        </div>
      )}
    </div>
  );
}
