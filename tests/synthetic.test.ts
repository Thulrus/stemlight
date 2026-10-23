import { describe, expect, it } from 'vitest';
import { mixTracks } from '../src/analysis/analyze';
import { ANALYSIS_SR, computeFeatures } from '../src/dsp/features';
import { pickOnsets } from '../src/dsp/rhythm';

/** A drum-machine-ish loop: kick on 1 and 3, snare on 2 and 4, hats on eighths, plus a chord change per bar. */
function synthLoop(bpm: number, bars: number, sr = ANALYSIS_SR) {
  const beat = 60 / bpm;
  const lead = 0.5;
  const n = Math.ceil((lead + bars * 4 * beat + 1) * sr);
  const x = new Float32Array(n);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t: number, dur: number, fn: (u: number) => number) => {
    const a = Math.round(t * sr);
    for (let i = 0; i < dur * sr && a + i < n; i++) x[a + i] += fn(i / sr);
  };
  const onsets: number[] = [];
  const roots = [220, 174.6, 261.6, 196];
  for (let b = 0; b < bars * 4; b++) {
    const t = lead + b * beat;
    onsets.push(t);
    if (b % 2 === 0) add(t, 0.25, (u) => 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
    else add(t, 0.15, (u) => 0.5 * noise() * Math.exp(-u * 25));
    add(t + beat / 2, 0.05, (u) => 0.15 * noise() * Math.exp(-u * 80));
    if (b % 4 === 0) {
      const f0 = roots[(b / 4) % roots.length];
      add(t, 4 * beat, (u) => 0.08 * (Math.sin(2 * Math.PI * f0 * u) + Math.sin(2 * Math.PI * f0 * 1.26 * u) + Math.sin(2 * Math.PI * f0 * 1.5 * u)));
    }
  }
  return { x, onsets, beat, lead };
}

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
