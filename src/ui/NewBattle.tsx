import {useMemo, useState} from 'react';
import {species as dexSpecies, toID, type Gen} from '../data/dex';
import {previewNamesByUsage, type FormatData} from '../data/format';
import {parseTeam, type PokemonSet} from '../data/paste';
import {createBattle} from '../engine/battle';
import {useStore} from '../state/store';
import {Datalist, Sprite, useFormat, useFormatIndex} from './common';

/** Map any species name (including Mega formes) to the name shown at team preview. */
function toPreviewName(fmt: FormatData, gen: Gen, raw: string): string | null {
  const name = raw.trim().replace(/,.*$/, '').replace(/\*$/, '').trim();
  if (!name) return null;
  const id = toID(name);
  for (const [preview, formes] of Object.entries(fmt.preview)) {
    if (toID(preview) === id || formes.some(f => toID(f) === id)) return preview;
  }
  // "Floette" -> "Floette-Eternal", "Basculegion" stays, etc.: most-used prefix match.
  const prefixed = Object.keys(fmt.preview)
    .filter(p => toID(p).startsWith(id))
    .sort((a, b) => (fmt.previewUsage[b] ?? 0) - (fmt.previewUsage[a] ?? 0));
  if (prefixed.length) return prefixed[0];
  const sp = dexSpecies(gen, name);
  if (!sp) return null;
  if (/-Mega/.test(sp.name) && sp.baseSpecies) return sp.baseSpecies;
  return sp.name;
}

/**
 * Accepts: a Showdown export (open team sheet), Showdown protocol lines
 * ("|poke|p2|Garchomp, L50, M|"), or names separated by newlines, "/" or ",".
 */
function parsePreview(fmt: FormatData, gen: Gen, text: string): {names: string[]; sheet: (PokemonSet | null)[] | null} {
  if (/ @ |Ability:|^- /m.test(text)) {
    const sets = parseTeam(text);
    return {names: sets.map(s => toPreviewName(fmt, gen, s.species) ?? s.species), sheet: sets};
  }
  const protocol = [...text.matchAll(/\|poke\|p\d\|([^|,]+)/g)].map(m => m[1]);
  const parts = protocol.length ? protocol : text.split(/[\n/,]+/);
  const names = parts.map(p => toPreviewName(fmt, gen, p)).filter((n): n is string => !!n);
  return {names, sheet: null};
}

export function NewBattle({teamId}: {teamId?: string}) {
  const teams = useStore(s => s.teams);
  const addBattle = useStore(s => s.addBattle);
  const setView = useStore(s => s.setView);
  const {formats} = useFormatIndex();
  const [myTeamId, setMyTeamId] = useState(teamId ?? teams[0]?.id ?? '');
  const team = teams.find(t => t.id === myTeamId);
  const [formatId, setFormatId] = useState(team?.formatId ?? '');
  const fid = formatId || team?.formatId || formats?.[0]?.id;
  const {fmt, gen} = useFormat(fid);
  const [opp, setOpp] = useState<string[]>(['', '', '', '', '', '']);
  const [sheet, setSheet] = useState<(PokemonSet | null)[] | null>(null);
  const [pasted, setPasted] = useState('');
  const [hpMode, setHpMode] = useState<'showdown' | 'approx'>('showdown');
  const [tolerance, setTolerance] = useState(4);
  const [label, setLabel] = useState('');

  const options = useMemo(() => (fmt ? previewNamesByUsage(fmt) : []), [fmt]);
  const resolved = fmt && gen ? opp.map(o => (o.trim() ? toPreviewName(fmt, gen, o) : null)) : [];
  const valid = resolved.filter(Boolean).length > 0 && resolved.every((r, i) => !opp[i].trim() || r);

  const applyPaste = (text: string) => {
    setPasted(text);
    if (!fmt || !gen) return;
    const {names, sheet: s} = parsePreview(fmt, gen, text);
    if (names.length) {
      setOpp([...names.slice(0, 6), ...Array(Math.max(0, 6 - names.length)).fill('')]);
      setSheet(s ? s.slice(0, 6) : null);
    }
  };

  const start = () => {
    if (!fmt || !team) return;
    const names = resolved.filter((r): r is string => !!r);
    const b = createBattle(fmt, team.sets, names, label.trim() || `vs ${names.slice(0, 3).join(', ')}`);
    b.settings = {hpMode, tolerance};
    if (sheet) b.oppSheet = resolved.map((r, i) => (r ? sheet[i] ?? null : null)).filter((_, i) => resolved[i]);
    addBattle(b);
    setView({page: 'battle', battleId: b.id});
  };

  if (!teams.length) {
    return (
      <div className="panel empty">
        <p>You need a team first.</p>
        <button className="btn primary" onClick={() => setView({page: 'teams'})}>Add a team</button>
      </div>
    );
  }

  return (
    <div className="panel col" style={{maxWidth: 820, margin: '0 auto'}}>
      <h2>New battle</h2>
      <div className="composer field-grid" style={{display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 12px', alignItems: 'center'}}>
        <span className="muted">Your team</span>
        <select value={myTeamId} onChange={e => setMyTeamId(e.target.value)}>
          {teams.map(t => (
            <option key={t.id} value={t.id}>{t.name} ({t.sets.map(s => s.species).join(', ')})</option>
          ))}
        </select>
        <span className="muted">Format</span>
        <select value={fid ?? ''} onChange={e => setFormatId(e.target.value)}>
          {formats?.map(f => (
            <option key={f.id} value={f.id}>
              {f.name}: Smogon stats {f.month}, {f.cutoff}+ ({f.battles.toLocaleString()} battles)
            </option>
          ))}
        </select>
        <span className="muted">Opponent HP</span>
        <div className="row">
          <label className="check"><input type="radio" checked={hpMode === 'showdown'} onChange={() => setHpMode('showdown')} /> Exact % (Showdown)</label>
          <label className="check"><input type="radio" checked={hpMode === 'approx'} onChange={() => setHpMode('approx')} /> Eyeballed HP bar (Switch) ±</label>
          <input type="number" min={1} max={15} value={tolerance} disabled={hpMode !== 'approx'} onChange={e => setTolerance(Number(e.target.value) || 4)} />
          <span className="muted small">%</span>
        </div>
        <span className="muted">Label</span>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="optional (e.g. ladder game 3)" />
      </div>

      <h3 style={{marginTop: 8}}>Opponent's team preview</h3>
      <textarea
        rows={3} value={pasted} onChange={e => applyPaste(e.target.value)}
        placeholder="Paste names (Garchomp / Incineroar / …), Showdown |poke| lines, or an open team sheet in export format"
      />
      {sheet && <div className="small good">Open team sheet detected: items, abilities and moves will be treated as known.</div>}
      {fmt && gen && (
        <div className="set-grid">
          {opp.map((o, i) => (
            <div key={i} className="set-card row" style={{flexWrap: 'nowrap'}}>
              {resolved[i] ? <Sprite gen={gen} species={resolved[i]!} small /> : <div className="sprite-fallback" style={{width: 32, height: 32}}>{i + 1}</div>}
              <input
                list="preview-names" value={o} style={{flex: 1}} placeholder={`Pokémon ${i + 1}`}
                onChange={e => setOpp(opp.map((x, j) => (j === i ? e.target.value : x)))}
                className={o.trim() && !resolved[i] ? 'bad' : ''}
              />
              {resolved[i] && fmt.preview[resolved[i]!]?.length > 1 && (
                <span className="tag" title={fmt.preview[resolved[i]!].join(', ')}>{fmt.preview[resolved[i]!].length} formes</span>
              )}
            </div>
          ))}
        </div>
      )}
      <Datalist id="preview-names" options={options} />
      <div className="row">
        <button className="btn primary" disabled={!valid || !fmt || !team} onClick={start}>Start battle</button>
        <span className="small muted">Empty slots are skipped (useful if you only saw part of the team).</span>
      </div>
    </div>
  );
}
