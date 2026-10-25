import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { logSoftmax, type Emissions } from './ctc';

/** wav2vec2 models hear 16 kHz audio and emit one frame per 320 samples (20 ms). */
export const W2V_SR = 16000;
const STRIDE = 320;
const RECEPTIVE = 400;
/** Chunks of ~20 s, each with 2 s of context on both sides whose frames are discarded. */
const CORE = 1000 * STRIDE;
const CONTEXT = 100 * STRIDE;

type TensorCtor = new (type: 'float32', data: Float32Array, dims: readonly number[]) => Tensor;

/**
 * CTC log-probabilities for a whole song (16 kHz mono), computed in overlapping chunks so
 * memory stays bounded (wav2vec2's attention is quadratic in length). Each chunk is
 * normalized to zero mean and unit variance like Wav2Vec2FeatureExtractor(do_normalize).
 */
export async function ctcEmissions(
  session: InferenceSession,
  TensorClass: TensorCtor,
  audio: Float32Array,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<Emissions> {
  const frames = Math.max(1, Math.floor((audio.length - RECEPTIVE) / STRIDE) + 1);
  let vocab = 0;
  let logp = new Float32Array(0);
  const total = Math.ceil((frames * STRIDE) / CORE);
  onProgress?.(0, total);
  for (let c = 0; c < total; c++) {
    if (shouldCancel?.()) throw new Error('cancelled');
    const coreStart = c * CORE;
    const a = Math.max(0, coreStart - CONTEXT);
    const b = Math.min(audio.length, coreStart + CORE + CONTEXT + RECEPTIVE);
    const x = audio.slice(a, b);
    if (x.length < RECEPTIVE) break;
    let mean = 0;
    for (const v of x) mean += v;
    mean /= x.length;
    let sq = 0;
    for (const v of x) sq += (v - mean) ** 2;
    const inv = 1 / Math.sqrt(sq / x.length + 1e-7);
    for (let i = 0; i < x.length; i++) x[i] = (x[i] - mean) * inv;
    const out = await session.run({ [session.inputNames[0]]: new TensorClass('float32', x, [1, x.length]) });
    const t = out[session.outputNames[0]];
    const [, n, v] = t.dims as number[];
    const data = (await t.getData()) as Float32Array;
    t.dispose();
    if (!vocab) { vocab = v; logp = new Float32Array(frames * vocab); }
    const f0 = a / STRIDE;
    const keepLo = coreStart / STRIDE;
    const keepHi = Math.min(frames, (coreStart + CORE) / STRIDE);
    for (let j = 0; j < n; j++) {
      const g = f0 + j;
      if (g < keepLo || g >= keepHi) continue;
      logp.set(data.subarray(j * vocab, (j + 1) * vocab), g * vocab);
    }
    onProgress?.(c + 1, total);
  }
  return { logp: logSoftmax(logp, vocab), frames, vocab, frameSec: STRIDE / W2V_SR, offsetSec: RECEPTIVE / 2 / W2V_SR };
}

/** Level (dB) of 16 kHz audio over each emission frame's window. */
export function frameLevels(em: Emissions, audio: Float32Array): Float32Array {
  const db = new Float32Array(em.frames);
  for (let t = 0; t < em.frames; t++) {
    const a = t * STRIDE;
    const end = Math.min(audio.length, a + RECEPTIVE);
    let sq = 0;
    for (let i = a; i < end; i++) sq += audio[i] * audio[i];
    db[t] = 10 * Math.log10(sq / Math.max(1, end - a) + 1e-12);
  }
  return db;
}

/**
 * Discourage letters where the vocals are silent: CTC's one-frame letter spikes are cheap
 * enough that, without this, a line can get smeared across a long instrumental gap. `db` is
 * the vocal level per emission frame; frames more than `quietDb` below its loud level (95th
 * percentile) lose up to `penalty` log-probability on every non-blank token, ramping in over
 * 10 dB.
 */
export function applyVocalPrior(em: Emissions, db: Float32Array, blank: number, quietDb = 30, penalty = 8): Emissions {
  const sorted = Float32Array.from(db).sort();
  const loud = sorted[Math.floor(0.95 * (sorted.length - 1))];
  const logp = Float32Array.from(em.logp);
  for (let t = 0; t < em.frames; t++) {
    const w = Math.min(1, Math.max(0, (loud - quietDb - db[t]) / 10));
    if (w <= 0) continue;
    for (let k = 0; k < em.vocab; k++) if (k !== blank) logp[t * em.vocab + k] -= w * penalty;
  }
  return { ...em, logp };
}
