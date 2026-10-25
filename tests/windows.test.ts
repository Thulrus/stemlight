import { describe, expect, it } from 'vitest';
import { asrWindows } from '../apps/timing/src/lyrics/windows';

describe('asrWindows', () => {
  it('starts windows at the singing and skips instrumental gaps', () => {
    const w = asrWindows([{ start: 14.5, end: 20 }, { start: 21, end: 30 }, { start: 60, end: 65 }], 100);
    expect(w.map((x) => [x.start, x.end])).toEqual([[14.1, 30.4], [59.6, 65.4]]);
  });

  it('never makes a window longer than 29 s', () => {
    const w = asrWindows([{ start: 0, end: 20 }, { start: 21, end: 40 }], 100);
    expect(w.length).toBe(2);
    for (const x of w) expect(x.end - x.start).toBeLessThanOrEqual(29);
  });

  it('splits a long region into overlapping pieces whose keep ranges tile it', () => {
    const w = asrWindows([{ start: 10, end: 80 }], 100);
    expect(w.length).toBeGreaterThan(2);
    for (const x of w) expect(x.end - x.start).toBeLessThanOrEqual(29);
    for (let i = 1; i < w.length; i++) {
      expect(w[i].start).toBeLessThan(w[i - 1].end); // overlap
      expect(w[i].keepFrom).toBeCloseTo(w[i - 1].keepTo, 6); // no gap, no double count
    }
    expect(w[0].keepFrom).toBe(-Infinity);
    expect(w[w.length - 1].keepTo).toBe(Infinity);
  });
});
