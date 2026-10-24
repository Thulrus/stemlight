/** Hand-placed effects per model from an .xsq, in seconds (all layers merged). */
export function parseModelEffects(xsq: string): Map<string, { start: number; end: number; name: string }[]> {
  const out = new Map<string, { start: number; end: number; name: string }[]>();
  const body = xsq.slice(xsq.indexOf('<ElementEffects>'));
  for (const m of body.matchAll(/<Element type="model" name="([^"]+)">([\s\S]*?)<\/Element>/g)) {
    const effects = [...m[2].matchAll(/<Effect\b([^>]*)\/?>/g)].map((e) => ({
      name: /\bname="([^"]*)"/.exec(e[1])?.[1] ?? '',
      start: Number(/\bstartTime="(\d+)"/.exec(e[1])?.[1]) / 1000,
      end: Number(/\bendTime="(\d+)"/.exec(e[1])?.[1]) / 1000,
    }));
    out.set(m[1], effects.sort((a, b) => a.start - b.start));
  }
  return out;
}

/** Union of possibly-overlapping spans. */
export function unionSpans(spans: { start: number; end: number }[], gap = 0): { start: number; end: number }[] {
  const s = [...spans].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const x of s) {
    const prev = out[out.length - 1];
    if (prev && x.start <= prev.end + gap) prev.end = Math.max(prev.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}
