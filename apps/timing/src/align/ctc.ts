/**
 * CTC forced alignment: given per-frame log-probabilities from a CTC acoustic model and the
 * token sequence that was sung, find the most likely frame for every token (Viterbi over the
 * usual blank-interleaved CTC topology, as in torchaudio's forced_align).
 */

/** Per-frame log-probabilities, row-major [frame * vocab + token]. */
export type Emissions = { logp: Float32Array; frames: number; vocab: number; /** seconds per frame */ frameSec: number; /** time of frame 0's center */ offsetSec: number };

/** One aligned token: the frames it occupies (inclusive start, exclusive end). */
export type TokenSpan = { token: number; start: number; end: number; /** mean log-prob over its frames */ score: number };

/**
 * Optional per-token frame windows, e.g. from approximate word times: token i may only be
 * emitted in [lo[i], hi[i]). Outside its window a token's emission scores −∞, so the
 * alignment can't wander across a long instrumental gap to a wrong repeat of the chorus.
 */
export type TokenWindows = { lo: Int32Array; hi: Int32Array };

const NEG = -1e30;

/**
 * Viterbi forced alignment. `tokens` must not contain the blank. Returns one span per token,
 * in order; a token occupies at least one frame. Memory is one byte per (frame, state).
 */
export function forcedAlign(em: Emissions, tokens: ArrayLike<number>, blank = 0, windows?: TokenWindows): TokenSpan[] {
  const T = em.frames;
  const V = em.vocab;
  const N = tokens.length;
  if (N === 0) return [];
  const S = 2 * N + 1;
  if (T < N) throw new Error(`Not enough frames (${T}) for ${N} tokens`);
  const tok = (s: number) => (s & 1 ? tokens[(s - 1) >> 1] : blank);
  // back[t * S + s]: 0 = stayed in s, 1 = came from s−1, 2 = came from s−2.
  const back = new Uint8Array(T * S);
  let prev = new Float64Array(S).fill(NEG);
  let cur = new Float64Array(S).fill(NEG);
  const allowed = (s: number, t: number) => {
    if (!windows || !(s & 1)) return true;
    const i = (s - 1) >> 1;
    return t >= windows.lo[i] && t < windows.hi[i];
  };
  prev[0] = em.logp[blank];
  if (allowed(1, 0)) prev[1] = em.logp[tokens[0]];
  for (let t = 1; t < T; t++) {
    const row = t * V;
    // Only states reachable by frame t that can still finish by the last frame.
    const sLo = Math.max(0, S - 2 * (T - t) - 1);
    const sHi = Math.min(S - 1, 2 * t + 1);
    cur.fill(NEG);
    for (let s = sLo; s <= sHi; s++) {
      let best = prev[s];
      let from = 0;
      if (s >= 1 && prev[s - 1] > best) { best = prev[s - 1]; from = 1; }
      // Skip the blank between two different tokens.
      if (s >= 2 && s & 1 && tok(s) !== tok(s - 2) && prev[s - 2] > best) { best = prev[s - 2]; from = 2; }
      if (best <= NEG / 2 || !allowed(s, t)) continue;
      cur[s] = best + em.logp[row + tok(s)];
      back[t * S + s] = from;
    }
    [prev, cur] = [cur, prev];
  }
  let s = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  if (prev[s] <= NEG / 2) throw new Error('No alignment fits the token windows');
  // Backtrack, recording the frames each token state occupies.
  const start = new Int32Array(N).fill(-1);
  const end = new Int32Array(N).fill(-1);
  const sum = new Float64Array(N);
  for (let t = T - 1; t >= 0; t--) {
    if (s & 1) {
      const i = (s - 1) >> 1;
      if (end[i] < 0) end[i] = t + 1;
      start[i] = t;
      sum[i] += em.logp[t * V + tokens[i]];
    }
    if (t > 0) s -= back[t * S + s];
  }
  return Array.from({ length: N }, (_, i) => ({ token: tokens[i], start: start[i], end: end[i], score: sum[i] / Math.max(1, end[i] - start[i]) }));
}

/** In-place log-softmax of each frame's logits. */
export function logSoftmax(logits: Float32Array, vocab: number): Float32Array {
  for (let o = 0; o < logits.length; o += vocab) {
    let m = -Infinity;
    for (let k = 0; k < vocab; k++) m = Math.max(m, logits[o + k]);
    let z = 0;
    for (let k = 0; k < vocab; k++) z += Math.exp(logits[o + k] - m);
    const lz = m + Math.log(z);
    for (let k = 0; k < vocab; k++) logits[o + k] -= lz;
  }
  return logits;
}

export const frameTime = (em: Emissions, frame: number) => em.offsetSec + frame * em.frameSec;

/**
 * Combine emissions of the same song from two sources (e.g. all vocals and the lead vocal
 * alone) by averaging their probabilities, weighted by `w` for `a`. A letter clearly heard in
 * either source stays likely, so lyrics sung by a second voice still align, while the lead
 * alone keeps backing vocals from blurring the lead's letters. Frames must line up.
 */
export function fuseEmissions(a: Emissions, b: Emissions, w = 0.5): Emissions {
  const n = Math.min(a.frames, b.frames) * a.vocab;
  const logp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = a.logp[i], y = b.logp[i];
    const m = Math.max(x, y);
    logp[i] = m + Math.log(w * Math.exp(x - m) + (1 - w) * Math.exp(y - m));
  }
  return { ...a, frames: Math.min(a.frames, b.frames), logp };
}
