import type { Mark } from '@stemlight/core/types';

export const DEFAULT_SNAP_PARAMS = {
  /** Grid steps per beat (1 = beats, 2 = eighth notes in 4/4, 4 = sixteenths); 0 turns snapping off. */
  division: 0,
  /** Only boundaries this close (s) to a grid line move onto it. */
  tolerance: 0.1,
};
export type SnapParams = typeof DEFAULT_SNAP_PARAMS;

/** Grid line times: each beat interval divided into `division` equal steps. */
export function beatGrid(beats: number[], division: number): number[] {
  const g: number[] = [];
  for (let i = 0; i + 1 < beats.length; i++) for (let k = 0; k < division; k++) g.push(beats[i] + ((beats[i + 1] - beats[i]) * k) / division);
  if (beats.length) g.push(beats[beats.length - 1]);
  return g;
}

/**
 * Move mark boundaries onto the beat grid when they're within `tolerance` of a grid line.
 * Sequencers place effects on the beat even where a singer or player is a little early or
 * late, so snapped marks match what they'd draw. Marks that would collapse are dropped, and
 * touching marks stay touching.
 */
export function snapMarks(marks: Mark[], beats: number[], p: SnapParams): Mark[] {
  if (!p.division || beats.length < 2) return marks;
  const grid = beatGrid(beats, p.division);
  const snap = (t: number) => {
    let lo = 0, hi = grid.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (grid[mid] <= t) lo = mid; else hi = mid;
    }
    const g = Math.abs(grid[lo] - t) <= Math.abs(grid[hi] - t) ? grid[lo] : grid[hi];
    return Math.abs(g - t) <= p.tolerance ? g : t;
  };
  const out: Mark[] = [];
  for (const m of marks) {
    const start = snap(m.start);
    let end = snap(m.end);
    if (end - start < 0.04) end = m.end > start + 0.04 ? m.end : start + 0.05;
    const prev = out[out.length - 1];
    if (prev && start < prev.end) {
      if (start <= prev.start) continue;
      prev.end = start;
    }
    out.push({ ...m, start, end });
  }
  return out;
}
