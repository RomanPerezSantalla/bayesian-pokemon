import {useState} from 'react';
import {STAT_LABELS, type BoostID, type Gen} from '../../data/dex';
import type {FormatData} from '../../data/format';
import {megaFormeOf} from '../../engine/likelihood';
import {maxHPOf, type StateCtx} from '../../engine/state';
import type {InferResult} from '../../engine/worker';
import {
  monKey, sameMon, type ActionEvent, type Battle, type BattleEvent, type MonRef, type SideID, type Weather,
} from '../../engine/types';
import {useStore} from '../../state/store';
import {HpBar, Sprite, pct, useFormat} from '../common';
import {useInference} from '../useInference';
import {ActionSheet} from './ActionSheet';
import {
  actedThisTurn, cameInThisTurn, canMoveAction, editLive, endTurn, everyoneMoved, logAction, logCheck, logMega, logReveal,
  logSwitch, moveAction, orderInTurn, ordinal, setOrdered, stateCtx, undo,
} from './actions';
import {pendingChecks} from './checks';
import {SpeedOrder} from './visuals';
import {headline, Intel} from './Intel';
import {monLabel, oppSpecies} from './names';

type Update = (fn: (b: Battle) => Battle) => void;
const STATUS_LABEL: Record<string, string> = {brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ'};
const BOOSTS: BoostID[] = ['atk', 'def', 'spa', 'spd', 'spe'];

function Pills({battle, update}: {battle: Battle; update: Update}) {
  const f = battle.live.field;
  const t = f.turns ?? {};
  const [adding, setAdding] = useState(false);
  const pills: [string, string, () => void][] = [];
  const clear = (fn: (b: Battle['live']) => void) => () => update(b => editLive(b, fn));
  const left = (k: string) => (t[k] ? ` ${t[k]}` : '');
  if (f.weather) pills.push(['weather', `${f.weather}${left('weather')}`, clear(l => {
    l.field.weather = undefined;
    delete l.field.turns?.weather;
  })]);
  if (f.terrain) pills.push(['terrain', `${f.terrain} T.${left('terrain')}`, clear(l => {
    l.field.terrain = undefined;
    delete l.field.turns?.terrain;
  })]);
  if (f.trickRoom) pills.push(['tr', `Trick Room${left('trickRoom')}`, clear(l => {
    l.field.trickRoom = false;
    delete l.field.turns?.trickRoom;
  })]);
  if (f.gravity) pills.push(['grav', `Gravity${left('gravity')}`, clear(l => {
    l.field.gravity = false;
  })]);
  for (const side of ['me', 'opp'] as const) {
    for (const [k, label] of [['tailwind', 'Tailwind'], ['reflect', 'Reflect'], ['lightScreen', 'L. Screen'], ['auroraVeil', 'Veil']] as const) {
      if (f[side][k]) pills.push([`${side}${k}`, `${side === 'me' ? 'Your' : 'Their'} ${label}${left(`${side}.${k}`)}`, clear(l => {
        l.field[side] = {...l.field[side], [k]: false};
        delete l.field.turns?.[`${side}.${k}`];
      })]);
    }
  }
  const add = (fn: (l: Battle['live']) => void) => {
    update(b => editLive(b, fn));
    setAdding(false);
  };
  return (
    <>
      {pills.map(([k, label, onClick]) => (
        <span key={k} className="pill" title="Tap to remove" onClick={onClick}>{label} ✕</span>
      ))}
      <span className="pill" onClick={() => setAdding(!adding)}>+ field</span>
      {adding && (
        <div className="row" style={{width: '100%'}}>
          {(['Sun', 'Rain', 'Sand', 'Snow'] as Weather[]).map(w => (
            <button key={w} className="btn sm" onClick={() => add(l => {
              l.field.weather = w;
              l.field.turns = {...l.field.turns, weather: 5};
            })}>{w}</button>
          ))}
          {(['Electric', 'Grassy', 'Psychic', 'Misty'] as const).map(tr => (
            <button key={tr} className="btn sm" onClick={() => add(l => {
              l.field.terrain = tr;
              l.field.turns = {...l.field.turns, terrain: 5};
            })}>{tr} T.</button>
          ))}
          <button className="btn sm" onClick={() => add(l => {
            l.field.trickRoom = true;
            l.field.turns = {...l.field.turns, trickRoom: 5};
          })}>Trick Room</button>
          {(['me', 'opp'] as const).map(side => (
            <button key={side} className="btn sm" onClick={() => add(l => {
              l.field[side] = {...l.field[side], tailwind: true};
              l.field.turns = {...l.field.turns, [`${side}.tailwind`]: 4};
            })}>{side === 'me' ? 'Your' : 'Their'} Tailwind</button>
          ))}
        </div>
      )}
    </>
  );
}

function Tile({gen, battle, result, ctx, ref_, selected, onTap}: {
  gen: Gen; battle: Battle; result: InferResult | null; ctx: StateCtx; ref_: MonRef; selected: boolean; onTap(): void;
}) {
  const c = battle.live.mons[monKey(ref_)];
  const max = maxHPOf(ctx, battle.live, ref_);
  const set = battle.myTeam[ref_.slot];
  const species = ref_.side === 'opp'
    ? oppSpecies(battle, result?.mons, ref_.slot)
    : (c?.mega ? megaFormeOf(gen, set) ?? set.species : set.species);
  const name = monLabel(battle, result?.mons, ref_);
  const m = ref_.side === 'opp' ? result?.mons[ref_.slot] : null;
  const fainted = (c?.hp ?? 1) <= 0;
  const boosts = BOOSTS.filter(k => c?.boosts[k]).map(k => `${STAT_LABELS[k]}${c!.boosts[k]! > 0 ? '+' : ''}${c!.boosts[k]}`);
  const ord = orderInTurn(battle, ref_);
  const justIn = !ord && !fainted && cameInThisTurn(battle, ref_);
  return (
    <button className={`tile${selected ? ' sel' : ''}${fainted ? ' fainted' : ''}${actedThisTurn(battle, ref_) ? ' acted' : ''}`} onClick={onTap}>
      <div className="top">
        <Sprite gen={gen} species={species} />
        <span className="nm">{name}</span>
        <span className="hp">{fainted ? 'KO' : ref_.side === 'opp' ? `${c?.hp ?? 100}%` : `${c?.hp}/${max}`}</span>
      </div>
      <HpBar frac={(c?.hp ?? max) / max} />
      <div className="badges">
        {ord && <span className={`tag ord${ord.ev.ordered ? '' : ' unsure'}`}>{ordinal(ord.n)}{ord.ev.ordered ? '' : '?'}</span>}
        {justIn && <span className="tag">just in</span>}
        {c?.status && <span className="tag st">{STATUS_LABEL[c.status]}</span>}
        {c?.mega && <span className="tag">Mega</span>}
        {boosts.map(b => <span key={b} className="tag boost">{b}</span>)}
        {c?.itemGone && <span className="tag">no item</span>}
      </div>
      {m && <div className="info">{headline(m, !!c?.mega)}</div>}
    </button>
  );
}

function Side({gen, battle, result, ctx, side, selected, onTap, onEmpty, onBench}: {
  gen: Gen; battle: Battle; result: InferResult | null; ctx: StateCtx; side: SideID;
  selected: MonRef | null;
  onTap(r: MonRef): void;
  onEmpty(position: number): void;
  onBench(slot: number): void;
}) {
  const active = battle.live.active[side];
  const pool = side === 'me' ? (battle.brought ?? battle.myTeam.map((_, i) => i)) : battle.oppPreview.map((_, i) => i);
  const bench = pool.filter(s => !active.includes(s));
  return (
    <div className="side">
      <div className="label"><span className={`tag ${side}`}>{side === 'me' ? 'You' : 'Opponent'}</span></div>
      <div className="tiles" style={{'--n': active.length} as React.CSSProperties}>
        {active.map((slot, pos) => {
          if (slot === null) {
            return <button key={pos} className="tile empty" onClick={() => onEmpty(pos)}>+ send in</button>;
          }
          const ref = {side, slot};
          const fainted = (battle.live.mons[monKey(ref)]?.hp ?? 1) <= 0;
          return (
            <Tile key={pos} gen={gen} battle={battle} result={result} ctx={ctx} ref_={ref}
              selected={!!selected && sameMon(selected, ref)} onTap={() => (fainted ? onEmpty(pos) : onTap(ref))} />
          );
        })}
      </div>
      {bench.length > 0 && (
        <div className="bench">
          {bench.map(slot => {
            const ref = {side, slot};
            const c = battle.live.mons[monKey(ref)];
            const species = side === 'me' ? battle.myTeam[slot].species : oppSpecies(battle, result?.mons, slot);
            return (
              <span key={slot} className={`b${(c?.hp ?? 1) <= 0 ? ' gone' : ''}`} onClick={() => onBench(slot)}>
                <Sprite gen={gen} species={species} />
                {monLabel(battle, result?.mons, ref)}
                {side === 'me' ? '' : c && c.hp < 100 ? ` ${c.hp}%` : ''}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function describe(battle: Battle, result: InferResult | null, ev: BattleEvent): string {
  const nm = (r: MonRef) => `${r.side === 'me' ? '' : 'opp '}${monLabel(battle, result?.mons, r)}`;
  switch (ev.kind) {
    case 'action': {
      const hits = ev.hits.map(h => `${nm(h.target)} ${h.noEffect ? 'unaffected' : h.fainted ? 'KO' : `→${h.hpAfter}${h.target.side === 'opp' ? '%' : ''}`}${h.crit ? ' crit' : ''}${h.status ? ` ${h.status}` : ''}${h.triggers.length ? ` [${h.triggers.join(',')}]` : ''}`);
      return `${nm(ev.actor)}: ${ev.move}${ev.quick ? ` (${ev.quick})` : ''}${ev.failed ? ' (failed)' : ''}${hits.length ? ` · ${hits.join('; ')}` : ''}${ev.actorTriggers.length ? ` [${ev.actorTriggers.join(',')}]` : ''}${ev.ordered ? '' : ' · order unsure'}`;
    }
    case 'reveal':
      return `${nm(ev.mon)} ${ev.negate ? 'not ' : ''}${ev.what === 'forme' ? 'Mega Evolved →' : `${ev.what}:`} ${ev.value}`;
    case 'switch':
      return `${ev.side === 'me' ? 'You' : 'Opp'}: ${ev.slotIn !== null ? `${monLabel(battle, result?.mons, {side: ev.side, slot: ev.slotIn})} in` : 'slot emptied'}${ev.slotOut !== null ? ` (for ${monLabel(battle, result?.mons, {side: ev.side, slot: ev.slotOut})})` : ''}`;
    case 'endTurn':
      return `— end of turn ${ev.turn} —`;
    case 'check':
      return `${nm(ev.mon)} ${ev.context === 'entry' ? 'came in' : 'Intimidated'}: ${ev.skipped ? 'not checked' : ev.seen ?? 'nothing shown'}`;
  }
}

/** "What did the game show?" after switch-ins: entry abilities and Intimidate reactions. */
function ChecksPanel({battle, result, ctx, run}: {
  battle: Battle; result: InferResult | null; ctx: StateCtx; run(fn: (b: Battle, c: StateCtx) => Battle): void;
}) {
  const checks = pendingChecks(battle, result?.mons, ctx);
  if (!checks.length) return null;
  return (
    <div className="panel col checks">
      <h3>What did the game show?</h3>
      {checks.map(c => {
        const key = monKey(c.mon);
        const answer = (seen: string | null, seenKind?: 'ability' | 'item', skipped?: boolean) => run((b, cx) => logCheck(cx, b, {
          mon: c.mon, context: c.context, about: c.about, seen, seenKind, skipped,
          mega: !!b.live.mons[key]?.mega, itemGone: !!b.live.mons[key]?.itemGone,
        }));
        return (
          <div key={`${c.about}${key}${c.context}`} className="check-row">
            <span className="who">{monLabel(battle, result?.mons, c.mon)} {c.context === 'entry' ? 'came in' : 'took your Intimidate'}</span>
            <div className="chips">
              {c.options.map(o => (
                <span key={o.name} className="chip" onClick={() => answer(o.name, o.kind)}>
                  {o.name} <small className="muted">{pct(o.p)}</small>
                </span>
              ))}
              <span className="chip" onClick={() => answer(null)}>nothing</span>
              <button className="btn ghost sm" onClick={() => answer(null, undefined, true)}>skip</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Fix where a move sits in its turn, or keep it out of the Speed inference. */
function OrderTools({battle, ev, run, update}: {
  battle: Battle; ev: ActionEvent; run(fn: (b: Battle, c: StateCtx) => Battle): void; update: Update;
}) {
  const earlier = canMoveAction(battle, ev.id, -1);
  const later = canMoveAction(battle, ev.id, 1);
  const why = [earlier, later].map(c => (c.ok ? '' : c.why)).filter(w => w && !/^already/.test(w));
  return (
    <div className="log-tools" onClick={e => e.stopPropagation()}>
      <div className="row">
        <button className="btn sm" disabled={!earlier.ok} onClick={() => run((b, c) => moveAction(c, b, ev.id, -1))}>It went earlier</button>
        <button className="btn sm" disabled={!later.ok} onClick={() => run((b, c) => moveAction(c, b, ev.id, 1))}>It went later</button>
        <button className={`btn sm${ev.ordered ? '' : ' on'}`} onClick={() => update(b => setOrdered(b, ev.id, !ev.ordered))}>Order unsure</button>
      </div>
      {why.length > 0 && <div className="note">Can't swap: {[...new Set(why)].join('; ')}.</div>}
      {!ev.ordered && <div className="note">Its place in the turn isn't used to judge Speed.</div>}
    </div>
  );
}

function Log({battle, result, run, update}: {
  battle: Battle; result: InferResult | null; run(fn: (b: Battle, c: StateCtx) => Battle): void; update: Update;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const events = [...battle.events].reverse();
  // Each move's place in its turn.
  const place = new Map<string, number>();
  const counts = new Map<number, number>();
  for (const e of battle.events) {
    if (e.kind !== 'action') continue;
    const n = (counts.get(e.turn) ?? 0) + 1;
    counts.set(e.turn, n);
    place.set(e.id, n);
  }
  return (
    <div className="panel col">
      <div className="row">
        <h3>Log</h3>
        <div className="spacer" />
        {result && <span className="small muted">{result.ms.toFixed(0)} ms</span>}
      </div>
      {!events.length && <div className="note">Tap each Pokémon as it moves on screen, in order, then its move, then the HP it's left at. Tap a logged move to fix its place in the turn.</div>}
      {events.map(ev => {
        const notes = result?.notes.filter(n => n.eventId === ev.id || (ev.kind === 'endTurn' && n.eventId === `turn${ev.turn}`)) ?? [];
        const action = ev.kind === 'action' ? ev : null;
        return (
          <div key={ev.id} className={`log-ev${action ? ' tappable' : ''}`} onClick={() => action && setOpen(open === ev.id ? null : ev.id)}>
            {action && <span className={`ord${action.ordered ? '' : ' unsure'}`}>{place.get(ev.id)}</span>}
            <div className="txt">
              {describe(battle, result, ev)}
              {notes.filter(n => n.kind === 'conflict' || n.kind === 'speed').map((n, i) => (
                <div key={i} className={`note${n.kind === 'conflict' ? ' alert' : ''}`}>↳ {battle.oppPreview[n.slot] ?? ''} {n.note}</div>
              ))}
              {action && open === ev.id && <OrderTools battle={battle} ev={action} run={run} update={update} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Settings({battle, update, onDelete}: {battle: Battle; update: Update; onDelete(): void}) {
  const s = battle.settings;
  const set = (patch: Partial<Battle['settings']>) => update(b => ({...b, settings: {...b.settings, ...patch}}));
  return (
    <div className="panel col">
      <h3>Opponent HP is read as</h3>
      <div className="seg">
        <button className={s.hpMode !== 'bar' ? 'on' : ''} onClick={() => set({hpMode: 'game'})}>Exact % shown</button>
        <button className={s.hpMode === 'bar' ? 'on' : ''} onClick={() => set({hpMode: 'bar'})}>Eyeballed ±{s.tolerance}</button>
      </div>
      {s.hpMode === 'bar' && (
        <div className="row">
          {[2, 4, 6, 8].map(t => <button key={t} className={`btn sm${s.tolerance === t ? ' on' : ''}`} onClick={() => set({tolerance: t})}>±{t}%</button>)}
        </div>
      )}
      <div className="note">
        The game rounds HP% down and never shows 0% while a Pokémon is alive (1 HP reads 1%; only full HP reads 100%).
        Showdown's Champions formats use the same rule. Use "eyeballed" only if you're estimating from a bar.
      </div>
      <button className="btn danger" onClick={onDelete}>Delete this battle</button>
    </div>
  );
}

export function BattleScreen({battleId}: {battleId: string}) {
  const battle = useStore(s => s.battles.find(b => b.id === battleId));
  const updateBattle = useStore(s => s.updateBattle);
  const deleteBattle = useStore(s => s.deleteBattle);
  const setView = useStore(s => s.setView);
  const {fmt, gen, error} = useFormat(battle?.formatId);
  const [actor, setActor] = useState<MonRef | null>(null);
  const [focusOpp, setFocusOpp] = useState(0);
  const [benchPick, setBenchPick] = useState<{side: SideID; position?: number; slot?: number} | null>(null);
  const [panel, setPanel] = useState<'intel' | 'log' | 'settings'>('intel');

  const activeOpp = battle?.live.active.opp.filter((s): s is number => s !== null) ?? [];
  const intelSlot = activeOpp.includes(focusOpp) || !activeOpp.length ? focusOpp : activeOpp[0];
  const {result} = useInference(fmt, battle, [...activeOpp, intelSlot]);

  if (!battle) return <div className="panel empty">Battle not found.</div>;
  if (error) return <div className="panel empty bad">Couldn't load data: {error}</div>;
  if (!fmt || !gen) return <div className="panel empty">Loading ladder data…</div>;
  return <Loaded {...{fmt, gen, battle, result, actor, setActor, intelSlot, setFocusOpp, benchPick, setBenchPick, panel, setPanel}}
    update={fn => updateBattle(battle.id, fn)}
    onDelete={() => {
      if (confirm('Delete this battle?')) {
        deleteBattle(battle.id);
        setView({page: 'battles'});
      }
    }} />;
}

function Loaded({fmt, gen, battle, result, actor, setActor, intelSlot, setFocusOpp, benchPick, setBenchPick, panel, setPanel, update, onDelete}: {
  fmt: FormatData; gen: Gen; battle: Battle; result: InferResult | null;
  actor: MonRef | null; setActor(r: MonRef | null): void;
  intelSlot: number; setFocusOpp(s: number): void;
  benchPick: {side: SideID; position?: number; slot?: number} | null; setBenchPick(p: {side: SideID; position?: number; slot?: number} | null): void;
  panel: 'intel' | 'log' | 'settings'; setPanel(p: 'intel' | 'log' | 'settings'): void;
  update: Update; onDelete(): void;
}) {
  const ctx = stateCtx(fmt, gen, battle, result?.mons);
  const run = (fn: (b: Battle, c: StateCtx) => Battle) => update(b => fn(b, stateCtx(fmt, gen, b, result?.mons)));

  const intel = (
    <div className="col">
      <div className="row">
        {battle.oppPreview.map((n, i) => (
          <button key={i} className={`btn sm${intelSlot === i ? ' on' : ''}`} onClick={() => setFocusOpp(i)}>{oppSpecies(battle, result?.mons, i) || n}</button>
        ))}
      </div>
      <Intel fmt={fmt} gen={gen} battle={battle} result={result} slot={intelSlot} />
    </div>
  );

  const tap = (r: MonRef) => {
    if (r.side === 'opp') setFocusOpp(r.slot);
    setActor(actor && sameMon(actor, r) ? null : r);
  };

  const sendIn = (side: SideID, position: number, slot: number) => {
    run((b, c) => logSwitch(c, b, side, position, slot));
    setBenchPick(null);
  };

  const onBench = (side: SideID, slot: number) => {
    const positions = battle.live.active[side];
    const empty = positions.findIndex(p => p === null || (battle.live.mons[`${side}${p}`]?.hp ?? 1) <= 0);
    if (positions.length === 1) return sendIn(side, 0, slot);
    if (empty >= 0) return sendIn(side, empty, slot);
    setBenchPick({side, slot});
  };

  return (
    <div className="bt">
      <div className="bt-main">
        <div className="bt-head">
          <span className="turn">T{battle.turn}</span>
          <button className={`btn primary sm${everyoneMoved(battle) ? ' ready' : ''}`} onClick={() => run((b, c) => endTurn(c, b))}>End turn</button>
          <button className="btn sm" disabled={!battle.events.length} onClick={() => update(undo)} title="Undo the last entry">↶ Undo</button>
          <Pills battle={battle} update={update} />
        </div>

        <ChecksPanel battle={battle} result={result} ctx={ctx} run={run} />

        <Side gen={gen} battle={battle} result={result} ctx={ctx} side="opp" selected={actor}
          onTap={tap} onEmpty={pos => setBenchPick({side: 'opp', position: pos})} onBench={slot => onBench('opp', slot)} />
        <Side gen={gen} battle={battle} result={result} ctx={ctx} side="me" selected={actor}
          onTap={tap} onEmpty={pos => setBenchPick({side: 'me', position: pos})} onBench={slot => onBench('me', slot)} />
        <SpeedOrder battle={battle} result={result} />

        {benchPick && (
          <div className="panel col">
            {benchPick.slot !== undefined ? (
              <>
                <div className="small">Send in {monLabel(battle, result?.mons, {side: benchPick.side, slot: benchPick.slot})} for…</div>
                <div className="targets-pick">
                  {battle.live.active[benchPick.side].map((s, pos) => (
                    <button key={pos} className="btn" style={{minHeight: 48}} onClick={() => sendIn(benchPick.side, pos, benchPick.slot!)}>
                      {s === null ? 'empty slot' : monLabel(battle, result?.mons, {side: benchPick.side, slot: s})}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="small">Who comes in?</div>
                <div className="targets-pick">
                  {(benchPick.side === 'me' ? (battle.brought ?? battle.myTeam.map((_, i) => i)) : battle.oppPreview.map((_, i) => i))
                    .filter(s => !battle.live.active[benchPick.side].includes(s) && (battle.live.mons[`${benchPick.side}${s}`]?.hp ?? 1) > 0)
                    .map(s => (
                      <button key={s} className="btn" style={{minHeight: 48}} onClick={() => sendIn(benchPick.side, benchPick.position!, s)}>
                        {monLabel(battle, result?.mons, {side: benchPick.side, slot: s})}
                      </button>
                    ))}
                </div>
              </>
            )}
            <button className="btn sm ghost" onClick={() => setBenchPick(null)}>cancel</button>
          </div>
        )}

        {actor && (
          <ActionSheet
            key={`${actor.side}${actor.slot}${battle.events.length}`}
            gen={gen} battle={battle} mons={result?.mons} ctx={ctx} actor={actor}
            onClose={() => setActor(null)}
            onCommit={draft => {
              run((b, c) => logAction(c, b, draft));
              setActor(null);
            }}
            onMega={forme => {
              run((b, c) => logMega(c, b, actor, forme));
            }}
            onReveal={(what, value, negate) => {
              update(b => logReveal(b, actor, what, value, negate));
              setActor(null);
            }}
            onSwitch={() => {
              const pos = battle.live.active[actor.side].indexOf(actor.slot);
              setBenchPick({side: actor.side, position: pos});
              setActor(null);
            }}
          />
        )}

        <div className="tabs">
          <button className={`mobile-only${panel === 'intel' ? ' on' : ''}`} onClick={() => setPanel('intel')}>Intel</button>
          <button className={panel === 'log' || panel === 'intel' ? 'desktop-on' + (panel === 'log' ? ' on' : '') : ''} onClick={() => setPanel('log')}>Log ({battle.events.length})</button>
          <button className={panel === 'settings' ? 'on' : ''} onClick={() => setPanel('settings')}>Settings</button>
        </div>
        {(panel === 'log' || panel === 'intel') && (
          <div className={panel === 'intel' ? 'desktop-only' : ''}><Log battle={battle} result={result} run={run} update={update} /></div>
        )}
        {panel === 'settings' && <Settings battle={battle} update={update} onDelete={onDelete} />}
        {panel === 'intel' && <div className="mobile-only">{intel}</div>}
      </div>
      <div className="bt-side desktop-only">{intel}</div>
    </div>
  );
}

