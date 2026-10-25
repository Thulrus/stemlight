/** A sung word: how it's displayed, its letters for the aligner, and its lyric line (and that line as written, for pasted lyrics). */
export type LyricWord = { text: string; norm: string; line: number; lineText?: string };

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spell out 0–9999 the way it's usually sung ("1999" → "nineteen ninety nine"). */
export function numberWords(n: number): string[] {
  const below100 = (x: number): string[] => (x < 20 ? [ONES[x]] : [TENS[Math.floor(x / 10)], ...(x % 10 ? [ONES[x % 10]] : [])]);
  if (n < 100) return below100(n);
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? below100(n % 100) : [])];
  if (n >= 1100 && n < 10000 && n % 100 !== 0 && Math.floor(n / 100) % 10 !== 0) return [...below100(Math.floor(n / 100)), ...below100(n % 100)];
  if (n < 10000) return [ONES[Math.floor(n / 1000)], 'thousand', ...(n % 1000 ? numberWords(n % 1000) : [])];
  return String(n).split('').map((d) => ONES[+d]);
}

/** Letters the English character models know: A–Z and the apostrophe. */
export const normWord = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[’‘`]/g, "'").replace(/[^A-Z']/g, '').replace(/^'+|'+$/g, '');

/**
 * Split lyrics into words, one lyric line per text line. Hyphenated words ("a-searching")
 * and numbers become separate sung words; text in parentheses is kept (it's usually sung,
 * often by backing vocals). Blank lines and section tags like "[Chorus]" are skipped.
 */
export function parseLyrics(text: string): LyricWord[] {
  const out: LyricWord[] = [];
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\[[^\]]*\]/g, ' ').trim();
    if (!l) continue;
    let any = false;
    for (const tok of l.split(/[\s–—]+|(?<=\p{L})-(?=\p{L})/u)) {
      const display = tok.replace(/^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}'’!?.,;:]+$/gu, '');
      if (/^\d+$/.test(display.replace(/[^\d]/g, '')) && /\d/.test(display)) {
        for (const w of numberWords(parseInt(display.replace(/[^\d]/g, ''), 10))) out.push({ text: w, norm: normWord(w), line, lineText: l });
        any = true;
        continue;
      }
      const norm = normWord(display);
      if (!norm) continue;
      out.push({ text: display, norm, line, lineText: l });
      any = true;
    }
    if (any) line++;
  }
  return out;
}

const isVowel = (w: string, i: number) => {
  const c = w[i];
  if ('AEIOU'.includes(c)) return true;
  // Y is a vowel unless it starts a syllable before another vowel ("yes", "beyond").
  return c === 'Y' && i > 0 && !(i + 1 < w.length && 'AEIOU'.includes(w[i + 1]));
};
/** Consonant pairs that stay together at the start of a syllable. */
const ONSETS = new Set(['BL', 'BR', 'CH', 'CL', 'CR', 'DR', 'FL', 'FR', 'GL', 'GR', 'PH', 'PL', 'PR', 'SC', 'SH', 'SK', 'SL', 'SM', 'SN', 'SP', 'ST', 'SW', 'TH', 'TR', 'TW', 'WH', 'WR', 'QU', 'GU']);
/** Vowel pairs that are two syllables ("li-on", "cre-ate", "ri-ot"). */
const HIATUS = new Set(['IA', 'IO', 'EO', 'UO', 'IU']);

/**
 * Spelled syllables of a normalized word, e.g. "SEARCHING" → ["SEAR", "CHING"], "WORLD" →
 * ["WORLD"]. Rule-based (vowel groups, silent final E, -ED/-ES endings, maximal legal
 * onsets); it gets the count right for most sung words, and the aligner only needs where
 * each syllable's letters start.
 */
export function syllabify(word: string): string[] {
  const w = word.replace(/'/g, '');
  if (w.length <= 3) return [word];
  // Vowel groups = candidate nuclei, as [start, end) letter ranges.
  const groups: [number, number][] = [];
  for (let i = 0; i < w.length; ) {
    if (!isVowel(w, i)) { i++; continue; }
    let j = i + 1;
    while (j < w.length && isVowel(w, j) && !HIATUS.has(w.slice(j - 1, j + 1))) j++;
    groups.push([i, j]);
    i = j;
  }
  const n = w.length;
  const last = groups[groups.length - 1];
  if (groups.length > 1 && last) {
    const [ls, le] = last;
    const cons = (k: number) => k >= 0 && !isVowel(w, k);
    // Silent final E ("make", "love"), but not "-LE" after a consonant ("little").
    if (ls === n - 1 && w[ls] === 'E' && w[ls - 1] === 'L' && cons(ls - 2)) last[0] = n - 2; // syllabic L: lit-tle
    else if (ls === n - 1 && w[ls] === 'E' && cons(ls - 1)) groups.pop();
    // -ED is silent except after T/D ("wanted"); -ES only sounds after sibilants ("kisses").
    else if (le === n - 1 && ls === n - 2 && w.endsWith('ED') && !/[TD]ED$/.test(w)) groups.pop();
    else if (le === n - 1 && ls === n - 2 && w.endsWith('ES') && !/(S|X|Z|CH|SH|CE|GE)ES$/.test(w)) groups.pop();
  }
  if (groups.length <= 1) return [word];
  // Split the consonants between nuclei: none or one go right (ba-by, li-on); of two or
  // more, a legal onset pair goes right (sear-ching), otherwise just the last (hap-py).
  const cuts: number[] = [];
  for (let g = 0; g + 1 < groups.length; g++) {
    const a = groups[g][1];
    const b = groups[g + 1][0];
    const k = b - a;
    if (k <= 1) cuts.push(a);
    else cuts.push(ONSETS.has(w.slice(b - 2, b)) ? b - 2 : b - 1);
  }
  // Map cuts in the apostrophe-free word back onto the original.
  const parts: string[] = [];
  let pos = 0;
  let letters = 0;
  let cut = 0;
  for (let i = 0; i <= word.length; i++) {
    if (cut < cuts.length && letters === cuts[cut] && i > pos && word[i] !== "'") {
      parts.push(word.slice(pos, i));
      pos = i;
      cut++;
    }
    if (i < word.length && word[i] !== "'") letters++;
  }
  parts.push(word.slice(pos));
  return parts.filter(Boolean);
}
