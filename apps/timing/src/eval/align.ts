/**
 * Word-onset accuracy for lyrics alignment, as in the MIREX/JamendoLyrics evaluations: mean
 * absolute onset error and the share of onsets within 0.1/0.2/0.3 s. `est[i]` and `ref[i]`
 * are the same word; NaN estimates count as misses (and as a 1 s error).
 */
export function scoreOnsets(est: number[], ref: number[]) {
  const err = est.map((e, i) => (Number.isNaN(e) ? 1 : e - ref[i]));
  const abs = err.map(Math.abs).sort((a, b) => a - b);
  const n = Math.max(1, abs.length);
  const within = [0.1, 0.2, 0.3].map((tol) => abs.filter((a) => a <= tol).length / n);
  return {
    meanAbs: abs.reduce((a, b) => a + b, 0) / n,
    medianAbs: abs[Math.floor(abs.length / 2)] ?? 0,
    bias: err.filter((e) => Math.abs(e) < 0.3).reduce((a, b, _, xs) => a + b / xs.length, 0),
    within,
  };
}

/**
 * Pair up two word sequences (e.g. a transcript and the true lyrics) by edit distance, returning
 * index pairs of words that match exactly. Used to score transcribed-then-aligned words
 * against annotations of the real lyrics.
 */
export function matchWords(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Int32Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  const pairs: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (d[i][j] === d[i - 1][j - 1] + 1) { i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  return pairs.reverse();
}
