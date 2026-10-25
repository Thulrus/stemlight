import { KEYS, MIDI_OFFSET, type PitchFrames } from './basicPitch';

/** A note of one musical part. Times in seconds. */
export type PartNote = { start: number; end: number; midi: number; /** mean note probability */ amp: number };

export const DEFAULT_MELODY_PARAMS = {
  /** Note probability (Basic Pitch) above which a frame counts as sounding. */
  voicing: 0.3,
  /** Cost of changing note, in log-probability; higher ignores vibrato and scoops. */
  changeCost: 2,
  /** Shortest note (s); shorter pitch excursions stay with the note around them. */
  minNote: 0.09,
  /**
   * Onset probability at the sounding key that marks a re-sung syllable on the same pitch.
   * (Dips in level are no use for this: vibrato and breathy singing dip as deeply.)
   */
  reattack: 0.7,
  /** Gaps shorter than this (s) between notes are closed: the earlier note runs to the next. */
  legato: 0.2,
};

export type MelodyParams = typeof DEFAULT_MELODY_PARAMS;

/**
 * The single line a part sings or plays, as notes. Per frame, the most likely pitch is decoded
 * with a Viterbi path over the 88 keys plus "silent", where changing note costs `changeCost`
 * (so vibrato, scoops and octave blips don't split notes). Notes split where the path changes
 * key, and within a held key where the note model hears it start again (a new syllable or
 * stroke on the same pitch).
 *
 * `levelDb(t)` gives the part's level at song time t, and `gateDb` the level below which it
 * counts as silent (separated stems always carry some bleed).
 */
export function melodyNotes(f: PitchFrames, levelDb: (t: number) => number, gateDb: number, p: MelodyParams = DEFAULT_MELODY_PARAMS): PartNote[] {
  const T = f.times.length;
  if (!T) return [];
  const fps = T > 1 ? (T - 1) / (f.times[T - 1] - f.times[0]) : 86;
  const level = Float32Array.from(f.times, (t) => levelDb(t));
  const path = viterbi(f, level, gateDb, p);

  // Runs of one key (or silence), with short runs folded into their neighbours.
  type Run = { a: number; b: number; k: number };
  let runs: Run[] = [];
  for (let t = 0; t < T; t++) {
    const last = runs[runs.length - 1];
    if (last && last.k === path[t]) last.b = t + 1;
    else runs.push({ a: t, b: t + 1, k: path[t] });
  }
  const minLen = Math.max(1, Math.round(p.minNote * fps));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.k < 0 || r.b - r.a >= minLen) continue;
      // A short voiced run joins the longer voiced neighbour it touches.
      const prev = runs[i - 1], next = runs[i + 1];
      const cand = [prev, next].filter((x) => x && x.k >= 0) as Run[];
      if (!cand.length) { r.k = -1; changed = true; continue; }
      const into = cand.sort((x, y) => (y.b - y.a) - (x.b - x.a))[0];
      r.k = into.k;
      changed = true;
    }
    if (changed) {
      const merged: Run[] = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && last.k === r.k) last.b = r.b;
        else merged.push({ ...r });
      }
      runs = merged;
    }
  }

  // Split held notes at re-attacks.
  const notes: PartNote[] = [];
  const onsetAt = (t: number, k: number) => {
    let m = 0;
    for (let dk = -1; dk <= 1; dk++) if (k + dk >= 0 && k + dk < KEYS) m = Math.max(m, f.onset[t * KEYS + k + dk]);
    return m;
  };
  for (const r of runs) {
    if (r.k < 0) continue;
    const cuts = [r.a];
    for (let t = r.a + minLen; t < r.b - minLen; t++) {
      const last = cuts[cuts.length - 1];
      if (t - last < minLen) continue;
      const o = onsetAt(t, r.k);
      if (o >= p.reattack && o >= onsetAt(t - 1, r.k) && o > onsetAt(t + 1, r.k)) cuts.push(t);
    }
    cuts.push(r.b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      let amp = 0;
      for (let t = cuts[i]; t < cuts[i + 1]; t++) amp += f.note[t * KEYS + r.k];
      notes.push({ start: f.times[cuts[i]], end: f.times[Math.min(T - 1, cuts[i + 1])], midi: r.k + MIDI_OFFSET, amp: amp / (cuts[i + 1] - cuts[i]) });
    }
  }
  for (let i = 0; i + 1 < notes.length; i++) {
    if (notes[i + 1].start - notes[i].end < p.legato) notes[i].end = notes[i + 1].start;
  }
  return notes;
}

/** Most likely key per frame (-1 = silent), changing key at a cost. */
function viterbi(f: PitchFrames, level: Float32Array, gateDb: number, p: MelodyParams): Int16Array {
  const T = f.times.length;
  const S = KEYS + 1; // last state = silent
  const SIL = KEYS;
  const floor = 1e-3;
  const silentScore = Math.log(p.voicing);
  let prev = new Float64Array(S);
  let cur = new Float64Array(S);
  const back = new Int16Array(T * S);
  const emit = (t: number, s: number) => {
    if (s === SIL) return silentScore;
    if (level[t] < gateDb) return Math.log(floor);
    return Math.log(Math.max(floor, f.note[t * KEYS + s]));
  };
  for (let s = 0; s < S; s++) prev[s] = emit(0, s);
  const leave = p.changeCost;
  const voice = p.changeCost / 2;
  for (let t = 1; t < T; t++) {
    // Best previous voiced state, for "change key" transitions (a small extra cost per semitone).
    let best1 = -Infinity, arg1 = 0, best2 = -Infinity, arg2 = 0;
    for (let s = 0; s < KEYS; s++) {
      const v = prev[s];
      if (v > best1) { best2 = best1; arg2 = arg1; best1 = v; arg1 = s; }
      else if (v > best2) { best2 = v; arg2 = s; }
    }
    for (let s = 0; s < S; s++) {
      let bv = prev[s], bs = s; // stay
      if (s === SIL) {
        if (best1 - voice > bv) { bv = best1 - voice; bs = arg1; }
      } else {
        if (prev[SIL] - voice > bv) { bv = prev[SIL] - voice; bs = SIL; }
        const o = arg1 !== s ? arg1 : arg2;
        const ov = arg1 !== s ? best1 : best2;
        if (ov - leave > bv) { bv = ov - leave; bs = o; }
      }
      cur[s] = bv + emit(t, s);
      back[t * S + s] = bs;
    }
    [prev, cur] = [cur, prev];
  }
  const path = new Int16Array(T);
  let s = 0;
  for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s === SIL ? -1 : s;
    s = back[t * S + s];
  }
  return path;
}
