/** One side of a Showdown replay, as build-leads.mjs reads it (names as counted: see leadName). */
export interface ReplaySide {
  player: string;
  six: string[];
  /** The two that led. */
  leads: string[];
  /** Every one that came in, the leads too. */
  brought: string[];
  /** All four were seen. */
  complete: boolean;
}

export function sidesOf(log: string): (ReplaySide | {rejected: string})[];
