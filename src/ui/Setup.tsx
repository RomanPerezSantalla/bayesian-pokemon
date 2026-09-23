import {useEffect, useMemo, useRef, useState} from 'react';
import {species as dexSpecies, toID, type Gen} from '../data/dex';
import {previewNamesByUsage, type FormatData} from '../data/format';
import {parseTeam, type PokemonSet} from '../data/paste';
import {createBattle} from '../engine/battle';
import {useStore} from '../state/store';
import {testLog} from '../testlog';
import {logLeads, stateCtx} from './battle/actions';
import {ACTIVITY} from './battle/VoiceBar';
import {previewPhrases, readPreview, type Picks, type Side, type Unsure} from './battle/voice/preview';
import {speech, useSpeech} from './battle/voice/useSpeech';
import {Sprite, useFormat, useFormatIndex} from './common';
import {useWakeLock} from './wake';

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

/** The mic button and what it heard, on both steps of team preview. */
function PreviewVoice({voice, heard, hint, unsure, label, onPick}: {
  voice: ReturnType<typeof useSpeech>;
  heard: {text: string; bad?: boolean} | null;
  hint: string;
  /** Heard but not sure which: the likeliest to tap. */
  unsure: Unsure[];
  label(option: string | number): string;
  onPick(u: Unsure, option: string | number): void;
}) {
  if (!voice.listening && !heard && !voice.error && !unsure.length) return null;
  return (
    <div className="voice-panel">
      {voice.error && <div className="note alert">{voice.error}</div>}
      {voice.listening && (voice.interim ? <div className="voice-live">…{voice.interim}</div>
        : <div className={voice.activity ? 'voice-live' : 'voice-line'}>{voice.activity ? ACTIVITY[voice.activity] : hint}</div>)}
      {heard && <div className={`voice-line${heard.bad ? ' bad' : ''}`}>{heard.text}</div>}
      {unsure.map((u, k) => (
        <div key={k} className="voice-unsure">
          <span className="voice-line">“{u.heard}”?</span>
          {u.options.map(o => <button key={o} className="btn sm" onClick={() => onPick(u, o)}>{label(o)}</button>)}
        </div>
      ))}
    </div>
  );
}

function VoiceToggle({voice}: {voice: ReturnType<typeof useSpeech>}) {
  return (
    <button className={`btn sm voice-btn${voice.listening ? ' on' : ''}`} onClick={() => (voice.listening ? voice.stop() : voice.start())}
      title="Say their six, then “mine” and yours in the order you pick them">
      {voice.listening ? '● Listening' : '🎙 Voice'}
    </button>
  );
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

  // By voice (battle/voice/preview.ts): their six, then yours in pick order. The session carries on into the battle.
  const [heard, setHeard] = useState<{text: string; bad?: boolean} | null>(null);
  const [unsure, setUnsure] = useState<Unsure[]>([]);
  const picks = useRef<Picks>({theirs: opp, mine: brought});
  /** "I brought…", a pause, then the names: the side said carries on for a moment. */
  const lastSide = useRef<{side: Side | null; at: number}>({side: null, at: 0});
  picks.current = {theirs: opp, mine: brought};
  const onVoice = useRef<(alternatives: string[]) => void>(() => {});
  const phrases = useRef<() => string[]>(() => []);
  const voice = useSpeech(alternatives => onVoice.current(alternatives), () => phrases.current());
  useWakeLock(voice.listening);

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

  // Voice can start it straight after changing the picks, before they've reached the state.
  const start = (theirs = opp, mine = pool, mineLeads = myLeads) => {
    if (!fmt || !gen || !team) return;
    let b = createBattle(fmt, team.sets, theirs, `vs ${theirs.slice(0, 3).join(', ')}`);
    b.brought = mine;
    if (sheet) b.oppSheet = theirs.map((_, i) => sheet[i] ?? null);
    const leads = [
      ...oppLeads.slice(0, positions).map(slot => ({side: 'opp' as const, slot})),
      ...mineLeads.slice(0, positions).map(slot => ({side: 'me' as const, slot})),
    ];
    b = logLeads(stateCtx(fmt, gen, b, undefined), b, leads);
    addBattle(b);
    setView({page: 'battle', battleId: b.id});
  };

  phrases.current = () => (fmt && gen && team ? previewPhrases({fmt, gen, team: team.sets, bring}) : []);
  onVoice.current = alternatives => {
    if (!fmt || !gen || !team) return;
    const env = {fmt, gen, team: team.sets, bring};
    const now = picks.current;
    // The recogniser's alternatives: take the one that makes the most sense.
    const side = Date.now() - lastSide.current.at < 10_000 ? lastSide.current.side : null;
    let read = readPreview(alternatives[0], now, env, side);
    let used = 0;
    alternatives.slice(1).forEach((alt, k) => {
      const r = readPreview(alt, now, env, side);
      if (r.said.length > read.said.length) [read, used] = [r, k + 1];
    });
    testLog('voice-preview', {heard: alternatives, used, said: read.said, unsure: read.unsure, side: read.side, battle: read.battle, picks: read.picks});
    const next = read.picks;
    picks.current = next;
    lastSide.current = {side: read.side, at: Date.now()};
    if (next.theirs.join() !== now.theirs.join()) {
      advanceOnSix.current = true;
      setOpp(next.theirs);
    }
    const mine = next.mine;
    if (mine && mine.join() !== (now.mine ?? []).join()) {
      setBrought(mine);
      setMyLeads(mine.slice(0, positions));
    }
    if (read.battle) {
      if (next.theirs.length) {
        // The battle's first line: start it, and hand the line to the battle's narrator (it sets the leads).
        speech.passOn(alternatives);
        start(next.theirs, mine ?? pool, mine ? mine.slice(0, positions) : myLeads);
        return;
      }
      setHeard({text: 'That’s the battle starting: say their team first, or tap them', bad: true});
      return;
    }
    setUnsure(read.unsure);
    if (read.said.length) setHeard({text: read.said.join(' · ')});
    else if (read.unsure.length) setHeard(null);
    // "I brought…" on its own: the names come next.
    else if (read.side && read.side !== side) setHeard({text: read.side === 'mine' ? 'Yours next…' : 'Theirs next…'});
    else setHeard({text: `didn’t catch: “${alternatives[0].trim()}”`, bad: true});
  };

  const labelOf = (option: string | number) =>
    typeof option === 'number' ? team?.sets[option]?.nickname || team?.sets[option]?.species || '?' : option;
  const pickUnsure = (u: Unsure, option: string | number) => {
    const now = picks.current;
    if (u.side === 'theirs' && typeof option === 'string' && !now.theirs.includes(option) && now.theirs.length < 6) {
      picks.current = {...now, theirs: [...now.theirs, option]};
      advanceOnSix.current = true;
      setOpp(picks.current.theirs);
    } else if (u.side === 'mine' && typeof option === 'number' && !(now.mine ?? []).includes(option)) {
      const mine = [...(now.mine ?? []), option].slice(0, bring);
      picks.current = {...now, mine};
      setBrought(mine);
      setMyLeads(mine.slice(0, positions));
    }
    setUnsure(list => list.filter(x => x !== u));
    setHeard({text: `${labelOf(option)} ✓`});
  };
  const voicePanel = (hint: string) => (
    <PreviewVoice voice={voice} heard={heard} hint={hint} unsure={unsure} label={labelOf} onPick={pickUnsure} />
  );

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
            <div className="spacer" />
            <VoiceToggle voice={voice} />
          </div>
          {voicePanel('Say their six as you see them, then “mine” and yours in the order you pick them.')}
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
          <div className="row">
            <h2>Their lead{positions > 1 ? 's' : ''}</h2>
            <div className="spacer" />
            <VoiceToggle voice={voice} />
          </div>
          {voicePanel('Say “mine” and yours in the order you pick them. Reading the battle’s first line starts it.')}
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
            <button className="btn primary" onClick={() => start()}>Start battle</button>
            <span className="small muted">Leads can also be set on the battle screen.</span>
          </div>
        </div>
      )}
    </div>
  );
}
