import type { Mark, Track } from '../core/types';

/** One recognized word with Whisper's (approximate, ±100–200 ms on singing) timing. */
export type AsrWord = { text: string; start: number; end: number | null };

export const DEFAULT_LYRIC_PARAMS = { snapWindow: 0.3, maxSilence: 0.5, maxLineWords: 12, leadIn: 1.5 };

const clean = (s: string) => s.trim().replace(/^[\s"“”'(]+|[\s"“”)]+$/g, '');
/**
 * Whisper tokens that aren't sung words: music notes, "(music)", "[laughs]", lone punctuation,
 * and its degenerate loops ("HOOOOPPPP…").
 */
const isWord = (s: string) =>
  /[\p{L}\p{N}]/u.test(s) && !/^[([].*[)\]]$/.test(s) && !/♪/.test(s) && s.length <= 24 && !/(\p{L})\1{4,}/u.test(s);

/**
 * Lyrics with our timing: Whisper says *what* was sung, our vocal tracks say *when*. Each word
 * is snapped to the nearest unused syllable start within `snapWindow` (keeping order), words
 * far from any vocal phrase are dropped (Whisper invents text over silence), and each word
 * ends at the next word or the end of its phrase. Phrases are labeled with their words.
 */
export function alignLyrics(
  words: AsrWord[],
  phrases: Mark[],
  syllables: Mark[],
  p = DEFAULT_LYRIC_PARAMS,
): { lines: Track; words: Track } {
  /** The phrase containing t, else the nearest one within maxSilence, else -1. */
  const phraseOf = (t: number) => {
    let best = -1;
    let bestDist = p.maxSilence;
    for (let i = 0; i < phrases.length; i++) {
      const ph = phrases[i];
      if (t >= ph.start && t < ph.end) return i;
      const d = t < ph.start ? ph.start - t : t - ph.end;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };
  const kept = words
    .map((w) => ({ ...w, text: clean(w.text) }))
    .filter((w) => isWord(w.text) && phraseOf(w.start) >= 0);

  const sylStarts = syllables.map((s) => s.start);
  let floor = -Infinity;
  let si = 0;
  const placed: { text: string; start: number; phrase: number }[] = [];
  for (const w of kept) {
    while (si < sylStarts.length && sylStarts[si] <= floor) si++;
    let best = -1;
    for (let j = si; j < sylStarts.length && sylStarts[j] <= w.start + p.snapWindow; j++) {
      if (sylStarts[j] < w.start - p.snapWindow) continue;
      if (best < 0 || Math.abs(sylStarts[j] - w.start) < Math.abs(sylStarts[best] - w.start)) best = j;
    }
    let start = best >= 0 ? sylStarts[best] : Math.max(w.start, floor + 0.05);
    // Whisper tends to time the first word after a pause late; the vocal phrase knows better.
    const ph = phraseOf(start);
    const firstInPhrase = ph >= 0 && (placed.length === 0 || placed[placed.length - 1].phrase !== ph);
    if (firstInPhrase && phrases[ph].start > floor && phrases[ph].start < start && start - phrases[ph].start < p.leadIn) {
      start = phrases[ph].start;
    }
    floor = start;
    placed.push({ text: w.text, start, phrase: phraseOf(start) });
  }

  const wordMarks: Mark[] = placed.map((w, i) => {
    const next = placed[i + 1];
    const ph = phrases[w.phrase];
    const phraseEnd = ph ? ph.end : w.start + 0.5;
    const end = next && next.phrase === w.phrase ? next.start : Math.max(phraseEnd, w.start + 0.1);
    return { start: w.start, end: Math.max(end, w.start + 0.05), label: w.text };
  });
  // Lines: break at phrase boundaries (breaths), at Whisper's sentence punctuation, before a
  // capitalized word after a comma (a new lyric line), and after maxLineWords words.
  const lineMarks: Mark[] = [];
  let line: number[] = [];
  const flush = () => {
    if (!line.length) return;
    const first = wordMarks[line[0]];
    const last = wordMarks[line[line.length - 1]];
    // A line runs until the next line starts or its phrase ends (the last word's end).
    lineMarks.push({ start: first.start, end: last.end, label: line.map((i) => wordMarks[i].label).join(' ') });
    line = [];
  };
  placed.forEach((w, i) => {
    const prev = placed[i - 1];
    if (prev) {
      const sentence = /[.!?]$/.test(prev.text);
      const comma = /[,;:]$/.test(prev.text) && /^\p{Lu}/u.test(w.text) && w.text !== 'I' && !w.text.startsWith("I'");
      if (prev.phrase !== w.phrase || sentence || comma || line.length >= p.maxLineWords) flush();
    }
    line.push(i);
  });
  flush();
  const params = p as unknown as Record<string, number>;
  return {
    lines: { id: 'vocals-lyric-lines', name: 'Lyric lines', source: 'vocals', marks: lineMarks, params },
    words: { id: 'vocals-lyric-words', name: 'Lyric words', source: 'vocals', marks: wordMarks, params },
  };
}
