import type { AsrWord } from '../analysis/lyrics';
import { activitySpans } from '../analysis/stems';
import { computeFeatures } from '../dsp/features';
import { asrWindows } from './windows';

export const ASR_SR = 16000;

type AsrOutput = { chunks?: { text: string; timestamp: [number, number | null] }[] };
export type AsrFn = (audio: Float32Array) => Promise<AsrOutput>;

/**
 * Transcribe vocals (16 kHz mono) window by window around where the singing is (see
 * asrWindows), returning words with song-time timestamps.
 */
export async function transcribeVocals(
  audio: Float32Array,
  asr: AsrFn,
  onProgress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<AsrWord[]> {
  const duration = audio.length / ASR_SR;
  // Generous activity detection: windows should include soft singing, not just the loud parts.
  const regions = activitySpans(computeFeatures(audio, ASR_SR), { thresholdDb: 25, mergeGap: 1.0, minDur: 0.3 });
  const windows = asrWindows(regions, duration);
  const words: AsrWord[] = [];
  onProgress?.(0, windows.length);
  for (let i = 0; i < windows.length; i++) {
    if (cancelled?.()) throw new Error('cancelled');
    const w = windows[i];
    const out = await asr(audio.subarray(Math.round(w.start * ASR_SR), Math.min(audio.length, Math.round(w.end * ASR_SR))));
    for (const c of out.chunks ?? []) {
      const start = w.start + c.timestamp[0];
      if (start < w.keepFrom || start >= w.keepTo) continue;
      words.push({ text: c.text, start, end: c.timestamp[1] === null ? null : w.start + c.timestamp[1] });
    }
    onProgress?.(i + 1, windows.length);
  }
  return words;
}
