import { describe, expect, it } from 'vitest';
import { mixTracks } from '../apps/timing/src/analysis/analyze';
import { ANALYSIS_SR, computeFeatures } from '../apps/timing/src/dsp/features';
import { pickOnsets } from '../apps/timing/src/dsp/rhythm';
import { synthLoop } from './synth';

describe('synthetic loop', () => {
  const { x, onsets, beat, lead } = synthLoop(128, 16);
  const f = computeFeatures(x, ANALYSIS_SR);
  const { rhythm, tracks } = mixTracks(f);

  it('finds the tempo', () => {
    expect(rhythm.bpm).toBeGreaterThan(126);
    expect(rhythm.bpm).toBeLessThan(130);
  });

  it('places onsets and beats within 15 ms of the true attacks', () => {
    const on = pickOnsets(f.onset, f.fps, { sensitivity: 0.5, minGap: 0.08 }).map((o) => o.time);
    const errs = onsets.map((t) => Math.min(...on.map((o) => Math.abs(o - t))));

    expect(Math.max(...errs)).toBeLessThan(0.015);
    // The synthetic chord is cut off abruptly at the end, which is itself an attack; ignore beats after the loop.
    const last = onsets[onsets.length - 1] + beat / 2;
    const beats = tracks.find((t) => t.name === 'Beats')!.marks.map((m) => m.start).filter((t) => t < last);
    const beatErrs = beats.map((b) => Math.min(...onsets.map((t) => Math.abs(b - t))));
    expect(Math.max(...beatErrs)).toBeLessThan(0.015);
    expect(beats.length).toBeGreaterThanOrEqual(onsets.length - 2);
  });

  it('puts downbeats on the chord changes', () => {
    const bars = tracks.find((t) => t.name === 'Bars')!.marks.map((m) => m.start);
    for (const b of bars) {
      const k = Math.round((b - lead) / beat);
      expect(((k % 4) + 4) % 4).toBe(0);
    }
  });
});
