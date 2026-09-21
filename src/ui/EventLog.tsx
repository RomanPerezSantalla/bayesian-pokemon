import type {Beliefs, EvidenceNote} from '../engine/posterior';
import type {Battle, BattleEvent} from '../engine/types';
import {monName} from './battleUtil';
import {pct} from './common';

function describe(battle: Battle, ev: BattleEvent): string {
  switch (ev.kind) {
    case 'action': {
      const who = `${ev.actor.side === 'me' ? 'My' : 'Opp'} ${monName(battle, ev.actor)}`;
      const hits = ev.hits.map(h => {
        const t = `${h.target.side === 'me' ? 'my' : 'opp'} ${monName(battle, h.target)}`;
        const unit = h.target.side === 'opp' ? '%' : '';
        const res = h.fainted ? 'fainted' : `${h.hpBefore}${unit}→${h.hpAfter}${unit}`;
        const extra = [h.crit && 'crit', ...h.triggers].filter(Boolean).join(', ');
        return `${t} ${res}${extra ? ` (${extra})` : ''}`;
      });
      const flags = [ev.helpingHand && 'Helping Hand', ev.hitCount && `${ev.hitCount} hits`, ...ev.actorTriggers, !ev.ordered && 'not speed-ordered']
        .filter(Boolean).join(', ');
      return `${who}: ${ev.move}${hits.length ? ` → ${hits.join('; ')}` : ''}${flags ? ` [${flags}]` : ''}`;
    }
    case 'reveal':
      return `Opp ${monName(battle, ev.mon)} ${ev.negate ? 'does NOT have' : 'has'} ${ev.what} ${ev.value}`;
    case 'switch': {
      const side = ev.side === 'me' ? 'My' : 'Opp';
      const inn = ev.slotIn !== null ? monName(battle, {side: ev.side, slot: ev.slotIn}) : 'nothing';
      const out = ev.slotOut !== null ? ` (for ${monName(battle, {side: ev.side, slot: ev.slotOut})})` : '';
      return `${side} ${inn} in${out}`;
    }
  }
}

function Notes({notes, battle}: {notes: EvidenceNote[]; battle: Battle}) {
  return (
    <>
      {notes.map((n, i) => (
        <div key={i} className={`note${n.consistent < 0.01 ? ' alert' : ''}`} style={{paddingLeft: 12}}>
          ↳ {battle.oppPreview[n.slot]}: {n.note}
          {n.kind !== 'reveal' && n.kind !== 'moves' && ` (${pct(n.consistent)} consistent)`}
          {n.consistent < 0.01 && ' ⚠ nothing we considered explains this well'}
        </div>
      ))}
    </>
  );
}

export function EventLog({battle, beliefs, onDelete}: {battle: Battle; beliefs: Beliefs | null; onDelete(id: string): void}) {
  const turns = [...new Set(battle.events.map(e => e.turn))].sort((a, b) => b - a);
  if (!battle.events.length) {
    return (
      <div className="panel">
        <h2>Battle log</h2>
        <p className="muted small">
          Set who's on the field (the buttons on each card), then log actions in the order they happen.
          Each one updates the beliefs on the right.
        </p>
      </div>
    );
  }
  const notesFor = (id: string) => beliefs?.notes.filter(n => n.eventId === id) ?? [];
  return (
    <div className="panel">
      <div className="row">
        <h2>Battle log</h2>
        {beliefs && <span className="small muted">updated in {beliefs.ms.toFixed(0)} ms</span>}
      </div>
      {turns.map(t => (
        <div key={t} className="log-turn">
          <div className="small muted">Turn {t}</div>
          {battle.events.filter(e => e.turn === t).map(ev => (
            <div key={ev.id}>
              <div className="log-ev">
                <span className="txt">{describe(battle, ev)}</span>
                <button className="btn ghost sm" title="Delete (HP changes in the live state aren't undone)" onClick={() => onDelete(ev.id)}>✕</button>
              </div>
              <Notes notes={notesFor(ev.id)} battle={battle} />
            </div>
          ))}
          <Notes notes={notesFor(`turn${t}`)} battle={battle} />
        </div>
      ))}
    </div>
  );
}
