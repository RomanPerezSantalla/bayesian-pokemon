import {useEffect, useState, type ReactNode} from 'react';
import {getGen, spriteUrl, type Gen} from '../data/dex';
import {loadFormat, loadFormatIndex, type FormatData, type FormatInfo} from '../data/format';
import type {DistEntry} from '../engine/posterior';

export const pct = (p: number, digits = 0) => {
  if (p >= 0.9995 && p < 1) return '>99%';
  if (p > 0 && p < 0.005 && digits === 0) return '<1%';
  return `${(p * 100).toFixed(digits)}%`;
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
    loadFormat(id).then(f => live && setFmt(f), e => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [id]);
  const gen: Gen | null = fmt ? getGen(fmt.gen) : null;
  return {fmt, gen, error};
}

export function Sprite({gen, species, small}: {gen: Gen; species: string; small?: boolean}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [species]);
  if (failed || !species) {
    return <div className={`sprite-fallback${small ? ' sm' : ''}`} style={small ? {width: 32, height: 32} : undefined}>{species.slice(0, 2)}</div>;
  }
  return (
    <img
      className={`sprite${small ? ' sm' : ''}`}
      src={spriteUrl(gen, species)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Posterior bars with a tick at the prior, so you can see what the evidence did. */
export function DistBars({entries, max = 6, label}: {entries: DistEntry[]; max?: number; label?: (n: string) => ReactNode}) {
  const [open, setOpen] = useState(false);
  const shown = open ? entries : entries.slice(0, max);
  const rest = entries.length - max;
  return (
    <div>
      <div className="dist">
        {shown.map(e => (
          <DistRow key={e.name} name={label ? label(e.name) : e.name} p={e.p} prior={e.prior} />
        ))}
      </div>
      {rest > 0 && (
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>
          {open ? 'show less' : `+${rest} more`}
        </button>
      )}
    </div>
  );
}

export function DistRow({name, p, prior}: {name: ReactNode; p: number; prior?: number}) {
  return (
    <>
      <div className="label" title={typeof name === 'string' ? name : undefined}>{name}</div>
      <div className="bar-track" title={prior !== undefined ? `prior ${pct(prior, 1)} → now ${pct(p, 1)}` : pct(p, 1)}>
        <div className="bar-fill" style={{width: `${Math.max(0, Math.min(1, p)) * 100}%`}} />
        {prior !== undefined && <div className="bar-prior" style={{left: `calc(${Math.min(1, prior) * 100}% - 1px)`}} />}
      </div>
      <div className="pct">{pct(p)}</div>
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
      {options.map(o => (
        <option key={o} value={o} />
      ))}
    </datalist>
  );
}
