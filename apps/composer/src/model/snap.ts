import type { Effect, Mark, Project, SnapMode, TimingTrack } from './types';

/** Sorted, unique mark boundaries (starts and ends) of a track: where effects snap to. */
export function boundaries(marks: readonly Mark[]): number[] {
  const set = new Set<number>();
  for (const m of marks) { set.add(m.start); set.add(m.end); }
  return [...set].sort((a, b) => a - b);
}

/** Index of the last value <= t (or -1). */
export function floorIndex(sorted: readonly number[], t: number): number {
  let lo = 0, hi = sorted.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
}

/** The boundary strictly after t, or undefined. */
export function nextBoundary(sorted: readonly number[], t: number): number | undefined {
  const i = floorIndex(sorted, t);
  return sorted[i + 1];
}

/** The boundary strictly before t, or undefined. */
export function prevBoundary(sorted: readonly number[], t: number): number | undefined {
  const i = floorIndex(sorted, t - 1);
  return i >= 0 ? sorted[i] : undefined;
}

/** The span between the boundaries around t: [b0, b1) with b0 <= t < b1. */
export function spanAround(sorted: readonly number[], t: number): [number, number] | undefined {
  const i = floorIndex(sorted, t);
  if (i < 0 || i + 1 >= sorted.length) return undefined;
  return [sorted[i], sorted[i + 1]];
}

export type SnapTarget = { t: number; label: string };

/** Snap candidates for a drag: built once at drag start, queried on every move. */
export class Snapper {
  private times: number[] = [];
  private labels: string[] = [];

  constructor(readonly mode: SnapMode, readonly frameMs: number) {}

  /** Add a track's boundaries. `subdivide` > 1 adds evenly spaced points between them (Grid mode). */
  addTrack(track: TimingTrack, subdivide = 1) {
    for (const m of track.marks) {
      this.push(m.start, `${track.name}${m.label ? ` · ${m.label}` : ''}`);
      this.push(m.end, `${track.name} · end`);
    }
    if (subdivide > 1) {
      const b = boundaries(track.marks);
      for (let i = 0; i + 1 < b.length; i++) {
        for (let k = 1; k < subdivide; k++) this.push(b[i] + ((b[i + 1] - b[i]) * k) / subdivide, `${track.name} · ${k}/${subdivide}`);
      }
    }
  }

  /** Edges of nearby effects ("magnetic edges"), so stacked effects line up. */
  addEdges(effects: Iterable<Effect>, rowName: (id: string) => string) {
    for (const e of effects) {
      this.push(e.startMs, `${rowName(e.rowId)} · edge`);
      this.push(e.endMs, `${rowName(e.rowId)} · edge`);
    }
  }

  private push(t: number, label: string) {
    this.times.push(Math.round(t / this.frameMs) * this.frameMs);
    this.labels.push(label);
  }

  /** Call after adding everything. */
  finish(): this {
    const order = this.times.map((_, i) => i).sort((a, b) => this.times[a] - this.times[b]);
    this.times = order.map((i) => this.times[i]);
    this.labels = order.map((i) => this.labels[i]);
    return this;
  }

  get active() { return this.mode !== 'off' && this.times.length > 0; }

  /** Nearest candidate to t (any distance), or undefined when snapping is off. */
  nearest(t: number): SnapTarget | undefined {
    if (!this.active) return undefined;
    const i = floorIndex(this.times, t);
    const a = i >= 0 ? i : 0;
    const b = Math.min(this.times.length - 1, i + 1);
    const best = Math.abs(this.times[a] - t) <= Math.abs(this.times[b] - t) ? a : b;
    return { t: this.times[best], label: this.labels[best] };
  }

  /** Snap t; with snapping off (or Shift held) only the frame grid applies. */
  snap(t: number, bypass = false): { t: number; target?: SnapTarget } {
    const target = bypass ? undefined : this.nearest(t);
    if (target) return { t: target.t, target };
    return { t: Math.round(t / this.frameMs) * this.frameMs };
  }
}

/** The tracks that drive snapping for a project's current snap mode. */
export function snapTracks(p: Project): TimingTrack[] {
  const visible = p.timingTracks.filter((t) => !p.view.hiddenTrackIds.includes(t.id));
  if (p.view.snap === 'any') return visible;
  const active = p.timingTracks.find((t) => t.id === p.view.activeTrackId);
  return active ? [active] : [];
}

/** Boundaries used by keyboard nudges and fills: the active track, else every visible track. */
export function activeBoundaries(p: Project): number[] {
  const tracks = snapTracks(p);
  const sections = p.sections.map((s) => ({ start: s.start, end: s.end, label: s.label }));
  const marks = tracks.length ? tracks.flatMap((t) => t.marks) : sections;
  return boundaries(marks);
}
