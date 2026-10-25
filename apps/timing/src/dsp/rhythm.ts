import { frameToTime, type Features } from './features';

export type OnsetParams = {
  /** 0..1, higher finds more onsets. */
  sensitivity: number;
  /** Minimum time between onsets, seconds. */
  minGap: number;
};

/** Peak-pick an onset envelope. Returns times in seconds with a 0..1 strength. */
export function pickOnsets(env: Float32Array, fps: number, p: OnsetParams): { time: number; strength: number }[] {
  const n = env.length;
  const w = Math.max(1, Math.round(0.03 * fps));
  const avgW = Math.round(0.1 * fps);
  // Threshold above the local mean: sensitivity 1 -> 0.1 std, sensitivity 0 -> 2.1 std.
  const delta = 0.1 + 2 * (1 - p.sensitivity);
  const minGapFrames = Math.max(1, Math.round(p.minGap * fps));
  let maxEnv = 0;
  for (let i = 0; i < n; i++) maxEnv = Math.max(maxEnv, env[i]);
  const out: { time: number; strength: number }[] = [];
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      if (env[j] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - avgW); j <= Math.min(n - 1, i + avgW); j++) { sum += env[j]; cnt++; }
    if (v < sum / cnt + delta) continue;
    if (i - last < minGapFrames) {
      // Keep the stronger of two onsets that are too close together.
      if (out.length && v > out[out.length - 1].strength * maxEnv) {
        out[out.length - 1] = { time: i / fps, strength: v / maxEnv };
        last = i;
      }
      continue;
    }
    out.push({ time: i / fps, strength: maxEnv ? v / maxEnv : 0 });
    last = i;
  }
  return out;
}

/**
 * Global tempo from the autocorrelation of the onset envelope, weighted by a
 * log-normal prior (one octave wide) around `priorBpm`.
 */
export function estimateTempo(env: Float32Array, fps: number, priorBpm = 120, minBpm = 50, maxBpm = 220): number {
  const n = env.length;
  const minLag = Math.floor((60 * fps) / maxBpm);
  const maxLag = Math.ceil((60 * fps) / minBpm);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += env[i] * env[i - lag];
    ac[lag] = acc / (n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / priorBpm) ** 2);
    // Reinforce with the 2x lag so a true beat beats one of its subdivisions.
    const score = (ac[lag] + 0.5 * (2 * lag <= maxLag ? ac[2 * lag] : 0)) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // Parabolic interpolation around the peak for sub-frame precision.
  const [a, b, c] = [ac[best - 1], ac[best], ac[best + 1]];
  const denom = a - 2 * b + c;
  const offset = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return (60 * fps) / (best + offset);
}

/**
 * Dynamic-programming beat tracker (Ellis 2007): beats sit on strong onsets while
 * keeping inter-beat intervals close to the tempo period. Returns beat frame indices.
 */
export function trackBeats(env: Float32Array, fps: number, bpm: number, tightness = 100): number[] {
  const n = env.length;
  const period = (60 * fps) / bpm;
  // Smooth the envelope with a Gaussian of width period/32 to form the local score.
  const sigma = period / 32;
  const radius = Math.ceil(4 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < n) acc += env[j] * kernel[k + radius];
    }
    local[i] = acc;
  }

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * period);
  const hi = Math.round(period / 2);
  const txCost = new Float64Array(lo - hi + 1);
  for (let d = hi; d <= lo; d++) txCost[d - hi] = -tightness * Math.log(d / period) ** 2;
  let localMax = 0;
  for (let i = 0; i < n; i++) localMax = Math.max(localMax, local[i]);
  let firstBeat = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = hi; d <= lo; d++) {
      const j = i - d;
      if (j < 0) break;
      const s = cum[j] + txCost[d - hi];
      if (s > best) { best = s; arg = j; }
    }
    cum[i] = local[i] + (arg >= 0 ? best : 0);
    back[i] = arg;
    // Don't let a beat chain start before the music does.
    if (firstBeat && local[i] < 0.01 * localMax) back[i] = -1;
    else firstBeat = false;
  }

  // Pick the last beat: the latest local maximum of cum that is reasonably strong.
  const maxima: number[] = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
  if (!maxima.length) return [];
  const vals = maxima.map((i) => cum[i]).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  let tail = maxima[maxima.length - 1];
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (cum[maxima[k]] >= 0.5 * median) { tail = maxima[k]; break; }
  }
  const beats: number[] = [];
  for (let i = tail; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  return trimWeakBeats(beats, local);
}

/** Drop leading/trailing beats in silence (local score below half the RMS of beat scores). */
function trimWeakBeats(beats: number[], local: Float64Array): number[] {
  if (beats.length < 3) return beats;
  let sq = 0;
  for (const b of beats) sq += local[b] ** 2;
  const thr = 0.5 * Math.sqrt(sq / beats.length);
  let a = 0;
  let z = beats.length;
  while (a < z && local[beats[a]] < thr) a++;
  while (z > a && local[beats[z - 1]] < thr) z--;
  return beats.slice(a, z);
}

/**
 * Downbeats with a 4-state HMM (position in bar). Each beat is scored by a
 * downbeat likelihood (harmonic change + low-band onset); the path must advance
 * one position per beat, with a penalty for restarting a bar early (irregular bars).
 * Returns the position in bar (0 = downbeat) for every beat.
 */
export function trackDownbeats(f: Features, beatFrames: number[], beatsPerBar = 4, restartPenalty = 3): number[] {
  const nb = beatFrames.length;
  if (nb === 0) return [];
  const obs = downbeatLikelihood(f, beatFrames);
  const S = beatsPerBar;
  const score = new Float64Array(nb * S);
  const back = new Int8Array(nb * S);
  const emit = (b: number, s: number) => (s === 0 ? obs[b] : -obs[b] / (S - 1));
  for (let s = 0; s < S; s++) score[s] = emit(0, s);
  for (let b = 1; b < nb; b++) {
    for (let s = 0; s < S; s++) {
      const regular = (s - 1 + S) % S;
      let best = score[(b - 1) * S + regular];
      let arg = regular;
      if (s === 0) {
        // A bar may restart early (e.g. a 2/4 bar), at a cost.
        for (let p = 0; p < S; p++) {
          if (p === regular) continue;
          const v = score[(b - 1) * S + p] - restartPenalty;
          if (v > best) { best = v; arg = p; }
        }
      }
      score[b * S + s] = best + emit(b, s);
      back[b * S + s] = arg;
    }
  }
  let s = 0;
  for (let k = 1; k < S; k++) if (score[(nb - 1) * S + k] > score[(nb - 1) * S + s]) s = k;
  const pos = new Array<number>(nb);
  for (let b = nb - 1; b >= 0; b--) {
    pos[b] = s;
    s = back[b * S + s];
  }
  return pos;
}

/** Per-beat z-scored evidence that the beat is a downbeat. */
function downbeatLikelihood(f: Features, beatFrames: number[]): Float64Array {
  const nb = beatFrames.length;
  const chromaAt = (b: number) => {
    const a = beatFrames[b];
    const z = b + 1 < nb ? beatFrames[b + 1] : Math.min(f.nFrames, a + (a - (beatFrames[b - 1] ?? a - 20)));
    const v = new Float64Array(12);
    for (let t = a; t < z; t++) for (let p = 0; p < 12; p++) v[p] += f.chroma[t * 12 + p];
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const chroma = beatFrames.map((_, b) => chromaAt(b));
  const harm = new Float64Array(nb);
  for (let b = 1; b < nb; b++) {
    let dot = 0;
    for (let p = 0; p < 12; p++) dot += chroma[b][p] * chroma[b - 1][p];
    harm[b] = 1 - dot;
  }
  const w = Math.max(1, Math.round(0.05 * f.fps));
  const low = beatFrames.map((t) => {
    let m = 0;
    for (let j = Math.max(0, t - w); j <= Math.min(f.nFrames - 1, t + w); j++) m = Math.max(m, f.onsetLow[j]);
    return m;
  });
  const z = (x: ArrayLike<number>) => {
    const arr = Array.from(x);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length) || 1;
    return arr.map((v) => (v - mean) / std);
  };
  const zh = z(harm);
  const zl = z(low);
  return Float64Array.from(zh, (v, i) => v + zl[i]);
}

export const beatTimes = (f: Features, frames: number[]) => frames.map((t) => frameToTime(f, t));
