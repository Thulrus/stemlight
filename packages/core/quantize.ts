import type { Mark } from './types';

/** A mark in integer milliseconds, ready for export. */
export type MsMark = { start: number; end: number; label: string };

/**
 * Snap marks to the sequence grid (xLights FixedPointTiming), keeping them sorted,
 * non-overlapping and at least one grid step long. Marks that collapse onto an
 * earlier one are dropped.
 */
export function quantizeMarks(marks: readonly Mark[], gridMs: number, durationSec?: number): MsMark[] {
  const snap = (sec: number) => Math.round((sec * 1000) / gridMs) * gridMs;
  const maxMs = durationSec === undefined ? Infinity : Math.floor((durationSec * 1000) / gridMs) * gridMs;
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  const out: MsMark[] = [];
  for (const m of sorted) {
    let start = Math.max(0, snap(m.start));
    let end = Math.min(snap(m.end), maxMs);
    if (end < start + gridMs) end = start + gridMs;
    const prev = out[out.length - 1];
    if (prev && start < prev.end) {
      start = prev.end;
      if (end - start < gridMs) continue;
    }
    if (end > maxMs) continue;
    out.push({ start, end, label: m.label ?? '' });
  }
  return out;
}
