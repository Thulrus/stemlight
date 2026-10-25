// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
//
// Ported to TypeScript for Stemlight from the WebNN Developer Preview stem separator demo
// (https://github.com/microsoft/webnn-developer-preview/blob/main/demos/stem-separator/htdemucs.js).
// Changes: types, module-level scratch buffers made per-call-safe for workers, and the
// overlap-add helpers trimmed to what Stemlight uses. See THIRD_PARTY_LICENSES.
//
// HTDemucs signal processing around the ONNX forward pass: segmenting, STFT / iSTFT,
// pre_forward / post_forward and overlap-add, following the standard HTDemucs configuration
// (num_subbands=1, cac=True and use_train_segment=True).

export const SAMPLE_RATE = 44100;
export const SEGMENT_LENGTH = 343980;
export const OVERLAP = 171990;
export const HOP = SEGMENT_LENGTH - OVERLAP;
export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemName = (typeof STEM_NAMES)[number];

const FFT_SIZE = 4096;
const STFT_HOP = 1024;
const FREQUENCY_BINS = FFT_SIZE / 2; // Nyquist bin dropped
const TIME_FRAMES = 336;
export const SPECTROGRAM_SHAPE = [1, 4, FREQUENCY_BINS, TIME_FRAMES];
export const WAVEFORM_SHAPE = [1, 2, SEGMENT_LENGTH];
// Demucs reflect-pads (1536, ...) and torch.stft center=True pads (2048, 2048) again; two
// sequential reflect pads differ from one combined pad, so they are applied in order.
const DEMUCS_PAD = (STFT_HOP / 2) * 3;
const CENTER_PAD = FFT_SIZE / 2;
// torch.stft normalized=True scales by 1 / sqrt(n_fft).
const STFT_SCALE = 1 / Math.sqrt(FFT_SIZE);
const NORMALIZE_EPSILON = 1e-5;

// ---- Segmenting and overlap-add -------------------------------------------------

/** Segments start every HOP samples; the last one is zero-padded up to SEGMENT_LENGTH. */
export function segmentCount(totalSamples: number): number {
  return Math.max(1, Math.ceil((totalSamples - OVERLAP) / HOP));
}

/** Planar stereo copy [left, right] of segment `index`, zero-padded past the end of the track. */
export function extractSegment(left: Float32Array, right: Float32Array, index: number): Float32Array {
  const start = index * HOP;
  const end = Math.min(start + SEGMENT_LENGTH, left.length);
  const segment = new Float32Array(2 * SEGMENT_LENGTH);
  segment.set(left.subarray(start, end), 0);
  segment.set(right.subarray(start, end), SEGMENT_LENGTH);
  return segment;
}

/** Triangular crossfade weights for one segment. */
export function buildOverlapWeights(): Float32Array {
  const weights = new Float32Array(SEGMENT_LENGTH);
  for (let i = 0; i < SEGMENT_LENGTH; i++) {
    if (i < OVERLAP) weights[i] = (i + 1) / OVERLAP;
    else if (i >= SEGMENT_LENGTH - OVERLAP) weights[i] = (SEGMENT_LENGTH - i) / OVERLAP;
    else weights[i] = 1;
  }
  return weights;
}

// ---- FFT ----------------------------------------------------------------------------

function buildHannWindow(size: number) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

const HANN_WINDOW = buildHannWindow(FFT_SIZE);
const TW_COS = new Float32Array(FFT_SIZE / 2);
const TW_SIN = new Float32Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  const angle = (-2 * Math.PI * i) / FFT_SIZE;
  TW_COS[i] = Math.cos(angle);
  TW_SIN[i] = Math.sin(angle);
}
const BIT_REVERSE = new Uint32Array(FFT_SIZE);
for (let i = 0, bits = Math.log2(FFT_SIZE); i < FFT_SIZE; i++) {
  let r = 0;
  let v = i;
  for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; }
  BIT_REVERSE[i] = r;
}
// Scratch buffers shared by every FFT frame (each worker has its own module instance).
const FFT_REAL = new Float32Array(FFT_SIZE);
const FFT_IMAG = new Float32Array(FFT_SIZE);

/** In-place iterative radix-2 Cooley-Tukey FFT of size FFT_SIZE. */
function fftInPlace(re: Float32Array, im: Float32Array) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REVERSE[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = TW_COS[k * step];
        const wi = TW_SIN[k * step];
        const e = start + k;
        const o = e + half;
        const pr = wr * re[o] - wi * im[o];
        const pi = wr * im[o] + wi * re[o];
        re[o] = re[e] - pr;
        im[o] = im[e] - pi;
        re[e] += pr;
        im[e] += pi;
      }
    }
  }
}

/** ifft(x) = conj(fft(conj(x))) / n; only the real part is produced, since that is all iSTFT reads. */
function inverseFftRealInPlace(re: Float32Array, im: Float32Array) {
  for (let i = 0; i < FFT_SIZE; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < FFT_SIZE; i++) re[i] /= FFT_SIZE;
}

// ---- STFT / iSTFT ---------------------------------------------------------------------

function padReflect(signal: Float32Array, padLeft: number, padRight: number) {
  const n = signal.length;
  const padded = new Float32Array(padLeft + n + padRight);
  padded.set(signal, padLeft);
  for (let i = 0; i < padLeft; i++) padded[padLeft - 1 - i] = signal[i + 1];
  for (let i = 0; i < padRight; i++) padded[padLeft + n + i] = signal[n - 2 - i];
  return padded;
}

/**
 * STFT of one channel into `output` at the given offsets, each FREQUENCY_BINS x TIME_FRAMES.
 * Matches demucs4ht._spec: reflect pad, torch.stft(center=True, normalized=True), frames [2 : 2 + TIME_FRAMES].
 */
function computeStftChannel(signal: Float32Array, output: Float32Array, realOffset: number, imagOffset: number) {
  const demucsPadded = padReflect(signal, DEMUCS_PAD, DEMUCS_PAD + TIME_FRAMES * STFT_HOP - signal.length);
  const centered = padReflect(demucsPadded, CENTER_PAD, CENTER_PAD);
  for (let frame = 0; frame < TIME_FRAMES; frame++) {
    const s0 = (frame + 2) * STFT_HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      FFT_REAL[i] = centered[s0 + i] * HANN_WINDOW[i];
      FFT_IMAG[i] = 0;
    }
    fftInPlace(FFT_REAL, FFT_IMAG);
    for (let bin = 0; bin < FREQUENCY_BINS; bin++) {
      output[realOffset + bin * TIME_FRAMES + frame] = FFT_REAL[bin] * STFT_SCALE;
      output[imagOffset + bin * TIME_FRAMES + frame] = FFT_IMAG[bin] * STFT_SCALE;
    }
  }
}

/**
 * Inverse of computeStftChannel: torch.istft(normalized=True, center=True) with a Hann window.
 * `re` / `im` hold (FREQUENCY_BINS + 1) x frameCount half-spectra.
 */
function computeIstftChannel(re: Float32Array, im: Float32Array, frameCount: number) {
  const halfBins = FFT_SIZE / 2 + 1;
  const rawLength = (frameCount - 1) * STFT_HOP + FFT_SIZE;
  const acc = new Float32Array(rawLength);
  const wsum = new Float32Array(rawLength);
  const scale = Math.sqrt(FFT_SIZE); // undoes the forward normalized=True
  for (let frame = 0; frame < frameCount; frame++) {
    for (let bin = 0; bin < halfBins; bin++) {
      FFT_REAL[bin] = re[bin * frameCount + frame];
      FFT_IMAG[bin] = im[bin * frameCount + frame];
    }
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      FFT_REAL[FFT_SIZE - bin] = FFT_REAL[bin];
      FFT_IMAG[FFT_SIZE - bin] = -FFT_IMAG[bin];
    }
    inverseFftRealInPlace(FFT_REAL, FFT_IMAG);
    const base = frame * STFT_HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = HANN_WINDOW[i];
      acc[base + i] += FFT_REAL[i] * w * scale;
      wsum[base + i] += w * w;
    }
  }
  for (let i = 0; i < rawLength; i++) if (wsum[i] > 1e-8) acc[i] /= wsum[i];
  // center=True trims FFT_SIZE / 2 from each end.
  return acc.subarray(CENTER_PAD, rawLength - CENTER_PAD);
}

// ---- pre_forward / post_forward -------------------------------------------------------

export type Stats = { mean: number; std: number };

/** (values - mean) / (epsilon + std), with the unbiased std that torch.Tensor.std uses. */
function normalizeInPlace(values: Float32Array): Stats {
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) { const d = values[i] - mean; sq += d * d; }
  const std = Math.sqrt(sq / (n - 1));
  const scale = 1 / (NORMALIZE_EPSILON + std);
  for (let i = 0; i < n; i++) values[i] = (values[i] - mean) * scale;
  return { mean, std };
}

/** Normalized model inputs `x` (spectrogram) and `xt` (waveform) for one planar stereo segment. */
export function preForward(segment: Float32Array) {
  const channelSize = FREQUENCY_BINS * TIME_FRAMES;
  const spectrogram = new Float32Array(4 * channelSize);
  computeStftChannel(segment.subarray(0, SEGMENT_LENGTH), spectrogram, 0, channelSize);
  computeStftChannel(segment.subarray(SEGMENT_LENGTH), spectrogram, 2 * channelSize, 3 * channelSize);
  const specStats = normalizeInPlace(spectrogram);
  const waveform = segment.slice();
  const waveStats = normalizeInPlace(waveform);
  return { spectrogram, waveform, specStats, waveStats };
}

/**
 * Model outputs `x_out` [1, 16, F, T] and `xt_out` [1, 8, SEGMENT_LENGTH] back into
 * [stem][channel][SEGMENT_LENGTH] waveforms: de-normalize, iSTFT the spectral branch, add the time branch.
 */
export function postForward(specOut: Float32Array, waveOut: Float32Array, specStats: Stats, waveStats: Stats): Float32Array {
  const channelSize = FREQUENCY_BINS * TIME_FRAMES;
  // _ispec pads one zero Nyquist bin and two zero frames on each side.
  const paddedFrames = TIME_FRAMES + 4;
  const re = new Float32Array((FREQUENCY_BINS + 1) * paddedFrames);
  const im = new Float32Array(re.length);
  const sources = new Float32Array(STEM_NAMES.length * 2 * SEGMENT_LENGTH);
  for (let stem = 0; stem < STEM_NAMES.length; stem++) {
    for (let ch = 0; ch < 2; ch++) {
      // x_out channels per stem are [real_L, imag_L, real_R, imag_R].
      const realOffset = (stem * 4 + ch * 2) * channelSize;
      const imagOffset = realOffset + channelSize;
      re.fill(0);
      im.fill(0);
      for (let bin = 0; bin < FREQUENCY_BINS; bin++) {
        for (let frame = 0; frame < TIME_FRAMES; frame++) {
          const src = bin * TIME_FRAMES + frame;
          const dst = bin * paddedFrames + frame + 2;
          re[dst] = specOut[realOffset + src] * specStats.std + specStats.mean;
          im[dst] = specOut[imagOffset + src] * specStats.std + specStats.mean;
        }
      }
      const spectral = computeIstftChannel(re, im, paddedFrames);
      const offset = (stem * 2 + ch) * SEGMENT_LENGTH;
      for (let i = 0; i < SEGMENT_LENGTH; i++) {
        sources[offset + i] = spectral[DEMUCS_PAD + i] + (waveOut[offset + i] * waveStats.std + waveStats.mean);
      }
    }
  }
  return sources;
}
