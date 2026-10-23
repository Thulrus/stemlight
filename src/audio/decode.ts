import { ANALYSIS_SR } from '../dsp/features';

export type DecodedAudio = {
  /** Original-rate buffer used for playback. */
  buffer: AudioBuffer;
  /** Mono at ANALYSIS_SR for the analysis worker. */
  mono: Float32Array;
};

/** Decode any browser-supported audio file, then downmix and resample for analysis. */
export async function decodeFile(file: File, ctx: AudioContext): Promise<DecodedAudio> {
  const bytes = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(bytes);
  const length = Math.ceil(buffer.duration * ANALYSIS_SR);
  // OfflineAudioContext with one channel downmixes and resamples in one render pass.
  const offline = new OfflineAudioContext(1, length, ANALYSIS_SR);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return { buffer, mono: rendered.getChannelData(0).slice() };
}

/** Min/max peaks per bin for drawing the waveform. */
export function computePeaks(buffer: AudioBuffer, binsPerSec = 200): { min: Float32Array; max: Float32Array; binsPerSec: number } {
  const ch = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const per = Math.max(1, Math.floor(buffer.sampleRate / binsPerSec));
  const n = Math.ceil(buffer.length / per);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(buffer.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      let v = 0;
      for (const c of ch) v += c[i];
      v /= ch.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, binsPerSec: buffer.sampleRate / per };
}
