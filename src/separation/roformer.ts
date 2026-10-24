import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { FFT } from '../dsp/fft';
import { decimate } from '../dsp/pitch';

/**
 * RoFormer-family separators that map a stereo complex spectrogram to one stem's spectrogram.
 * STFT, iSTFT and segmenting follow ZFTurbo's Music-Source-Separation-Training demix(): chunks
 * every half chunk with linear fades over a tenth of a chunk, the song reflect-padded at both
 * ends, nothing normalized.
 */
export const RF_SR = 44100;
const N_FFT = 2048;
const BINS = N_FFT / 2 + 1;

type TensorCtor = new (type: 'float32', data: Float32Array, dims: readonly number[]) => Tensor;

/** One model: its chunk length and hop (samples at 44.1 kHz) and how to run it on a chunk. */
export type RoformerModel = {
  chunk: number;
  hop: number;
  /**
   * Run on one chunk's spectrogram, planes [left re, left im, right re, right im], each
   * [bin * frames + frame], and return the stem's spectrogram in the same layout.
   */
  run: (session: InferenceSession, T: TensorCtor, spec: Float32Array, frames: number) => Promise<Float32Array>;
};

/** Graphs exported with the spectrogram in and out ("mix_spec" → "stems_spec"). */
const specInOut = async (session: InferenceSession, T: TensorCtor, spec: Float32Array, frames: number) => {
  const out = await session.run({ mix_spec: new T('float32', spec, [1, 4, BINS, frames]) });
  const data = (await out.stems_spec.getData()) as Float32Array;
  out.stems_spec.dispose();
  return data;
};

/**
 * Mel-Band RoFormer vocals (Kimberley Jensen's checkpoint, MIT) as exported to ONNX by audiojs
 * (https://huggingface.co/audiojs/mel-roformer): 8 s chunks, hop 441.
 */
export const VOCALS_MODEL: RoformerModel = { chunk: 352800, hop: 441, run: specInOut };

/**
 * BS-RoFormer karaoke (anvuew, GPL-3.0; trained on becruily's lead/backing data) exported with
 * tools/export/bs_roformer_onnx.py: lead vocals only, backing vocals stay with the rest. Hop
 * 512; exported for 8 s chunks (689 frames) instead of its 14.5 s training chunks, which would
 * need a 3 GB attention matrix per layer.
 */
export const LEAD_MODEL: RoformerModel = { chunk: 688 * 512, hop: 512, run: specInOut };

const fft = new FFT(N_FFT);
// torch.hann_window default: periodic.
const WINDOW = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));

function reflectPad(x: Float32Array, left: number, right: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(left + n + right);
  out.set(x, left);
  for (let i = 0; i < left; i++) out[left - 1 - i] = x[Math.min(n - 1, i + 1)];
  for (let i = 0; i < right; i++) out[left + n + i] = x[Math.max(0, n - 2 - i)];
  return out;
}

/** torch.stft(n_fft, hop, hann, center=True, reflect, unnormalized) into [bin][frame] at `offset`. */
function stft(x: Float32Array, out: Float32Array, reOffset: number, imOffset: number, hop: number, frames: number) {
  const padded = reflectPad(x, N_FFT / 2, N_FFT / 2);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let t = 0; t < frames; t++) {
    const s = t * hop;
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[s + i] * WINDOW[i]; im[i] = 0; }
    fft.transform(re, im);
    for (let b = 0; b < BINS; b++) {
      out[reOffset + b * frames + t] = re[b];
      out[imOffset + b * frames + t] = im[b];
    }
  }
}

/** torch.istft with the same settings, returning `len` samples. */
function istft(spec: Float32Array | Float64Array, reOffset: number, imOffset: number, hop: number, frames: number, len: number): Float64Array {
  const total = (frames - 1) * hop + N_FFT;
  const acc = new Float64Array(total);
  const wsum = new Float64Array(total);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < BINS; b++) {
      re[b] = spec[reOffset + b * frames + t];
      im[b] = -spec[imOffset + b * frames + t]; // conjugate for the inverse via forward FFT
    }
    for (let b = 1; b < N_FFT / 2; b++) { re[N_FFT - b] = re[b]; im[N_FFT - b] = -im[b]; }
    fft.transform(re, im);
    const s = t * hop;
    for (let i = 0; i < N_FFT; i++) {
      acc[s + i] += (re[i] / N_FFT) * WINDOW[i];
      wsum[s + i] += WINDOW[i] * WINDOW[i];
    }
  }
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const j = i + N_FFT / 2;
    out[i] = wsum[j] > 1e-10 ? acc[j] / wsum[j] : 0;
  }
  return out;
}

/** Exposed for tests: STFT then iSTFT of one chunk (should reproduce the input). */
export function roundTripForTest(x: Float32Array, hop = 441): Float64Array {
  const frames = Math.floor(x.length / hop) + 1;
  const spec = new Float32Array(2 * BINS * frames);
  stft(x, spec, 0, BINS * frames, hop, frames);
  return istft(spec, 0, BINS * frames, hop, frames, x.length);
}

/**
 * Separate one stem from a 44.1 kHz stereo song. Returns it as mono at 22.05 kHz, like the
 * HTDemucs stems, so the analysis treats both the same.
 */
export async function separateRoformer(
  model: RoformerModel,
  session: InferenceSession,
  TensorClass: TensorCtor,
  left: Float32Array,
  right: Float32Array,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<Float32Array> {
  const CHUNK = model.chunk;
  const STEP = CHUNK / 2;
  const FADE = Math.round(CHUNK / 10);
  const HOP = model.hop;
  const FRAMES = CHUNK / HOP + 1;
  const n0 = left.length;
  const border = CHUNK - STEP;
  const padEnds = n0 > 2 * border;
  const L = padEnds ? reflectPad(left, border, border) : left;
  const R = padEnds ? reflectPad(right, border, border) : right;
  const n = L.length;
  const mono = new Float64Array(n);
  const counter = new Float64Array(n);
  const total = Math.ceil(n / STEP);
  const base = new Float64Array(CHUNK).fill(1);
  for (let i = 0; i < FADE; i++) { base[i] = i / FADE; base[CHUNK - 1 - i] = i / FADE; }
  onProgress?.(0, total);

  let done = 0;
  for (let i = 0; i < n; i += STEP) {
    if (shouldCancel?.()) throw new Error('cancelled');
    const len = Math.min(CHUNK, n - i);
    const chunk = (x: Float32Array) => {
      const part = x.subarray(i, i + len);
      if (len === CHUNK) return part;
      // demix() pads a short last chunk by reflection when it's over half a chunk, else zeros.
      return len > CHUNK / 2 ? reflectPad(part, 0, CHUNK - len).subarray(0, CHUNK) : Float32Array.from({ length: CHUNK }, (_, k) => (k < len ? part[k] : 0));
    };
    const spec = new Float32Array(4 * BINS * FRAMES);
    const plane = BINS * FRAMES;
    stft(chunk(L), spec, 0, plane, HOP, FRAMES);
    stft(chunk(R), spec, 2 * plane, 3 * plane, HOP, FRAMES);
    const stemSpec = await model.run(session, TensorClass, spec, FRAMES);
    const vl = istft(stemSpec, 0, plane, HOP, FRAMES, CHUNK);
    const vr = istft(stemSpec, 2 * plane, 3 * plane, HOP, FRAMES, CHUNK);
    const w = Float64Array.from(base);
    if (i === 0) w.fill(1, 0, FADE);
    if (i + CHUNK >= n) w.fill(1, CHUNK - FADE);
    for (let k = 0; k < len; k++) {
      mono[i + k] += 0.5 * (vl[k] + vr[k]) * w[k];
      counter[i + k] += w[k];
    }
    onProgress?.(++done, total);
  }
  const start = padEnds ? border : 0;
  const stem = new Float32Array(n0);
  for (let k = 0; k < n0; k++) {
    const c = counter[start + k];
    stem[k] = c > 0 ? mono[start + k] / c : 0;
  }
  return decimate(stem, 2);
}
