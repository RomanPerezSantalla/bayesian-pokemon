import {useEffect, useState, type ReactNode} from 'react';
import {getGen, spriteUrl, type Gen} from '../data/dex';
import {loadFormat, loadFormatIndex, type FormatData, type FormatInfo} from '../data/format';
import type {DistEntry} from '../engine/posterior';
import {pct} from './format';

export {pct};

export const TYPE_COLORS: Record<string, string> = {
  Normal: '#9fa19f', Fire: '#e62829', Water: '#2980ef', Electric: '#fac000', Grass: '#3fa129', Ice: '#3dcef3',
  Fighting: '#ff8000', Poison: '#9141cb', Ground: '#915121', Flying: '#81b9ef', Psychic: '#ef4179', Bug: '#91a119',
  Rock: '#afa981', Ghost: '#704170', Dragon: '#5060e1', Dark: '#624d4e', Steel: '#60a1b8', Fairy: '#ef70ef', Stellar: '#40b5a5',
};

export function useFormatIndex() {
  const [formats, setFormats] = useState<FormatInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadFormatIndex().then(setFormats, e => setError(String(e.message ?? e)));
  }, []);
  return {formats, error};
}

export function useFormat(id: string | undefined) {
  const [fmt, setFmt] = useState<FormatData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setFmt(null);
    setError(null);
    loadFormat(id).then(f => live && setFmt(f), e => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [id]);
  const gen: Gen | null = fmt ? getGen(fmt.gen) : null;
  return {fmt, gen, error};
}

export function Sprite({gen, species, large}: {gen: Gen; species: string; large?: boolean}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [species]);
  if (failed || !species) return <div className="sprite-fallback">{species.slice(0, 2)}</div>;
  return <img className={`sprite${large ? ' lg' : ''}`} src={spriteUrl(gen, species)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** Beliefs now vs. where the usage-stats prior started (thin tick). Ruled-out options are hidden. */
export function DistBars({entries, max = 5, label}: {entries: DistEntry[]; max?: number; label?: (n: string) => ReactNode}) {
  const [open, setOpen] = useState(false);
  const live = entries.filter(e => e.p > 0);
  const shown = open ? live : live.slice(0, max);
  const ruledOut = entries.filter(e => e.p === 0 && e.prior > 0.01);
  return (
    <div>
      <div className="dist">
        {shown.map(e => (
          <DistRow key={e.name} name={label ? label(e.name) : e.name} p={e.p} prior={e.prior} certain={e.certain} />
        ))}
      </div>
      <div className="row small">
        {live.length > max && (
          <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? 'less' : `+${live.length - max} more`}</button>
        )}
        {ruledOut.length > 0 && (
          <span className="muted">ruled out: {ruledOut.slice(0, 4).map(e => e.name).join(', ')}{ruledOut.length > 4 ? '…' : ''}</span>
        )}
      </div>
    </div>
  );
}

export function DistRow({name, p, prior, certain}: {name: ReactNode; p: number; prior?: number; certain?: boolean}) {
  return (
    <>
      <div className="label">{name}</div>
      <div className="bar-track" title={prior !== undefined ? `prior ${pct(prior)} → now ${pct(p)}` : pct(p)}>
        <div className={`bar-fill${certain ? ' certain' : ''}`} style={{width: `${Math.max(0, Math.min(1, p)) * 100}%`}} />
        {prior !== undefined && <div className="bar-prior" style={{left: `calc(${Math.min(1, prior) * 100}% - 1px)`}} />}
      </div>
      <div className={`pct${certain ? ' ok-badge' : ''}`}>{certain ? '✓' : pct(p)}</div>
    </>
  );
}

export function HpBar({frac}: {frac: number}) {
  const cls = frac > 0.5 ? '' : frac > 0.2 ? 'mid' : 'low';
  return (
    <div className={`hpbar ${cls}`}>
      <div style={{width: `${Math.max(0, Math.min(1, frac)) * 100}%`}} />
    </div>
  );
}

export function Datalist({id, options}: {id: string; options: string[]}) {
  return (
    <datalist id={id}>
      {options.map(o => <option key={o} value={o} />)}
    </datalist>
  );
}
