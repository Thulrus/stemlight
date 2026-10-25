import { defaultParams, effectDef, type EffectType } from '@stemlight/xlights/effects';
import type { ParamValue } from '@stemlight/xlights/settings';
import type { Tx } from './change';
import { uid } from './project';
import { nextBoundary, prevBoundary, spanAround } from './snap';
import type { Effect } from './types';

/**
 * Edit operations. Each works inside a transaction (Tx), which snaps times to the frame
 * grid, keeps layers free of overlaps and skips locked rows; the caller commits it as one
 * undoable change.
 */

export type Brush = { type: EffectType; colors: string[]; params: Record<string, ParamValue>; rampIn?: number; rampOut?: number };

export function brushEffect(rowId: string, startMs: number, endMs: number, brush: Brush, layer = 0): Effect {
  return {
    id: uid('e'),
    rowId,
    layer,
    startMs: Math.min(startMs, endMs),
    endMs: Math.max(startMs, endMs),
    type: brush.type,
    params: { ...defaultParams(brush.type), ...brush.params },
    colors: [...brush.colors].slice(0, 8),
    ramp: brush.rampIn || brush.rampOut ? { in: brush.rampIn ?? 0, out: brush.rampOut ?? 0 } : undefined,
    source: 'manual',
  };
}

export function create(tx: Tx, rowId: string, startMs: number, endMs: number, brush: Brush, layer = 0): Effect | null {
  return tx.place(brushEffect(rowId, startMs, endMs, brush, layer));
}

/** Fill the span between the marks around t (double-click, number key at the playhead). */
export function fillSpan(tx: Tx, rowId: string, t: number, brush: Brush, bounds: number[]): Effect | null {
  const span = spanAround(bounds, t);
  if (!span) return null;
  return create(tx, rowId, span[0], span[1], brush);
}

export function remove(tx: Tx, ids: Iterable<string>) {
  for (const id of ids) tx.del(id);
}

/** Detach bound effects when they are edited by hand. */
const edited = (e: Effect): Effect => (e.source === 'binding' ? { ...e, source: 'manual', bindingId: undefined } : e);

/**
 * Move effects in time and across rows. `rowFor` maps an effect's row to its target row
 * (vertical drag) and `dLayer` shifts layers (dragging between the lanes of a multi-layer
 * row). With `copy`, the originals stay and copies move. Whatever is underneath is overwritten.
 */
export function move(tx: Tx, ids: string[], dtMs: number, rowFor: (rowId: string) => string, opts: { copy?: boolean; dLayer?: number } = {}): string[] {
  const src = ids.map((id) => tx.get(id)).filter((e): e is Effect => !!e);
  if (!opts.copy) for (const e of src) tx.del(e.id);
  const out: string[] = [];
  for (const e of src) {
    const rowId = rowFor(e.rowId);
    const layers = Math.max(1, tx.row(rowId)?.layers ?? 1);
    const layer = Math.max(0, Math.min(layers - 1, e.layer + (opts.dLayer ?? 0)));
    const moved = { ...edited(e), id: opts.copy ? uid('e') : e.id, rowId, startMs: e.startMs + dtMs, endMs: e.endMs + dtMs, layer };
    const placed = tx.place(moved);
    if (placed) out.push(placed.id);
    else if (!opts.copy) tx.put(e); // locked target: put the original back
  }
  return out;
}

/** Move one edge of each effect by the same amount, keeping each at least one frame long. */
export function resize(tx: Tx, ids: string[], edge: 'start' | 'end', dtMs: number) {
  const f = tx.frameMs;
  const src = ids.map((id) => tx.get(id)).filter((e): e is Effect => !!e);
  for (const e of src) tx.del(e.id);
  for (const e of src) {
    const n = edge === 'start'
      ? { ...edited(e), startMs: Math.min(e.endMs - f, e.startMs + dtMs) }
      : { ...edited(e), endMs: Math.max(e.startMs + f, e.endMs + dtMs) };
    if (!tx.place(n)) tx.put(e);
  }
}

/** Set exact times for one effect (inspector fields, edge snaps). */
export function setTimes(tx: Tx, id: string, startMs: number, endMs: number) {
  const e = tx.get(id);
  if (!e) return;
  tx.del(id);
  if (!tx.place({ ...edited(e), startMs, endMs })) tx.put(e);
}

/** Stretch a selection proportionally around an anchor time (Ctrl+edge drag). */
export function stretch(tx: Tx, ids: string[], anchorMs: number, factor: number) {
  const src = ids.map((id) => tx.get(id)).filter((e): e is Effect => !!e);
  for (const e of src) tx.del(e.id);
  for (const e of src) {
    const s = anchorMs + (e.startMs - anchorMs) * factor;
    const t = anchorMs + (e.endMs - anchorMs) * factor;
    if (!tx.place({ ...edited(e), startMs: Math.min(s, t), endMs: Math.max(s, t) })) tx.put(e);
  }
}

/** Nudge the selection so its first effect starts on the previous/next mark. */
export function nudgeToMark(tx: Tx, ids: string[], dir: -1 | 1, bounds: number[]) {
  const src = ids.map((id) => tx.get(id)).filter((e): e is Effect => !!e);
  if (!src.length) return;
  const first = Math.min(...src.map((e) => e.startMs));
  const target = dir > 0 ? nextBoundary(bounds, first) : prevBoundary(bounds, first);
  if (target === undefined) return;
  move(tx, ids, target - first, (r) => r);
}

export function nudgeFrames(tx: Tx, ids: string[], frames: number) {
  move(tx, ids, frames * tx.frameMs, (r) => r);
}

/** Move one edge of each effect to the previous/next mark ([ and ], E and Shift+E). */
export function edgeToMark(tx: Tx, ids: string[], edge: 'start' | 'end', dir: -1 | 1, bounds: number[]) {
  for (const id of ids) {
    const e = tx.get(id);
    if (!e) continue;
    const at = edge === 'start' ? e.startMs : e.endMs;
    const t = dir > 0 ? nextBoundary(bounds, at) : prevBoundary(bounds, at);
    // Never collapse an effect.
    if (t === undefined || (edge === 'start' && t >= e.endMs) || (edge === 'end' && t <= e.startMs)) continue;
    setTimes(tx, id, edge === 'start' ? t : e.startMs, edge === 'end' ? t : e.endMs);
  }
}

/** Split effects at time t (S at the playhead, Alt+click). */
export function splitAt(tx: Tx, ids: string[], t: number): string[] {
  const out: string[] = [];
  const at = tx.snap(t);
  for (const id of ids) {
    const e = tx.get(id);
    if (!e || at <= e.startMs || at >= e.endMs) continue;
    const ramp = e.ramp;
    const left = tx.put({ ...edited(e), endMs: at, ramp: ramp ? { in: ramp.in, out: 0 } : undefined });
    const right = tx.put({ ...edited(e), id: uid('e'), startMs: at, ramp: ramp ? { in: 0, out: ramp.out } : undefined });
    if (left && right) out.push(left.id, right.id);
  }
  return out;
}

/** Split effects at every boundary inside them: a run of per-mark effects. */
export function splitAtMarks(tx: Tx, ids: string[], bounds: number[]) {
  for (const id of ids) {
    const e = tx.get(id);
    if (!e) continue;
    let cur = id;
    for (const b of bounds) {
      if (b <= e.startMs || b >= e.endMs) continue;
      const parts = splitAt(tx, [cur], b);
      if (parts.length === 2) cur = parts[1];
    }
  }
}

/** Merge touching or overlapping selected effects on the same row and layer; the first one's settings win. */
export function merge(tx: Tx, ids: string[]): string[] {
  const src = ids.map((id) => tx.get(id)).filter((e): e is Effect => !!e).sort((a, b) => a.startMs - b.startMs);
  const groups = new Map<string, Effect[]>();
  for (const e of src) {
    const k = `${e.rowId}:${e.layer}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out: string[] = [];
  for (const list of groups.values()) {
    let cur = list[0];
    for (let i = 1; i <= list.length; i++) {
      const e = list[i];
      // Merge across gaps too, as long as nothing unselected sits in between.
      const between = e && tx.layerEffects(cur.rowId, cur.layer).some((x) => x.startMs >= cur.endMs && x.endMs <= e.startMs && !ids.includes(x.id));
      if (e && !between) {
        tx.del(e.id);
        cur = { ...cur, endMs: Math.max(cur.endMs, e.endMs) };
        continue;
      }
      const put = tx.put(edited(cur));
      if (put) out.push(put.id);
      if (e) cur = e;
    }
  }
  return out;
}

/** Extend each effect to meet the next effect on its layer. */
export function closeGaps(tx: Tx, ids: string[]) {
  for (const id of ids) {
    const e = tx.get(id);
    if (!e) continue;
    const next = tx.layerEffects(e.rowId, e.layer).find((x) => x.startMs >= e.endMs);
    if (next && next.startMs > e.endMs) tx.put({ ...edited(e), endMs: next.startMs });
  }
}

export type EffectPatch = {
  type?: EffectType;
  colors?: string[];
  params?: Record<string, ParamValue>;
  rampIn?: number;
  rampOut?: number;
};

/** Change type, colors, parameters or fades of effects (inspector, number keys, C). */
export function patch(tx: Tx, ids: string[], p: EffectPatch) {
  for (const id of ids) {
    const e = tx.get(id);
    if (!e) continue;
    let n: Effect = edited(e);
    if (p.type && p.type !== e.type) {
      // Keep parameters the new type shares (none, usually); opaque effects become curated.
      n = { ...n, type: p.type, params: { ...defaultParams(p.type) }, raw: undefined, rawPalette: undefined };
    }
    if (p.colors?.length) n = { ...n, colors: p.colors.slice(0, 8), rawPalette: undefined };
    // Opaque effects of types the composer doesn't know can only be moved, not re-parameterized.
    const curated = !!effectDef(n.type);
    if (p.params && curated) {
      const known = new Set(effectDef(n.type)!.params.map((x) => x.id));
      const ps = Object.fromEntries(Object.entries(p.params).filter(([k]) => known.has(k)));
      if (Object.keys(ps).length) n = { ...n, params: { ...n.params, ...ps }, raw: undefined };
    }
    if (curated && (p.rampIn !== undefined || p.rampOut !== undefined)) {
      const ramp = { in: p.rampIn ?? e.ramp?.in ?? 0, out: p.rampOut ?? e.ramp?.out ?? 0 };
      n = { ...n, ramp: ramp.in || ramp.out ? ramp : undefined, raw: undefined };
    }
    tx.put(n);
  }
}
