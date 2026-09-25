import {useEffect, useMemo, useRef, useState} from 'react';
import {allItems, allAbilities, allMoves, isStatusMove, move as dexMove, STAT_LABELS, toID, type Gen} from '../../data/dex';
import {DROP_REACT, DROP_REACT_ITEMS} from '../../engine/abilities';
import {berryApplies, megaFormeOf} from '../../engine/likelihood';
import {CONTACT_PUNISH, moveFx} from '../../engine/moves';
import {OTHER_ITEM} from '../../engine/prior';
import {canMega, maxHPOf, type StateCtx} from '../../engine/state';
import type {MonSummary} from '../../engine/worker';
import {
  monKey, sameMon, type Battle, type Boosts, type HitResult, type MonRef, type RevealEvent, type Status, type Trigger,
} from '../../engine/types';
import {Datalist, TYPE_COLORS, pct} from '../common';
import {choiceLockedMove, helpedThisTurn, type ActionDraft} from './actions';
import {Keypad, valueComplete} from './Keypad';
import {monLabel} from './names';
import {hitChoices, targetPlan} from './targets';

interface Row {
  ref: MonRef;
  value: string;
  before?: string;
  fainted: boolean;
  crit: boolean;
  noEffect: boolean;
  status?: Status;
  triggers: Trigger[];
  boosts?: Boosts;
  /** Reaction shown to this move's stat drop, if it was asked about. */
  reaction?: string;
}

const STATUS_LABEL: Record<string, string> = {brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ'};

const has = (m: MonSummary | null | undefined, list: 'items' | 'abilities', name: string) =>
  !!m?.[list].some(e => e.name === name && e.p > 0);

export function ActionSheet({gen, battle, mons, ctx, actor, queue, onPickActor, onCommit, onMega, onReveal, onSwitch, onClose}: {
  gen: Gen;
  battle: Battle;
  mons: (MonSummary | null)[] | undefined;
  ctx: StateCtx;
  actor: MonRef;
  /** Who still has to move this turn, likeliest next first: one tap switches the sheet to them. */
  queue: MonRef[];
  onPickActor(r: MonRef): void;
  onCommit(d: ActionDraft): void;
  onMega(forme: string): void;
  onReveal(what: RevealEvent['what'], value: string, negate?: boolean): void;
  onSwitch(): void;
  onClose(): void;
}) {
  const live = battle.live;
  const [move, setMove] = useState<string | null>(null);
  const [stage, setStage] = useState<'move' | 'target' | 'result' | 'ability' | 'item' | 'search'>('move');
  const [rows, setRows] = useState<Row[]>([]);
  const [spreadCount, setSpreadCount] = useState(1);
  const [focus, setFocus] = useState(0);
  const [editBefore, setEditBefore] = useState(false);
  const [actorTriggers, setActorTriggers] = useState<Trigger[]>([]);
  const [actorStatus, setActorStatus] = useState<Status | undefined>();
  const [hitCount, setHitCount] = useState<number | undefined>();
  const [actorBoosts, setActorBoosts] = useState<Boosts | undefined>();
  const [quick, setQuick] = useState<'Quick Claw' | 'Quick Draw' | null>(null);
  const [query, setQuery] = useState('');

  const summary = actor.side === 'opp' ? mons?.[actor.slot] : undefined;
  const foeSide = actor.side === 'me' ? 'opp' : 'me';
  const foes = live.active[foeSide].filter((s): s is number => s !== null && (live.mons[`${foeSide}${s}`]?.hp ?? 1) > 0)
    .map(slot => ({side: foeSide, slot}) as MonRef);
  const allies = live.active[actor.side].filter((s): s is number => s !== null && s !== actor.slot)
    .map(slot => ({side: actor.side, slot}) as MonRef);

  const moveList = useMemo(() => {
    if (actor.side === 'me') return (battle.myTeam[actor.slot]?.moves ?? []).map(name => ({name, hint: '', seen: false}));
    return (summary?.moves ?? []).filter(m => m.p > 0).slice(0, 10)
      .map(m => ({name: m.name, hint: m.revealed ? '✓ seen' : pct(m.p), seen: m.revealed}));
  }, [actor, battle.myTeam, summary]);

  // Quick Claw / Quick Draw: when the game says it let this Pokémon move first.
  const quickOptions = ((): ('Quick Claw' | 'Quick Draw')[] => {
    const c = live.mons[monKey(actor)];
    const set = actor.side === 'me' ? battle.myTeam[actor.slot] : undefined;
    const p = (list: 'items' | 'abilities', name: string) => summary?.[list].find(e => e.name === name)?.p ?? 0;
    const claw = set ? set.item === 'Quick Claw' : p('items', 'Quick Claw') >= 0.02;
    const draw = set ? set.ability === 'Quick Draw' : p('abilities', 'Quick Draw') >= 0.02;
    return [...(claw && !c?.itemGone ? ['Quick Claw' as const] : []), ...(draw ? ['Quick Draw' as const] : [])];
  })();

  const hpBefore = (ref: MonRef) => live.mons[monKey(ref)]?.hp ?? 0;
  const maxOf = (ref: MonRef) => maxHPOf(ctx, live, ref);

  const commit = (over: Partial<{rows: Row[]; targetRefs: MonRef[]; move: string; failed: boolean}> = {}) => {
    const mv = over.move ?? move;
    if (!mv) return;
    const useRows = over.rows ?? rows;
    const hits = useRows.map((r): HitResult => {
      const typedBefore = r.before !== undefined && r.before !== '';
      const before = typedBefore ? Number(r.before) : hpBefore(r.ref);
      const c = live.mons[monKey(r.ref)];
      // Nothing typed: it was hit, the HP just wasn't read ("skip HP").
      if (!(r.fainted || r.noEffect || r.value !== '')) {
        return {target: r.ref, hpBefore: before, hpAfter: before, fainted: false, crit: r.crit, triggers: [], unread: true};
      }
      return {
        target: r.ref,
        hpBefore: before,
        hpAfter: r.fainted ? 0 : r.noEffect ? before : Number(r.value),
        fainted: r.fainted,
        crit: r.crit,
        triggers: r.triggers,
        status: r.status,
        boosts: r.boosts,
        noEffect: r.noEffect || undefined,
        beforeApprox: r.ref.side === 'opp' && !!c?.hpEstimated && !typedBefore ? true : undefined,
        beforeUnknown: c?.hpUnknown && !typedBefore ? true : undefined,
        // Asked about means an unticked chip is evidence ("nothing shown").
        reaction: reactionOptions(r).length ? r.reaction ?? null : undefined,
      };
    });
    onCommit({
      actor,
      move: dexMove(gen, mv)?.name ?? mv,
      hits,
      targets: Math.max(1, spreadCount),
      hitCount,
      helpingHand: helpedThisTurn(battle, actor),
      actorTriggers,
      actorStatus,
      actorBoosts,
      targetRefs: over.targetRefs,
      failed: over.failed,
      ordered: true,
      // Asked about means an unticked chip is evidence (it didn't fire).
      quick: quickOptions.length ? quick : undefined,
    });
  };

  const newRow = (ref: MonRef): Row => ({ref, value: '', fainted: false, crit: false, noEffect: false, triggers: []});

  // A certain Choice item locks it into the move it already used: start there ("‹ back" for another).
  const lockItem = actor.side === 'me' ? battle.myTeam[actor.slot]?.item : summary?.items.find(e => e.certain)?.name;
  const locked = choiceLockedMove(battle, actor, lockItem);
  const openedLocked = useRef(false);
  useEffect(() => {
    if (openedLocked.current || !locked || stage !== 'move' || move || isStatusMove(gen, locked)) return;
    openedLocked.current = true;
    pickMove(locked);
  });

  const pickMove = (name: string) => {
    const m = dexMove(gen, name);
    if (!m) return;
    setMove(m.name);
    const plan = targetPlan(gen, m.name, foes, allies);
    if (plan.kind === 'log') return commit({move: m.name, rows: [], targetRefs: plan.targets});
    if (plan.kind === 'pick') {
      setStage('target');
      return;
    }
    setRows(plan.targets.map(newRow));
    setSpreadCount(Math.max(1, plan.targets.length));
    setFocus(0);
    setStage('result');
  };

  const pickTarget = (ref: MonRef) => {
    if (move && isStatusMove(gen, move)) return commit({targetRefs: [ref]});
    setRows([newRow(ref)]);
    setSpreadCount(1);
    setFocus(0);
    setStage('result');
  };

  const patch = (i: number, p: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? {...r, ...p} : r)));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const onKey = (k: string) => {
    if (k === 'ok' || k === 'skip') return commit();
    const r = rows[focus];
    if (!r) return;
    if (k === 'next') {
      setEditBefore(false);
      setFocus((focus + 1) % rows.length);
      return;
    }
    if (k === 'ko') return patch(focus, {fainted: !r.fainted, value: '', noEffect: false});
    const field = editBefore ? 'before' : 'value';
    const cur = (editBefore ? r.before : r.value) ?? '';
    if (k === 'del') return patch(focus, {[field]: cur.slice(0, -1)});
    const next = (cur + k).replace(/^0+(?=\d)/, '');
    if (next.length > 3) return;
    if (Number(next) > maxOf(r.ref)) return;
    patch(focus, {[field]: next, fainted: false, noEffect: false});
    // A value that can't take another digit is complete: on to the HP after, or the next target.
    if (valueComplete(next, maxOf(r.ref))) {
      if (editBefore) setEditBefore(false);
      else if (focus < rows.length - 1) setFocus(focus + 1);
    }
  };

  const dropRow = (i: number) => {
    setRows(rows.filter((_, j) => j !== i));
    setFocus(0);
  };
  const ready = rows.length > 0 && rows.every(r => r.fainted || r.noEffect || r.value !== '');

  // Keyboard (PC): numbers pick moves and targets and type HP; Enter logs; see the hint line.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      if (e.key === 'Escape') onClose();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const done = () => e.preventDefault();
    if (k === 'Escape') return done(), onClose();
    if (stage === 'move') {
      if (/^[1-9]$/.test(k) && moveList[Number(k) - 1]) return done(), pickMove(moveList[Number(k) - 1].name);
      if ((k === 'ArrowRight' || k === 'ArrowLeft') && queue.length > 1) {
        const i = queue.findIndex(r => sameMon(r, actor));
        return done(), onPickActor(queue[(i + (k === 'ArrowRight' ? 1 : queue.length - 1)) % queue.length]);
      }
      // Typing a letter searches every move.
      if (/^[a-z]$/i.test(k)) {
        done();
        setQuery(k);
        setStage('search');
      }
      return;
    }
    if (stage === 'target') {
      const targets = [...foes, ...allies];
      if (/^[1-9]$/.test(k) && targets[Number(k) - 1]) return done(), pickTarget(targets[Number(k) - 1]);
      return;
    }
    if (stage !== 'result') return;
    if (/^[0-9]$/.test(k)) return done(), onKey(k);
    if (k === 'Backspace') return done(), onKey('del');
    if (k === 'Enter') return done(), onKey('ok');
    if (k === 'Tab') return done(), onKey('next');
    const r = rows[focus];
    switch (k.toLowerCase()) {
      case 'k': return done(), onKey('ko');
      case 's': return done(), onKey('skip');
      case 'c': return r ? (done(), patch(focus, {crit: !r.crit})) : undefined;
      case 'x': return r ? (done(), dropRow(focus)) : undefined;
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // --- context-aware chips ------------------------------------------------
  const fx = move ? moveFx(move) : {};
  const moveType = move ? dexMove(gen, move)?.type ?? '' : '';
  const contact = !!fx.ct;

  const statusChoices = (): Status[] => {
    const out = new Set<Status>();
    for (const s of fx.sec ?? []) {
      if (s.st) out.add(s.st);
      for (const x of s.any ?? []) out.add(x);
    }
    if (actor.side === 'opp') {
      if (contact && has(summary, 'abilities', 'Poison Touch')) out.add('psn');
      if (has(summary, 'abilities', 'Toxic Chain')) out.add('tox');
    }
    return [...out];
  };

  const messageChips = (r: Row): [Trigger, string][] => {
    if (r.ref.side !== 'opp') return [];
    const m = mons?.[r.ref.slot];
    const c = live.mons[monKey(r.ref)];
    if (!m || c?.itemGone) return [];
    const out: [Trigger, string][] = [];
    if (m.items.some(e => e.p > 0 && berryApplies(e.name, moveType, 2))) out.push(['berry', 'Berry weakened it']);
    if (has(m, 'items', 'Sitrus Berry')) out.push(['sitrus', 'Sitrus']);
    if (hpBefore(r.ref) >= 100 && (has(m, 'items', 'Focus Sash') || has(m, 'abilities', 'Sturdy'))) out.push(['sash', 'Hung on (Sash)']);
    if (has(m, 'items', 'Weakness Policy')) out.push(['wp', 'Weakness Policy']);
    return out;
  };

  const chanceBoosts = (fx.sec ?? []).filter(s => s.ch < 100 && s.b);
  // Its own, by chance: Meteor Mash's Attack, Ancient Power's everything.
  const selfChance = (fx.sec ?? []).filter(s => s.ch < 100 && s.sb);

  // Guaranteed stat drops (Icy Wind, Snarl…) can set off Defiant, Competitive, Clear Amulet…
  const guaranteedDrop = (fx.sec ?? []).some(s => s.ch >= 100 && s.b && Object.values(s.b).some(v => (v ?? 0) < 0));
  function reactionOptions(r: Row): {name: string; p: number}[] {
    if (r.ref.side !== 'opp' || !guaranteedDrop || r.fainted || r.noEffect) return [];
    const m = mons?.[r.ref.slot];
    const c = live.mons[monKey(r.ref)];
    if (!m || !c) return [];
    const top = ctx.oppAbility(r.ref.slot, c.mega);
    if (top && top.p >= 1) return []; // known for certain: its reaction is applied automatically
    const opts = [
      ...m.abilities.filter(a => a.p > 0 && DROP_REACT.has(a.name)),
      ...(c.itemGone ? [] : m.items.filter(it => it.p > 0 && DROP_REACT_ITEMS.has(it.name))),
    ];
    return opts.reduce((t, o) => t + o.p, 0) >= 0.02 ? opts.map(o => ({name: o.name, p: o.p})) : [];
  }
  const boostLabel = (b: Boosts) => Object.entries(b).map(([k, v]) => `${STAT_LABELS[k as keyof typeof STAT_LABELS]} ${v! > 0 ? '+' : ''}${v}`).join(' ');

  const oppTargets = rows.filter(r => r.ref.side === 'opp').map(r => mons?.[r.ref.slot]);
  const contactStatuses = actor.side === 'me' && contact
    ? (['brn', 'par', 'psn', 'slp'] as Status[]).filter(st => oppTargets.some(m => m?.abilities.some(a => a.p > 0 && CONTACT_PUNISH[a.name]?.[st])))
    : [];
  const helmetPossible = actor.side === 'me' && contact && oppTargets.some(m => has(m, 'items', 'Rocky Helmet'));
  // Hits, when the number varies (Bullet Seed 2–5, Triple Axel 1–3).
  const hits = move ? hitChoices(move) : [];
  const lifeOrbPossible = actor.side === 'opp' && has(summary, 'items', 'Life Orb') && !live.mons[monKey(actor)]?.itemGone;

  const megaOptions = canMega(ctx, live, actor) && !live.mons[monKey(actor)]?.mega
    ? actor.side === 'me'
      ? [megaFormeOf(gen, battle.myTeam[actor.slot])].filter((x): x is string => !!x)
      : (summary?.formes ?? []).filter(f => /-Mega/.test(f.name) && f.p > 0).map(f => f.name)
    : [];

  const title = monLabel(battle, mons, actor, live);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={`${title} action`}>
        {queue.some(r => !sameMon(r, actor)) && (
          <div className="queue">
            <span className="small muted">still to move:</span>
            {queue.map(r => (
              <button key={monKey(r)} className={`qchip ${r.side}${sameMon(r, actor) ? ' on' : ''}`} onClick={() => onPickActor(r)}>
                {monLabel(battle, mons, r, live)}
              </button>
            ))}
          </div>
        )}
        <div className="sheet-head">
          <span className={`tag ${actor.side}`}>{actor.side === 'me' ? 'you' : 'opp'}</span>
          <span className="who">{title}{move ? ` · ${move}` : ''}</span>
          {locked && move === locked && <span className="tag" title="A Choice item keeps it on this move">locked</span>}
          {stage !== 'move' && <button className="btn sm ghost" onClick={() => {
            setStage('move');
            setMove(null);
            setRows([]);
          }}>‹ back</button>}
          <button className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {stage === 'move' && (
          <>
            <div className="movegrid">
              {moveList.map((m, i) => {
                const type = dexMove(gen, m.name)?.type ?? 'Normal';
                return (
                  <button key={m.name} className={`mv${m.seen ? ' seen' : ''}`} style={{'--type': TYPE_COLORS[type]} as React.CSSProperties} onClick={() => pickMove(m.name)}>
                    <span className="n">{i < 9 && <kbd className="kbd">{i + 1}</kbd>}{m.name}</span>
                    {m.hint && <span className="p">{m.hint}</span>}
                  </button>
                );
              })}
              <button className="mv" onClick={() => setStage('search')}>
                <span className="n">Other move…</span><span className="p">search</span>
              </button>
            </div>
            <div className="note kbd-hint">Keys: 1–9 move · a letter searches · ← → switch Pokémon · Esc close</div>
            <div className="chips">
              {quickOptions.map(q => (
                <span key={q} className={`chip warn-on${quick === q ? ' on' : ''}`} onClick={() => setQuick(quick === q ? null : q)}>{q} activated</span>
              ))}
              {megaOptions.map(f => (
                <button key={f} className="btn sm" onClick={() => onMega(f)}>Mega {f.replace(/^.*?-Mega-?/, '') || ''}</button>
              ))}
              <button className="btn sm" onClick={onSwitch}>Switch out</button>
              {actor.side === 'opp' && <button className="btn sm" onClick={() => setStage('ability')}>Ability shown…</button>}
              {actor.side === 'opp' && <button className="btn sm" onClick={() => setStage('item')}>Item shown…</button>}
            </div>
          </>
        )}

        {stage === 'search' && (
          <>
            <input autoFocus list="sheet-moves" value={query} onChange={e => setQuery(e.target.value)} placeholder="Type a move…"
              onKeyDown={e => e.key === 'Enter' && dexMove(gen, query) && pickMove(query)} />
            <Datalist id="sheet-moves" options={allMoves(gen)} />
            <div className="movegrid">
              {allMoves(gen).filter(n => query.length >= 2 && toID(n).includes(toID(query))).slice(0, 12).map(n => (
                <button key={n} className="mv" style={{'--type': TYPE_COLORS[dexMove(gen, n)?.type ?? 'Normal']} as React.CSSProperties} onClick={() => pickMove(n)}>
                  <span className="n">{n}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {(stage === 'ability' || stage === 'item') && summary && (
          <RevealPicker
            gen={gen}
            what={stage}
            options={(stage === 'ability' ? summary.abilities : summary.items).filter(e => e.p > 0 && e.name !== OTHER_ITEM)}
            onPick={v => onReveal(stage, v)}
          />
        )}

        {stage === 'target' && (
          <>
            <div className="small muted">Target?</div>
            <div className="targets-pick">
              {[...foes, ...allies].map((r, i) => (
                <button key={monKey(r)} className="btn" style={{minHeight: 56}} onClick={() => pickTarget(r)}>
                  <kbd className="kbd">{i + 1}</kbd> <span className={`tag ${r.side}`}>{r.side === 'me' ? 'you' : 'opp'}</span> {monLabel(battle, mons, r, live)}
                </button>
              ))}
            </div>
            {move && isStatusMove(gen, move) && (
              <button className="btn sm ghost" onClick={() => commit({targetRefs: [], failed: true})}>It failed / was blocked</button>
            )}
          </>
        )}

        {stage === 'result' && (
          <>
            {rows.length === 0 && <div className="small muted">No target on the field: logged for turn order only.</div>}
            {rows.map((r, i) => {
              const unknown = !!live.mons[monKey(r.ref)]?.hpUnknown;
              const before = r.before !== undefined ? r.before : unknown ? '?' : String(hpBefore(r.ref));
              const unit = r.ref.side === 'opp' ? '%' : '';
              const statuses = statusChoices();
              return (
                <div key={monKey(r.ref)} className={`target-row${focus === i ? ' focus' : ''}`} onClick={() => setFocus(i)}>
                  <div className="line">
                    <span className={`tag ${r.ref.side}`}>{r.ref.side === 'me' ? 'you' : 'opp'}</span>
                    <b style={{flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{monLabel(battle, mons, r.ref, live)}</b>
                    <button className="btn sm ghost" title="Correct the HP before the hit" onClick={e => {
                      e.stopPropagation();
                      setFocus(i);
                      setEditBefore(!(editBefore && focus === i));
                      if (r.before === undefined) patch(i, {before: unknown ? '' : String(hpBefore(r.ref))});
                    }}>
                      {editBefore && focus === i ? <u>{before}{unit}</u> : <>{before}{unit}</>} →
                    </button>
                    <div className="value">{r.fainted ? 'KO' : r.noEffect ? '—' : r.value === '' ? <span className="muted">?</span> : `${r.value}${unit}`}</div>
                  </div>
                  <div className="chips">
                    <span className={`chip${r.crit ? ' on' : ''}`} onClick={() => patch(i, {crit: !r.crit})}>✦ Crit</span>
                    <span className={`chip${r.noEffect ? ' on' : ''}`} onClick={() => patch(i, {noEffect: !r.noEffect, fainted: false, value: ''})}>No effect</span>
                    {statuses.map(st => (
                      <span key={st} className={`chip warn-on${r.status === st ? ' on' : ''}`} onClick={() => patch(i, {status: r.status === st ? undefined : st})}>{STATUS_LABEL[st]}</span>
                    ))}
                    {chanceBoosts.map((s, k) => (
                      <span key={k} className={`chip${r.boosts ? ' on' : ''}`} onClick={() => patch(i, {boosts: r.boosts ? undefined : s.b})}>{boostLabel(s.b!)}</span>
                    ))}
                    {reactionOptions(r).map(o => (
                      <span key={o.name} className={`chip warn-on${r.reaction === o.name ? ' on' : ''}`}
                        onClick={() => patch(i, {reaction: r.reaction === o.name ? undefined : o.name})}>{o.name}</span>
                    ))}
                    {messageChips(r).map(([t, label]) => (
                      <span key={t} className={`chip warn-on${r.triggers.includes(t) ? ' on' : ''}`} onClick={() => patch(i, {triggers: toggle(r.triggers, t)})}>{label}</span>
                    ))}
                    <span className="chip" onClick={() => dropRow(i)}>Missed / protected</span>
                  </div>
                </div>
              );
            })}
            {(lifeOrbPossible || helmetPossible || contactStatuses.length > 0 || hits.length > 0 || selfChance.length > 0) && (
              <div className="chips">
                {lifeOrbPossible && <span className={`chip warn-on${actorTriggers.includes('lifeorb') ? ' on' : ''}`} onClick={() => setActorTriggers(toggle(actorTriggers, 'lifeorb'))}>Life Orb recoil</span>}
                {helmetPossible && <span className={`chip warn-on${actorTriggers.includes('helmet') ? ' on' : ''}`} onClick={() => setActorTriggers(toggle(actorTriggers, 'helmet'))}>Hurt by Rocky Helmet</span>}
                {contactStatuses.map(st => (
                  <span key={st} className={`chip warn-on${actorStatus === st ? ' on' : ''}`} onClick={() => setActorStatus(actorStatus === st ? undefined : st)}>I got {STATUS_LABEL[st]}</span>
                ))}
                {hits.map(n => (
                  <span key={n} className={`chip${hitCount === n ? ' on' : ''}`} onClick={() => setHitCount(hitCount === n ? undefined : n)}>{n} hits</span>
                ))}
                {selfChance.map((s, k) => (
                  <span key={`self${k}`} className={`chip${actorBoosts ? ' on' : ''}`} onClick={() => setActorBoosts(actorBoosts ? undefined : s.sb)}>Its own {boostLabel(s.sb!)}</span>
                ))}
              </div>
            )}
            <Keypad onKey={onKey} multi={rows.length > 1} ready={ready} />
            <div className="note">Type the HP shown right after the hit (before berries). A message chip left off means the message didn't appear. No time? <b>skip HP</b> logs the move without it.</div>
            <div className="note kbd-hint">Keys: type the HP · Enter log · Tab next target · K KO · C crit · X missed · S skip HP · Esc close</div>
          </>
        )}
      </div>
    </>
  );
}

function RevealPicker({gen, what, options, onPick}: {
  gen: Gen; what: 'ability' | 'item'; options: {name: string; p: number}[]; onPick(v: string): void;
}) {
  const [q, setQ] = useState('');
  const all = what === 'ability' ? allAbilities(gen) : allItems(gen);
  return (
    <>
      <div className="small muted">Which {what} did the game show?</div>
      <div className="movegrid">
        {options.slice(0, 10).map(o => (
          <button key={o.name} className="mv" onClick={() => onPick(o.name)}>
            <span className="n">{o.name}</span><span className="p">{pct(o.p)}</span>
          </button>
        ))}
      </div>
      <input list="reveal-all" value={q} onChange={e => setQ(e.target.value)} placeholder={`other ${what}…`}
        onKeyDown={e => e.key === 'Enter' && all.includes(q) && onPick(q)} />
      <Datalist id="reveal-all" options={all} />
    </>
  );
}
