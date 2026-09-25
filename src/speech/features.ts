/**
 * What the speech model reads: the log-mel spectrogram NeMo computes for Parakeet
 * (AudioToMelSpectrogramPreprocessor): 16 kHz audio, pre-emphasis 0.97, 25 ms Hann windows every
 * 10 ms (a 512-point FFT, centred, zero-padded), power spectrum, 80 Slaney mel bands (0–8 kHz),
 * ln(x + 2⁻²⁴), then each band normalised to mean 0 and standard deviation 1 over the clip.
 */

export const SAMPLE_RATE = 16_000;
export const MELS = 80;
const N_FFT = 512;
const WIN = 400;
const HOP = 160;
const BINS = N_FFT / 2 + 1;

const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp(((m - 15) * Math.log(6.4)) / 27));

/** librosa.filters.mel(sr=16000, n_fft=512, n_mels=80), Slaney-normalised: each band's first bin and weights. */
const FILTERS = (() => {
  const top = hzToMel(SAMPLE_RATE / 2);
  const edges = Array.from({length: MELS + 2}, (_, i) => melToHz((top * i) / (MELS + 1)));
  return Array.from({length: MELS}, (_, m) => {
    const norm = 2 / (edges[m + 2] - edges[m]);
    const w: number[] = [];
    let first = -1;
    for (let k = 0; k < BINS; k++) {
      const f = (k * SAMPLE_RATE) / N_FFT;
      const v = Math.max(0, Math.min((f - edges[m]) / (edges[m + 1] - edges[m]), (edges[m + 2] - f) / (edges[m + 2] - edges[m + 1])));
      if (v > 0) {
        if (first < 0) first = k;
        w[k - first] = v * norm;
      } else if (first >= 0) break;
    }
    return {first: Math.max(first, 0), weights: Float64Array.from(w)};
  });
})();

/** torch.hann_window(400, periodic=False), centred in the 512-point frame as torch.stft pads it. */
const WINDOW = (() => {
  const w = new Float64Array(N_FFT);
  const off = (N_FFT - WIN) >> 1;
  for (let n = 0; n < WIN; n++) w[off + n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (WIN - 1));
  return w;
})();

const TWIDDLE = (() => {
  const c = new Float64Array(N_FFT / 2);
  const s = new Float64Array(N_FFT / 2);
  for (let k = 0; k < N_FFT / 2; k++) {
    c[k] = Math.cos((-2 * Math.PI * k) / N_FFT);
    s[k] = Math.sin((-2 * Math.PI * k) / N_FFT);
  }
  return {c, s};
})();

/** In-place radix-2 FFT of N_FFT points. */
function fft(re: Float64Array, im: Float64Array) {
  const n = N_FFT;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = TWIDDLE.c[j * step];
        const wi = TWIDDLE.s[j * step];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

export interface Features {
  /** [MELS × frames], band-major (the model's [1, 80, T] input). */
  data: Float32Array;
  frames: number;
}

/** The model's input for 16 kHz mono samples in [-1, 1]. */
export function melFeatures(samples: Float32Array): Features {
  const n = samples.length;
  const frames = Math.floor(n / HOP) + 1;
  const pad = N_FFT / 2;
  const data = new Float32Array(MELS * frames);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  const pre = (i: number) => (i <= 0 ? (i === 0 ? samples[0] : 0) : i < n ? samples[i] - 0.97 * samples[i - 1] : 0);
  for (let t = 0; t < frames; t++) {
    const at = t * HOP - pad;
    for (let k = 0; k < N_FFT; k++) {
      re[k] = pre(at + k) * WINDOW[k];
      im[k] = 0;
    }
    fft(re, im);
    for (let k = 0; k < BINS; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < MELS; m++) {
      const {first, weights} = FILTERS[m];
      let s = 0;
      for (let k = 0; k < weights.length; k++) s += weights[k] * power[first + k];
      data[m * frames + t] = Math.log(s + 2 ** -24);
    }
  }
  for (let m = 0; m < MELS; m++) {
    const row = data.subarray(m * frames, (m + 1) * frames);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= frames;
    let sq = 0;
    for (const v of row) sq += (v - mean) ** 2;
    const sd = Math.sqrt(sq / Math.max(1, frames - 1)) + 1e-5;
    for (let t = 0; t < frames; t++) row[t] = (row[t] - mean) / sd;
  }
  return {data, frames};
}
