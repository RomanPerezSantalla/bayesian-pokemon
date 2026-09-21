import {useState} from 'react';
import {useStore} from './state/store';
import {BattleScreen} from './ui/battle/BattleScreen';
import {BattlesPage} from './ui/BattlesPage';
import {Setup} from './ui/Setup';
import {TeamsPage} from './ui/TeamsPage';

const COFFEE_URL = 'https://buymeacoffee.com/romanps';

/** Light/dark switch; the choice is kept in this browser (index.html applies it before paint). */
function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const flip = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('bba-theme', next);
    } catch {
      // Private mode: it still switches for this visit.
    }
    setDark(!dark);
  };
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  return <button className="theme-toggle" onClick={flip} aria-label={label} title={label}>{dark ? '☀' : '☾'}</button>;
}

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
            <path d="M2 16a14 14 0 0 0 28 0z" fill="#fff" />
            <path d="M2 16h28" stroke="#111" strokeWidth="2" />
            <circle cx="16" cy="16" r="4.5" fill="#fff" stroke="#111" strokeWidth="2" />
          </svg>
          <span className="brand-name">Battle Analyzer</span>
        </div>
        <nav className="nav">
          <button className={view.page === 'new' ? 'on' : ''} onClick={() => setView({page: 'new'})}>New battle</button>
          <button className={view.page === 'battles' ? 'on' : ''} onClick={() => setView({page: 'battles'})}>Battles</button>
          <button className={view.page === 'teams' ? 'on' : ''} onClick={() => setView({page: 'teams'})}>Teams</button>
          {current && <button className="on">{current.label}</button>}
        </nav>
        <div className="topbar-end">
          <a className="coffee-link" href={COFFEE_URL} target="_blank" rel="noreferrer" title="Buy me a coffee">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M4 6h12v6.5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V6zM17 7.4h1.6a2.9 2.9 0 0 1 0 5.8H17v-2h1.6a.9.9 0 0 0 0-1.8H17v-2zM3 19h14v2H3z" fill="currentColor" />
            </svg>
            <span className="coffee-label">Buy me a coffee</span>
          </a>
          <ThemeToggle />
        </div>
      </header>
      <main className="main">
        {storageError && <div className="banner warn">{storageError}</div>}
        {view.page === 'teams' && <TeamsPage teamId={view.teamId} />}
        {view.page === 'battles' && <BattlesPage />}
        {view.page === 'new' && <Setup key={view.teamId} teamId={view.teamId} />}
        {view.page === 'battle' && <BattleScreen key={view.battleId} battleId={view.battleId} />}
      </main>
    </div>
  );
}
