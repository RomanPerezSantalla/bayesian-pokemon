import {useStore} from '../state/store';

export function BattlesPage() {
  const battles = useStore(s => s.battles);
  const setView = useStore(s => s.setView);
  if (!battles.length) {
    return (
      <div className="panel empty">
        <p>No battles yet.</p>
        <button className="btn primary" onClick={() => setView({page: 'new'})}>New battle</button>
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
          <div style={{fontWeight: 600}}>{b.label}</div>
          <div className="small muted">
            {b.formatId === 'champions-singles' ? 'Singles' : 'Doubles'} · turn {b.turn} · {b.events.length} entries · {new Date(b.updated).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
