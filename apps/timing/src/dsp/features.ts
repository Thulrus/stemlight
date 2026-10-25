import { FFT } from './fft';

/** Analysis runs on mono audio at this rate; the decoder resamples to it. */
export const ANALYSIS_SR = 22050;
export const N_FFT = 2048;
export const HOP = 256;
export const N_MELS = 64;
/** How early spectral flux peaks relative to the true attack with this window. */
const ONSET_LATENCY_SEC = 0.035;

/** Frame-level features shared by every extractor. Frames are HOP samples apart. */
export type Features = {
  sr: number;
  hop: number;
  fps: number;
  nFrames: number;
  duration: number;
  /** Log-mel spectrogram, row-major [frame * N_MELS + band], in dB. */
  melDb: Float32Array;
  /** Chroma, row-major [frame * 12 + pitchClass], each frame L2-normalized. */
  chroma: Float32Array;
  /** RMS per frame (linear), over the full analysis window. */
  rms: Float32Array;
  /** RMS per frame over a short centered window (~23 ms), for precise span edges. */
  rmsShort: Float32Array;
  /** Full-band onset strength (spectral flux on log-mel), z-normalized. */
  onset: Float32Array;
  /** Low-band (< ~150 Hz) onset strength, z-normalized. Kick/bass cue for downbeats. */
  onsetLow: Float32Array;
  /** Center frequency (Hz) of each mel band. */
  melCenters: Float32Array;
};

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filterbank as sparse [bin, weight] lists, one per band. */
function melFilterbank(sr: number, nFft: number, nMels: number, fMin = 30, fMax = sr / 2) {
  const nBins = nFft / 2 + 1;
  const mMin = hzToMel(fMin);
  const mMax = hzToMel(fMax);
  const edges = Array.from({ length: nMels + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1)));
  const binHz = sr / nFft;
  const bands: { bins: number[]; weights: number[]; centerHz: number }[] = [];
  for (let m = 0; m < nMels; m++) {
    const [lo, c, hi] = [edges[m], edges[m + 1], edges[m + 2]];
    const bins: number[] = [];
    const weights: number[] = [];
    for (let k = 0; k < nBins; k++) {
      const f = k * binHz;
      const w = f <= lo || f >= hi ? 0 : f <= c ? (f - lo) / (c - lo) : (hi - f) / (hi - c);
      if (w > 0) { bins.push(k); weights.push(w); }
    }
    // Low bands can be narrower than one bin; fall back to the nearest bin.
    if (bins.length === 0) { bins.push(Math.round(c / binHz)); weights.push(1); }
    bands.push({ bins, weights, centerHz: c });
  }
  return bands;
}

/** Subtract a centered moving average, half-wave rectify, then scale to unit std. */
function normalizeEnvelope(x: Float32Array, halfWin: number): Float32Array {
  const n = x.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWin);
    const b = Math.min(n, i + halfWin + 1);
    out[i] = Math.max(0, x[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  let sq = 0;
  for (let i = 0; i < n; i++) sq += out[i] * out[i];
  const std = Math.sqrt(sq / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= std;
  return out;
}

export type ProgressFn = (fraction: number) => void;

/** Compute all frame-level features from mono audio at `sr` (expected ANALYSIS_SR). */
export function computeFeatures(samples: Float32Array, sr: number, onProgress?: ProgressFn): Features {
  const nFrames = Math.max(1, Math.floor((samples.length - 1) / HOP) + 1);
  const fps = sr / HOP;
  const fft = new FFT(N_FFT);
  const window = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const bands = melFilterbank(sr, N_FFT, N_MELS);

  // Chroma maps 55 Hz .. 5 kHz bins to pitch classes (A = 0 shifted so C = 0).
  const nBins = N_FFT / 2 + 1;
  const chromaOf = new Int8Array(nBins).fill(-1);
  for (let k = 1; k < nBins; k++) {
    const f = (k * sr) / N_FFT;
    if (f < 55 || f > 5000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    chromaOf[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const melDb = new Float32Array(nFrames * N_MELS);
  const chroma = new Float32Array(nFrames * 12);
  const rms = new Float32Array(nFrames);
  const rmsShort = new Float32Array(nFrames);
  const SHORT = 512;
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(nBins);
  const half = N_FFT / 2;

  for (let t = 0; t < nFrames; t++) {
    const center = t * HOP;
    let energy = 0;
    for (let i = 0; i < N_FFT; i++) {
      const idx = center - half + i;
      const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
      re[i] = s * window[i];
      im[i] = 0;
      energy += s * s;
    }
    rms[t] = Math.sqrt(energy / N_FFT);
    let short = 0;
    for (let i = center - SHORT / 2; i < center + SHORT / 2; i++) {
      const v = i >= 0 && i < samples.length ? samples[i] : 0;
      short += v * v;
    }
    rmsShort[t] = Math.sqrt(short / SHORT);
    fft.transform(re, im);
    for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    for (let m = 0; m < N_MELS; m++) {
      const { bins, weights } = bands[m];
      let acc = 0;
      for (let j = 0; j < bins.length; j++) acc += power[bins[j]] * weights[j];
      melDb[t * N_MELS + m] = 10 * Math.log10(acc + 1e-10);
    }
    let norm = 0;
    const c0 = t * 12;
    for (let k = 0; k < nBins; k++) {
      const pc = chromaOf[k];
      if (pc >= 0) chroma[c0 + pc] += power[k];
    }
    for (let p = 0; p < 12; p++) norm += chroma[c0 + p] * chroma[c0 + p];
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) chroma[c0 + p] /= norm;

    if (onProgress && t % 2000 === 0) onProgress(t / nFrames);
  }

  // Clamp the dynamic range per song so near-silence doesn't dominate the flux.
  let maxDb = -Infinity;
  for (let i = 0; i < melDb.length; i++) if (melDb[i] > maxDb) maxDb = melDb[i];
  for (let i = 0; i < melDb.length; i++) melDb[i] = Math.max(melDb[i], maxDb - 80);

  const f: Features = {
    sr,
    hop: HOP,
    fps,
    nFrames,
    duration: samples.length / sr,
    melDb,
    chroma,
    rms,
    rmsShort,
    onset: new Float32Array(0),
    onsetLow: new Float32Array(0),
    melCenters: Float32Array.from(bands, (b) => b.centerHz),
  };
  f.onset = bandOnset(f, 0, Infinity);
  f.onsetLow = bandOnset(f, 0, 150);
  onProgress?.(1);
  return f;
}

/**
 * Onset strength from the mel bands centered in [loHz, hiHz): positive spectral flux on
 * the log-mel spectrogram, latency-compensated, local mean removed, scaled to unit RMS.
 */
export function bandOnset(f: Features, loHz: number, hiHz: number): Float32Array {
  const bands: number[] = [];
  f.melCenters.forEach((c, i) => { if (c >= loHz && c < hiHz) bands.push(i); });
  const { nFrames, melDb } = f;
  // A centered 2048-sample window starts registering an attack ~35 ms before its center
  // reaches it, so flux peaks early. Write each value later to compensate (calibrated
  // against synthetic attacks in tests/synthetic.test.ts).
  const lag = Math.round(ONSET_LATENCY_SEC * f.fps);
  const flux = new Float32Array(nFrames);
  for (let t = 1; t + lag < nFrames; t++) {
    let acc = 0;
    for (const m of bands) {
      const d = melDb[t * N_MELS + m] - melDb[(t - 1) * N_MELS + m];
      if (d > 0) acc += d;
    }
    flux[t + lag] = acc / Math.max(1, bands.length);
  }
  return normalizeEnvelope(flux, Math.round(0.25 * f.fps));
}

/** Time in seconds of frame `t`'s center. */
export const frameToTime = (f: Features, t: number) => (t * f.hop) / f.sr;
