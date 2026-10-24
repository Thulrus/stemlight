import { describe, expect, it } from 'vitest';
import { alignLyrics, type AsrWord } from '../src/analysis/lyrics';

const span = (start: number, end: number) => ({ start, end });

describe('alignLyrics', () => {
  const phrases = [span(1.0, 4.0), span(5.0, 8.0)];
  const syllables = [1.0, 1.4, 1.9, 2.5, 3.1, 5.0, 5.6, 6.3, 7.0].map((t, i, a) => span(t, a[i + 1] ?? 8));

  it('snaps words to syllables, pulls a late first word back to the phrase start, and labels lines', () => {
    const words: AsrWord[] = [
      { text: ' Boys', start: 1.3, end: 1.5 }, // late first word: pulled to 1.0
      { text: ' and', start: 1.5, end: 1.7 },
      { text: ' girls,', start: 1.95, end: 2.3 },
      { text: ' Of', start: 2.6, end: 2.9 }, // capital after comma: new line
      { text: ' every', start: 3.0, end: 3.3 },
      { text: ' ♪', start: 4.4, end: 4.6 }, // not a word
      { text: ' HOOOOOOOOPPP', start: 4.5, end: 4.8 }, // degenerate loop
      { text: ' age.', start: 5.7, end: 6.0 },
      { text: ' Town', start: 6.25, end: 6.6 },
      { text: ' ghost', start: 30, end: 31 }, // far from any vocals: dropped
    ];
    const { lines, words: w } = alignLyrics(words, phrases, syllables);
    expect(w.marks.map((m) => [m.label, m.start])).toEqual([
      ['Boys', 1.0], ['and', 1.4], ['girls,', 1.9], ['Of', 2.5], ['every', 3.1], ['age.', 5.0], ['Town', 6.3],
    ]);
    expect(lines.marks.map((m) => m.label)).toEqual(['Boys and girls,', 'Of every', 'age.', 'Town']);
    expect(lines.marks[0].start).toBe(1.0);
    // Words end at the next word, or their phrase's end.
    expect(w.marks[4].end).toBe(4.0);
  });

  it('keeps word order when several words want the same syllable', () => {
    const words: AsrWord[] = [
      { text: 'a', start: 1.38, end: null },
      { text: 'b', start: 1.42, end: null },
    ];
    const starts = alignLyrics(words, phrases, syllables).words.marks.map((m) => m.start);
    expect(starts[1]).toBeGreaterThan(starts[0]);
  });
});

describe('Whisper filler', () => {
  it('drops sentences that are only filler, and keeps lyrics that contain the same words', async () => {
    const { dropFiller } = await import('../src/lyrics/transcribe');
    const words = (s: string) => s.split(' ').map((text) => ({ text }));
    const kept = dropFiller(words('Music. Thank you. Cara mia, addio! [Music] Thank you for the music.')).map((w) => w.text);
    expect(kept).toEqual(['Cara', 'mia,', 'addio!', 'Thank', 'you', 'for', 'the', 'music.']);
  });
});
