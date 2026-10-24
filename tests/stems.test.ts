import { describe, expect, it } from 'vitest';
import { bassTracks, DEFAULT_STEM_PARAMS, drumTracks } from '../src/analysis/stems';
import { attackOnsets, DEFAULT_VOCAL_PARAMS, phrasesFrom, syllableSpans } from '../src/analysis/vocals';
import { ANALYSIS_SR, computeFeatures } from '../src/dsp/features';
import { eventF } from '../src/eval/metrics';
import { synthLoop } from './synth';

const sr = ANALYSIS_SR;

describe('drum split', () => {
  const { x, kicks, snares, hats } = synthLoop(110, 8);
  const tracks = Object.fromEntries(drumTracks(computeFeatures(x, sr), DEFAULT_STEM_PARAMS).map((t) => [t.name, t.marks.map((m) => m.start)]));
  it.each([
    ['Kick', kicks],
    ['Snare', snares],
    ['Hats', hats],
  ] as const)('%s finds its own hits and not the others', (name, ref) => {
    const r = eventF(tracks[name], ref, 0.03);
    expect(r.recall).toBeGreaterThan(0.9);
    expect(r.precision).toBeGreaterThan(0.9);
  });
});

/** A sequence of harmonic tones with a 40 ms release: [midi, start, duration]. */
function tones(notes: [number, number, number][], seconds: number, decay = 2) {
  const out = new Float32Array(Math.ceil(seconds * sr));
  for (const [midi, start, dur] of notes) {
    const f0 = 440 * 2 ** ((midi - 69) / 12);
    const a = Math.round(start * sr);
    for (let i = 0; i < dur * sr && a + i < out.length; i++) {
      const u = i / sr;
      const env = Math.min(1, u / 0.005) * Math.exp(-u * decay) * Math.min(1, (dur - u) / 0.04);
      out[a + i] += 0.3 * env * (Math.sin(2 * Math.PI * f0 * u) + 0.5 * Math.sin(4 * Math.PI * f0 * u) + 0.25 * Math.sin(6 * Math.PI * f0 * u));
    }
  }
  return out;
}

describe('bass notes', () => {
  // E1 A1 B1 E2, then a repeated E1 (re-articulated, same pitch).
  const notes: [number, number, number][] = [[28, 0.5, 0.45], [33, 1.0, 0.45], [35, 1.5, 0.45], [40, 2.0, 0.8], [28, 3.0, 0.3], [28, 3.4, 0.3]];
  const x = tones(notes, 4.5, 1.5);
  const marks = bassTracks(computeFeatures(x, sr), x, DEFAULT_STEM_PARAMS.bassNotes)[0].marks;

  it('labels pitches and keeps re-articulated notes separate', () => {
    expect(marks.map((m) => m.label)).toEqual(['E1', 'A1', 'B1', 'E2', 'E1', 'E1']);
  });

  it('places note starts and ends within 60 ms', () => {
    marks.forEach((m, i) => {
      expect(Math.abs(m.start - notes[i][1])).toBeLessThan(0.06);
      expect(Math.abs(m.end - (notes[i][1] + notes[i][2]))).toBeLessThan(0.06);
    });
  });
});

describe('vocal tracks', () => {
  // Two "lines" of sung syllables separated by a breath.
  const syl: [number, number, number][] = [[64, 0.5, 0.3], [67, 0.85, 0.3], [69, 1.2, 0.5], [67, 2.6, 0.25], [64, 2.9, 0.25], [62, 3.2, 0.6]];
  const x = tones(syl, 4.5, 0.5);
  const f = computeFeatures(x, sr);
  const syllables = syllableSpans(attackOnsets(f), f);
  const phrases = phrasesFrom(syllables, DEFAULT_VOCAL_PARAMS.breath);

  it('groups syllables into lines', () => {
    expect(phrases.length).toBe(2);
    expect(phrases[0].start).toBeCloseTo(0.5, 1);
    expect(phrases[1].start).toBeCloseTo(2.6, 1);
  });

  it('finds each syllable', () => {
    const r = eventF(syllables.map((m) => m.start), syl.map((s) => s[1]), 0.05);
    expect(r.f).toBe(1);
  });

  it('holds each syllable until the next one in a smooth line, and to its release at the end', () => {
    // Within a line the syllables touch (gaps under the join gap are closed)...
    for (const i of [0, 1, 3, 4]) expect(syllables[i].end).toBeCloseTo(syllables[i + 1].start, 5);
    // ...and the last syllable of each line ends near where its tone does.
    expect(Math.abs(syllables[2].end - 1.7)).toBeLessThan(0.1);
    expect(Math.abs(syllables[5].end - 3.8)).toBeLessThan(0.1);
  });
});
