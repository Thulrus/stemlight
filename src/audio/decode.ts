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

/** Planar stereo at `sr` (the separator needs 44.1 kHz), resampled via an OfflineAudioContext. */
export async function toStereo(buffer: AudioBuffer, sr: number): Promise<{ left: Float32Array; right: Float32Array }> {
  const offline = new OfflineAudioContext(2, Math.ceil(buffer.duration * sr), sr);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const r = await offline.startRendering();
  return { left: r.getChannelData(0).slice(), right: r.getChannelData(1).slice() };
}

/** Decode a file straight to mono at `sr` (used for user-supplied stems). */
export async function decodeMono(file: File, ctx: AudioContext, sr: number): Promise<Float32Array> {
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * sr), sr);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0).slice();
}

/** Which stem a file name refers to, if any (drums.wav, "Song - Vocals.flac", vox, …). */
export function stemFromFileName(name: string): 'drums' | 'bass' | 'vocals' | 'other' | undefined {
  // Treat _ - . as word breaks (\b doesn't split on underscores).
  const n = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ');
  if (/\b(drums?|percussion|perc)\b/.test(n)) return 'drums';
  if (/\bbass\b/.test(n)) return 'bass';
  if (/\b(vocals?|vox|voice|acapella|a cappella)\b/.test(n)) return 'vocals';
  if (/\b(other|accompaniment|instrumental|music)\b/.test(n)) return 'other';
  return undefined;
}

/** Resample mono audio with an OfflineAudioContext (e.g. 22.05 kHz vocals to 16 kHz for Whisper). */
export async function resample(x: Float32Array, from: number, to: number): Promise<Float32Array> {
  const offline = new OfflineAudioContext(1, Math.ceil((x.length * to) / from), to);
  const buf = offline.createBuffer(1, x.length, from);
  buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0).slice();
}
