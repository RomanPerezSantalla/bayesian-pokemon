import {useMemo, useState} from 'react';
import {STAT_LABELS, STAT_IDS, evBudget, evCap, getGen, species as dexSpecies, move as dexMove, toID, usesStatPoints, type Gen} from '../data/dex';
import {exportTeam, fetchPokepaste, parseTeam, pokepasteId, type PokemonSet} from '../data/paste';
import {useStore, type SavedTeam} from '../state/store';
import {Sprite, useFormatIndex} from './common';

const SAMPLE = `Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 10 Def / 24 SpD
Careful Nature
- Fake Out
- Flare Blitz
- Parting Shot
- Throat Chop

Sneasler @ Focus Sash
Ability: Unburden
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Fake Out
- Close Combat
- Dire Claw
- Protect`;

export function validateSet(gen: Gen, set: PokemonSet): string[] {
  const out: string[] = [];
  if (!dexSpecies(gen, set.species)) out.push(`Unknown species "${set.species}"`);
  if (set.item && !gen.items.get(toID(set.item))) out.push(`Unknown item "${set.item}"`);
  if (set.ability && !gen.abilities.get(toID(set.ability))) out.push(`Unknown ability "${set.ability}"`);
  for (const m of set.moves) if (!dexMove(gen, m)) out.push(`Unknown move "${m}"`);
  const cap = evCap(gen);
  const total = set.evs.reduce((a, b) => a + b, 0);
  if (set.evs.some(v => v > cap)) {
    out.push(usesStatPoints(gen)
      ? 'EVs above 32: Champions uses Stat Points (max 32 each, 66 total). Use "Convert EVs → SP".'
      : `EVs above ${cap}`);
  } else if (total > evBudget(gen)) out.push(`${total} total ${usesStatPoints(gen) ? 'SP' : 'EVs'} (max ${evBudget(gen)})`);
  if (!set.nature) out.push('No nature (assuming Serious)');
  return out;
}

/** Old-style EV spreads to Champions Stat Points (8 EVs ≈ 1 SP at level 50). */
function evsToSp(sets: PokemonSet[]) {
  return sets.map(s => ({...s, evs: s.evs.map(v => Math.min(32, Math.round(v / 8)))}));
}

export function SetCard({gen, set}: {gen: Gen; set: PokemonSet}) {
  const warnings = validateSet(gen, set);
  const unit = usesStatPoints(gen) ? 'SP' : 'EVs';
  const evs = set.evs.map((v, i) => (v ? `${v} ${STAT_LABELS[STAT_IDS[i]]}` : '')).filter(Boolean).join(' / ');
  return (
    <div className="set-card">
      <div className="row" style={{flexWrap: 'nowrap'}}>
        <Sprite gen={gen} species={set.species} />
        <div style={{minWidth: 0}}>
          <div style={{fontWeight: 600}}>{set.nickname ? `${set.nickname} (${set.species})` : set.species}</div>
          <div className="small muted">{set.item ?? 'no item'} · {set.ability ?? '?'}</div>
          <div className="small muted">{set.nature ?? '—'}{evs ? ` · ${unit}: ${evs}` : ''}</div>
        </div>
      </div>
      <div className="small" style={{marginTop: 4}}>{set.moves.join(' · ') || <span className="muted">no moves</span>}</div>
      {warnings.map(w => (
        <div key={w} className="small warn">⚠ {w}</div>
      ))}
    </div>
  );
}

function TeamEditor({team, onDone}: {team: SavedTeam | null; onDone(id?: string): void}) {
  const {formats} = useFormatIndex();
  const saveTeam = useStore(s => s.saveTeam);
  const deleteTeam = useStore(s => s.deleteTeam);
  const setView = useStore(s => s.setView);
  const [name, setName] = useState(team?.name ?? 'New team');
  const [formatId, setFormatId] = useState(team?.formatId ?? '');
  const [paste, setPaste] = useState(team?.paste ?? '');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const fid = formatId || formats?.[0]?.id;
  const fmtInfo = formats?.find(f => f.id === fid);
  const gen = getGen(fmtInfo?.gen ?? 0);
  const sets = useMemo(() => parseTeam(paste), [paste]);

  const importUrl = async () => {
    const id = pokepasteId(url);
    if (!id) {
      setStatus('That doesn\'t look like a pokepast.es link.');
      return;
    }
    setStatus('Fetching…');
    try {
      const p = await fetchPokepaste(id);
      setPaste(p.paste.replace(/\r/g, ''));
      if (p.title && (name === 'New team' || !name)) setName(p.title);
      setStatus(`Imported "${p.title || id}"${p.author ? ` by ${p.author}` : ''}.`);
    } catch (e) {
      setStatus(`Couldn't fetch: ${(e as Error).message}. You can paste the text instead.`);
    }
  };

  const save = () => {
    const id = saveTeam({id: team?.id, name: name.trim() || 'Untitled', formatId: fid, paste, sets});
    onDone(id);
    return id;
  };

  return (
    <div className="panel col">
      <div className="row">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Team name" style={{flex: 1, fontWeight: 600}} />
        <select value={fid ?? ''} onChange={e => setFormatId(e.target.value)} title="Format (used to validate sets)">
          {formats?.map(f => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <input
          type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://pokepast.es/…"
          style={{flex: 1}} onKeyDown={e => e.key === 'Enter' && importUrl()}
        />
        <button className="btn" onClick={importUrl}>Import pokepaste</button>
        {!paste && <button className="btn ghost" onClick={() => setPaste(SAMPLE)}>Load example</button>}
      </div>
      {status && <div className="small muted">{status}</div>}
      <textarea
        rows={14} value={paste} onChange={e => setPaste(e.target.value)}
        placeholder={'Paste a team in Showdown export format…\n\nGarchomp @ Life Orb\nAbility: Rough Skin\nEVs: 2 HP / 32 Atk / 32 Spe\nJolly Nature\n- Dragon Claw\n…'}
      />
      {sets.length > 0 && (
        <>
          <div className="row">
            <h3>{sets.length} Pokémon</h3>
            <div className="spacer" />
            {usesStatPoints(gen) && sets.some(s => s.evs.some(v => v > 32)) && (
              <button className="btn sm" onClick={() => setPaste(exportTeam(evsToSp(sets)))}>Convert EVs → SP</button>
            )}
          </div>
          <div className="set-grid">
            {sets.map((s, i) => (
              <SetCard key={i} gen={gen} set={s} />
            ))}
          </div>
        </>
      )}
      <div className="row">
        <button className="btn primary" onClick={save} disabled={!sets.length}>Save team</button>
        <button
          className="btn" disabled={!sets.length}
          onClick={() => setView({page: 'new', teamId: save()})}
        >
          Save & start battle
        </button>
        <div className="spacer" />
        {team && (
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete "${team.name}"?`)) {
                deleteTeam(team.id);
                onDone();
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export function TeamsPage({teamId}: {teamId?: string}) {
  const teams = useStore(s => s.teams);
  const setView = useStore(s => s.setView);
  const [editing, setEditing] = useState<string | 'new' | undefined>(teamId ?? (teams.length ? teams[0].id : 'new'));
  const current = editing && editing !== 'new' ? teams.find(t => t.id === editing) ?? null : null;
  const {formats} = useFormatIndex();

  return (
    <div className="teams-layout">
      <div className="col">
        <div className="row">
          <h2>Your teams</h2>
          <div className="spacer" />
          <button className="btn sm" onClick={() => setEditing('new')}>+ New</button>
        </div>
        <div className="small muted">Saved only in this browser.</div>
        <div className="team-list">
          {teams.map(t => {
            const gen = getGen(formats?.find(f => f.id === t.formatId)?.gen ?? 0);
            return (
              <div key={t.id} className={`team-item${editing === t.id ? ' on' : ''}`} onClick={() => setEditing(t.id)}>
                <div style={{fontWeight: 600}}>{t.name}</div>
                <div className="row" style={{gap: 0}}>
                  {t.sets.map((s, i) => (
                    <Sprite key={i} gen={gen} species={s.species} />
                  ))}
                </div>
                <div className="row" style={{marginTop: 4}}>
                  <button className="btn sm" onClick={e => {
                    e.stopPropagation();
                    setView({page: 'new', teamId: t.id});
                  }}>Battle</button>
                </div>
              </div>
            );
          })}
          {!teams.length && <div className="small muted">No teams yet: paste one on the right.</div>}
        </div>
      </div>
      <TeamEditor key={editing} team={current} onDone={id => setEditing(id ?? 'new')} />
    </div>
  );
}
