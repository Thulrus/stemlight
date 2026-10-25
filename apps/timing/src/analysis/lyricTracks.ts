import type { AlignedWord, WordHint } from '../align/align';
import { PRESTON_BLAIR } from '../align/pron';
import type { LyricWord } from '../align/text';
import { normWord } from '../align/text';
import type { Mark, Track } from '@stemlight/core/types';
import type { Features } from '../dsp/features';
import type { AsrWord } from './lyrics';
import { DEFAULT_STEM_PARAMS, type StemParams } from './stems';

/**
 * offsetMs shifts every aligned start (CTC letter spikes come a little late); a word or
 * syllable ends where the vocal falls decayDb below its own peak, holding at most maxHold
 * seconds past its last letter.
 */
export type AlignParams = StemParams['lyrics'];

const clean = (s: string) => s.trim().replace(/^[\s"“”'(]+|[\s"“”)]+$/g, '');
const isWord = (s: string) =>
  /[\p{L}\p{N}]/u.test(s) && !/^[([].*[)\]]$/.test(s) && !/♪/.test(s) && s.length <= 24 && !/(\p{L})\1{4,}/u.test(s);

/**
 * Whisper's words as lyric words with line numbers and time hints. Lines break at sentence
 * punctuation, before a capitalized word after a comma, at pauses over `maxGap` seconds and
 * after `maxLineWords` words.
 */
export function wordsFromAsr(asr: AsrWord[], maxGap = 0.8, maxLineWords = 12): { words: LyricWord[]; hints: WordHint[] } {
  const words: LyricWord[] = [];
  const hints: WordHint[] = [];
  let line = 0;
  let inLine = 0;
  let prevText = '';
  let prevEnd = -Infinity;
  for (const w of asr) {
    const text = clean(w.text);
    if (!isWord(text)) continue;
    // Hyphenated or numeric tokens become several sung words; they share the hint.
    const parts = text.split(/(?<=\p{L})-(?=\p{L})/u).map((t) => ({ t, n: normWord(t) })).filter((x) => x.n);
    if (!parts.length) continue;
    const end = w.end ?? w.start + 0.3;
    if (words.length) {
      const sentence = /[.!?]$/.test(prevText);
      const comma = /[,;:]$/.test(prevText) && /^\p{Lu}/u.test(text) && text !== 'I' && !text.startsWith("I'");
      if (sentence || comma || w.start - prevEnd > maxGap || inLine >= maxLineWords) { line++; inLine = 0; }
    }
    for (const p of parts) {
      words.push({ text: p.t, norm: p.n, line });
      hints.push({ start: w.start, end });
      inLine++;
    }
    prevText = text;
    prevEnd = end;
  }
  return { words, hints };
}

/** (start, from, limit) → where the vocal falls `decayDb` below its peak since `start`, searching [from, limit]. */
function decayFinder(vocal: Features | undefined, decayDb: number) {
  const level = vocal ? levelDb(vocal) : undefined;
  const frame = (t: number) => (vocal ? Math.max(0, Math.min(vocal.nFrames - 1, Math.round(t * vocal.fps))) : 0);
  return (start: number, from: number, limit: number) => {
    if (!level || !vocal) return Math.min(limit, from + 0.2);
    let peak = -Infinity;
    for (let i = frame(start); i <= frame(from); i++) peak = Math.max(peak, level[i]);
    for (let i = frame(from); i <= frame(limit); i++) if (level[i] < peak - decayDb) return Math.max(from, i / vocal.fps);
    return limit;
  };
}

/** Frame level in dB of a stem (short-window RMS). */
function levelDb(f: Features): Float32Array {
  return Float32Array.from(f.rmsShort, (r) => 20 * Math.log10(r + 1e-9));
}

/**
 * Lyric tracks from aligned words: Lyric lines, Lyric words, Vocal syllables (labeled) and a
 * three-layer "Lyrics" track (lines, words, Preston Blair phonemes) for xLights singing faces.
 * Starts come from the aligner; a word holds until the next word or until `vocal` decays
 * `decayDb` below the word's peak, whichever is first.
 */
export function lyricTracks(aligned: AlignedWord[], vocal: Features | undefined, p: AlignParams = DEFAULT_STEM_PARAMS.lyrics): Track[] {
  const off = p.offsetMs / 1000;
  const decayEnd = decayFinder(vocal, p.decayDb);
  const words = aligned.map((w) => ({ ...w, start: w.start + off, end: w.end + off, syllables: w.syllables.map((s) => ({ ...s, start: s.start + off, end: s.end + off })), phones: w.phones.map((s) => ({ ...s, start: s.start + off, end: s.end + off })) }));
  const wordMarks: Mark[] = [];
  const sylMarks: Mark[] = [];
  const phoneMarks: Mark[] = [];
  words.forEach((w, i) => {
    const next = words[i + 1];
    const limit = Math.min(next ? next.start : Infinity, w.end + p.maxHold);
    const end = Math.max(w.start + 0.05, decayEnd(w.start, w.end, limit));
    wordMarks.push({ start: w.start, end, label: w.text });
    w.syllables.forEach((s, k) => sylMarks.push({ start: s.start, end: k + 1 < w.syllables.length ? s.end : end, label: s.text.toLowerCase() }));
    w.phones.forEach((ph, k) => phoneMarks.push({ start: ph.start, end: k + 1 < w.phones.length ? ph.end : end, label: PRESTON_BLAIR[ph.text] ?? 'etc' }));
  });
  const lineMarks: Mark[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j + 1 < words.length && words[j + 1].line === words[i].line) j++;
    lineMarks.push({ start: wordMarks[i].start, end: wordMarks[j].end, label: words[i].lineText ?? words.slice(i, j + 1).map((w) => w.text).join(' ') });
    i = j + 1;
  }
  const params = p as unknown as Record<string, number>;
  return [
    { id: 'vocals-lyric-lines', name: 'Lyric lines', source: 'vocals', marks: lineMarks, params },
    { id: 'vocals-lyric-words', name: 'Lyric words', source: 'vocals', marks: wordMarks, params },
    { id: 'vocals-lyric-syllables', name: 'Vocal syllables', source: 'vocals', marks: sylMarks, params },
    { id: 'vocals-lyrics', name: 'Lyrics', source: 'vocals', marks: lineMarks, layers: [wordMarks, phoneMarks], params },
  ];
}
