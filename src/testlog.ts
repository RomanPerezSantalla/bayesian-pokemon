/**
 * The test log, only in the copy `npm run phone` builds (scripts/phone.mjs): what happens on the
 * phone goes back to the PC serving it. Voice phrases (what was heard and what they did), undos and
 * errors are appended to .cache/phone-log.jsonl; each battle is written to .cache/phone-battles/ as
 * it's saved. In every other build `__TEST_LOG__` is false and all of this drops out.
 */
import type {PackedBattle} from './state/pack';

export const testLogOn = __TEST_LOG__;

function send(url: string, body: unknown) {
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return;
  }
  // keepalive lets a line sent as the page closes still arrive; it's limited to 64 KB.
  fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: text, keepalive: text.length < 60_000})
    .catch(() => {});
}

export function testLog(kind: string, entry: Record<string, unknown> = {}) {
  if (!testLogOn) return;
  send('./__log', {at: new Date().toISOString(), kind, ...entry});
}

/** The latest copy of each battle, at most every few seconds (and straight away when the page is hidden). */
const latest = new Map<string, PackedBattle>();
let timer: ReturnType<typeof setTimeout> | undefined;

function sendBattles() {
  clearTimeout(timer);
  timer = undefined;
  for (const b of latest.values()) send('./__log/battle', b);
  latest.clear();
}

export function testLogBattle(b: PackedBattle) {
  if (!testLogOn) return;
  latest.set(b.id, b);
  timer ??= setTimeout(sendBattles, 3000);
}

if (testLogOn && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendBattles();
  });
}
