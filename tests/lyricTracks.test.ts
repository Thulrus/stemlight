import { describe, expect, it } from 'vitest';
import type { AlignedWord } from '../src/align/align';
import { fuseEmissions, type Emissions } from '../src/align/ctc';
import { greedySyllables } from '../src/align/greedy';
import { lyricTracks, wordsFromAsr } from '../src/analysis/lyricTracks';
import { DEFAULT_STEM_PARAMS } from '../src/analysis/stems';
import { toXTiming } from '../src/export/xtiming';
import { ALIGNER_VOCAB } from '../src/separation/model';

const span = (text: string, start: number, end: number) => ({ text, start, end });
const p0 = { ...DEFAULT_STEM_PARAMS.lyrics, offsetMs: 0 };

describe('lyricTracks', () => {
  const words: AlignedWord[] = [
    { ...span('Candy', 1.0, 1.3), line: 0, score: -1, syllables: [span('CAN', 1.0, 1.2), span('DY', 1.2, 1.3)], phones: [span('K', 1.0, 1.05), span('AE', 1.05, 1.15), span('N', 1.15, 1.2), span('D', 1.2, 1.25), span('IY', 1.25, 1.3)] },
    { ...span('girl', 1.6, 1.8), line: 0, score: -1, syllables: [span('GIRL', 1.6, 1.8)], phones: [span('G', 1.6, 1.65), span('ER', 1.65, 1.75), span('L', 1.75, 1.8)] },
    { ...span('Oh', 3.0, 3.1), line: 1, score: -1, syllables: [span('OH', 3.0, 3.1)], phones: [span('OW', 3.0, 3.1)] },
  ];
  const tracks = Object.fromEntries(lyricTracks(words, undefined, p0).map((t) => [t.id, t]));

  it('makes lines, words, labeled syllables and a three-layer Lyrics track', () => {
    expect(tracks['vocals-lyric-lines'].marks.map((m) => m.label)).toEqual(['Candy girl', 'Oh']);
    expect(tracks['vocals-lyric-words'].marks.map((m) => m.label)).toEqual(['Candy', 'girl', 'Oh']);
    expect(tracks['vocals-lyric-syllables'].marks.map((m) => m.label)).toEqual(['can', 'dy', 'girl', 'oh']);
    const faces = tracks['vocals-lyrics'];
    expect(faces.layers).toHaveLength(2);
    expect(faces.layers![1].map((m) => m.label)).toEqual(['etc', 'AI', 'etc', 'etc', 'E', 'etc', 'E', 'L', 'O']);
  });
  it('holds words until the next word at most', () => {
    const w = tracks['vocals-lyric-words'].marks;
    expect(w[0].end).toBeLessThanOrEqual(w[1].start);
    expect(w[0].end).toBeGreaterThanOrEqual(1.3);
  });
  it('applies the offset to every layer', () => {
    const shifted = lyricTracks(words, undefined, { ...p0, offsetMs: -50 });
    expect(shifted[1].marks[0].start).toBeCloseTo(0.95);
    expect(shifted[3].layers![1][0].start).toBeCloseTo(0.95);
  });
  it('exports each layer as its own EffectLayer', () => {
    const xml = toXTiming([tracks['vocals-lyrics']], { gridMs: 50 });
    expect(xml.match(/<EffectLayer>/g)).toHaveLength(3);
    expect(xml).toContain('label="Candy girl" starttime="1000"');
    expect(xml).toContain('label="AI" starttime="1050"');
  });
});

describe('wordsFromAsr', () => {
  it('splits lines at sentences, capitalized words after commas and long pauses', () => {
    const { words, hints } = wordsFromAsr([
      { text: ' Candy', start: 1, end: 1.3 }, { text: ' girl,', start: 1.4, end: 1.8 }, { text: ' Candy', start: 2, end: 2.3 },
      { text: ' ♪', start: 2.5, end: 2.6 }, { text: ' a-whirl.', start: 2.7, end: 3 }, { text: ' Oh', start: 5, end: 5.2 },
    ]);
    expect(words.map((w) => `${w.line}:${w.norm}`)).toEqual(['0:CANDY', '0:GIRL', '1:CANDY', '1:A', '1:WHIRL', '2:OH']);
    expect(hints[3]).toEqual({ start: 2.7, end: 3 });
  });
});

/** Emissions with one confident token per listed frame (blank elsewhere). */
function spikes(frames: number, at: Record<number, string>): Emissions {
  const V = 32;
  const logp = new Float32Array(frames * V).fill(Math.log(0.01 / (V - 1)));
  for (let t = 0; t < frames; t++) {
    const id = at[t] !== undefined ? ALIGNER_VOCAB[at[t]] : 0;
    logp[t * V + id] = Math.log(0.99);
  }
  return { logp, frames, vocab: V, frameSec: 0.02, offsetSec: 0 };
}

describe('character-model syllables', () => {
  it('decodes letters into words and syllables', () => {
    // "CANDY GIRL": C A N D Y | G I R L, one letter every 3 frames.
    const letters = 'CANDY|GIRL'.split('');
    const em = spikes(40, Object.fromEntries(letters.map((ch, i) => [3 + 3 * i, ch])));
    const syl = greedySyllables(em, ALIGNER_VOCAB);
    expect(syl.map((s) => s.text)).toEqual(['CAN', 'DY', 'GIRL']);
    syl.forEach((s, i) => expect(s.start).toBeCloseTo([0.06, 0.24, 0.42][i], 5));
  });
  it('fuses two sources so a letter heard in either stays likely', () => {
    const a = spikes(10, { 2: 'A' });
    const b = spikes(10, { 6: 'B' });
    const f = fuseEmissions(a, b, 0.5);
    const p = (t: number, ch: string) => Math.exp(f.logp[t * 32 + ALIGNER_VOCAB[ch]]);
    expect(p(2, 'A')).toBeGreaterThan(0.45);
    expect(p(6, 'B')).toBeGreaterThan(0.45);
  });
});
