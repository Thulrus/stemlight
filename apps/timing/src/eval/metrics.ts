/** Precision/recall/F for event times matched one-to-one within ±tol seconds. */
export function eventF(est: number[], ref: number[], tol: number) {
  const e = [...est].sort((a, b) => a - b);
  const r = [...ref].sort((a, b) => a - b);
  let i = 0, j = 0, hits = 0;
  while (i < e.length && j < r.length) {
    const d = e[i] - r[j];
    if (Math.abs(d) <= tol) { hits++; i++; j++; }
    else if (d < 0) i++;
    else j++;
  }
  const precision = e.length ? hits / e.length : 0;
  const recall = r.length ? hits / r.length : 0;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f, hits, est: e.length, ref: r.length };
}

/** Time-overlap P/R/F between two sets of spans (total covered seconds). */
export function spanOverlapF(est: { start: number; end: number }[], ref: { start: number; end: number }[]) {
  const total = (xs: { start: number; end: number }[]) => xs.reduce((a, x) => a + (x.end - x.start), 0);
  let inter = 0;
  for (const a of est) for (const b of ref) inter += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const precision = total(est) ? inter / total(est) : 0;
  const recall = total(ref) ? inter / total(ref) : 0;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f };
}

type Span = { start: number; end: number };

/**
 * One-to-one matching of spans where both the start and the end are within ±tol seconds
 * (closest starts first). This is what "the mark lines up with my effect" means to a sequencer:
 * a mark with the right start but the wrong length still needs fixing by hand.
 */
export function spanF(est: Span[], ref: Span[], tol: number) {
  const e = [...est].sort((a, b) => a.start - b.start);
  const r = [...ref].sort((a, b) => a.start - b.start);
  const pairs: [number, number, number][] = [];
  let lo = 0;
  for (let i = 0; i < e.length; i++) {
    while (lo < r.length && r[lo].start < e[i].start - tol) lo++;
    for (let j = lo; j < r.length && r[j].start <= e[i].start + tol; j++) {
      if (Math.abs(e[i].end - r[j].end) <= tol) pairs.push([Math.abs(e[i].start - r[j].start) + Math.abs(e[i].end - r[j].end), i, j]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedE = new Uint8Array(e.length), usedR = new Uint8Array(r.length);
  let hits = 0;
  for (const [, i, j] of pairs) if (!usedE[i] && !usedR[j]) { usedE[i] = usedR[j] = 1; hits++; }
  const precision = e.length ? hits / e.length : 0;
  const recall = r.length ? hits / r.length : 0;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f, hits, est: e.length, ref: r.length };
}

/** Spans overlapping [lo, hi). */
export const within = <T extends Span>(xs: T[], lo: number, hi: number) => xs.filter((x) => x.end > lo && x.start < hi);
