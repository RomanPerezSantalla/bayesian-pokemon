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

/** 16-bit mono WAV of 16 kHz samples. */
export function wav(samples: Float32Array, rate = 16_000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buf;
}

let clips = 0;

/**
 * A line the voice model heard, as audio, to .cache/phone-audio/ on the PC (test copies only), so
 * the reading can be tuned on the voice it's for. Returns the name it's saved under.
 */
export function testLogAudio(samples: Float32Array): string | undefined {
  if (!testLogOn) return undefined;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${clips++}`;
  fetch(`./__log/audio?id=${id}`, {method: 'POST', headers: {'content-type': 'audio/wav'}, body: wav(samples)}).catch(() => {});
  return id;
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
