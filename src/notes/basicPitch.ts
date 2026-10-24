import type { InferenceSession, Tensor } from 'onnxruntime-web';

/**
 * Basic Pitch (Spotify, Apache-2.0; https://github.com/spotify/basic-pitch): a small polyphonic
 * note model. It hears 22.05 kHz mono in ~2 s windows and gives, per frame and piano key, the
 * probability that a note sounds ("note") and that one starts ("onset"). Windowing follows the
 * reference run_inference(): 30 overlapping frames, half dropped at each window edge.
 */
export const BP_SR = 22050;
const HOP = 256;
const WINDOW = 43844; // AUDIO_N_SAMPLES
const FRAMES_PER_WINDOW = 172;
const OVERLAP_FRAMES = 30;
const OVERLAP = OVERLAP_FRAMES * HOP;
const STEP = WINDOW - OVERLAP;
const KEEP = FRAMES_PER_WINDOW - OVERLAP_FRAMES;
export const KEYS = 88;
/** MIDI note of key 0 (A0). */
export const MIDI_OFFSET = 21;

export type PitchFrames = {
  /** [frame * 88 + key] probabilities. */
  note: Float32Array;
  onset: Float32Array;
  /** Song time (s) of each frame; frames aren't exactly evenly spaced across windows. */
  times: Float32Array;
};

type TensorCtor = new (type: 'float32', data: Float32Array, dims: readonly number[]) => Tensor;

export async function basicPitchFrames(
  session: InferenceSession,
  TensorClass: TensorCtor,
  audio: Float32Array,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<PitchFrames> {
  const pad = OVERLAP / 2;
  const total = Math.ceil((audio.length + pad) / STEP);
  const note = new Float32Array(total * KEEP * KEYS);
  const onset = new Float32Array(total * KEEP * KEYS);
  const times = new Float32Array(total * KEEP);
  const [inName] = session.inputNames;
  for (let w = 0; w < total; w++) {
    if (shouldCancel?.()) throw new Error('cancelled');
    const start = w * STEP - pad; // in song samples
    const x = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      const k = start + i;
      if (k >= 0 && k < audio.length) x[i] = audio[k];
    }
    const out = await session.run({ [inName]: new TensorClass('float32', x, [1, WINDOW, 1]) });
    const n = (await out['StatefulPartitionedCall:1'].getData()) as Float32Array;
    const o = (await out['StatefulPartitionedCall:2'].getData()) as Float32Array;
    for (const t of Object.values(out)) t.dispose();
    const off = OVERLAP_FRAMES / 2;
    note.set(n.subarray(off * KEYS, (off + KEEP) * KEYS), w * KEEP * KEYS);
    onset.set(o.subarray(off * KEYS, (off + KEEP) * KEYS), w * KEEP * KEYS);
    for (let j = 0; j < KEEP; j++) times[w * KEEP + j] = (start + (j + off) * HOP) / BP_SR;
    onProgress?.(w + 1, total);
  }
  // Drop frames past the end of the song.
  let frames = times.length;
  while (frames > 0 && times[frames - 1] > audio.length / BP_SR) frames--;
  return { note: note.subarray(0, frames * KEYS), onset: onset.subarray(0, frames * KEYS), times: times.subarray(0, frames) };
}

export type Note = { start: number; end: number; midi: number; /** mean note probability */ amp: number };

export const DEFAULT_NOTE_PARAMS = { onsetThresh: 0.5, frameThresh: 0.3, minNote: 0.12 };

/**
 * Notes from Basic Pitch frames, after the reference output_to_notes_polyphonic(): starting at
 * onset peaks (latest first), a note lasts while its key stays above `frameThresh`, tolerating
 * 11 frames below; frames it used can't start another note. Then remaining strong frame
 * activations become notes too (the "melodia trick"), for notes whose onset was missed.
 */
export function framesToNotes(f: PitchFrames, p = DEFAULT_NOTE_PARAMS): Note[] {
  const T = f.times.length;
  const note = Float32Array.from(f.note);
  const minLen = Math.max(1, Math.round(p.minNote * 86));
  const tol = 11;
  const notes: Note[] = [];
  const at = (t: number, k: number) => note[t * KEYS + k];
  const take = (t0: number, k: number): number => {
    // Walk forward from t0 while the key sounds; return the end frame (exclusive).
    let t = t0 + 1, below = 0;
    while (t < T && below < tol) {
      if (at(t, k) < p.frameThresh) below++;
      else below = 0;
      t++;
    }
    return t - below;
  };
  const add = (t0: number, t1: number, k: number) => {
    let amp = 0;
    for (let t = t0; t < t1; t++) { amp += at(t, k); note[t * KEYS + k] = 0; }
    for (const dk of [-1, 1]) if (k + dk >= 0 && k + dk < KEYS) for (let t = t0; t < t1; t++) note[t * KEYS + k + dk] = 0;
    notes.push({ start: f.times[t0], end: f.times[Math.min(T - 1, t1)], midi: k + MIDI_OFFSET, amp: amp / (t1 - t0) });
  };
  // Onset peaks (local maxima in time above threshold), latest first.
  const peaks: [number, number][] = [];
  for (let t = 1; t + 1 < T; t++) {
    for (let k = 0; k < KEYS; k++) {
      const v = f.onset[t * KEYS + k];
      if (v >= p.onsetThresh && v >= f.onset[(t - 1) * KEYS + k] && v > f.onset[(t + 1) * KEYS + k]) peaks.push([t, k]);
    }
  }
  peaks.sort((a, b) => b[0] - a[0]);
  for (const [t0, k] of peaks) {
    if (at(t0, k) < p.frameThresh) continue;
    const t1 = take(t0, k);
    if (t1 - t0 >= minLen) add(t0, t1, k);
  }
  // Melodia trick: grow notes around the strongest remaining activations, strongest first
  // (only confident ones; the reference also checks energy).
  const seeds: number[] = [];
  for (let i = 0; i < note.length; i++) if (note[i] >= 0.7) seeds.push(i);
  seeds.sort((a, b) => note[b] - note[a]);
  for (const i of seeds) {
    if (note[i] < 0.7) continue; // used by a note found since
    const bt = Math.floor(i / KEYS), bk = i % KEYS;
    let t0 = bt;
    while (t0 > 0 && at(t0 - 1, bk) >= p.frameThresh) t0--;
    const t1 = take(bt, bk);
    if (t1 - t0 >= minLen) add(t0, t1, bk);
    else for (let t = t0; t < t1; t++) note[t * KEYS + bk] = 0;
  }
  return notes.sort((a, b) => a.start - b.start || b.midi - a.midi);
}

/**
 * The lead line among polyphonic notes: at any moment the most prominent sounding note, by
 * amplitude with a preference for higher pitches (melodies usually ride on top of chords),
 * as one non-overlapping sequence of notes. A note must lead for `minDur` seconds to count;
 * shorter flickers between notes stay with the note before them.
 */
export function leadLine(notes: Note[], minDur = 0.12, step = 0.01): Note[] {
  if (!notes.length) return [];
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const end = Math.max(...sorted.map((n) => n.end));
  const raw: (Note & { src: Note })[] = [];
  for (let t = sorted[0].start; t < end; t += step) {
    let best: Note | undefined, bestScore = 0;
    for (const n of sorted) {
      if (n.start > t) break;
      if (n.end <= t) continue;
      const score = n.amp * (1 + (n.midi - 48) / 48);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    const last = raw[raw.length - 1];
    if (best && last && last.src === best && t - last.end < step * 1.5) last.end = Math.min(best.end, t + step);
    else if (best) raw.push({ start: Math.max(best.start, t), end: Math.min(best.end, t + step), midi: best.midi, amp: best.amp, src: best });
  }
  // Fold short segments into the one before when they touch it, then merge repeats of a note.
  const out: Note[] = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    const touches = prev && r.start - prev.end < 0.03;
    if (prev && touches && (r.end - r.start < minDur || r.midi === prev.midi)) prev.end = r.end;
    else out.push({ start: r.start, end: r.end, midi: r.midi, amp: r.amp });
  }
  return out.filter((n) => n.end - n.start >= Math.min(minDur, 0.06));
}
