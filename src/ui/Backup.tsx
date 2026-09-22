import {useEffect, useRef, useState} from 'react';
import {backupName, makeBackup, restore, saveFile, sharesFiles, type ImportPlan} from '../state/backup';
import {useStore} from '../state/store';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describe(plan: ImportPlan) {
  const parts = [
    ...(plan.teams.length ? [count(plan.teams.length, 'team')] : []),
    ...(plan.battles.length ? [count(plan.battles.length, 'battle')] : []),
  ];
  if (!parts.length) return 'Nothing new: everything in that file is already here.';
  return `Restored ${parts.join(' and ')}${plan.skipped ? ` (${count(plan.skipped, 'was', 'were')} already here)` : ''}.`;
}

interface Ready {
  text: string;
  teams: number;
  battles: number;
}

const prepare = async (): Promise<Ready> => {
  const b = await makeBackup();
  return {text: JSON.stringify(b), teams: b.teams.length, battles: b.battles.length};
};

/** Save everything to a file, or bring a file back. */
export function BackupPanel() {
  const teamList = useStore(s => s.teams);
  const battleList = useStore(s => s.battles);
  const [status, setStatus] = useState<{text: string; bad?: boolean} | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<Ready | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Where the share sheet needs the tap itself (iPhone), the file is made ahead, and again when anything changes.
  useEffect(() => {
    if (!sharesFiles()) return;
    let live = true;
    setReady(null);
    prepare().then(r => live && setReady(r), () => {});
    return () => {
      live = false;
    };
  }, [teamList, battleList]);

  const save = async () => {
    setBusy(true);
    try {
      // Nothing awaited before the share sheet opens when the file is ready.
      const b = ready ?? await prepare();
      await saveFile(backupName(), b.text);
      setStatus({text: `Backup of ${count(b.teams, 'team')} and ${count(b.battles, 'battle')} made.`});
    } catch (err) {
      setStatus({text: `Couldn't make the backup: ${(err as Error).message}`, bad: true});
    } finally {
      setBusy(false);
    }
  };

  const load = async (file: File) => {
    setBusy(true);
    try {
      setStatus({text: describe(await restore(await file.text()))});
    } catch (err) {
      setStatus({text: `Couldn't restore: ${(err as Error).message}.`, bad: true});
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="panel col">
      <h3>Backup</h3>
      <div className="note">
        Teams and battles are saved in this browser only. Save a backup file now and then, or to move to another
        device; restoring adds what's missing and keeps the newest copy of each.
      </div>
      <div className="row">
        <button className="btn" disabled={busy || (!teamList.length && !battleList.length)} onClick={save}>Save backup</button>
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Restore from file…</button>
        <input ref={input} type="file" accept="application/json,.json" hidden onChange={e => {
          const f = e.target.files?.[0];
          if (f) void load(f);
        }} />
      </div>
      {status && <div className={`small ${status.bad ? 'bad' : 'muted'}`} role="status">{status.text}</div>}
    </div>
  );
}
