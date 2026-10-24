import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { FFT } from '../dsp/fft';
import { decimate } from '../dsp/pitch';

/**
 * Mel-Band RoFormer vocals (Kimberley Jensen's checkpoint, MIT) as exported to ONNX by audiojs
 * (https://huggingface.co/audiojs/mel-roformer). The graph maps a stereo complex spectrogram
 * to the vocals' spectrogram; STFT, iSTFT and segmenting follow ZFTurbo's
 * Music-Source-Separation-Training demix(): 8 s chunks every 4 s with 0.8 s linear fades,
 * the song reflect-padded at both ends, nothing normalized.
 */
export const RF_SR = 44100;
const CHUNK = 352800;
const STEP = CHUNK / 2;
const FADE = CHUNK / 10;
const N_FFT = 2048;
const HOP = 441;
const BINS = N_FFT / 2 + 1;
const FRAMES = CHUNK / HOP + 1; // 801
const SHAPE = [1, 4, BINS, FRAMES];

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
function stft(x: Float32Array, out: Float32Array, reOffset: number, imOffset: number) {
  const padded = reflectPad(x, N_FFT / 2, N_FFT / 2);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let t = 0; t < FRAMES; t++) {
    const s = t * HOP;
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[s + i] * WINDOW[i]; im[i] = 0; }
    fft.transform(re, im);
    for (let b = 0; b < BINS; b++) {
      out[reOffset + b * FRAMES + t] = re[b];
      out[imOffset + b * FRAMES + t] = im[b];
    }
  }
}

/** torch.istft with the same settings, returning CHUNK samples. */
function istft(spec: Float32Array | Float64Array, reOffset: number, imOffset: number): Float64Array {
  const total = (FRAMES - 1) * HOP + N_FFT;
  const acc = new Float64Array(total);
  const wsum = new Float64Array(total);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let t = 0; t < FRAMES; t++) {
    for (let b = 0; b < BINS; b++) {
      re[b] = spec[reOffset + b * FRAMES + t];
      im[b] = -spec[imOffset + b * FRAMES + t]; // conjugate for the inverse via forward FFT
    }
    for (let b = 1; b < N_FFT / 2; b++) { re[N_FFT - b] = re[b]; im[N_FFT - b] = -im[b]; }
    fft.transform(re, im);
    const s = t * HOP;
    for (let i = 0; i < N_FFT; i++) {
      acc[s + i] += (re[i] / N_FFT) * WINDOW[i];
      wsum[s + i] += WINDOW[i] * WINDOW[i];
    }
  }
  const out = new Float64Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    const j = i + N_FFT / 2;
    out[i] = wsum[j] > 1e-10 ? acc[j] / wsum[j] : 0;
  }
  return out;
}

/** Exposed for tests: STFT then iSTFT of one chunk (should reproduce the input). */
export function roundTripForTest(x: Float32Array): Float64Array {
  const spec = new Float32Array(2 * BINS * FRAMES);
  stft(x, spec, 0, BINS * FRAMES);
  return istft(spec, 0, BINS * FRAMES);
}

type TensorCtor = new (type: 'float32', data: Float32Array, dims: readonly number[]) => Tensor;

/**
 * Separate vocals from a 44.1 kHz stereo song. Returns the vocals as mono at 22.05 kHz,
 * like the HTDemucs stems, so the analysis treats both the same.
 */
export async function separateVocalsRoformer(
  session: InferenceSession,
  TensorClass: TensorCtor,
  left: Float32Array,
  right: Float32Array,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<Float32Array> {
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
    stft(chunk(L), spec, 0, plane);
    stft(chunk(R), spec, 2 * plane, 3 * plane);
    const out = await session.run({ mix_spec: new TensorClass('float32', spec, SHAPE) });
    const vocalSpec = (await out.stems_spec.getData()) as Float32Array;
    out.stems_spec.dispose();
    const vl = istft(vocalSpec, 0, plane);
    const vr = istft(vocalSpec, 2 * plane, 3 * plane);
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
  const vocals = new Float32Array(n0);
  for (let k = 0; k < n0; k++) {
    const c = counter[start + k];
    vocals[k] = c > 0 ? mono[start + k] / c : 0;
  }
  return decimate(vocals, 2);
}
