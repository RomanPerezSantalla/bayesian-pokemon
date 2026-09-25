/**
 * Where lines start and end, from the speech detector's verdict on every 32 ms of audio (Silero
 * VAD: the probability someone is talking). A line starts when it's sure (0.5), carries on through
 * anything that might be speech (0.35), and ends after a pause; it's cut after 12 s so a long
 * stretch still gets read, and a blip shorter than a word is dropped.
 */

export const FRAME = 512;
const START = 0.5;
const KEEP = 0.35;
const FRAMES_PER_S = 16_000 / FRAME;

export interface EndpointOptions {
  /** Silence that ends a line. */
  pauseMs: number;
  /** Audio kept from before the detector was sure (it's a little late). */
  beforeMs: number;
  /** And after the last speech. */
  afterMs: number;
  minMs: number;
  maxMs: number;
}

export const ENDPOINT: EndpointOptions = {pauseMs: 700, beforeMs: 300, afterMs: 250, minMs: 200, maxMs: 12_000};

export type EndpointEvent =
  | {kind: 'start'}
  /** A line: frames `from`–`to` (exclusive), counted from the first frame fed. */
  | {kind: 'end'; from: number; to: number};

const frames = (ms: number) => Math.round((ms / 1000) * FRAMES_PER_S);

export class Endpointer {
  private frame = 0;
  private start = -1;
  private lastSpeech = -1;
  private speechFrames = 0;
  private readonly o: {pause: number; before: number; after: number; min: number; max: number};

  constructor(opts: EndpointOptions = ENDPOINT) {
    this.o = {pause: frames(opts.pauseMs), before: frames(opts.beforeMs), after: frames(opts.afterMs), min: frames(opts.minMs), max: frames(opts.maxMs)};
  }

  get speaking() {
    return this.start >= 0;
  }

  /** The detector's verdict on the next frame. */
  push(prob: number): EndpointEvent[] {
    const t = this.frame++;
    const out: EndpointEvent[] = [];
    if (this.start < 0) {
      if (prob >= START) {
        this.start = Math.max(0, t - this.o.before);
        this.lastSpeech = t;
        this.speechFrames = 1;
        out.push({kind: 'start'});
      }
      return out;
    }
    if (prob >= KEEP) {
      this.lastSpeech = t;
      if (prob >= START) this.speechFrames++;
    }
    if (t - this.lastSpeech >= this.o.pause) out.push(...this.finish(this.lastSpeech + this.o.after + 1));
    else if (t + 1 - this.start >= this.o.max) out.push(...this.finish(t + 1));
    return out;
  }

  /** Ends the line now (listening stopped): what was said so far still counts. */
  flush(): EndpointEvent[] {
    return this.start >= 0 ? this.finish(Math.min(this.frame, this.lastSpeech + this.o.after + 1)) : [];
  }

  private finish(to: number): EndpointEvent[] {
    const from = this.start;
    const enough = this.speechFrames >= this.o.min;
    this.start = -1;
    this.speechFrames = 0;
    return enough ? [{kind: 'end', from, to: Math.min(to, this.frame)}] : [{kind: 'end', from, to: from}];
  }
}
