import { syllabify } from './text';

/** Uppercase word → ARPAbet phones without stress ("CANDY" → K AE N D IY). */
export type PronDict = Map<string, string[]>;

/** Parse the "word PH ON ES" lines of public/cmudict.txt.gz (already decompressed). */
export function parsePronDict(text: string): PronDict {
  const d: PronDict = new Map();
  for (const line of text.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) d.set(line.slice(0, sp).toUpperCase(), line.slice(sp + 1).split(' '));
  }
  return d;
}

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
export const isVowelPhone = (p: string) => VOWELS.has(p);

/**
 * CMU phones to the Preston Blair mouth shapes xLights' singing faces use (the same table as
 * xLights' resources/dictionaries/phoneme_mapping, from Papagayo). "rest" is the closed mouth
 * between phrases.
 */
export const PRESTON_BLAIR: Record<string, string> = {
  AA: 'AI', AE: 'AI', AH: 'AI', AO: 'O', AW: 'O', AY: 'AI', B: 'MBP', CH: 'etc', D: 'etc', DH: 'etc', EH: 'E', ER: 'E',
  EY: 'E', F: 'FV', G: 'etc', HH: 'etc', IH: 'AI', IY: 'E', JH: 'etc', K: 'etc', L: 'L', M: 'MBP', N: 'etc', NG: 'etc',
  OW: 'O', OY: 'WQ', P: 'MBP', R: 'etc', S: 'etc', SH: 'etc', T: 'etc', TH: 'etc', UH: 'U', UW: 'U', V: 'FV', W: 'WQ',
  Y: 'etc', Z: 'etc', ZH: 'etc',
};

/** Letters a phone is usually spelled with (first letter of its common spellings). */
const SPELL: Record<string, string> = {
  AA: 'AOE', AE: 'AI', AH: 'AEIOUY', AO: 'OAU', AW: 'OA', AY: 'IYAE', B: 'B', CH: 'CT', D: 'DT', DH: 'T', EH: 'EAI', ER: 'EIUOAY',
  EY: 'AEI', F: 'FPG', G: 'GX', HH: 'HW', IH: 'IEYUA', IY: 'EIYA', JH: 'JGD', K: 'KCQXG', L: 'L', M: 'M', N: 'NKG', NG: 'NG',
  OW: 'OEA', OY: 'O', P: 'P', R: 'RW', S: 'SCXZ', SH: 'SCTX', T: 'TDC', TH: 'T', UH: 'UOE', UW: 'UOEW', V: 'VF', W: 'WUOQ',
  Y: 'YIJUE', Z: 'ZSX', ZH: 'SZGT',
};

/**
 * Which letter each phone starts at, by a small monotonic alignment: every phone takes 0–3
 * letters, preferring a first letter it's commonly spelled with; letters may also be silent.
 * Returns one letter index per phone (non-decreasing), for word letters without apostrophes.
 */
export function phoneLetters(letters: string, phones: string[]): number[] {
  const L = letters.length;
  const P = phones.length;
  const INF = 1e9;
  const cost = Array.from({ length: L + 1 }, () => new Float64Array(P + 1).fill(INF));
  const from = Array.from({ length: L + 1 }, () => new Int8Array(P + 1).fill(-1));
  cost[0][0] = 0;
  for (let i = 0; i <= L; i++) {
    for (let j = 0; j <= P; j++) {
      const c = cost[i][j];
      if (c >= INF) continue;
      // A silent letter.
      if (i < L && c + 1 < cost[i + 1][j]) { cost[i + 1][j] = c + 1; from[i + 1][j] = 9; }
      if (j === P) continue;
      const ok = SPELL[phones[j]] ?? '';
      // A phone with no letter of its own (the S of X, the Y of a long U).
      if (c + 1.5 < cost[i][j + 1]) { cost[i][j + 1] = c + 1.5; from[i][j + 1] = 0; }
      for (let k = 1; k <= 3 && i + k <= L; k++) {
        const v = c + (ok.includes(letters[i]) ? 0 : 2) + 0.3 * (k - 1);
        if (v < cost[i + k][j + 1]) { cost[i + k][j + 1] = v; from[i + k][j + 1] = k; }
      }
    }
  }
  const start = new Array<number>(P).fill(0);
  let i = L, j = P;
  while (i > 0 || j > 0) {
    const f = from[i][j];
    if (f === 9) { i--; continue; }
    if (f < 0) break;
    i -= f;
    j--;
    start[j] = i;
  }
  return start;
}

const ONSETS = new Set([
  'B L', 'B R', 'D R', 'D W', 'F L', 'F R', 'G L', 'G R', 'K L', 'K R', 'K W', 'P L', 'P R', 'S K', 'S L', 'S M', 'S N',
  'S P', 'S T', 'S W', 'T R', 'T W', 'TH R', 'SH R', 'TH W', 'G W', 'K Y', 'M Y', 'P Y', 'F Y', 'B Y', 'V Y', 'HH Y',
  'S T R', 'S K R', 'S P R', 'S P L', 'S K W', 'S K Y',
]);

/** Index of the first phone of each syllable (maximal legal onsets), starting with 0. */
export function phoneSyllables(phones: string[]): number[] {
  const nuclei = phones.map((p, i) => (isVowelPhone(p) ? i : -1)).filter((i) => i >= 0);
  if (nuclei.length <= 1) return [0];
  const starts = [0];
  for (let s = 1; s < nuclei.length; s++) {
    const a = nuclei[s - 1] + 1;
    const b = nuclei[s];
    let cut = b; // no consonants between: the new syllable starts at its vowel
    for (let k = a; k < b; k++) {
      const onset = phones.slice(k, b);
      if (onset.length === 1 ? onset[0] !== 'NG' : ONSETS.has(onset.join(' '))) { cut = k; break; }
    }
    starts.push(cut);
  }
  return starts;
}

export type WordPron = {
  /** Syllables as letter ranges of the normalized word (apostrophes included). */
  syllables: { text: string; letter: number }[];
  /** Phones with the letter each starts at, or none if the word isn't in the dictionary. */
  phones: { phone: string; letter: number }[];
};

/**
 * Syllables and phones of a normalized word. Dictionary words get the dictionary's syllable
 * count; others fall back to spelling rules (and no phones).
 */
export function wordPron(norm: string, dict?: PronDict): WordPron {
  const phones = dict?.get(norm) ?? dict?.get(norm.replace(/'/g, ''));
  // Letter indices in the word without apostrophes map back through `idx`.
  const idx: number[] = [];
  for (let i = 0; i < norm.length; i++) if (norm[i] !== "'") idx.push(i);
  if (!phones || idx.length === 0) {
    let at = 0;
    return { syllables: syllabify(norm).map((t) => { const s = { text: t, letter: at }; at += t.length; return s; }), phones: [] };
  }
  const letters = idx.map((i) => norm[i]).join('');
  const pl = phoneLetters(letters, phones).map((l) => idx[Math.min(l, idx.length - 1)]);
  // A doubled consonant splits between its letters (hal-lo-ween), though one phone spans both.
  const doubled = (l: number) => l + 1 < norm.length && norm[l] === norm[l + 1] && !'AEIOU'.includes(norm[l]);
  const sylStarts = phoneSyllables(phones).map((p, i) => (i > 0 && doubled(pl[p]) ? pl[p] + 1 : pl[p]));
  sylStarts[0] = 0;
  // Keep syllable letter starts strictly increasing; merge any that collapse.
  const cuts = sylStarts.filter((l, i) => i === 0 || l > sylStarts[i - 1]);
  const syllables = cuts.map((l, i) => ({ text: norm.slice(l, cuts[i + 1] ?? norm.length), letter: l }));
  return { syllables, phones: phones.map((phone, i) => ({ phone, letter: pl[i] })) };
}
