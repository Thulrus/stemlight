import { ANALYSIS_SR } from '../apps/timing/src/dsp/features';

/** A drum-machine-ish loop: kick on 1 and 3, snare on 2 and 4, hats on eighths, plus a chord change per bar. */
export function synthLoop(bpm: number, bars: number, sr = ANALYSIS_SR) {
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
  const kicks: number[] = [];
  const snares: number[] = [];
  const hats: number[] = [];
  const roots = [220, 174.6, 261.6, 196];
  for (let b = 0; b < bars * 4; b++) {
    const t = lead + b * beat;
    onsets.push(t);
    (b % 2 === 0 ? kicks : snares).push(t);
    hats.push(t + beat / 2);
    if (b % 2 === 0) add(t, 0.25, (u) => 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12));
    else add(t, 0.15, (u) => (0.4 * noise() + 0.3 * Math.sin(2 * Math.PI * 190 * u)) * Math.exp(-u * 25));
    // Hats: second difference of noise, i.e. a steep high-pass like a real hi-hat.
    let n1 = 0, n2 = 0;
    add(t + beat / 2, 0.05, (u) => {
      const v = noise();
      const hp = v - 2 * n1 + n2;
      n2 = n1; n1 = v;
      return 0.1 * hp * Math.exp(-u * 80);
    });
    if (b % 4 === 0) {
      const f0 = roots[(b / 4) % roots.length];
      add(t, 4 * beat, (u) => 0.08 * (Math.sin(2 * Math.PI * f0 * u) + Math.sin(2 * Math.PI * f0 * 1.26 * u) + Math.sin(2 * Math.PI * f0 * 1.5 * u)));
    }
  }
  return { x, onsets, beat, lead, kicks, snares, hats };
}

