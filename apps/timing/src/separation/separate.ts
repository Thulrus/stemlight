import type { InferenceSession, Tensor } from 'onnxruntime-web';
import {
  buildOverlapWeights, extractSegment, HOP, postForward, preForward, SEGMENT_LENGTH,
  SPECTROGRAM_SHAPE, STEM_NAMES, WAVEFORM_SHAPE, type StemName,
} from './htdemucs';

/** Stems as mono at half the model rate (22.05 kHz), which is what analysis and auditioning use. */
export type Stems = Record<StemName, Float32Array>;
export const STEM_SR = 22050;

type TensorCtor = new (type: 'float32', data: Float32Array, dims: readonly number[]) => Tensor;

/** Half-band lowpass (windowed sinc, cutoff ~10 kHz at 44.1 kHz) for 2:1 decimation. */
const DECIM_TAPS = (() => {
  const n = 63;
  const mid = (n - 1) / 2;
  const fc = 10000 / 44100;
  const taps = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < n; i++) taps[i] /= sum;
  return taps;
})();

/** Downmix one stem of a [stem][channel][SEGMENT_LENGTH] block to mono and decimate 2:1. */
function stemToMonoHalf(sources: Float32Array, stem: number, out: Float32Array) {
  const l = stem * 2 * SEGMENT_LENGTH;
  const r = l + SEGMENT_LENGTH;
  const mid = (DECIM_TAPS.length - 1) / 2;
  for (let j = 0; j < out.length; j++) {
    const c = 2 * j;
    let acc = 0;
    for (let k = 0; k < DECIM_TAPS.length; k++) {
      const i = c + k - mid;
      if (i < 0 || i >= SEGMENT_LENGTH) continue;
      acc += DECIM_TAPS[k] * (sources[l + i] + sources[r + i]);
    }
    out[j] = 0.5 * acc;
  }
}

export type SeparateProgress = (done: number, total: number) => void;

/**
 * Run HTDemucs over a 44.1 kHz stereo track in overlapping 7.8 s segments and overlap-add
 * the stems. Each segment is downmixed and decimated to 22.05 kHz before accumulation,
 * which keeps memory ~8x lower than holding full-rate stereo stems.
 */
export async function separate(
  session: InferenceSession,
  TensorClass: TensorCtor,
  left: Float32Array,
  right: Float32Array,
  onProgress?: SeparateProgress,
  shouldCancel?: () => boolean,
): Promise<Stems> {
  const total = left.length;
  const count = Math.max(1, Math.ceil((total - (SEGMENT_LENGTH - HOP)) / HOP));
  const halfTotal = Math.ceil(total / 2);
  const halfSeg = SEGMENT_LENGTH / 2;
  const halfHop = HOP / 2;
  const stems = Object.fromEntries(STEM_NAMES.map((n) => [n, new Float32Array(halfTotal)])) as Stems;
  const weightTotals = new Float32Array(halfTotal);
  const fullWeights = buildOverlapWeights();
  const weights = new Float32Array(halfSeg);
  for (let i = 0; i < halfSeg; i++) weights[i] = fullWeights[2 * i];
  const scratch = new Float32Array(halfSeg);
  onProgress?.(0, count);

  for (let s = 0; s < count; s++) {
    if (shouldCancel?.()) throw new Error('cancelled');
    const segment = extractSegment(left, right, s);
    const pre = preForward(segment);
    const feeds = {
      x: new TensorClass('float32', pre.spectrogram, SPECTROGRAM_SHAPE),
      xt: new TensorClass('float32', pre.waveform, WAVEFORM_SHAPE),
    };
    const out = await session.run(feeds);
    const specOut = out.x_out;
    const waveOut = out.xt_out;
    const sources = postForward(
      (await specOut.getData()) as Float32Array,
      (await waveOut.getData()) as Float32Array,
      pre.specStats,
      pre.waveStats,
    );
    specOut.dispose();
    waveOut.dispose();

    const start = s * halfHop;
    const len = Math.min(halfSeg, halfTotal - start);
    STEM_NAMES.forEach((name, k) => {
      stemToMonoHalf(sources, k, scratch);
      const dst = stems[name];
      for (let i = 0; i < len; i++) dst[start + i] += scratch[i] * weights[i];
    });
    for (let i = 0; i < len; i++) weightTotals[start + i] += weights[i];
    onProgress?.(s + 1, count);
  }

  for (const name of STEM_NAMES) {
    const x = stems[name];
    for (let i = 0; i < halfTotal; i++) if (weightTotals[i] > 0) x[i] /= weightTotals[i];
  }
  return stems;
}
