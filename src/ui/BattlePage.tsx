import {useDeferredValue, useMemo, useState} from 'react';
import {TYPES, toID, type BoostID, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {cloneSnapshot, myMaxHP, uid} from '../engine/battle';
import {computeBeliefs, type Beliefs} from '../engine/posterior';
import {OTHER_ITEM} from '../engine/prior';
import type {Battle, MonCondition, RevealEvent, SideCondition, SideID, Status, SwitchEvent, Terrain, Weather} from '../engine/types';
import {useStore} from '../state/store';
import {oppDisplaySpecies} from './battleUtil';
import {BeliefPanel} from './BeliefPanel';
import {HpBar, Sprite, pct, useFormat} from './common';
import {Composer} from './Composer';
import {EventLog} from './EventLog';

const WEATHERS: Weather[] = ['Sun', 'Rain', 'Sand', 'Snow', 'Harsh Sunshine', 'Heavy Rain', 'Strong Winds'];
const TERRAINS: Terrain[] = ['Electric', 'Grassy', 'Psychic', 'Misty'];
const BOOSTS: BoostID[] = ['atk', 'def', 'spa', 'spd', 'spe'];
const STATUSES: [Status, string][] = [['', 'healthy'], ['brn', 'burned'], ['par', 'paralyzed'], ['psn', 'poisoned'], ['tox', 'badly poisoned'], ['slp', 'asleep'], ['frz', 'frozen']];

type Update = (fn: (b: Battle) => Battle) => void;

const boostText = (c?: MonCondition) =>
  c ? BOOSTS.filter(k => c.boosts[k]).map(k => `${k} ${c.boosts[k]! > 0 ? '+' : ''}${c.boosts[k]}`).join(' ') : '';

const IGNORES_INTIMIDATE = new Set(['Clear Body', 'White Smoke', 'Full Metal Body', 'Hyper Cutter', 'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy', 'Mirror Armor']);
const clamp6 = (v: number) => Math.max(-6, Math.min(6, v));

/** Apply an Intimidate from `side` to the opposing active Pokémon, honouring known reactions. */
function intimidate(b: Battle, beliefs: Beliefs | null, side: SideID): Battle {
  const live = cloneSnapshot(b.live);
  const foe: SideID = side === 'me' ? 'opp' : 'me';
  for (const slot of live.active[foe]) {
    if (slot === null) continue;
    const key = `${foe}${slot}`;
    const c = live.mons[key];
    if (!c || c.hp <= 0) continue;
    let ability: string | undefined;
    if (foe === 'me') ability = b.myTeam[slot]?.ability;
    else {
      const top = beliefs?.mons[slot]?.abilities[0];
      if (top && top.p > 0.9) ability = top.name;
    }
    if (ability && IGNORES_INTIMIDATE.has(ability)) continue;
    const boosts = {...c.boosts};
    if (ability === 'Guard Dog') boosts.atk = clamp6((boosts.atk ?? 0) + 1);
    else {
      boosts.atk = clamp6((boosts.atk ?? 0) - 1);
      if (ability === 'Defiant') boosts.atk = clamp6(boosts.atk + 2);
      if (ability === 'Competitive') boosts.spa = clamp6((boosts.spa ?? 0) + 2);
      if (ability === 'Rattled') boosts.spe = clamp6((boosts.spe ?? 0) + 1);
    }
    live.mons[key] = {...c, boosts};
  }
  return {...b, live};
}

function FieldBar({battle, update}: {battle: Battle; update: Update}) {
  const f = battle.live.field;
  const set = (patch: Partial<typeof f>) => update(b => ({...b, live: {...b.live, field: {...b.live.field, ...patch}}}));
  const side = (s: SideID, patch: Partial<SideCondition>) => set({[s]: {...f[s], ...patch}} as never);
  const toggles: [keyof SideCondition, string][] = [['tailwind', 'Tailwind'], ['reflect', 'Reflect'], ['lightScreen', 'Light Screen'], ['auroraVeil', 'Aurora Veil'], ['friendGuard', 'Friend Guard']];
  return (
    <div className="row small">
      <select value={f.weather ?? ''} onChange={e => set({weather: (e.target.value || undefined) as Weather | undefined})}>
        <option value="">no weather</option>
        {WEATHERS.map(w => <option key={w} value={w}>{w}</option>)}
      </select>
      <select value={f.terrain ?? ''} onChange={e => set({terrain: (e.target.value || undefined) as Terrain | undefined})}>
        <option value="">no terrain</option>
        {TERRAINS.map(t => <option key={t} value={t}>{t} Terrain</option>)}
      </select>
      <span className={`chip${f.trickRoom ? ' on' : ''}`} onClick={() => set({trickRoom: !f.trickRoom})}>Trick Room</span>
      <span className={`chip${f.gravity ? ' on' : ''}`} onClick={() => set({gravity: !f.gravity})}>Gravity</span>
      {(['me', 'opp'] as const).map(s => (
        <span key={s} className="row" style={{gap: 4}}>
          <span className={`tag ${s}`}>{s === 'me' ? 'my side' : 'their side'}</span>
          {toggles.map(([k, label]) => (
            <span key={k} className={`chip${f[s][k] ? ' on' : ''}`} onClick={() => side(s, {[k]: !f[s][k]})}>{label}</span>
          ))}
        </span>
      ))}
    </div>
  );
}

function CondEditor({gen, fmt, cond, side, max, onChange}: {
  gen: Gen; fmt: FormatData; cond: MonCondition; side: SideID; max: number; onChange(c: MonCondition): void;
}) {
  const boost = (k: BoostID, v: number) => onChange({...cond, boosts: {...cond.boosts, [k]: v || undefined}});
  void gen;
  return (
    <div className="col small" onClick={e => e.stopPropagation()} style={{marginTop: 6}}>
      <div className="row">
        <label className="check">HP
          <input type="number" min={0} max={max} value={cond.hp} onChange={e => onChange({...cond, hp: Math.max(0, Math.min(max, Number(e.target.value) || 0))})} />
          {side === 'opp' ? '%' : `/ ${max}`}
        </label>
        <select value={cond.status} onChange={e => onChange({...cond, status: e.target.value as Status})}>
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="row" style={{gap: 4}}>
        {BOOSTS.map(k => (
          <label key={k} className="check" title={`${k} stage`}>
            {k}
            <select value={cond.boosts[k] ?? 0} onChange={e => boost(k, Number(e.target.value))}>
              {[6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map(v => <option key={v} value={v}>{v > 0 ? `+${v}` : v}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={cond.itemGone} onChange={e => onChange({...cond, itemGone: e.target.checked})} /> item used / lost</label>
        <label className="check" title="Flash Fire, Protosynthesis/Quark Drive from Booster Energy, etc.">
          <input type="checkbox" checked={cond.abilityOn} onChange={e => onChange({...cond, abilityOn: e.target.checked})} /> ability active
        </label>
        {fmt.gen === 9 && (
          <select value={cond.tera ?? ''} onChange={e => onChange({...cond, tera: e.target.value || undefined})}>
            <option value="">not Terastallized</option>
            {TYPES.map(t => <option key={t} value={t}>Tera {t}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

function PositionButtons({battle, side, slot, onSet}: {battle: Battle; side: SideID; slot: number; onSet(pos: number | null): void}) {
  const positions = battle.live.active[side];
  const at = positions.indexOf(slot);
  return (
    <span className="row" style={{gap: 2}} onClick={e => e.stopPropagation()}>
      {positions.map((_, pos) => (
        <button key={pos} className={`btn sm${at === pos ? ' on' : ''}`} title={positions.length > 1 ? `Put in ${pos ? 'right' : 'left'} position` : 'On the field'}
          onClick={() => onSet(at === pos ? null : pos)}>
          {positions.length > 1 ? (pos ? 'R' : 'L') : 'In'}
        </button>
      ))}
    </span>
  );
}

export function BattlePage({battleId}: {battleId: string}) {
  const battle = useStore(s => s.battles.find(b => b.id === battleId));
  const updateBattle = useStore(s => s.updateBattle);
  const deleteBattle = useStore(s => s.deleteBattle);
  const setView = useStore(s => s.setView);
  const {fmt, gen, error} = useFormat(battle?.formatId);
  const [selected, setSelected] = useState<number>(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Only what the inference depends on; live-state edits (HP, boosts) don't recompute it.
  const inferenceInput = useMemo(
    () => battle && {events: battle.events, oppPreview: battle.oppPreview, oppSheet: battle.oppSheet, myTeam: battle.myTeam, settings: battle.settings},
    [battle?.events, battle?.oppPreview, battle?.oppSheet, battle?.myTeam, battle?.settings],
  );
  const deferred = useDeferredValue(inferenceInput);
  const beliefs: Beliefs | null = useMemo(() => {
    if (!fmt || !battle || !deferred) return null;
    try {
      return computeBeliefs(fmt, {...battle, ...deferred});
    } catch (e) {
      console.error(e);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmt, deferred]);

  if (!battle) return <div className="panel empty">Battle not found.</div>;
  if (error) return <div className="panel empty bad">Couldn't load {battle.formatId}: {error}</div>;
  if (!fmt || !gen) return <div className="panel empty">Loading usage stats…</div>;

  const update: Update = fn => updateBattle(battle.id, fn);
  const live = battle.live;

  const setCond = (key: string, c: MonCondition) => update(b => ({...b, live: {...b.live, mons: {...b.live.mons, [key]: c}}}));

  const setPosition = (side: SideID, slot: number, pos: number | null) => update(b => {
    const next = cloneSnapshot(b.live);
    const positions = next.active[side];
    const events = [...b.events];
    const cur = positions.indexOf(slot);
    if (cur >= 0) positions[cur] = null;
    if (pos !== null) {
      const out = positions[pos];
      positions[pos] = slot;
      const ev: SwitchEvent = {kind: 'switch', id: uid(), turn: b.turn, side, position: pos, slotIn: slot, slotOut: out};
      events.push(ev);
      // Leaving the field resets boosts.
      if (out !== null && next.mons[`${side}${out}`]) next.mons[`${side}${out}`] = {...next.mons[`${side}${out}`], boosts: {}};
    } else {
      events.push({kind: 'switch', id: uid(), turn: b.turn, side, position: cur, slotIn: null, slotOut: slot});
      next.mons[`${side}${slot}`] = {...next.mons[`${side}${slot}`], boosts: {}};
    }
    return {...b, events, live: next};
  });

  const megaEvolve = (slot: number, forme: string) => update(b => {
    const next = cloneSnapshot(b.live);
    next.mons[`opp${slot}`].mega = true;
    const ev: RevealEvent = {kind: 'reveal', id: uid(), turn: b.turn, mon: {side: 'opp', slot}, what: 'forme', value: forme, negate: false};
    return {...b, events: [...b.events, ev], live: next};
  });

  const nextTurn = () => update(b => {
    // Single-turn effects wear off; the user toggles lasting ones.
    return {...b, turn: b.turn + 1};
  });

  const oppCard = (slot: number) => {
    const key = `opp${slot}`;
    const cond = live.mons[key];
    const b = beliefs?.mons[slot];
    const species = oppDisplaySpecies(battle, beliefs, slot, live);
    const topItem = b?.items.find(i => i.name !== OTHER_ITEM);
    const topAbility = b?.abilities[0];
    const megas = b?.formes.filter(f => /-Mega/.test(f.name) && f.p > 0.001) ?? [];
    const anyMega = Object.entries(live.mons).some(([k, c]) => k.startsWith('opp') && c.mega);
    const active = live.active.opp.includes(slot);
    return (
      <div key={key} className={`mon-card${selected === slot ? ' sel' : ''}${active ? ' active' : ''}${cond?.hp === 0 ? ' fainted' : ''}`} onClick={() => setSelected(slot)}>
        <Sprite gen={gen} species={species} small />
        <div className="body">
          <div className="name">
            <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{species}</span>
            <div className="spacer" />
            <PositionButtons battle={battle} side="opp" slot={slot} onSet={pos => setPosition('opp', slot, pos)} />
          </div>
          <HpBar frac={(cond?.hp ?? 100) / 100} />
          <div className="small muted" style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
            {cond?.hp ?? 100}%{cond?.status ? ` · ${cond.status}` : ''}
            {topItem && ` · ${topItem.name} ${pct(topItem.p)}`}
            {topAbility && ` · ${topAbility.name} ${pct(topAbility.p)}`}
          </div>
          {boostText(cond) && <div className="small warn">{boostText(cond)}</div>}
          <div className="row" style={{gap: 4, marginTop: 2}}>
            {!cond?.mega && !anyMega && megas.map(m => (
              <button key={m.name} className="btn sm" onClick={e => {
                e.stopPropagation();
                megaEvolve(slot, m.name);
              }}>Mega {m.name.replace(/^.*-Mega-?/, '') || ''} {pct(m.p)}</button>
            ))}
            {active && topAbility?.name === 'Intimidate' && topAbility.p > 0.9 && (
              <button className="btn sm" title="Lower my active Pokémon's Attack" onClick={e => {
                e.stopPropagation();
                update(bt => intimidate(bt, beliefs, 'opp'));
              }}>Intimidate</button>
            )}
            <button className="btn ghost sm" onClick={e => {
              e.stopPropagation();
              setExpanded(expanded === key ? null : key);
            }}>{expanded === key ? 'done' : 'edit'}</button>
          </div>
          {expanded === key && cond && <CondEditor gen={gen} fmt={fmt} cond={cond} side="opp" max={100} onChange={c => setCond(key, c)} />}
        </div>
      </div>
    );
  };

  const myCard = (slot: number) => {
    const key = `me${slot}`;
    const set = battle.myTeam[slot];
    const cond = live.mons[key];
    const max = myMaxHP(gen, fmt, set);
    const active = live.active.me.includes(slot);
    const stone = set.item ? gen.items.get(toID(set.item))?.megaStone : undefined;
    return (
      <div key={key} className={`mon-card${active ? ' active' : ''}${cond?.hp === 0 ? ' fainted' : ''}`}>
        <Sprite gen={gen} species={set.species} small />
        <div className="body">
          <div className="name">
            <span>{set.nickname || set.species}</span>
            <div className="spacer" />
            <PositionButtons battle={battle} side="me" slot={slot} onSet={pos => setPosition('me', slot, pos)} />
          </div>
          <HpBar frac={(cond?.hp ?? max) / max} />
          <div className="row small muted" style={{gap: 4}}>
            <span>{cond?.hp ?? max}/{max}{cond?.status ? ` · ${cond.status}` : ''}</span>
            {boostText(cond) && <span className="warn">{boostText(cond)}</span>}
            <div className="spacer" />
            {active && set.ability === 'Intimidate' && (
              <button className="btn sm" title="Lower the opposing active Pokémon's Attack" onClick={() => update(bt => intimidate(bt, beliefs, 'me'))}>Intimidate</button>
            )}
            {stone && cond && (
              <label className="check"><input type="checkbox" checked={cond.mega} onChange={e => setCond(key, {...cond, mega: e.target.checked})} /> Mega</label>
            )}
            <button className="btn ghost sm" onClick={() => setExpanded(expanded === key ? null : key)}>{expanded === key ? 'done' : 'edit'}</button>
          </div>
          {expanded === key && cond && <CondEditor gen={gen} fmt={fmt} cond={cond} side="me" max={max} onChange={c => setCond(key, c)} />}
        </div>
      </div>
    );
  };

  return (
    <div className="col">
      <div className="panel col">
        <div className="row">
          <input value={battle.label} onChange={e => update(b => ({...b, label: e.target.value}))} style={{fontWeight: 600, minWidth: 200}} />
          <span className="small muted">{fmt.name} · stats {fmt.month}</span>
          <div className="spacer" />
          <button className="btn sm" onClick={() => update(b => ({...b, turn: Math.max(1, b.turn - 1)}))}>◀</button>
          <b>Turn {battle.turn}</b>
          <button className="btn primary sm" onClick={nextTurn}>Next turn ▶</button>
          <select value={battle.settings.hpMode} onChange={e => update(b => ({...b, settings: {...b.settings, hpMode: e.target.value as 'showdown' | 'approx'}}))} className="small">
            <option value="showdown">Opp HP: exact % (Showdown)</option>
            <option value="approx">Opp HP: eyeballed ±{battle.settings.tolerance}%</option>
          </select>
          <button className="btn danger sm" onClick={() => {
            if (confirm('Delete this battle?')) {
              deleteBattle(battle.id);
              setView({page: 'battles'});
            }
          }}>Delete</button>
        </div>
        <FieldBar battle={battle} update={update} />
      </div>

      <div className="battle-layout">
        <div className="col">
          <div className="section-title"><h3>Opponent</h3></div>
          <div className="mon-list">{battle.oppPreview.map((_, i) => oppCard(i))}</div>
          <div className="section-title"><h3>You</h3></div>
          <div className="mon-list">{battle.myTeam.map((_, i) => myCard(i))}</div>
        </div>
        <div className="col">
          <Composer fmt={fmt} gen={gen} battle={battle} beliefs={beliefs} update={update} focusOpp={selected} />
          <EventLog battle={battle} beliefs={beliefs} onDelete={id => update(b => ({...b, events: b.events.filter(e => e.id !== id)}))} />
        </div>
        <div className="col detail-col">
          {beliefs ? <BeliefPanel fmt={fmt} gen={gen} battle={battle} beliefs={beliefs} slot={selected} /> : <div className="panel empty">Computing…</div>}
        </div>
      </div>
    </div>
  );
}

export function BattlesPage() {
  const battles = useStore(s => s.battles);
  const setView = useStore(s => s.setView);
  if (!battles.length) {
    return (
      <div className="panel empty">
        <p>No battles yet.</p>
        <button className="btn primary" onClick={() => setView({page: 'new'})}>Start one</button>
      </div>
    );
  }
  return (
    <div className="panel col" style={{maxWidth: 820, margin: '0 auto'}}>
      <div className="row">
        <h2>Battles</h2>
        <div className="spacer" />
        <button className="btn primary sm" onClick={() => setView({page: 'new'})}>+ New battle</button>
      </div>
      {battles.map(b => (
        <div key={b.id} className="team-item" onClick={() => setView({page: 'battle', battleId: b.id})}>
          <div className="row">
            <b>{b.label}</b>
            <span className="small muted">{b.formatId} · turn {b.turn} · {b.events.length} events · {new Date(b.updated).toLocaleString()}</span>
          </div>
          <div className="small muted">{b.oppPreview.join(', ')}</div>
        </div>
      ))}
    </div>
  );
}
