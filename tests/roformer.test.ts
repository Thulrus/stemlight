import { expect, it } from 'vitest';
import { roundTripForTest } from '../apps/timing/src/separation/roformer';

it('RoFormer STFT/iSTFT reproduce a chunk', () => {
  const n = 352800;
  const x = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i * 0.031) + 0.2 * Math.sin(i * 0.4) * Math.sin(i * 0.0007));
  const y = roundTripForTest(x);
  let err = 0, pow = 0;
  for (let i = 0; i < n; i++) { err += (y[i] - x[i]) ** 2; pow += x[i] ** 2; }
  expect(10 * Math.log10(pow / err)).toBeGreaterThan(80);
});
