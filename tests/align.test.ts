import { describe, expect, it } from 'vitest';
import { forcedAlign, type Emissions } from '../src/align/ctc';
import { numberWords, parseLyrics, syllabify } from '../src/align/text';

describe('syllabify', () => {
  const cases: [string, string[]][] = [
    ['SEARCHING', ['SEAR', 'CHING']],
    ['WORLD', ['WORLD']],
    ['CANDY', ['CAN', 'DY']],
    ['HAPPY', ['HAP', 'PY']],
    ['MAKE', ['MAKE']],
    ['LITTLE', ['LIT', 'TLE']],
    ['WANTED', ['WAN', 'TED']],
    ['LOVED', ['LOVED']],
    ['KISSES', ['KIS', 'SES']],
    ['HALLOWEEN', ['HAL', 'LO', 'WEEN']],
    ['FINALLY', ['FI', 'NAL', 'LY']],
    ['LION', ['LI', 'ON']],
    ["THERE'S", ["THERE'S"]],
    ['BEYOND', ['BE', 'YOND']],
  ];
  for (const [w, want] of cases) it(w, () => expect(syllabify(w)).toEqual(want));
  it('keeps every letter', () => {
    for (const w of ['STRENGTH', 'EVERYBODY', "DON'T", 'AWAKE', 'WONDERING', 'HIGHWAY']) expect(syllabify(w).join('')).toBe(w);
  });
});

describe('parseLyrics', () => {
  it('splits lines, hyphens and numbers', () => {
    const w = parseLyrics("I've been a-searching\n\n[Chorus]\nAll 4 you (yeah)");
    expect(w.map((x) => x.norm)).toEqual(["I'VE", 'BEEN', 'A', 'SEARCHING', 'ALL', 'FOUR', 'YOU', 'YEAH']);
    expect(w.map((x) => x.line)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
  it('spells numbers', () => {
    expect(numberWords(1999).join(' ')).toBe('nineteen ninety nine');
    expect(numberWords(42).join(' ')).toBe('forty two');
  });
});

describe('forcedAlign', () => {
  it('finds token frames in a synthetic emission', () => {
    // vocab: 0 blank, 1 A, 2 B. Frames: blank blank A A blank B blank blank
    const seq = [0, 0, 1, 1, 0, 2, 0, 0];
    const logp = new Float32Array(seq.length * 3).fill(Math.log(0.05));
    seq.forEach((k, t) => (logp[t * 3 + k] = Math.log(0.9)));
    const em: Emissions = { logp, frames: seq.length, vocab: 3, frameSec: 0.02, offsetSec: 0 };
    const spans = forcedAlign(em, [1, 2]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[2, 4], [5, 6]]);
    // Repeated tokens need a blank between them.
    const rep = forcedAlign({ ...em }, [1, 1]);
    expect(rep[0].end).toBeLessThanOrEqual(rep[1].start);
  });
  it('respects token windows', () => {
    const seq = [1, 0, 0, 0, 0, 1, 0];
    const logp = new Float32Array(seq.length * 2).fill(Math.log(0.1));
    seq.forEach((k, t) => (logp[t * 2 + k] = Math.log(0.9)));
    const em: Emissions = { logp, frames: seq.length, vocab: 2, frameSec: 0.02, offsetSec: 0 };
    expect(forcedAlign(em, [1])[0].start).toBe(0);
    expect(forcedAlign(em, [1], 0, { lo: Int32Array.of(3), hi: Int32Array.of(7) })[0].start).toBe(5);
  });
});

describe('matchWords', () => {
  it('pairs equal words around insertions and substitutions', async () => {
    const { matchWords } = await import('../src/eval/align');
    expect(matchWords(['i', 'found', 'a', 'girl', 'yeah'], ['i', 'found', 'me', 'a', 'girl'])).toEqual([[0, 0], [1, 1], [2, 3], [3, 4]]);
  });
});
