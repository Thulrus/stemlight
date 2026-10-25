import type { EffectIndex } from './effectIndex';
import type { Effect, Project, Row } from './types';

/** Project fields a change can replace wholesale (small arrays and scalars). */
export type FieldKey = 'name' | 'rows' | 'timingTracks' | 'sections' | 'colorSets' | 'bindings' | 'recipes' | 'layout';

/**
 * One undoable edit: the before/after of every effect it touched and of every field it
 * replaced. Undo applies "before", redo applies "after". Every project mutation goes
 * through one of these, which gives undo/redo, autosave and (later) recording replay.
 */
export type Change = {
  label: string;
  effects: Record<string, [Effect | null, Effect | null]>;
  fields: Partial<Record<FieldKey, [unknown, unknown]>>;
  /** Effect selection after the change (restored on redo); before (restored on undo). */
  selection?: [string[], string[]];
};

export function applyChange(p: Project, c: Change, dir: 'forward' | 'back', index?: EffectIndex): Project {
  const k = dir === 'forward' ? 1 : 0;
  const effects = { ...p.effects };
  for (const [id, pair] of Object.entries(c.effects)) {
    const old = effects[id];
    const next = pair[k];
    if (old) index?.remove(old);
    if (next) {
      effects[id] = next;
      index?.add(next);
    } else delete effects[id];
  }
  const out = { ...p, effects, updatedAt: Date.now() } as Project;
  for (const [key, pair] of Object.entries(c.fields) as [FieldKey, [unknown, unknown]][]) {
    (out as Record<string, unknown>)[key] = pair[k];
  }
  return out;
}

export function isEmptyChange(c: Change): boolean {
  return Object.keys(c.effects).length === 0 && Object.keys(c.fields).length === 0;
}

const sameEffect = (a: Effect | null, b: Effect | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Builds a Change against the current project. Reads see the transaction's own writes, so
 * several placements in one transaction resolve overlaps against each other. Times are
 * snapped to the frame grid and clamped to the song here, so no edit can leave the grid.
 */
export class Tx {
  private effects = new Map<string, Effect | null>();
  private fields = new Map<FieldKey, unknown>();
  /** Set when an edit was refused because its row is locked. */
  lockedHit = false;

  constructor(readonly project: Project, private readonly index: EffectIndex) {}

  get frameMs() { return this.project.frameMs; }
  get durationMs() { return this.project.audio.durationMs; }

  get(id: string): Effect | undefined {
    if (this.effects.has(id)) return this.effects.get(id) ?? undefined;
    return this.project.effects[id];
  }

  get rows(): Row[] {
    return (this.fields.get('rows') as Row[] | undefined) ?? this.project.rows;
  }

  row(id: string): Row | undefined {
    return this.rows.find((r) => r.id === id);
  }

  updateRow(id: string, patch: Partial<Row>) {
    this.setField('rows', this.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  setField<K extends FieldKey>(key: K, value: Project[K]) {
    this.fields.set(key, value);
  }

  field<K extends FieldKey>(key: K): Project[K] {
    return (this.fields.has(key) ? this.fields.get(key) : this.project[key]) as Project[K];
  }

  /** Effects of a row layer as of this transaction, sorted by start. */
  layerEffects(rowId: string, layer: number): Effect[] {
    const base = this.index.layer(rowId, layer).filter((e) => !this.effects.has(e.id));
    for (const e of this.effects.values()) if (e && e.rowId === rowId && e.layer === layer) base.push(e);
    return base.sort((a, b) => a.startMs - b.startMs);
  }

  /** All effects of a row as of this transaction. */
  rowEffects(rowId: string): Effect[] {
    const n = Math.max(this.row(rowId)?.layers ?? 1, this.index.layers(rowId).length);
    const out: Effect[] = [];
    for (let l = 0; l < n + 1; l++) out.push(...this.layerEffects(rowId, l));
    return out;
  }

  snap(t: number): number {
    return Math.round(t / this.frameMs) * this.frameMs;
  }

  /** Grid-snap and clamp an effect's times; at least one frame long. */
  normalize(e: Effect): Effect {
    const f = this.frameMs;
    const maxT = Math.floor(this.durationMs / f) * f;
    let start = Math.max(0, Math.min(maxT - f, this.snap(e.startMs)));
    let end = Math.max(start + f, Math.min(maxT, this.snap(e.endMs)));
    if (end > maxT) { end = maxT; start = Math.max(0, end - f); }
    const out = start === e.startMs && end === e.endMs ? e : { ...e, startMs: start, endMs: end };
    if (out.ramp) {
      const len = out.endMs - out.startMs;
      const rin = Math.max(0, Math.min(len, Math.round(out.ramp.in)));
      const rout = Math.max(0, Math.min(len - rin, Math.round(out.ramp.out)));
      if (rin !== out.ramp.in || rout !== out.ramp.out) return { ...out, ramp: { in: rin, out: rout } };
    }
    return out;
  }

  private writable(rowId: string): boolean {
    const r = this.row(rowId);
    if (r?.locked) { this.lockedHit = true; return false; }
    return true;
  }

  /** Write an effect as is (after normalizing). Callers keep layers overlap-free (see place). */
  put(e: Effect): Effect | null {
    if (!this.writable(e.rowId)) return null;
    const prev = this.get(e.id);
    if (prev && prev.rowId !== e.rowId && !this.writable(prev.rowId)) return null;
    const n = this.normalize(e);
    this.effects.set(n.id, n);
    return n;
  }

  del(id: string): boolean {
    const e = this.get(id);
    if (!e || !this.writable(e.rowId)) return false;
    this.effects.set(id, null);
    return true;
  }

  private overlaps(e: Effect, layer: number): Effect[] {
    return this.layerEffects(e.rowId, layer).filter((x) => x.id !== e.id && x.startMs < e.endMs && x.endMs > e.startMs);
  }

  /**
   * Place an effect without overlapping anything. 'overwrite' (default) stays on the requested
   * layer and cuts back (or removes) whatever it overlaps there, like a DAW; undo brings it
   * back. 'stack' keeps the requested layer if it's free, else the first free layer, else adds
   * a layer to the row.
   */
  place(e: Effect, mode: 'overwrite' | 'stack' = 'overwrite'): Effect | null {
    if (!this.writable(e.rowId)) return null;
    let n = this.normalize(e);
    const row = this.row(n.rowId);
    const layers = Math.max(1, row?.layers ?? 1);
    if (mode === 'overwrite') {
      if (n.layer >= layers || n.layer < 0) n = { ...n, layer: Math.max(0, Math.min(layers - 1, n.layer)) };
      for (const x of this.overlaps(n, n.layer)) {
        if (x.startMs >= n.startMs && x.endMs <= n.endMs) this.del(x.id);
        else if (x.startMs < n.startMs && x.endMs > n.endMs) {
          this.put({ ...x, endMs: n.startMs });
          this.put({ ...x, id: `${x.id}~${n.endMs}`, startMs: n.endMs });
        } else if (x.startMs < n.startMs) this.put({ ...x, endMs: n.startMs });
        else this.put({ ...x, startMs: n.endMs });
      }
      return this.put(n);
    }
    const order = [n.layer, ...Array.from({ length: layers }, (_, i) => i).filter((i) => i !== n.layer)];
    for (const l of order) {
      if (l < layers && this.overlaps({ ...n, layer: l }, l).length === 0) return this.put({ ...n, layer: l });
    }
    n = { ...n, layer: layers };
    if (row) this.updateRow(row.id, { layers: layers + 1 });
    return this.put(n);
  }

  commit(label: string, selection?: [string[], string[]]): Change {
    const effects: Change['effects'] = {};
    for (const [id, after] of this.effects) {
      const before = this.project.effects[id] ?? null;
      if (!sameEffect(before, after)) effects[id] = [before, after];
    }
    const fields: Change['fields'] = {};
    for (const [k, v] of this.fields) {
      if (JSON.stringify(this.project[k]) !== JSON.stringify(v)) fields[k] = [this.project[k], v];
    }
    return { label, effects, fields, selection };
  }
}
