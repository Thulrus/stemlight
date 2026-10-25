import type { Effect } from './types';

/**
 * Effects per row and layer, sorted by start. Effects in a layer never overlap, so ends are
 * sorted too, and visible-range queries are two binary searches. Updated incrementally by
 * each change, so the UI stays fast at tens of thousands of effects.
 */
export class EffectIndex {
  private byRow = new Map<string, Effect[][]>();

  constructor(effects?: Record<string, Effect>) {
    if (effects) for (const e of Object.values(effects)) this.add(e);
  }

  layers(rowId: string): readonly (readonly Effect[])[] {
    return this.byRow.get(rowId) ?? [];
  }

  layer(rowId: string, layer: number): readonly Effect[] {
    return this.byRow.get(rowId)?.[layer] ?? [];
  }

  /** Effects of one layer that intersect [t0, t1). */
  range(rowId: string, layer: number, t0: number, t1: number): readonly Effect[] {
    const list = this.layer(rowId, layer);
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].endMs <= t0) lo = m + 1; else hi = m; }
    let end = lo;
    while (end < list.length && list[end].startMs < t1) end++;
    return list.slice(lo, end);
  }

  /** The effect of a layer under time t, if any. */
  at(rowId: string, layer: number, t: number): Effect | undefined {
    const r = this.range(rowId, layer, t, t + 1);
    return r[0];
  }

  add(e: Effect) {
    let layers = this.byRow.get(e.rowId);
    if (!layers) this.byRow.set(e.rowId, (layers = []));
    while (layers.length <= e.layer) layers.push([]);
    const list = layers[e.layer];
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].startMs < e.startMs) lo = m + 1; else hi = m; }
    list.splice(lo, 0, e);
  }

  remove(e: Effect) {
    const list = this.byRow.get(e.rowId)?.[e.layer];
    if (!list) return;
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].startMs < e.startMs) lo = m + 1; else hi = m; }
    for (let i = Math.max(0, lo - 1); i < list.length && list[i].startMs <= e.startMs; i++) {
      if (list[i].id === e.id) { list.splice(i, 1); return; }
    }
    // Fallback: the stored copy may differ (shouldn't happen); scan.
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list.splice(i, 1);
  }
}
