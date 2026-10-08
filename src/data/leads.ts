import type {LeadTable} from '../engine/leads';

const base = import.meta.env?.BASE_URL ?? '/';
let table: Promise<LeadTable | null> | undefined;

/** The leads table (scripts/build-leads.mjs), or null where it can't be had (tried again next time). */
export function loadLeads(): Promise<LeadTable | null> {
  table ||= fetch(`${base}data/leads-doubles.json`)
    .then(r => {
      if (!r.ok) throw new Error(`leads: HTTP ${r.status}`);
      return r.json() as Promise<LeadTable>;
    })
    .catch(() => {
      table = undefined;
      return null;
    });
  return table;
}
