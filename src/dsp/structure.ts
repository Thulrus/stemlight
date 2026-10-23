import { N_MELS, type Features } from './features';

/**
 * Bar-synchronous feature vectors: mean chroma (12) and a coarse, per-song
 * z-scored timbre profile (16 mel groups) plus loudness, each block L2-normalized.
 */
export function barFeatures(f: Features, barFrames: number[]): Float64Array[] {
  const groups = 16;
  const perGroup = N_MELS / groups;
  const raw: Float64Array[] = [];
  for (let b = 0; b < barFrames.length; b++) {
    const a = barFrames[b];
    const z = b + 1 < barFrames.length ? barFrames[b + 1] : f.nFrames;
    const v = new Float64Array(12 + groups + 1);
    const len = Math.max(1, z - a);
    for (let t = a; t < z; t++) {
      for (let p = 0; p < 12; p++) v[p] += f.chroma[t * 12 + p] / len;
      for (let g = 0; g < groups; g++) {
        let acc = 0;
        for (let m = 0; m < perGroup; m++) acc += f.melDb[t * N_MELS + g * perGroup + m];
        v[12 + g] += acc / perGroup / len;
      }
      v[12 + groups] += (20 * Math.log10(f.rms[t] + 1e-6)) / len;
    }
    raw.push(v);
  }
  // z-score the timbre/loudness dims across the song so they compare like chroma does.
  for (let d = 12; d < 12 + groups + 1; d++) {
    const vals = raw.map((v) => v[d]);
    const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length)) || 1;
    for (const v of raw) v[d] = (v[d] - mean) / std;
  }
  return raw.map((v) => {
    const out = new Float64Array(v.length);
    const cn = Math.hypot(...v.subarray(0, 12)) || 1;
    const tn = Math.hypot(...v.subarray(12)) || 1;
    for (let i = 0; i < 12; i++) out[i] = v[i] / cn / Math.SQRT2;
    for (let i = 12; i < v.length; i++) out[i] = v[i] / tn / Math.SQRT2;
    return out;
  });
}

const cosine = (a: Float64Array, b: Float64Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
};

/** Self-similarity matrix of time-delay-embedded features (`embed` consecutive bars). */
export function selfSimilarity(feats: Float64Array[], embed = 2): Float64Array[] {
  const n = feats.length;
  const stacked = feats.map((_, i) => {
    const parts: number[] = [];
    for (let k = 0; k < embed; k++) parts.push(...(feats[Math.min(n - 1, i + k)] ?? []));
    return Float64Array.from(parts);
  });
  return stacked.map((a) => Float64Array.from(stacked, (b) => cosine(a, b)));
}

/** Foote novelty: correlate a Gaussian-tapered checkerboard kernel along the SSM diagonal. */
export function noveltyCurve(ssm: Float64Array[], halfWidth: number): Float64Array {
  const n = ssm.length;
  const out = new Float64Array(n);
  const sigma = halfWidth / 2;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let u = -halfWidth; u < halfWidth; u++) {
      for (let v = -halfWidth; v < halfWidth; v++) {
        const a = i + u, b = i + v;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const sign = (u < 0) === (v < 0) ? 1 : -1;
        const g = Math.exp(-((u + 0.5) ** 2 + (v + 0.5) ** 2) / (2 * sigma * sigma));
        acc += sign * g * ssm[a][b];
      }
    }
    out[i] = Math.max(0, acc);
  }
  return out;
}

/** Peaks of the novelty curve at least `minGap` bars apart, strongest first, above an adaptive threshold. */
export function pickBoundaries(nov: Float64Array, minGap: number, sensitivity: number): number[] {
  const n = nov.length;
  const mean = nov.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const std = Math.sqrt(nov.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n));
  const thr = mean + (1 - 2 * sensitivity) * std;
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) if (nov[i] >= nov[i - 1] && nov[i] > nov[i + 1] && nov[i] > thr) peaks.push(i);
  peaks.sort((a, b) => nov[b] - nov[a]);
  const chosen: number[] = [];
  for (const p of peaks) {
    if (p < minGap || p > n - minGap) continue;
    if (chosen.every((c) => Math.abs(c - p) >= minGap)) chosen.push(p);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Label segments A, B, C... by repetition: segments whose mean similarity
 * (the SSM block between them, compared along matched offsets) exceeds `threshold`
 * share a letter.
 */
export function labelSegments(ssm: Float64Array[], bounds: number[], threshold = 0.6): string[] {
  const segs = bounds.slice(0, -1).map((a, i) => [a, bounds[i + 1]] as const);
  const sim = (i: number, j: number) => {
    const [a0, a1] = segs[i];
    const [b0, b1] = segs[j];
    const len = Math.min(a1 - a0, b1 - b0);
    // Allow small offsets so a segment that starts a bar late still matches.
    let best = -1;
    for (let off = -1; off <= 1; off++) {
      let acc = 0, cnt = 0;
      for (let k = 0; k < len; k++) {
        const x = a0 + k, y = b0 + k + off;
        if (y < b0 || y >= b1) continue;
        acc += ssm[x][y]; cnt++;
      }
      if (cnt) best = Math.max(best, acc / cnt);
    }
    // Penalize big length mismatches.
    const ratio = len / Math.max(a1 - a0, b1 - b0);
    return best * (0.7 + 0.3 * ratio);
  };
  const labels: string[] = [];
  const letters: number[] = [];
  let next = 0;
  for (let i = 0; i < segs.length; i++) {
    let bestJ = -1, bestS = threshold;
    for (let j = 0; j < i; j++) {
      const s = sim(i, j);
      if (s > bestS) { bestS = s; bestJ = j; }
    }
    letters[i] = bestJ >= 0 ? letters[bestJ] : next++;
    labels.push(letterName(letters[i]));
  }
  return labels;
}

const letterName = (i: number): string =>
  i < 26 ? String.fromCharCode(65 + i) : letterName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));

/**
 * Coarse role guess per segment from letters and loudness: the first/last unique
 * low-energy segments are intro/outro, the loudest repeated letter is the chorus,
 * other repeated letters are verses, and one-off segments are bridges.
 */
export function guessRoles(letters: string[], loudness: number[]): string[] {
  const n = letters.length;
  const count = new Map<string, number>();
  const loud = new Map<string, number[]>();
  letters.forEach((l, i) => {
    count.set(l, (count.get(l) ?? 0) + 1);
    loud.set(l, [...(loud.get(l) ?? []), loudness[i]]);
  });
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const songMean = avg(loudness);
  const repeated = [...count.entries()].filter(([, c]) => c > 1).map(([l]) => l);
  const chorus = repeated.sort((a, b) => avg(loud.get(b)!) - avg(loud.get(a)!))[0];
  return letters.map((l, i) => {
    const unique = count.get(l) === 1;
    if (i === 0 && unique && loudness[i] <= songMean) return 'intro';
    if (i === n - 1 && n > 1 && unique) return 'outro';
    if (l === chorus) return 'chorus';
    if (!unique) return 'verse';
    return 'bridge';
  });
}

/**
 * Energy rise/drop points: bars where the mean loudness of the next `span` bars
 * differs from the previous `span` bars by more than `thresholdDb`.
 */
export function energyChanges(barLoudnessDb: number[], span = 2, thresholdDb = 4): { bar: number; kind: 'rise' | 'drop'; amount: number }[] {
  const n = barLoudnessDb.length;
  const diff = new Float64Array(n);
  for (let i = span; i <= n - span; i++) {
    let before = 0, after = 0;
    for (let k = 0; k < span; k++) { before += barLoudnessDb[i - 1 - k]; after += barLoudnessDb[i + k]; }
    diff[i] = (after - before) / span;
  }
  const out: { bar: number; kind: 'rise' | 'drop'; amount: number }[] = [];
  for (let i = span; i <= n - span; i++) {
    const d = diff[i];
    if (Math.abs(d) < thresholdDb) continue;
    const isPeak = Math.abs(d) >= Math.abs(diff[i - 1] ?? 0) && Math.abs(d) > Math.abs(diff[i + 1] ?? 0);
    if (isPeak) out.push({ bar: i, kind: d > 0 ? 'rise' : 'drop', amount: d });
  }
  return out;
}
