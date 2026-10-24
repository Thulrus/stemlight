import * as ort from 'onnxruntime-node';
import { describe, expect, it } from 'vitest';
import { basicPitchFrames, BP_SR, framesToNotes, leadLine } from '../src/notes/basicPitch';

/** A plucked-string-like tone: a few decaying harmonics. */
function melody(notes: { t: number; dur: number; midi: number }[], seconds: number) {
  const x = new Float32Array(Math.round(seconds * BP_SR));
  for (const n of notes) {
    const f0 = 440 * 2 ** ((n.midi - 69) / 12);
    const a = Math.round(n.t * BP_SR);
    for (let i = 0; i < n.dur * BP_SR && a + i < x.length; i++) {
      const u = i / BP_SR;
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f0 * h * u) / h;
      x[a + i] += 0.25 * v * Math.exp(-u * 2) * Math.min(1, u / 0.005);
    }
  }
  return x;
}

describe('Basic Pitch notes', () => {
  it('finds a melody over a sustained chord, with the right pitches and onsets', async () => {
    const session = await ort.InferenceSession.create(new URL('../src/notes/basic-pitch.onnx', import.meta.url).pathname);
    // Melody C5 D5 E5 G5 E5 (MIDI 72..) over a C3–E3–G3 pad, spanning a window boundary (~1.6 s).
    const tune = [72, 74, 76, 79, 76].map((midi, i) => ({ t: 0.5 + i * 0.5, dur: 0.45, midi }));
    const pad = [48, 52, 55].map((midi) => ({ t: 0.4, dur: 3.2, midi }));
    const x = melody([...tune, ...pad], 4.5);
    for (let i = 0; i < x.length; i++) x[i] *= 0.8;
    const frames = await basicPitchFrames(session, ort.Tensor as never, x);
    // Frame times rise steadily and cover the audio.
    expect(frames.times[0]).toBeGreaterThanOrEqual(0);
    expect(frames.times[frames.times.length - 1]).toBeGreaterThan(4.3);
    const notes = framesToNotes(frames);
    for (const n of tune) {
      const hit = notes.find((m) => m.midi === n.midi && Math.abs(m.start - n.t) < 0.06);
      expect(hit, `MIDI ${n.midi} at ${n.t}`).toBeTruthy();
    }
    // While the melody plays it is the lead; the pad's top note leads only when alone.
    const lead = leadLine(notes).filter((n) => n.start >= 0.45 && n.start < 2.8);
    expect(lead.map((n) => n.midi)).toEqual(tune.map((n) => n.midi));
    for (const [i, n] of tune.entries()) expect(Math.abs(lead[i].start - n.t)).toBeLessThan(0.06);
  });
});
