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
