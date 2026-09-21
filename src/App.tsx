import {useStore} from './state/store';
import {BattlePage, BattlesPage} from './ui/BattlePage';
import {NewBattle} from './ui/NewBattle';
import {TeamsPage} from './ui/TeamsPage';

export function App() {
  const view = useStore(s => s.view);
  const setView = useStore(s => s.setView);
  const storageError = useStore(s => s.storageError);
  const battles = useStore(s => s.battles);
  const current = view.page === 'battle' ? battles.find(b => b.id === view.battleId) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r="14" fill="#e5484d" />
            <path d="M2 16h28" stroke="#111" strokeWidth="2" />
            <path d="M2 16a14 14 0 0 0 28 0z" fill="#fff" />
            <circle cx="16" cy="16" r="4.5" fill="#fff" stroke="#111" strokeWidth="2" />
          </svg>
          Bayesian Battle Analyzer
          <small>P(set | what you've seen)</small>
        </div>
        <nav className="nav">
          <button className={view.page === 'teams' ? 'on' : ''} onClick={() => setView({page: 'teams'})}>Teams</button>
          <button className={view.page === 'battles' ? 'on' : ''} onClick={() => setView({page: 'battles'})}>Battles</button>
          <button className={view.page === 'new' ? 'on' : ''} onClick={() => setView({page: 'new'})}>New battle</button>
          {current && <button className="on">{current.label}</button>}
        </nav>
      </header>
      <main className="main">
        {storageError && <div className="banner warn">{storageError}</div>}
        {view.page === 'teams' && <TeamsPage teamId={view.teamId} />}
        {view.page === 'battles' && <BattlesPage />}
        {view.page === 'new' && <NewBattle key={view.teamId} teamId={view.teamId} />}
        {view.page === 'battle' && <BattlePage key={view.battleId} battleId={view.battleId} />}
      </main>
    </div>
  );
}
