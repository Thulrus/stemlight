export type Region = { start: number; end: number };
/** A window to transcribe; words starting outside [keepFrom, keepTo) belong to a neighbor. */
export type AsrWindow = { start: number; end: number; keepFrom: number; keepTo: number };

const MAX = 29; // Whisper hears 30 s at most
const PAD = 0.4;
const SPLIT_STEP = 25;

/**
 * Transcription windows built around where the singing is. Whisper fails on long leading
 * silence (it emits "You" and stops, especially with 4-bit weights), so each window starts
 * just before a vocal region and groups regions up to ~29 s. Instrumental stretches are
 * skipped entirely. A region longer than a window is split with overlap, keeping each
 * piece's words from its middle.
 */
export function asrWindows(regions: Region[], duration: number): AsrWindow[] {
  const out: AsrWindow[] = [];
  let cur: AsrWindow | undefined;
  const close = () => { if (cur) out.push(cur); cur = undefined; };
  for (const r of regions) {
    const start = Math.max(0, r.start - PAD);
    const end = Math.min(duration, r.end + PAD);
    if (end - start > MAX) {
      close();
      for (let s = start; s < end; s += SPLIT_STEP) {
        const e = Math.min(end, s + MAX);
        out.push({
          start: s,
          end: e,
          keepFrom: s === start ? -Infinity : s + (MAX - SPLIT_STEP) / 2,
          keepTo: e >= end ? Infinity : s + SPLIT_STEP + (MAX - SPLIT_STEP) / 2,
        });
        if (e >= end) break;
      }
      continue;
    }
    if (cur && end - cur.start <= MAX) cur.end = end;
    else { close(); cur = { start, end, keepFrom: -Infinity, keepTo: Infinity }; }
  }
  close();
  return out;
}
