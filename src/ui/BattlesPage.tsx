import {useStore} from '../state/store';
import {BackupPanel} from './Backup';
import {VoicePanel} from './VoiceSetup';

export function BattlesPage() {
  const battles = useStore(s => s.battles);
  const ready = useStore(s => s.ready);
  const setView = useStore(s => s.setView);
  if (!ready) return <div className="panel empty">Loading battles…</div>;
  return (
    <div className="col" style={{maxWidth: 820, margin: '0 auto'}}>
      {battles.length ? (
        <div className="panel col">
          <div className="row">
            <h2>Battles</h2>
            <div className="spacer" />
            <button className="btn primary sm" onClick={() => setView({page: 'new'})}>+ New battle</button>
          </div>
          {battles.map(b => (
            <div key={b.id} className="team-item" onClick={() => setView({page: 'battle', battleId: b.id})}>
              <div style={{fontWeight: 600}}>{b.label}</div>
              <div className="small muted">
                {b.formatId === 'champions-singles' ? 'Singles' : 'Doubles'} · turn {b.turn} · {b.entries} entries · {new Date(b.updated).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel empty">
          <p>No battles yet.</p>
          <button className="btn primary" onClick={() => setView({page: 'new'})}>New battle</button>
        </div>
      )}
      <BackupPanel />
      <VoicePanel />
    </div>
  );
}
