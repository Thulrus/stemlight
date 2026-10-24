import { forcedAlign, frameTime, type Emissions, type TokenWindows } from './ctc';
import { wordPron, type PronDict } from './pron';
import type { LyricWord } from './text';

/** Token ids of a character CTC model (wav2vec2 "vocab.json"): letters, "'" and "|" between words. */
export type CharVocab = Record<string, number>;

export type TimedSpan = { text: string; start: number; end: number };
export type AlignedWord = TimedSpan & {
  line: number;
  lineText?: string;
  syllables: TimedSpan[];
  /** ARPAbet phones (empty for words not in the dictionary). */
  phones: TimedSpan[];
  /** mean log-prob of its letters */
  score: number;
};

/** Approximate time per word (e.g. Whisper's), used to keep the alignment near it. */
export type WordHint = { start: number; end: number } | undefined;

/**
 * Align lyric words to CTC character emissions. Syllables and phones (from the pronunciation
 * dictionary when given, else spelling rules) start where their first letter is emitted; a
 * word ends where its last letter's emission ends (CTC spikes are short, so the caller
 * extends ends from the audio). With `hints`, each word's letters are confined to ±`slack`
 * seconds around its hinted time.
 */
export function alignWords(
  em: Emissions,
  vocab: CharVocab,
  words: LyricWord[],
  opts: { hints?: WordHint[]; slack?: number; dict?: PronDict } = {},
): AlignedWord[] {
  if (!opts.hints) return alignOnce(em, vocab, words, opts);
  // Hints that are far off (a misheard or misplaced word) can make the windows impossible:
  // widen them, and failing that align without them.
  const slack = opts.slack ?? 2.5;
  for (const s of [slack, slack * 3]) {
    try {
      return alignOnce(em, vocab, words, { ...opts, slack: s });
    } catch {
      /* try wider */
    }
  }
  return alignOnce(em, vocab, words, { ...opts, hints: undefined });
}

function alignOnce(
  em: Emissions,
  vocab: CharVocab,
  words: LyricWord[],
  opts: { hints?: WordHint[]; slack?: number; dict?: PronDict },
): AlignedWord[] {
  const { hints, slack = 2.5, dict } = opts;
  const blank = vocab['<pad>'] ?? 0;
  const sep = vocab['|'];
  const tokens: number[] = [];
  const owner: number[] = []; // word index per token, −1 for separators
  const letterOf: number[] = []; // letter index within the word's norm
  words.forEach((w, wi) => {
    if (wi > 0 && sep !== undefined) { tokens.push(sep); owner.push(-1); letterOf.push(-1); }
    for (let i = 0; i < w.norm.length; i++) {
      const id = vocab[w.norm[i]];
      if (id === undefined) continue;
      tokens.push(id); owner.push(wi); letterOf.push(i);
    }
  });
  let windows: TokenWindows | undefined;
  if (hints) {
    const lo = new Int32Array(tokens.length);
    const hi = new Int32Array(tokens.length).fill(em.frames);
    const toFrame = (t: number) => Math.max(0, Math.min(em.frames, Math.round((t - em.offsetSec) / em.frameSec)));
    // Separators take their window from the following word.
    for (let k = tokens.length - 1, next: WordHint; k >= 0; k--) {
      const h = owner[k] >= 0 ? hints[owner[k]] : next;
      if (owner[k] >= 0) next = hints[owner[k]];
      if (h) { lo[k] = toFrame(h.start - slack); hi[k] = toFrame(h.end + slack); }
    }
    windows = { lo, hi };
  }
  const spans = forcedAlign(em, tokens, blank, windows);

  const letterStart = words.map((w) => new Float64Array(w.norm.length).fill(NaN));
  const out: AlignedWord[] = words.map((w) => ({ text: w.text, line: w.line, lineText: w.lineText, start: NaN, end: NaN, syllables: [], phones: [], score: 0 }));
  const scoreN = new Array<number>(words.length).fill(0);
  spans.forEach((s, k) => {
    const wi = owner[k];
    if (wi < 0) return;
    const t0 = frameTime(em, s.start);
    const t1 = frameTime(em, s.end);
    letterStart[wi][letterOf[k]] = t0;
    const o = out[wi];
    if (!(o.start <= t0)) o.start = t0;
    if (!(o.end >= t1)) o.end = t1;
    o.score += s.score;
    scoreN[wi]++;
  });
  words.forEach((w, wi) => {
    const o = out[wi];
    o.score /= Math.max(1, scoreN[wi]);
    if (Number.isNaN(o.start)) return;
    // A letter the model didn't emit (an apostrophe) starts with the next one that it did.
    const at = (l: number) => {
      for (let i = l; i < w.norm.length; i++) if (!Number.isNaN(letterStart[wi][i])) return letterStart[wi][i];
      return o.end;
    };
    const pron = wordPron(w.norm, dict);
    const timed = (parts: { text: string; letter: number }[]): TimedSpan[] => {
      const spans = parts.map((p, i) => ({ text: p.text, start: i === 0 ? o.start : at(p.letter), end: o.end }));
      // Keep starts ordered, then each part ends where the next begins.
      for (let i = 1; i < spans.length; i++) spans[i].start = Math.max(spans[i].start, spans[i - 1].start);
      for (let i = 0; i + 1 < spans.length; i++) spans[i].end = spans[i + 1].start;
      return spans.filter((x, i) => i === spans.length - 1 || x.end > x.start || parts.length === 1);
    };
    o.syllables = timed(pron.syllables);
    o.phones = timed(pron.phones.map((p) => ({ text: p.phone, letter: p.letter })));
  });
  return out.filter((o) => !Number.isNaN(o.start));
}

