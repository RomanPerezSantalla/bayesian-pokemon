import {useEffect, useMemo, useRef, useState} from 'react';
import {species as dexSpecies, toID, type Gen} from '../data/dex';
import {previewNamesByUsage, type FormatData} from '../data/format';
import {parseTeam, type PokemonSet} from '../data/paste';
import {createBattle} from '../engine/battle';
import {loadReader, readerReady, readWith} from '../speech/reader';
import {installedManifest} from '../speech/store';
import {useStore} from '../state/store';
import {testLog, testLogOn} from '../testlog';
import {logLeads, stateCtx} from './battle/actions';
import {ACTIVITY, BEFORE_MS, MicMeter, missed, SURE} from './battle/VoiceBar';
import {namesPutBack} from './battle/voice/heard';
import {applyPreview, modelInput, previewContext, readPreviewAnswer, startSaid, yesSaid} from './battle/voice/lm';
import {addTheirs, previewPhrases, readPreview, type Picks, type PreviewRead, type Side, type Unsure} from './battle/voice/preview';
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
      {voice.listening && (voice.interim ? <div className="voice-live"><MicMeter />…{voice.interim}</div>
        : <div className={voice.activity ? 'voice-live' : 'voice-line'}><MicMeter />{voice.activity ? ACTIVITY[voice.activity] : hint}</div>)}
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
  // The same, for a "yes" heard before the next render.
  const unsureNow = useRef<Unsure[]>([]);
  unsureNow.current = unsure;
  const picks = useRef<Picks>({theirs: opp, mine: brought});
  /** Whose was picked last, said or tapped, for "scratch that". */
  const lastPick = useRef<Side | undefined>(undefined);
  /** "I brought…", a pause, then the names: the side said carries on for a moment (not for good). */
  const lastSide = useRef<{side: Side | null; at: number}>({side: null, at: 0});
  /** By the language model: phrases one at a time, and what the last one did (for "scratch that", "I meant…"). */
  const reading = useRef<Promise<void>>(Promise.resolve());
  const lastRead = useRef<{lines: string[]; at: number} | null>(null);
  picks.current = {theirs: opp, mine: brought, last: lastPick.current};
  const onVoice = useRef<(alternatives: string[]) => void>(() => {});
  const phrases = useRef<() => string[]>(() => []);
  const voice = useSpeech(alternatives => onVoice.current(alternatives), () => phrases.current());
  useWakeLock(voice.listening);
  // Development and test builds: team preview by text too (window.__narrate("…")), as in a battle.
  useEffect(() => {
    if (!import.meta.env.DEV && !testLogOn) return;
    const w = window as unknown as {__narrate?: (t: string) => void; __reader?: () => Promise<boolean>};
    w.__narrate = t => onVoice.current([t]);
    // The language model without the microphone: loaded from the installed pack.
    w.__reader = () => installedManifest().then(m => (m ? loadReader(m) : false));
    return () => {
      delete w.__narrate;
      delete w.__reader;
    };
  }, []);

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
    if (!opp.includes(name)) lastPick.current = 'theirs';
    // Another forme of one of theirs replaces it (one of each species), as by voice.
    setOpp(o => (o.includes(name) ? o.filter(x => x !== name) : gen ? addTheirs(o, name, gen).theirs : o.length < 6 ? [...o, name] : o));
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
  onVoice.current = heard => {
    if (!fmt || !gen || !team) return;
    // Names as the recogniser has been heard to spell them ("Right to" for Raichu), put back.
    const alternatives = heard.map(t => namesPutBack(t, [...Object.keys(fmt.preview), ...team.sets.map(s => s.species)]));
    // "Yes" to the first thing offered to tap.
    const offered = unsureNow.current[0];
    if (offered && yesSaid(alternatives[0])) {
      unsureNow.current = [];
      testLog('voice-preview', {heard: alternatives, used: 0, said: [], notes: [], unsure: [], picks: picks.current, yes: offered});
      pickUnsure(offered, offered.options[0]);
      return;
    }
    if (readerReady()) {
      reading.current = reading.current.then(() => byModel(alternatives)).catch(err => {
        testLog('voice-error', {error: `reader: ${err instanceof Error ? err.message : String(err)}`});
        byRules(alternatives);
      });
      return;
    }
    byRules(alternatives);
  };

  const byRules = (alternatives: string[]) => {
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
    testLog('voice-preview', {heard: alternatives, used, said: read.said, notes: read.notes, unsure: read.unsure, side: read.side, battle: read.battle, picks: read.picks});
    // Only when this phrase said it or named one of theirs / yours: otherwise it runs out.
    if (read.side) lastSide.current = {side: read.side, at: Date.now()};
    // "Start the battle" however it's heard ("start butter"), when nothing else was made of it.
    const command = !read.said.length && !read.unsure.length && !read.battle && startSaid(alternatives[0]);
    if (command) read.battle = true;
    applyRead(read, alternatives, now, command);
  };

  /** By the language model (speech/reader.ts): the picks and what was said before, and the phrase. */
  const byModel = async (alternatives: string[]) => {
    if (!fmt || !gen || !team) return;
    const env = {fmt, gen, team: team.sets, bring};
    const asked = picks.current;
    const last = lastRead.current;
    const before = last && Date.now() - last.at < BEFORE_MS ? last.lines : [];
    const input = modelInput(previewContext(team.sets.map(s => s.species), bring, (asked.mine ?? []).map(s => team.sets[s].species), asked.theirs, before), alternatives[0]);
    const answer = await readWith(input);
    const now = picks.current;
    const sure = readPreviewAnswer(env, now, answer.lines.filter(l => l.p >= SURE).map(l => l.text).join('\n'));
    const unsure = readPreviewAnswer(env, now, answer.lines.filter(l => l.p < SURE).map(l => l.text).join('\n'));
    const read = applyPreview(env, now, sure.ops);
    // "Start the battle" however it's heard ("start butter"), when the model made nothing of it.
    const command = !sure.ops.length && !unsure.ops.length && startSaid(alternatives[0]);
    if (command) read.battle = true;
    // Adding one of theirs or picking one of yours the model wasn't sure of: offered to tap.
    read.unsure = unsure.ops.flatMap((op): Unsure[] => op.kind === 'add' ? [{heard: alternatives[0], side: 'theirs', options: [op.name]}]
      : op.kind === 'bring' ? [{heard: alternatives[0], side: 'mine', options: [op.slot]}] : []);
    if (sure.lines.length) lastRead.current = {lines: sure.lines, at: Date.now()};
    testLog('voice-preview', {heard: alternatives, used: 0, said: read.said, notes: read.notes, unsure: read.unsure, battle: read.battle, picks: read.picks,
      reader: {lines: answer.lines, ms: answer.ms, tokens: answer.tokens, reused: answer.reused, before, dropped: [...sure.dropped, ...unsure.dropped]}});
    applyRead(read, alternatives, now, command);
  };

  /** What a phrase did, onto the screen (by either reading). `command`: "start the battle" (not the battle's first line). */
  const applyRead = (read: PreviewRead, alternatives: string[], now: Picks, command = false) => {
    const next = read.picks;
    picks.current = next;
    lastPick.current = next.last;
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
        if (!command) speech.passOn(alternatives);
        start(next.theirs, mine ?? pool, mine ? mine.slice(0, positions) : myLeads);
        return;
      }
      setHeard({text: 'That’s the battle starting: say their team first, or tap them', bad: true});
      return;
    }
    setUnsure(read.unsure);
    // What it did, and why a Pokémon heard changed nothing ("Froslass is in already").
    const did = [...read.said, ...read.notes];
    if (did.length) setHeard({text: did.join(' · ')});
    else if (read.unsure.length) setHeard(null);
    // "I brought…" on its own: the names come next.
    else if (read.side) setHeard({text: read.side === 'mine' ? 'Yours next…' : 'Theirs next…'});
    else setHeard({text: missed(alternatives[0]), bad: true});
  };

  const labelOf = (option: string | number) =>
    typeof option === 'number' ? team?.sets[option]?.nickname || team?.sets[option]?.species || '?' : option;
  const pickUnsure = (u: Unsure, option: string | number) => {
    const now = picks.current;
    let note: string | undefined;
    if (u.side === 'theirs' && typeof option === 'string' && gen) {
      // A forme of one of theirs replaces it (tapping "Goodra-Hisui" after "Goodra").
      const r = addTheirs(now.theirs, option, gen);
      note = r.note;
      if (r.said) {
        lastPick.current = 'theirs';
        picks.current = {...now, theirs: r.theirs, last: 'theirs'};
        advanceOnSix.current = true;
        setOpp(r.theirs);
      }
    } else if (u.side === 'mine' && typeof option === 'number' && !(now.mine ?? []).includes(option)) {
      const mine = [...(now.mine ?? []), option].slice(0, bring);
      lastPick.current = 'mine';
      picks.current = {...now, mine, last: 'mine'};
      setBrought(mine);
      setMyLeads(mine.slice(0, positions));
    }
    setUnsure(list => list.filter(x => x !== u));
    setHeard({text: note ?? `${labelOf(option)} ✓`});
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
                  if (!pool.includes(i)) lastPick.current = 'mine';
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
