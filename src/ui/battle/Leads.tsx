import {useEffect, useState} from 'react';
import {loadLeads} from '../../data/leads';
import {backOdds, eachOdds, leadOdds, type LeadTable} from '../../engine/leads';
import type {Battle} from '../../engine/types';
import {DistRow, pct} from '../common';

/** Their slots in the order they first came in: the first two led. */
export function cameIn(battle: Battle): number[] {
  const out: number[] = [];
  const add = (slot: number | null | undefined) => {
    if (slot !== null && slot !== undefined && !out.includes(slot)) out.push(slot);
  };
  for (const ev of battle.events) if (ev.kind === 'switch' && ev.side === 'opp') add(ev.slotIn);
  battle.live.active.opp.forEach(add);
  return out;
}

function useLeads(wanted: boolean): LeadTable | null {
  const [table, setTable] = useState<LeadTable | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadLeads().then(t => live && setTable(t));
    return () => {
      live = false;
    };
  }, [wanted]);
  return table;
}

/**
 * Doubles: at team preview, the pairs they likeliest lead with; once their leads are out, how likely each of the other
 * four is to be one of the two in the back, until both have come in. From Showdown's ladder (scripts/build-leads.mjs):
 * leanings, not calls (the lead pair is in the top five about half the time).
 */
export function LeadsPanel({battle}: {battle: Battle}) {
  const doubles = battle.live.active.opp.length === 2;
  const table = useLeads(doubles);
  // All six from team preview (a battle opened at its first "sent out" learns them as they come in: no guessing then).
  const six = battle.oppPreview;
  if (!table || !doubles || six.length !== 6 || six.some(n => !n)) return null;
  const order = cameIn(battle);
  // "05/10/2026", as the priors' date is shown.
  const day = (iso: string) => iso.split('-').reverse().join('/');
  const {source, checked} = table;
  const when = source.from === source.to ? day(source.to) : `${day(source.from)} to ${day(source.to)}`;
  const from = `Showdown's ladder, ${source.battles ?? Math.round(source.sides / 2)} games (${when}).`;

  if (!order.length) {
    const odds = leadOdds(table, six).slice(0, 5);
    return (
      <div className="panel col leads">
        <h3>Likely leads</h3>
        <div className="dist">
          {odds.map(o => <DistRow key={o.pair.join('+')} name={o.pair.join(' + ')} p={o.p} />)}
        </div>
        <div className="note">
          {from}{checked && ` The real lead was in its top five ${pct(checked.leadTop5)} of the time (at random, 33%).`}
        </div>
      </div>
    );
  }

  // The second lead's line is a moment away; both back seen, nothing left to guess.
  const back = order.slice(2);
  if (order.length < 2 || back.length >= 2) return null;
  const leads = order.slice(0, 2).map(s => six[s]);
  const each = eachOdds(backOdds(table, six, leads, back.map(s => six[s])));
  const rest = six.map((name, slot) => ({name, slot, p: each.get(name) ?? 0}))
    .filter(m => !order.includes(m.slot))
    .sort((a, b) => b.p - a.p);
  return (
    <div className="panel col leads">
      <h3>{back.length ? `In the back with ${six[back[0]]}` : 'Likely in the back'}</h3>
      <div className="chips">
        {rest.map(m => <span key={m.slot} className="tag">{m.name} <b>{pct(m.p)}</b></span>)}
      </div>
      <div className="note">
        {from}{checked && ` Its likeliest two were the real two ${pct(checked.backTop1)} of the time (at random, 17%).`}
      </div>
    </div>
  );
}
