import * as ort from 'onnxruntime-node';
import { describe, expect, it } from 'vitest';
import { basicPitchFrames, BP_SR } from '../apps/timing/src/notes/basicPitch';
import { DEFAULT_MELODY_PARAMS, melodyNotes } from '../apps/timing/src/notes/melody';

/** A sung-like tone: a few harmonics, with optional vibrato (semitones) and a release. */
function melody(notes: { t: number; dur: number; midi: number; vib?: number }[], seconds: number, decay = 0.5) {
  const x = new Float32Array(Math.round(seconds * BP_SR));
  for (const n of notes) {
    const a = Math.round(n.t * BP_SR);
    let phase = 0;
    for (let i = 0; i < n.dur * BP_SR && a + i < x.length; i++) {
      const u = i / BP_SR;
      const f0 = 440 * 2 ** ((n.midi - 69 + (n.vib ?? 0) * Math.sin(2 * Math.PI * 5.5 * u)) / 12);
      phase += (2 * Math.PI * f0) / BP_SR;
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(h * phase) / h;
      x[a + i] += 0.25 * v * Math.exp(-u * decay) * Math.min(1, u / 0.01) * Math.min(1, (n.dur - u) / 0.03);
    }
  }
  return x;
}

const levelOf = (x: Float32Array) => (t: number) => {
  const i = Math.round(t * BP_SR);
  let sq = 0;
  for (let j = Math.max(0, i - 256); j < Math.min(x.length, i + 256); j++) sq += x[j] * x[j];
  return 10 * Math.log10(sq / 512 + 1e-12);
};

describe('melody notes', () => {
  it('follows a legato line note by note, through vibrato, as touching notes', async () => {
    const session = await ort.InferenceSession.create(new URL('../apps/timing/src/notes/basic-pitch.onnx', import.meta.url).pathname);
    // A4 A#4 C5 A#4 A4 sung without gaps (one tone ends where the next starts), with vibrato.
    const tune = [69, 70, 72, 70, 69].map((midi, i) => ({ t: 0.5 + i * 0.6, dur: 0.6, midi, vib: 0.4 }));
    const x = melody(tune, 4);
    const frames = await basicPitchFrames(session, ort.Tensor as never, x);
    const notes = melodyNotes(frames, levelOf(x), -40, DEFAULT_MELODY_PARAMS);
    expect(notes.map((n) => n.midi)).toEqual(tune.map((n) => n.midi));
    notes.forEach((n, i) => {
      expect(Math.abs(n.start - tune[i].t)).toBeLessThan(0.07);
      if (i + 1 < notes.length) expect(n.end).toBeCloseTo(notes[i + 1].start, 5);
    });
    expect(Math.abs(notes[4].end - 3.5)).toBeLessThan(0.1);
  });
});
