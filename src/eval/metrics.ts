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
