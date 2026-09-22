/**
 * When something breaks. A screen that throws while drawing shows the crash screen instead of a
 * blank page, and an error from a tap shows a banner; both can copy a bug report with the battle
 * on screen. Saved battles are safe either way: they're written as they change.
 */
import {Component, useEffect, useState, type ErrorInfo, type ReactNode} from 'react';
import {makeReport, saveFile} from '../state/backup';
import {battleById, useStore} from '../state/store';
import {testLog} from '../testlog';
import {undo} from './battle/actions';

const ISSUES_URL = 'https://github.com/RomanPerezSantalla/bayesian-pokemon/issues';

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

function battleOnScreen() {
  const view = useStore.getState().view;
  return view.page === 'battle' ? battleById(view.battleId) : undefined;
}

/** Copied to the clipboard; saved as a file where the clipboard is blocked (plain HTTP, older browsers). */
async function sendReport(error: Error, where?: string): Promise<string> {
  const text = JSON.stringify(makeReport(error, where, battleOnScreen()));
  try {
    await navigator.clipboard.writeText(text);
    return 'Copied.';
  } catch {
    await saveFile(`battle-analyzer-report-${new Date().toISOString().slice(0, 10)}.json`, text);
    return 'Saved as a file.';
  }
}

function ReportNote({text, withBattle}: {text: string; withBattle: boolean}) {
  return (
    <div className="small muted">
      {text} Paste it into a <a href={ISSUES_URL} target="_blank" rel="noreferrer">bug report</a>: it has the error,
      your browser{withBattle ? ' and this battle (your team and everything logged)' : ''}.
    </div>
  );
}

function CrashScreen({error, where, onRetry}: {error: Error; where?: string; onRetry(): void}) {
  const view = useStore(s => s.view);
  const battle = useStore(s => (view.page === 'battle' && s.current?.id === view.battleId ? s.current : undefined));
  const saving = useStore(s => !s.storageError);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="panel col crash" role="alert">
      <h2>Something broke on this screen</h2>
      <div className="small">
        {saving ? 'Your battles are saved, up to the last entry.' : "Saving isn't working in this browser right now: save a backup from the Battles page."}
      </div>
      <code className="crash-msg">{error.message || error.name}</code>
      <div className="row">
        <button className="btn primary" onClick={onRetry}>Try again</button>
        {battle && battle.events.length > 0 && (
          <button className="btn" title="If what was just logged is what broke it" onClick={() => {
            testLog('undo', {battle: battle.id, turn: battle.turn, from: 'crash screen'});
            useStore.getState().updateBattle(battle.id, undo);
            onRetry();
          }}>↶ Undo the last entry</button>
        )}
        <button className="btn" onClick={async () => setSent(await sendReport(error, where))}>
          {battle ? 'Copy this battle for a bug report' : 'Copy a bug report'}
        </button>
        <button className="btn ghost" onClick={() => location.reload()}>Reload the app</button>
      </div>
      {sent && <ReportNote text={sent} withBattle={!!battle} />}
    </div>
  );
}

/** Shows the crash screen for anything below it that throws; a new `resetKey` (another page) clears it. */
export class ErrorBoundary extends Component<{children: ReactNode; resetKey?: string}, {error: Error | null; where?: string}> {
  state: {error: Error | null; where?: string} = {error: null};

  static getDerivedStateFromError(error: unknown) {
    return {error: asError(error)};
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    testLog('crash', {report: makeReport(error, info.componentStack ?? undefined, battleOnScreen())});
    this.setState({where: info.componentStack ?? undefined});
  }

  componentDidUpdate(prev: {resetKey?: string}) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({error: null, where: undefined});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <CrashScreen error={this.state.error} where={this.state.where} onRetry={() => this.setState({error: null, where: undefined})} />;
  }
}

/** Errors outside drawing (a tap that failed) leave the screen as it was: say so, rather than nothing happening. */
export function ErrorBanner() {
  const [error, setError] = useState<Error | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      // Browser extensions and cross-origin scripts aren't ours; "ResizeObserver loop" warnings carry no error.
      if (!e.error || (e.filename && !e.filename.startsWith(location.origin))) return;
      testLog('error', {report: makeReport(e.error, undefined, battleOnScreen())});
      setError(asError(e.error));
      setSent(null);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      testLog('error', {report: makeReport(e.reason, undefined, battleOnScreen())});
      setError(asError(e.reason));
      setSent(null);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  if (!error) return null;
  return (
    <div className="banner warn col" role="alert">
      <div className="row">
        <span style={{flex: 1, minWidth: 0}}>Something went wrong: {error.message || error.name}</span>
        <button className="btn sm" onClick={async () => setSent(await sendReport(error))}>Copy bug report</button>
        <button className="btn sm ghost" onClick={() => setError(null)} aria-label="Dismiss">✕</button>
      </div>
      {sent && <ReportNote text={sent} withBattle={!!battleOnScreen()} />}
    </div>
  );
}
