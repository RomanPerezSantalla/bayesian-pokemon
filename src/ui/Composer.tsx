import {useEffect, useMemo, useState} from 'react';
import {allItems, allAbilities, allMoves, isDamagingMove, isSpreadMove, move as dexMove, TYPES, type Gen} from '../data/dex';
import type {FormatData} from '../data/format';
import {applyAction, cloneSnapshot, uid} from '../engine/battle';
import type {Beliefs} from '../engine/posterior';
import {OTHER_ITEM} from '../engine/prior';
import {sameMon, type ActionEvent, type Battle, type HitResult, type MonRef, type RevealEvent, type Trigger} from '../engine/types';
import {activeRefs, monName} from './battleUtil';
import {Datalist, pct} from './common';

interface HitDraft {
  target: MonRef;
  hpAfter: string;
  fainted: boolean;
  crit: boolean;
  triggers: Trigger[];
}

const DEF_TRIGGERS: [Trigger, string][] = [
  ['berry', 'Resist berry'], ['sash', 'Focus Sash / Sturdy'], ['wp', 'Weakness Policy'], ['sitrus', 'Sitrus Berry'],
];

const MULTI_HIT = new Set([
  'bulletseed', 'rockblast', 'iciclespear', 'scaleshot', 'tailslap', 'pinmissile', 'armthrust', 'furyattack',
  'doubleslap', 'watershuriken', 'populationbomb', 'bonerush', 'furyswipes', 'cometpunch', 'barrage', 'spikecannon',
  'tripleaxel', 'triplekick',
]);

function Chip({on, onClick, children}: {on: boolean; onClick(): void; children: React.ReactNode}) {
  return <span className={`chip${on ? ' on' : ''}`} onClick={onClick}>{children}</span>;
}

export function Composer({fmt, gen, battle, beliefs, update, focusOpp}: {
  fmt: FormatData;
  gen: Gen;
  battle: Battle;
  beliefs: Beliefs | null;
  update(fn: (b: Battle) => Battle): void;
  focusOpp: number | null;
}) {
  const live = battle.live;
  const actives = activeRefs(live);
  const everyone: MonRef[] = [
    ...battle.myTeam.map((_, slot) => ({side: 'me' as const, slot})),
    ...battle.oppPreview.map((_, slot) => ({side: 'opp' as const, slot})),
  ].filter(r => (live.mons[`${r.side}${r.slot}`]?.hp ?? 1) > 0);
  const actorChoices = actives.length ? actives : everyone;

  const [actor, setActor] = useState<MonRef | null>(null);
  const [move, setMove] = useState('');
  const [hits, setHits] = useState<HitDraft[]>([]);
  const [actorTriggers, setActorTriggers] = useState<Trigger[]>([]);
  const [helpingHand, setHelpingHand] = useState(false);
  const [hitCount, setHitCount] = useState('');
  const [ordered, setOrdered] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const damaging = !!move && isDamagingMove(gen, move);
  const moveData = move ? dexMove(gen, move) : undefined;

  // Sensible default targets whenever the actor or move changes.
  useEffect(() => {
    if (!actor || !damaging) {
      setHits([]);
      return;
    }
    const foeSide = actor.side === 'me' ? 'opp' : 'me';
    const foes = live.active[foeSide].filter((s): s is number => s !== null).map(slot => ({side: foeSide, slot} as MonRef));
    const allies = live.active[actor.side].filter((s): s is number => s !== null && s !== actor.slot).map(slot => ({side: actor.side, slot} as MonRef));
    let targets: MonRef[];
    if (isSpreadMove(gen, move)) targets = moveData?.target === 'allAdjacent' ? [...foes, ...allies] : foes;
    else if (foeSide === 'opp' && focusOpp !== null && foes.some(f => f.slot === focusOpp)) targets = [{side: 'opp', slot: focusOpp}];
    else targets = foes.slice(0, 1);
    if (!targets.length) {
      const any = foeSide === 'opp' ? (focusOpp ?? 0) : 0;
      targets = [{side: foeSide, slot: any}];
    }
    setHits(targets.map(t => ({target: t, hpAfter: '', fainted: false, crit: false, triggers: []})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor?.side, actor?.slot, move]);

  const moveOptions = useMemo((): {name: string; hint?: string}[] => {
    if (!actor) return [];
    if (actor.side === 'me') return (battle.myTeam[actor.slot]?.moves ?? []).map(name => ({name}));
    const b = beliefs?.mons[actor.slot];
    return (b?.moves ?? []).slice(0, 10).map(m => ({name: m.name, hint: m.revealed ? '✓' : pct(m.p)}));
  }, [actor, battle.myTeam, beliefs]);

  const hpBefore = (ref: MonRef) => live.mons[`${ref.side}${ref.slot}`]?.hp ?? (ref.side === 'opp' ? 100 : 0);

  const submit = () => {
    if (!actor || !move) return;
    // A blank HP box means "didn't see / missed / protected": no damage evidence.
    const hitResults: HitResult[] = hits
      .filter(h => h.fainted || h.hpAfter !== '' || h.triggers.length)
      .map(h => {
        const before = hpBefore(h.target);
        const after = h.fainted ? 0 : h.hpAfter === '' ? before : Number(h.hpAfter);
        return {target: h.target, hpBefore: before, hpAfter: after, fainted: h.fainted, crit: h.crit, triggers: h.triggers};
      });
    const ev: ActionEvent = {
      kind: 'action',
      id: uid(),
      turn: battle.turn,
      actor,
      move: dexMove(gen, move)?.name ?? move,
      hits: hitResults,
      targets: Math.max(1, hits.length),
      hitCount: hitCount ? Number(hitCount) : undefined,
      helpingHand,
      actorTriggers,
      before: cloneSnapshot(live),
      ordered,
    };
    update(b => ({...b, events: [...b.events, ev], live: applyAction(b.live, ev)}));
    setMove('');
    setActorTriggers([]);
    setHelpingHand(false);
    setHitCount('');
    // Next actor: the next active Pokémon that hasn't moved this turn.
    const moved = new Set([...battle.events, ev].filter(e => e.kind === 'action' && e.turn === battle.turn).map(e => (e as ActionEvent).actor).map(r => `${r.side}${r.slot}`));
    setActor(actives.find(r => !moved.has(`${r.side}${r.slot}`)) ?? null);
  };

  const setHit = (i: number, patch: Partial<HitDraft>) => setHits(hits.map((h, j) => (j === i ? {...h, ...patch} : h)));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const targetCandidates = everyone.filter(r => !actor || !sameMon(r, actor));

  return (
    <div className="panel composer col">
      <div className="row">
        <h2>Log an action</h2>
        <span className="muted small">turn {battle.turn}, in the order they happened</span>
      </div>
      <div className="who">
        {actorChoices.map(r => (
          <button key={`${r.side}${r.slot}`} className={`btn sm${actor && sameMon(actor, r) ? ' on' : ''}`} onClick={() => setActor(r)}>
            <span className={`tag ${r.side}`}>{r.side === 'me' ? 'me' : 'opp'}</span> {monName(battle, r)}
          </button>
        ))}
        {actives.length > 0 && (
          <button className="btn sm ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'hide bench' : 'bench…'}</button>
        )}
      </div>
      {showAll && (
        <div className="who">
          {everyone.filter(r => !actives.some(a => sameMon(a, r))).map(r => (
            <button key={`${r.side}${r.slot}`} className={`btn sm${actor && sameMon(actor, r) ? ' on' : ''}`} onClick={() => setActor(r)}>
              <span className={`tag ${r.side}`}>{r.side}</span> {monName(battle, r)}
            </button>
          ))}
        </div>
      )}

      {actor && (
        <>
          <div className="who">
            {moveOptions.map(m => (
              <button key={m.name} className={`btn sm${move === m.name ? ' on' : ''}`} onClick={() => setMove(m.name)}>
                {m.name}{m.hint && <span className="muted small"> {m.hint}</span>}
              </button>
            ))}
            <input list="all-moves" value={move} onChange={e => setMove(e.target.value)} placeholder="other move…" style={{width: 150}} />
          </div>
          <Datalist id="all-moves" options={allMoves(gen)} />

          {move && !dexMove(gen, move) && <div className="small warn">Unknown move.</div>}

          {damaging && (
            <div className="col">
              {hits.map((h, i) => {
                const before = hpBefore(h.target);
                const max = h.target.side === 'opp' ? 100 : undefined;
                return (
                  <div key={i} className="hit-box col">
                    <div className="row">
                      <span>→</span>
                      <select
                        value={`${h.target.side}${h.target.slot}`}
                        onChange={e => {
                          const t = targetCandidates.find(r => `${r.side}${r.slot}` === e.target.value);
                          if (t) setHit(i, {target: t, hpAfter: ''});
                        }}
                      >
                        {targetCandidates.map(r => (
                          <option key={`${r.side}${r.slot}`} value={`${r.side}${r.slot}`}>{r.side === 'me' ? 'my' : 'opp'} {monName(battle, r)}</option>
                        ))}
                      </select>
                      <span className="muted small">{h.target.side === 'opp' ? `${before}% →` : `${before} HP →`}</span>
                      <input
                        type="number" min={0} max={max ?? 999} value={h.hpAfter} disabled={h.fainted}
                        onChange={e => setHit(i, {hpAfter: e.target.value})}
                        placeholder={h.target.side === 'opp' ? '% left' : 'HP left'}
                        onKeyDown={e => e.key === 'Enter' && submit()}
                      />
                      <label className="check"><input type="checkbox" checked={h.fainted} onChange={e => setHit(i, {fainted: e.target.checked})} /> fainted</label>
                      <label className="check"><input type="checkbox" checked={h.crit} onChange={e => setHit(i, {crit: e.target.checked})} /> crit</label>
                      {hits.length > 1 && <button className="btn sm ghost" onClick={() => setHits(hits.filter((_, j) => j !== i))}>✕</button>}
                    </div>
                    {h.target.side === 'opp' && (
                      <div className="row small">
                        <span className="muted">messages:</span>
                        {DEF_TRIGGERS.map(([t, label]) => (
                          <Chip key={t} on={h.triggers.includes(t)} onClick={() => setHit(i, {triggers: toggle(h.triggers, t)})}>{label}</Chip>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="row small">
                {hits.length < targetCandidates.length && (
                  <button className="btn sm ghost" onClick={() => {
                    const next = targetCandidates.find(r => !hits.some(h => sameMon(h.target, r)));
                    if (next) setHits([...hits, {target: next, hpAfter: '', fainted: false, crit: false, triggers: []}]);
                  }}>+ target</button>
                )}
                {actor.side === 'opp' && <Chip on={actorTriggers.includes('lifeorb')} onClick={() => setActorTriggers(toggle(actorTriggers, 'lifeorb'))}>Life Orb recoil shown</Chip>}
                {actor.side === 'me' && moveData?.flags?.contact && (
                  <Chip on={actorTriggers.includes('helmet')} onClick={() => setActorTriggers(toggle(actorTriggers, 'helmet'))}>hurt by Rocky Helmet</Chip>
                )}
                <label className="check"><input type="checkbox" checked={helpingHand} onChange={e => setHelpingHand(e.target.checked)} /> Helping Hand</label>
                {MULTI_HIT.has(moveData?.id ?? '') && (
                  <label className="check">hits <input type="number" min={1} max={10} value={hitCount} onChange={e => setHitCount(e.target.value)} style={{width: 50}} /></label>
                )}
              </div>
              <div className="note">
                Enter HP right after the hit, before any berry heal. Leaving an unticked message box means it didn't appear, which is evidence too.
              </div>
            </div>
          )}

          <div className="row">
            <button className="btn primary" disabled={!move || !dexMove(gen, move)} onClick={submit}>Log</button>
            <label className="check small" title="Untick for actions not in speed order (Quick Claw, After You, Dancer, Instruct…)">
              <input type="checkbox" checked={ordered} onChange={e => setOrdered(e.target.checked)} /> use for speed order
            </label>
            <div className="spacer" />
            <button className="btn ghost sm" onClick={() => setActor(null)}>cancel</button>
          </div>
        </>
      )}
      <RevealForm gen={gen} fmt={fmt} battle={battle} beliefs={beliefs} update={update} focusOpp={focusOpp} />
    </div>
  );
}

function RevealForm({gen, fmt, battle, beliefs, update, focusOpp}: {
  gen: Gen; fmt: FormatData; battle: Battle; beliefs: Beliefs | null; update(fn: (b: Battle) => Battle): void; focusOpp: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<number>(focusOpp ?? 0);
  const [what, setWhat] = useState<RevealEvent['what']>('item');
  const [value, setValue] = useState('');
  const [negate, setNegate] = useState(false);
  useEffect(() => {
    if (focusOpp !== null) setSlot(focusOpp);
  }, [focusOpp]);
  const b = beliefs?.mons[slot];
  const suggestions = what === 'item' ? (b?.items ?? []).filter(i => i.name !== OTHER_ITEM).map(i => i.name)
    : what === 'ability' ? (b?.abilities ?? []).map(a => a.name)
      : what === 'move' ? (b?.moves ?? []).filter(m => !m.revealed).map(m => m.name)
        : what === 'forme' ? (b?.formes ?? []).map(f => f.name)
          : TYPES;
  const all = what === 'item' ? allItems(gen) : what === 'ability' ? allAbilities(gen) : what === 'move' ? allMoves(gen) : suggestions;

  const add = (v = value) => {
    if (!v) return;
    const ev: RevealEvent = {kind: 'reveal', id: uid(), turn: battle.turn, mon: {side: 'opp', slot}, what, value: v, negate};
    update(bt => {
      const live = cloneSnapshot(bt.live);
      const c = live.mons[`opp${slot}`];
      if (c && !negate && what === 'forme' && /-Mega/.test(v)) c.mega = true;
      if (c && !negate && what === 'tera') c.tera = v;
      return {...bt, events: [...bt.events, ev], live};
    });
    setValue('');
  };
  void fmt;

  if (!open) {
    return (
      <div className="row">
        <button className="btn sm" onClick={() => setOpen(true)}>Reveal / rule out…</button>
        <span className="small muted">item or ability message, Mega Evolution, Tera, a move it doesn't have…</span>
      </div>
    );
  }
  return (
    <div className="hit-box col">
      <div className="row">
        <select value={slot} onChange={e => setSlot(Number(e.target.value))}>
          {battle.oppPreview.map((n, i) => (
            <option key={i} value={i}>{n}</option>
          ))}
        </select>
        <select value={negate ? 'not' : 'has'} onChange={e => setNegate(e.target.value === 'not')}>
          <option value="has">has / is</option>
          <option value="not">does NOT have</option>
        </select>
        <select value={what} onChange={e => {
          setWhat(e.target.value as RevealEvent['what']);
          setValue('');
        }}>
          <option value="item">item</option>
          <option value="ability">ability</option>
          <option value="move">move</option>
          <option value="forme">forme (Mega)</option>
          {fmt.gen === 9 && <option value="tera">Tera type</option>}
        </select>
        <input list="reveal-values" value={value} onChange={e => setValue(e.target.value)} placeholder="value…" style={{width: 150}} onKeyDown={e => e.key === 'Enter' && add()} />
        <Datalist id="reveal-values" options={all} />
        <button className="btn primary sm" onClick={() => add()}>Add</button>
        <button className="btn ghost sm" onClick={() => setOpen(false)}>close</button>
      </div>
      <div className="who">
        {suggestions.slice(0, 8).map(s => (
          <button key={s} className="btn sm" onClick={() => add(s)}>{negate ? 'not ' : ''}{s}</button>
        ))}
      </div>
    </div>
  );
}
