/**
 * The microphone's audio, as 16 kHz mono, straight to the voice worker (the port it's handed):
 * batches of 2048 samples (128 ms), resampled here if the audio context runs at another rate.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new () => unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const TARGET = 16_000;
const BATCH = 2048;

class SpeechCapture extends AudioWorkletProcessor {
  private out: MessagePort | null = null;
  private buf = new Float32Array(BATCH);
  private n = 0;
  /** Resampling: input samples per output sample, and where the next output falls. */
  private readonly step = sampleRate / TARGET;
  private pos = 0;
  private last = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{port?: MessagePort}>) => {
      if (e.data.port) this.out = e.data.port;
    };
  }

  private emit(v: number) {
    this.buf[this.n++] = v;
    if (this.n === BATCH) {
      this.out?.postMessage(this.buf, [this.buf.buffer]);
      this.buf = new Float32Array(BATCH);
      this.n = 0;
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (this.step === 1) {
      for (const v of input) this.emit(v);
      return true;
    }
    // Linear interpolation between the samples either side (the capture is already band-limited enough for speech).
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      this.emit(i === 0 && frac === 0 ? a : a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= input.length;
    this.last = input[input.length - 1];
    return true;
  }
}

registerProcessor('speech-capture', SpeechCapture);
