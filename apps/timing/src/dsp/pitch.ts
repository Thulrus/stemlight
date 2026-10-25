/** Lowpass (windowed sinc) and keep every `factor`-th sample. */
export function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor === 1) return x;
  const n = 16 * factor + 1;
  const mid = (n - 1) / 2;
  const fc = 0.45 / factor;
  const taps = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = i - mid;
    const sinc = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
    taps[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
    sum += taps[i];
  }
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let j = 0; j < out.length; j++) {
    let acc = 0;
    const c = j * factor;
    for (let k = 0; k < n; k++) {
      const i = c + k - mid;
      if (i >= 0 && i < x.length) acc += taps[k] * x[i];
    }
    out[j] = acc / sum;
  }
  return out;
}

export type PitchTrack = {
  /** Frame rate (frames per second). */
  fps: number;
  /** Fundamental in Hz per frame, 0 where unvoiced. */
  f0: Float32Array;
  /** YIN aperiodicity per frame (0 = perfectly periodic). */
  aperiodicity: Float32Array;
  /** Time of frame 0's center; frame t is at offsetSec + t / fps. */
  offsetSec: number;
};

/**
 * YIN pitch tracker (de Cheveigné & Kawahara 2002) with cumulative-mean-normalized
 * difference, absolute threshold and parabolic refinement.
 */
export function yin(x: Float32Array, sr: number, opts: { fMin: number; fMax: number; hopSec: number; threshold: number }): PitchTrack {
  const tauMin = Math.max(2, Math.floor(sr / opts.fMax));
  const tauMax = Math.ceil(sr / opts.fMin);
  const w = tauMax; // integration window = longest period
  const hop = Math.max(1, Math.round(opts.hopSec * sr));
  const nFrames = Math.max(0, Math.floor((x.length - w - tauMax) / hop) + 1);
  const f0 = new Float32Array(nFrames);
  const ap = new Float32Array(nFrames).fill(1);
  const d = new Float64Array(tauMax + 1);
  for (let t = 0; t < nFrames; t++) {
    const s = t * hop;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let j = 0; j < w; j++) {
        const diff = x[s + j] - x[s + j + tau];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    // Cumulative mean normalized difference.
    let run = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < opts.threshold) {
        while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) continue;
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const denom = a - 2 * b + c;
    const refined = denom ? best + (0.5 * (a - c)) / denom : best;
    f0[t] = sr / refined;
    ap[t] = b;
  }
  // Each frame spans w + tauMax samples; report it at the center of that span.
  return { fps: sr / hop, f0, aperiodicity: ap, offsetSec: (w + tauMax) / 2 / sr };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
