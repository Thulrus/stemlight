import { effectDef } from '@stemlight/xlights/effects';
import * as ops from '../model/ops';
import { Snapper, activeBoundaries, boundaries, snapTracks } from '../model/snap';
import type { Effect, Project, Row } from '../model/types';
import type { Store } from '../state/store';
import { formatTime } from './dom';
import { layoutRows, MINIMAP_H, pinnedLanes, sectionHue, type PinnedLane, type RowSlot } from './geometry';

export type Peaks = { min: Float32Array; max: Float32Array; binsPerSec: number };

export type TimelineHost = {
  store: Store;
  peaks?: Peaks;
  currentMs(): number;
  isPlaying(): boolean;
  seek(ms: number): void;
  brush(rowId?: string): ops.Brush;
  loop(): { start: number; end: number } | null;
  setLoop(range: { start: number; end: number } | null): void;
  rowFilter(): string;
  /** View (zoom/scroll) changed: re-sync the row list. */
  onView(): void;
  onRename(sectionId: string, rect: DOMRect): void;
  notice(msg: string): void;
};

type Hit =
  | { zone: 'ruler' | 'wave' | 'minimap' | 'none' }
  | { zone: 'sections'; sectionId?: string }
  | { zone: 'track'; lane: Extract<PinnedLane, { kind: 'track' }> }
  | { zone: 'rows'; slot?: RowSlot; layer: number; t: number; effect?: Effect; part?: 'body' | 'start' | 'end' | 'rampIn' | 'rampOut' };

type Drag =
  | { kind: 'seek' }
  | { kind: 'minimap' }
  | { kind: 'pan'; x0: number; view0: number; y0: number; scroll0: number }
  | { kind: 'create'; slot: RowSlot; layer: number; t0: number; t1: number; started: boolean; x0: number; y0: number; additive: boolean; clickT: number }
  | { kind: 'move'; ids: string[]; grab: Effect; slot: RowSlot; x0: number; y0: number; started: boolean; dt: number; dRow: number; dLayer: number; copy: boolean; altClick: boolean; t: number }
  | { kind: 'resize'; ids: string[]; grab: Effect; edge: 'start' | 'end'; dt: number; stretch: boolean }
  | { kind: 'ramp'; id: string; side: 'in' | 'out'; value: number }
  /** A selection box, kept in content coordinates (time, y within the rows) so it survives scrolling. */
  | { kind: 'band'; t0: number; cy0: number; t1: number; cy1: number; x0: number; y0: number; started: boolean; mode: 'replace' | 'add' | 'toggle'; slot?: RowSlot; clickT: number };

type Colors = ReturnType<typeof readColors>;
function readColors(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v('--lane-bg'), alt: v('--lane-alt'), sel: v('--lane-sel'), grid: v('--grid'), gridStrong: v('--grid-strong'),
    text: v('--text'), dim: v('--text-dim'), faint: v('--text-faint'), wave: v('--wave'), cursor: v('--cursor'),
    mark: v('--mark'), markActive: v('--mark-active'), selOutline: v('--sel-outline'), guide: v('--guide'),
    panel: v('--panel'), line: v('--line'), accent: v('--accent'), dark: v('--is-dark') === '1',
  };
}

const EDGE_PX = 6;

/** Relative luminance of a #rrggbb color, 0..1. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
const DRAG_PX = 3;

/**
 * The editor surface: pinned timing lanes on top (ruler, waveform, sections, timing
 * tracks), effect rows below, a minimap at the bottom. Canvas 2D only; static content is
 * cached in an offscreen canvas so playback only redraws the playhead and overlays.
 */
export class Timeline {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly stat: HTMLCanvasElement;
  private readonly sg: CanvasRenderingContext2D;
  private colors!: Colors;

  viewStartMs = 0;
  pxPerMs = 0.08;
  scrollY = 0;
  slots: RowSlot[] = [];
  rowsHeight = 0;
  lanes: PinnedLane[] = [];
  pinnedH = 0;

  private w = 0;
  private hgt = 0;
  private staticDirty = true;
  private raf = 0;
  private drag?: Drag;
  private guide?: { t: number; label: string };
  private hover?: Hit;
  private pointerInside = false;
  private pointer = { x: 0, y: 0, shift: false, alt: false, ctrl: false };
  private snapper?: Snapper;
  private lastPlayMs = -1;
  private viewSaveTimer = 0;

  constructor(private readonly host: HTMLElement, private readonly h: TimelineHost) {
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Sequence timeline');
    host.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.stat = document.createElement('canvas');
    this.sg = this.stat.getContext('2d')!;
    const v = h.store.project.view;
    if (v.pxPerSec) this.pxPerMs = v.pxPerSec / 1000;
    if (v.viewStartMs) this.viewStartMs = v.viewStartMs;
    if (v.scrollY) this.scrollY = v.scrollY;
    new ResizeObserver(() => this.resize()).observe(host);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag());
    this.canvas.addEventListener('pointerenter', () => { this.pointerInside = true; });
    this.canvas.addEventListener('pointerleave', () => { this.pointerInside = false; this.hover = undefined; this.invalidate(false); });
    this.canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContext(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.relayout();
    this.loop();
  }

  // ---------- geometry ----------

  get width() { return this.w; }
  get rowsTop() { return this.pinnedH; }
  get rowsBottom() { return this.hgt - MINIMAP_H; }
  get rowsViewH() { return Math.max(0, this.rowsBottom - this.rowsTop); }
  get viewEndMs() { return this.viewStartMs + this.w / this.pxPerMs; }
  get durationMs() { return this.h.store.project.audio.durationMs; }

  x(ms: number) { return (ms - this.viewStartMs) * this.pxPerMs; }
  t(x: number) { return this.viewStartMs + x / this.pxPerMs; }

  /** Recompute lanes and row slots (after rows, tracks or filter change). */
  relayout() {
    const p = this.h.store.project;
    const pl = pinnedLanes(p);
    this.lanes = pl.lanes;
    this.pinnedH = pl.height;
    const rl = layoutRows(p, this.h.rowFilter());
    this.slots = rl.slots;
    this.rowsHeight = rl.height;
    this.clampScroll();
    this.invalidate();
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.host.clientWidth;
    this.hgt = this.host.clientHeight;
    for (const c of [this.canvas, this.stat]) {
      c.width = Math.max(1, Math.round(this.w * dpr));
      c.height = Math.max(1, Math.round(this.hgt * dpr));
    }
    if (!this.h.store.project.view.pxPerSec) this.fitAll(false);
    this.clampView();
    this.clampScroll();
    this.invalidate();
    this.h.onView();
  }

  /** Mark the static layer for redraw (or only overlays when `full` is false). */
  invalidate(full = true) {
    if (full) this.staticDirty = true;
    this.lastPlayMs = -1;
  }

  private clampView() {
    const minPx = this.durationMs ? (this.w * 0.98) / this.durationMs : 0.01;
    this.pxPerMs = Math.max(minPx, Math.min(4, this.pxPerMs));
    const span = this.w / this.pxPerMs;
    this.viewStartMs = Math.max(0, Math.min(this.viewStartMs, Math.max(0, this.durationMs - span)));
  }

  private clampScroll() {
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, this.rowsHeight - this.rowsViewH + 40)));
  }

  private viewChanged() {
    this.clampView();
    this.clampScroll();
    this.invalidate();
    this.h.onView();
    clearTimeout(this.viewSaveTimer);
    this.viewSaveTimer = window.setTimeout(() => {
      this.h.store.setView({ pxPerSec: this.pxPerMs * 1000, viewStartMs: this.viewStartMs, scrollY: this.scrollY });
    }, 400);
  }

  zoomAt(factor: number, anchorX = this.w / 2) {
    const t = this.t(anchorX);
    this.pxPerMs *= factor;
    this.clampView();
    this.viewStartMs = t - anchorX / this.pxPerMs;
    this.viewChanged();
  }

  zoomTo(startMs: number, endMs: number, margin = 0.04) {
    const span = Math.max(200, endMs - startMs);
    this.pxPerMs = this.w / (span * (1 + 2 * margin));
    this.clampView();
    this.viewStartMs = startMs - span * margin;
    this.viewChanged();
  }

  fitAll(notify = true) {
    if (!this.durationMs || !this.w) return;
    this.pxPerMs = (this.w * 0.98) / this.durationMs;
    this.viewStartMs = 0;
    if (notify) this.viewChanged();
  }

  scrollBy(dy: number) {
    this.scrollY += dy;
    this.viewChanged();
  }

  panBy(dx: number) {
    this.viewStartMs += dx / this.pxPerMs;
    this.viewChanged();
  }

  /** Make sure a row is in view. */
  revealRow(rowId: string) {
    const s = this.slots.find((x) => x.row.id === rowId);
    if (!s) return;
    if (s.y < this.scrollY) this.scrollY = s.y;
    else if (s.y + s.h > this.scrollY + this.rowsViewH) this.scrollY = s.y + s.h - this.rowsViewH;
    this.viewChanged();
  }

  /** Keep a time in view, paging like a DAW. */
  follow(ms: number) {
    if (this.drag || this.pointerInside) return;
    const span = this.viewEndMs - this.viewStartMs;
    if (ms > this.viewEndMs - span * 0.02 || ms < this.viewStartMs) {
      this.viewStartMs = ms - span * 0.05;
      this.viewChanged();
    }
  }

  slotAtY(y: number): RowSlot | undefined {
    const cy = y - this.rowsTop + this.scrollY;
    let lo = 0, hi = this.slots.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const s = this.slots[m];
      if (cy < s.y) hi = m - 1;
      else if (cy >= s.y + s.h) lo = m + 1;
      else return s;
    }
    return undefined;
  }

  slotY(s: RowSlot) { return this.rowsTop + s.y - this.scrollY; }

  // ---------- hit testing ----------

  private hit(x: number, y: number): Hit {
    if (y >= this.rowsBottom) return { zone: 'minimap' };
    if (y < this.pinnedH) {
      const lane = this.lanes.find((l) => y >= l.y && y < l.y + l.h);
      if (!lane) return { zone: 'none' };
      if (lane.kind === 'track') return { zone: 'track', lane };
      if (lane.kind === 'sections') {
        const t = this.t(x);
        return { zone: 'sections', sectionId: this.h.store.project.sections.find((s) => t >= s.start && t < s.end)?.id };
      }
      return { zone: lane.kind };
    }
    const slot = this.slotAtY(y);
    const t = this.t(x);
    if (!slot) return { zone: 'rows', layer: 0, t };
    const layer = slot.row.collapsed ? -1 : Math.min(slot.lanes - 1, Math.floor((y - this.slotY(slot)) / slot.laneH));
    const tol = 3 / this.pxPerMs;
    const layers = layer < 0 ? Array.from({ length: Math.max(1, slot.row.layers) }, (_, i) => i) : [layer];
    for (const l of layers) {
      const cands = this.h.store.index.range(slot.row.id, l, t - tol, t + tol);
      // Prefer the effect actually under the pointer, then the nearest.
      const e = cands.find((c) => t >= c.startMs && t < c.endMs) ?? cands[0];
      if (!e) continue;
      const x0 = this.x(e.startMs), x1 = this.x(e.endMs);
      const ly = this.slotY(slot) + (slot.row.collapsed ? 0 : e.layer * slot.laneH);
      const edge = Math.min(EDGE_PX, (x1 - x0) / 3);
      let part: 'body' | 'start' | 'end' | 'rampIn' | 'rampOut' = 'body';
      // Fade handles sit in the top band of selected effects, where they are drawn.
      if (y - ly < 9 && effectDef(e.type) && slot.laneH >= 18 && x1 - x0 > 16 && this.h.store.selection.has(e.id)) {
        const rin = Math.max(x0 + 4, Math.min(x1 - 4, this.x(e.startMs + (e.ramp?.in ?? 0))));
        const rout = Math.max(x0 + 4, Math.min(x1 - 4, this.x(e.endMs - (e.ramp?.out ?? 0))));
        if (Math.abs(x - rin) <= 6) part = 'rampIn';
        else if (Math.abs(x - rout) <= 6) part = 'rampOut';
      }
      if (part === 'body') {
        if (x - x0 <= edge) part = 'start';
        else if (x1 - x <= edge) part = 'end';
      }
      return { zone: 'rows', slot, layer: e.layer, t, effect: e, part };
    }
    return { zone: 'rows', slot, layer: Math.max(0, layer), t };
  }

  private cursorFor(hit: Hit): string {
    if (hit.zone === 'rows') {
      if (!hit.slot) return 'default';
      if (hit.slot.row.locked) return 'not-allowed';
      if (!hit.effect) return this.h.store.project.view.dragMode === 'draw' ? 'crosshair' : 'default';
      if (hit.part === 'start' || hit.part === 'end') return 'ew-resize';
      if (hit.part === 'rampIn' || hit.part === 'rampOut') return 'col-resize';
      return this.pointer.alt ? 'copy' : 'grab';
    }
    if (hit.zone === 'sections' || hit.zone === 'track' || hit.zone === 'ruler' || hit.zone === 'wave' || hit.zone === 'minimap') return 'pointer';
    return 'default';
  }

  // ---------- snapping ----------

  private buildSnapper(exclude: Set<string>, nearRows: RowSlot[]): Snapper {
    const p = this.h.store.project;
    const s = new Snapper(p.view.snap, p.frameMs);
    if (p.view.snap !== 'off') {
      for (const t of snapTracks(p)) s.addTrack(t, p.view.snap === 'grid' ? 2 : 1);
      if (!snapTracks(p).length) for (const sec of p.sections) s.addTrack({ id: 's', name: 'Sections', source: 'xtiming', marks: [{ start: sec.start, end: sec.end, label: sec.label }] });
      // Magnetic edges: effects on the rows involved and their neighbors.
      const idx = new Set<number>();
      for (const r of nearRows) for (let d = -1; d <= 1; d++) idx.add(r.index + d);
      const edges: Effect[] = [];
      for (const i of idx) {
        const slot = this.slots[i];
        if (!slot) continue;
        const span = this.viewEndMs - this.viewStartMs;
        const n = this.h.store.index.layers(slot.row.id).length;
        for (let l = 0; l < n; l++) {
          for (const e of this.h.store.index.range(slot.row.id, l, this.viewStartMs - span, this.viewEndMs + span)) if (!exclude.has(e.id)) edges.push(e);
        }
      }
      const names = new Map(p.rows.map((r) => [r.id, r.name]));
      s.addEdges(edges, (id) => names.get(id) ?? '');
    }
    return s.finish();
  }

  private snapT(t: number, bypass: boolean): number {
    const r = this.snapper ? this.snapper.snap(t, bypass) : { t: Math.round(t / this.h.store.project.frameMs) * this.h.store.project.frameMs };
    this.guide = 'target' in r && r.target ? r.target : undefined;
    return r.t;
  }

  // ---------- pointer ----------

  private local(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent) {
    this.canvas.focus({ preventScroll: true });
    const { x, y } = this.local(e);
    this.pointer = { x, y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    const store = this.h.store;
    if (e.button === 1) {
      this.drag = { kind: 'pan', x0: x, view0: this.viewStartMs, y0: y, scroll0: this.scrollY };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const hit = this.hit(x, y);
    this.canvas.setPointerCapture(e.pointerId);
    switch (hit.zone) {
      case 'ruler':
      case 'wave':
      case 'track':
        this.drag = { kind: 'seek' };
        this.h.seek(Math.max(0, Math.min(this.durationMs, this.t(x))));
        return;
      case 'minimap':
        this.drag = { kind: 'minimap' };
        this.minimapTo(x);
        return;
      case 'sections': {
        const sec = store.project.sections.find((s) => s.id === hit.sectionId);
        if (sec) {
          this.h.seek(sec.start);
          this.selectSection(sec.start, sec.end, this.pointer.shift || this.pointer.ctrl);
        }
        this.drag = { kind: 'seek' };
        return;
      }
      case 'rows':
        break;
      default:
        return;
    }
    if (!hit.slot) {
      this.startBand(x, y, undefined, hit.t);
      return;
    }
    const slot = hit.slot;
    if (hit.effect) {
      const eff = hit.effect;
      const sel = store.selection;
      if (this.pointer.ctrl && hit.part === 'body') store.select([eff.id], 'toggle');
      else if (this.pointer.shift) store.select([eff.id], 'add');
      else if (!sel.has(eff.id)) store.select([eff.id]);
      store.selectRows([slot.row.id], this.pointer.shift ? 'add' : 'replace');
      const ids = [...store.selection].filter((id) => store.project.effects[id]);
      if (!ids.includes(eff.id)) return; // toggled off
      if (hit.part === 'rampIn' || hit.part === 'rampOut') {
        this.drag = { kind: 'ramp', id: eff.id, side: hit.part === 'rampIn' ? 'in' : 'out', value: hit.part === 'rampIn' ? eff.ramp?.in ?? 0 : eff.ramp?.out ?? 0 };
      } else if (hit.part === 'start' || hit.part === 'end') {
        this.snapper = this.buildSnapper(new Set(ids), this.slotsOf(ids));
        this.drag = { kind: 'resize', ids, grab: eff, edge: hit.part, dt: 0, stretch: this.pointer.ctrl };
      } else {
        this.drag = { kind: 'move', ids, grab: eff, slot, x0: x, y0: y, started: false, dt: 0, dRow: 0, dLayer: 0, copy: this.pointer.alt, altClick: this.pointer.alt, t: hit.t };
      }
      this.invalidate();
      return;
    }
    // Empty space in a row: a selection box in Select mode (or with Ctrl), an effect in Draw mode.
    if (store.project.view.dragMode !== 'draw' || this.pointer.ctrl) {
      this.startBand(x, y, slot, hit.t);
      return;
    }
    this.snapper = this.buildSnapper(new Set(), [slot]);
    const t0 = this.snapT(hit.t, this.pointer.shift);
    this.drag = { kind: 'create', slot, layer: hit.layer, t0, t1: t0, started: false, x0: x, y0: y, additive: this.pointer.shift, clickT: hit.t };
  }

  private startBand(x: number, y: number, slot: RowSlot | undefined, clickT: number) {
    const select = this.h.store.project.view.dragMode !== 'draw';
    // Select mode: Shift adds, Ctrl toggles. Draw mode (where Ctrl makes the box): Shift adds.
    const mode = this.pointer.shift ? 'add' : select && this.pointer.ctrl ? 'toggle' : 'replace';
    const cy = y - this.rowsTop + this.scrollY;
    this.drag = { kind: 'band', t0: this.t(x), cy0: cy, t1: this.t(x), cy1: cy, x0: x, y0: y, started: false, mode, slot, clickT };
  }

  /** Effects touched by a selection box. */
  private bandIds(d: Extract<Drag, { kind: 'band' }>): string[] {
    const t0 = Math.min(d.t0, d.t1), t1 = Math.max(d.t0, d.t1);
    const y0 = Math.min(d.cy0, d.cy1), y1 = Math.max(d.cy0, d.cy1);
    const ids: string[] = [];
    for (const s of this.slots) {
      if (s.y + s.h <= y0 || s.y >= y1) continue;
      for (let l = 0; l < Math.max(1, s.row.layers); l++) {
        const ly = s.row.collapsed ? s.y : s.y + l * s.laneH;
        const lh = s.row.collapsed ? s.h : s.laneH;
        if (ly + lh <= y0 || ly >= y1) continue;
        for (const ef of this.h.store.index.range(s.row.id, l, t0, t1)) ids.push(ef.id);
      }
    }
    return ids;
  }

  private slotsOf(ids: string[]): RowSlot[] {
    const rows = new Set(ids.map((id) => this.h.store.project.effects[id]?.rowId));
    return this.slots.filter((s) => rows.has(s.row.id));
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.local(e);
    this.pointer = { x, y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    const d = this.drag;
    if (!d) {
      const hit = this.hit(x, y);
      this.hover = hit;
      this.canvas.style.cursor = this.cursorFor(hit);
      this.invalidate(false);
      return;
    }
    this.updateDrag(d, x, y);
    this.invalidate(false);
  }

  private updateDrag(d: Drag, x: number, y: number) {
    const bypass = this.pointer.shift;
    const f = this.h.store.project.frameMs;
    switch (d.kind) {
      case 'seek':
        this.h.seek(Math.max(0, Math.min(this.durationMs, this.t(x))));
        break;
      case 'minimap':
        this.minimapTo(x);
        break;
      case 'pan':
        this.viewStartMs = d.view0 - (x - d.x0) / this.pxPerMs;
        this.scrollY = d.scroll0 - (y - d.y0);
        this.viewChanged();
        break;
      case 'band':
        if (!d.started && Math.hypot(x - d.x0, y - d.y0) < DRAG_PX) return;
        d.started = true;
        d.t1 = this.t(x);
        d.cy1 = Math.max(0, y - this.rowsTop + this.scrollY);
        break;
      case 'create': {
        if (!d.started && Math.abs(x - d.x0) < DRAG_PX) return;
        d.started = true;
        d.t1 = this.snapT(this.t(x), bypass);
        break;
      }
      case 'move': {
        if (!d.started && Math.hypot(x - d.x0, y - d.y0) < DRAG_PX) return;
        if (!d.started) {
          d.started = true;
          this.snapper = this.buildSnapper(new Set(d.ids), this.slotsOf(d.ids));
          this.invalidate();
        }
        if (d.copy !== this.pointer.alt) { d.copy = this.pointer.alt; this.invalidate(); }
        const raw = (x - d.x0) / this.pxPerMs;
        // Snap whichever edge of the grabbed effect lands closer to a snap target.
        const s = this.snapT(d.grab.startMs + raw, bypass);
        const gs = this.guide;
        const e2 = this.snapT(d.grab.endMs + raw, bypass);
        const ge = this.guide;
        const useStart = Math.abs(s - (d.grab.startMs + raw)) <= Math.abs(e2 - (d.grab.endMs + raw));
        d.dt = useStart ? s - d.grab.startMs : e2 - d.grab.endMs;
        this.guide = useStart ? gs : ge;
        const cy = Math.max(this.rowsTop, Math.min(this.rowsBottom - 1, y));
        const over = this.slotAtY(cy);
        if (over) {
          d.dRow = over.index - d.slot.index;
          // On a multi-layer row, the lane under the pointer is where the grabbed effect goes.
          const lane = over.row.collapsed ? d.grab.layer : Math.max(0, Math.min(over.lanes - 1, Math.floor((cy - this.slotY(over)) / over.laneH)));
          d.dLayer = over.row.layers > 1 || d.grab.layer > 0 ? lane - d.grab.layer : 0;
        }
        break;
      }
      case 'resize': {
        const edgeT = d.edge === 'start' ? d.grab.startMs : d.grab.endMs;
        const raw = this.t(x);
        const snapped = this.snapT(raw, bypass);
        d.dt = snapped - edgeT;
        d.stretch = this.pointer.ctrl;
        // Keep the grabbed effect at least a frame long.
        if (d.edge === 'start') d.dt = Math.min(d.dt, d.grab.endMs - f - d.grab.startMs);
        else d.dt = Math.max(d.dt, d.grab.startMs + f - d.grab.endMs);
        break;
      }
      case 'ramp': {
        const e = this.h.store.project.effects[d.id];
        if (!e) return;
        const len = e.endMs - e.startMs;
        const other = d.side === 'in' ? e.ramp?.out ?? 0 : e.ramp?.in ?? 0;
        const raw = d.side === 'in' ? this.t(x) - e.startMs : e.endMs - this.t(x);
        d.value = Math.max(0, Math.min(len - other, Math.round(raw / f) * f));
        this.guide = { t: d.side === 'in' ? e.startMs + d.value : e.endMs - d.value, label: `Fade ${d.side} ${(d.value / 1000).toFixed(2)} s` };
        break;
      }
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = undefined;
    this.guide = undefined;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    const store = this.h.store;
    switch (d.kind) {
      case 'create': {
        if (!d.started || d.t0 === d.t1) {
          // A click on an empty row: select the row, clear effect selection, and (when stopped)
          // put the playhead there, so D or a number key drops on the beat that was clicked.
          if (!d.additive) store.select([]);
          store.selectRows([d.slot.row.id], d.additive ? 'toggle' : 'replace');
          if (!this.h.isPlaying()) this.h.seek(Math.max(0, Math.min(this.durationMs, Math.round(d.clickT))));
          break;
        }
        store.selectRows([d.slot.row.id]);
        store.edit('Add effect', (tx) => {
          const n = ops.create(tx, d.slot.row.id, Math.min(d.t0, d.t1), Math.max(d.t0, d.t1), this.h.brush(d.slot.row.id), d.layer);
          return n ? [n.id] : [];
        });
        break;
      }
      case 'move': {
        if (!d.started) {
          if (d.altClick) {
            // Alt+click splits at the click (snapped).
            this.snapper = this.buildSnapper(new Set(), [d.slot]);
            const at = this.snapT(d.t, false);
            this.guide = undefined;
            store.edit('Split', (tx) => ops.splitAt(tx, [d.grab.id], at));
          } else if (!this.pointer.shift && !this.pointer.ctrl) store.select([d.grab.id]);
          break;
        }
        if (d.dt === 0 && d.dRow === 0 && d.dLayer === 0 && !d.copy) break;
        const rowFor = this.rowMapper(d.dRow);
        store.edit(d.copy ? 'Duplicate' : 'Move', (tx) => ops.move(tx, d.ids, d.dt, rowFor, { copy: d.copy, dLayer: d.dLayer }));
        break;
      }
      case 'resize': {
        if (d.dt === 0) break;
        if (d.stretch && d.ids.length > 1) {
          const sel = d.ids.map((id) => store.project.effects[id]).filter(Boolean);
          const lo = Math.min(...sel.map((x) => x.startMs)), hi = Math.max(...sel.map((x) => x.endMs));
          const anchor = d.edge === 'start' ? hi : lo;
          const factor = d.edge === 'start' ? (hi - (lo + d.dt)) / (hi - lo) : (hi + d.dt - lo) / (hi - lo);
          if (factor > 0) store.edit('Stretch', (tx) => { ops.stretch(tx, d.ids, anchor, factor); });
        } else store.edit('Resize', (tx) => { ops.resize(tx, d.ids, d.edge, d.dt); });
        break;
      }
      case 'ramp':
        store.edit(`Fade ${d.side}`, (tx) => { ops.patch(tx, [d.id], d.side === 'in' ? { rampIn: d.value } : { rampOut: d.value }); });
        break;
      case 'band': {
        if (!d.started) {
          // A click on empty space: select the row (or nothing), and put the playhead there.
          if (d.mode === 'replace') store.select([]);
          if (d.slot) store.selectRows([d.slot.row.id], d.mode === 'replace' ? 'replace' : 'toggle');
          else if (d.mode === 'replace') store.selectRows([]);
          if (d.slot && !this.h.isPlaying()) this.h.seek(Math.max(0, Math.min(this.durationMs, Math.round(d.clickT))));
          break;
        }
        store.select(this.bandIds(d), d.mode);
        break;
      }
    }
    this.snapper = undefined;
    this.invalidate();
  }

  cancelDrag() {
    this.drag = undefined;
    this.guide = undefined;
    this.snapper = undefined;
    this.invalidate();
  }

  get dragging() { return !!this.drag; }

  /** Map a row to the row `dRow` visible rows away (vertical drags), clamped. */
  private rowMapper(dRow: number): (rowId: string) => string {
    if (!dRow) return (r) => r;
    const pos = new Map(this.slots.map((s) => [s.row.id, s.index]));
    return (rowId) => {
      const i = pos.get(rowId);
      if (i === undefined) return rowId;
      return this.slots[Math.max(0, Math.min(this.slots.length - 1, i + dRow))].row.id;
    };
  }

  private selectSection(start: number, end: number, add: boolean) {
    const store = this.h.store;
    const rows = store.selectedRows.size ? this.slots.filter((s) => store.selectedRows.has(s.row.id)) : this.slots;
    const ids: string[] = [];
    for (const s of rows) for (let l = 0; l < Math.max(1, s.row.layers); l++) {
      for (const e of store.index.range(s.row.id, l, start, end)) if (e.startMs >= start && e.endMs <= end) ids.push(e.id);
    }
    store.select(ids, add ? 'add' : 'replace');
  }

  private onDouble(e: MouseEvent) {
    const { x, y } = this.local(e);
    const hit = this.hit(x, y);
    const store = this.h.store;
    if (hit.zone === 'sections' && hit.sectionId) {
      const sec = store.project.sections.find((s) => s.id === hit.sectionId)!;
      this.zoomTo(sec.start, sec.end);
      this.h.setLoop({ start: sec.start, end: sec.end });
      return;
    }
    if (hit.zone === 'rows' && hit.slot && !hit.effect) {
      const bounds = activeBoundaries(store.project);
      store.edit('Fill span', (tx) => {
        const n = ops.fillSpan(tx, hit.slot!.row.id, hit.t, this.h.brush(hit.slot!.row.id), bounds.length ? bounds : boundaries([{ start: 0, end: this.durationMs, label: '' }]));
        return n ? [n.id] : [];
      });
    }
  }

  private onContext(e: MouseEvent) {
    const { x, y } = this.local(e);
    const hit = this.hit(x, y);
    if (hit.zone === 'sections' && hit.sectionId) {
      e.preventDefault();
      const sec = this.h.store.project.sections.find((s) => s.id === hit.sectionId)!;
      const r = this.canvas.getBoundingClientRect();
      const x0 = Math.max(0, this.x(sec.start));
      const lane = this.lanes.find((l) => l.kind === 'sections')!;
      this.h.onRename(sec.id, new DOMRect(r.left + x0, r.top + lane.y, Math.max(120, Math.min(this.x(sec.end), this.w) - x0), lane.h));
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const { x } = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.hgt : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-dy * 0.0025), x);
    else if (e.shiftKey) this.panBy(dy || dx);
    else if (Math.abs(dx) > Math.abs(dy)) this.panBy(dx);
    else this.scrollBy(dy);
  }

  private minimapTo(x: number) {
    const span = this.viewEndMs - this.viewStartMs;
    this.viewStartMs = (x / this.w) * this.durationMs - span / 2;
    this.viewChanged();
  }

  // ---------- drawing ----------

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = this.h.currentMs();
    if (this.h.isPlaying()) this.follow(now);
    // Auto-scroll while dragging near the edges.
    if (this.drag && this.drag.kind !== 'pan' && this.drag.kind !== 'minimap' && this.drag.kind !== 'seek') {
      const edge = 28;
      if (this.pointer.x < edge) { this.panBy(-(edge - this.pointer.x) * 0.6); this.updateDrag(this.drag, this.pointer.x, this.pointer.y); }
      else if (this.pointer.x > this.w - edge) { this.panBy((this.pointer.x - (this.w - edge)) * 0.6); this.updateDrag(this.drag, this.pointer.x, this.pointer.y); }
      // And up/down when dragging toward rows that are out of view.
      const top = this.rowsTop + edge, bottom = this.rowsBottom - edge;
      const canScroll = this.drag.kind === 'move' || this.drag.kind === 'band' || this.drag.kind === 'create';
      if (canScroll && this.pointer.y < top && this.pointer.y > this.rowsTop - 40 && this.scrollY > 0) { this.scrollBy(-(top - this.pointer.y) * 0.5); this.updateDrag(this.drag, this.pointer.x, this.pointer.y); }
      else if (canScroll && this.pointer.y > bottom) { this.scrollBy((this.pointer.y - bottom) * 0.5); this.updateDrag(this.drag, this.pointer.x, this.pointer.y); }
    }
    if (!this.staticDirty && now === this.lastPlayMs) return;
    if (this.staticDirty) {
      this.colors = readColors(this.host);
      this.drawStatic();
      this.staticDirty = false;
    }
    this.lastPlayMs = now;
    this.drawFrame(now);
  };

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private drawStatic() {
    const g = this.sg;
    const dpr = window.devicePixelRatio || 1;
    const c = this.colors;
    const p = this.h.store.project;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, this.w, this.hgt);

    // Rows area (clipped), drawn first so pinned lanes sit on top.
    g.save();
    g.beginPath();
    g.rect(0, this.rowsTop, this.w, this.rowsViewH);
    g.clip();
    this.drawRowsBackground(g, c, p);
    this.drawGridLines(g, c, p);
    const store = this.h.store;
    const t0 = this.viewStartMs, t1 = this.viewEndMs;
    const dragging = this.drag && (this.drag.kind === 'move' && this.drag.started && !this.drag.copy ? new Set(this.drag.ids) : this.drag.kind === 'resize' ? new Set(this.drag.ids) : undefined);
    for (const s of this.visibleSlots()) {
      const sy = this.slotY(s);
      const n = Math.max(1, s.row.layers);
      for (let l = 0; l < n; l++) {
        const ly = s.row.collapsed ? sy : sy + l * s.laneH;
        for (const e of store.index.range(s.row.id, l, t0, t1)) {
          this.drawEffect(g, c, e, ly, s.laneH, store.selection.has(e.id), dragging?.has(e.id) ?? false, s.row);
        }
      }
      if (s.row.locked) {
        g.fillStyle = c.dark ? 'rgb(0 0 0 / 0.35)' : 'rgb(255 255 255 / 0.45)';
        g.fillRect(0, sy, this.w, s.h);
      }
    }
    if (!this.slots.length) {
      g.fillStyle = c.dim;
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('No rows yet. Load a layout or add rows from the row list on the left.', this.w / 2, this.rowsTop + 48);
      g.textAlign = 'left';
    }
    g.restore();

    // Pinned lanes.
    for (const lane of this.lanes) {
      if (lane.kind === 'ruler') this.drawRuler(g, c, lane);
      else if (lane.kind === 'wave') this.drawWave(g, c, lane);
      else if (lane.kind === 'sections') this.drawSections(g, c, lane, p);
      else this.drawTrack(g, c, lane);
    }
    g.fillStyle = c.gridStrong;
    g.fillRect(0, this.pinnedH - 1, this.w, 1);
    this.drawMinimap(g, c, p);
  }

  private visibleSlots(): RowSlot[] {
    const top = this.scrollY, bottom = this.scrollY + this.rowsViewH;
    let lo = 0, hi = this.slots.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.slots[m].y + this.slots[m].h <= top) lo = m + 1; else hi = m; }
    const out: RowSlot[] = [];
    for (let i = lo; i < this.slots.length && this.slots[i].y < bottom; i++) out.push(this.slots[i]);
    return out;
  }

  private drawRowsBackground(g: CanvasRenderingContext2D, c: Colors, _p: Project) {
    const sel = this.h.store.selectedRows;
    for (const s of this.visibleSlots()) {
      const y = this.slotY(s);
      g.fillStyle = sel.has(s.row.id) ? c.sel : s.index % 2 ? c.alt : c.bg;
      g.fillRect(0, y, this.w, s.h);
      g.fillStyle = c.grid;
      if (!s.row.collapsed) for (let l = 1; l < s.lanes; l++) {
        g.globalAlpha = 0.5;
        g.fillRect(0, y + l * s.laneH, this.w, 1);
        g.globalAlpha = 1;
      }
      g.fillRect(0, y + s.h - 1, this.w, 1);
    }
  }

  private drawGridLines(g: CanvasRenderingContext2D, c: Colors, p: Project) {
    const top = this.rowsTop, h = this.rowsViewH;
    const active = p.timingTracks.find((t) => t.id === p.view.activeTrackId);
    if (active && !p.view.hiddenTrackIds.includes(active.id)) {
      const b = boundaries(active.marks);
      let lastX = -10;
      g.fillStyle = c.grid;
      for (const t of b) {
        if (t < this.viewStartMs || t > this.viewEndMs) continue;
        const x = Math.round(this.x(t));
        if (x - lastX < 5) continue;
        g.fillRect(x, top, 1, h);
        lastX = x;
      }
    }
    g.fillStyle = c.gridStrong;
    for (const s of p.sections) {
      const x = Math.round(this.x(s.start));
      if (x >= 0 && x <= this.w) g.fillRect(x, top, 1, h);
    }
    const loop = this.h.loop();
    if (loop) {
      g.fillStyle = c.dark ? 'rgb(251 191 36 / 0.05)' : 'rgb(217 119 6 / 0.06)';
      g.fillRect(this.x(loop.start), top, (loop.end - loop.start) * this.pxPerMs, h);
    }
  }

  private effectFill(g: CanvasRenderingContext2D, cols: readonly string[] | undefined, x0: number, x1: number): string | CanvasGradient {
    const colors = cols?.length ? cols : ['#9ca3af'];
    if (colors.length === 1 || x1 - x0 < 6) return colors[0];
    const grad = g.createLinearGradient(x0, 0, x1, 0);
    colors.forEach((col, i) => grad.addColorStop(i / (colors.length - 1), col));
    return grad;
  }

  private drawEffect(g: CanvasRenderingContext2D, c: Colors, e: Effect, y: number, laneH: number, selected: boolean, ghosted: boolean, row: Row) {
    const cols = e.colors;
    const x0 = this.x(e.startMs), x1 = this.x(e.endMs);
    const w = Math.max(1.5, x1 - x0);
    const top = y + 2, hh = laneH - 4;
    const curated = !!effectDef(e.type);
    g.globalAlpha = ghosted ? 0.3 : row.muted ? 0.45 : 1;
    // Body: palette colors, dimmed so labels stay readable.
    g.fillStyle = this.effectFill(g, cols, x0, x1);
    g.fillRect(x0, top, w, hh);
    g.fillStyle = e.type === 'Off' ? 'rgb(0 0 0 / 0.75)' : c.dark ? 'rgb(10 12 16 / 0.42)' : 'rgb(255 255 255 / 0.25)';
    g.fillRect(x0, top, w, hh);
    // Brightness ramp for On (start/end intensity) as a sloped top.
    if (e.type === 'On' && (e.params.Eff_On_Start !== 100 || e.params.Eff_On_End !== 100)) {
      const a = Number(e.params.Eff_On_Start ?? 100) / 100, b = Number(e.params.Eff_On_End ?? 100) / 100;
      g.fillStyle = 'rgb(0 0 0 / 0.45)';
      g.beginPath();
      g.moveTo(x0, top); g.lineTo(x1, top); g.lineTo(x1, top + hh * (1 - b)); g.lineTo(x0, top + hh * (1 - a)); g.closePath();
      g.fill();
    }
    // Fades as dark triangles.
    if (e.ramp && w > 4) {
      g.fillStyle = 'rgb(0 0 0 / 0.5)';
      if (e.ramp.in > 0) {
        const fx = x0 + e.ramp.in * this.pxPerMs;
        g.beginPath(); g.moveTo(x0, top); g.lineTo(fx, top); g.lineTo(x0, top + hh); g.closePath(); g.fill();
      }
      if (e.ramp.out > 0) {
        const fx = x1 - e.ramp.out * this.pxPerMs;
        g.beginPath(); g.moveTo(fx, top); g.lineTo(x1, top); g.lineTo(x1, top + hh); g.closePath(); g.fill();
      }
    }
    // Opaque (imported, unknown) effects: hatched.
    if (!curated) {
      g.save();
      g.beginPath(); g.rect(x0, top, w, hh); g.clip();
      g.strokeStyle = 'rgb(255 255 255 / 0.18)';
      g.lineWidth = 1;
      for (let k = -hh; k < w; k += 7) { g.beginPath(); g.moveTo(x0 + k, top + hh); g.lineTo(x0 + k + hh, top); g.stroke(); }
      g.restore();
    }
    // Edges.
    g.fillStyle = cols?.[0] ?? '#9ca3af';
    g.fillRect(x0, top, Math.min(2, w), hh);
    if (e.source === 'binding') {
      g.setLineDash([3, 3]);
      g.strokeStyle = c.text;
      g.strokeRect(x0 + 0.5, top + 0.5, w - 1, hh - 1);
      g.setLineDash([]);
    }
    if (selected) {
      g.lineWidth = 2;
      g.strokeStyle = c.selOutline;
      g.strokeRect(x0 + 1, top + 1, Math.max(1, w - 2), hh - 2);
      g.lineWidth = 1;
    }
    // Label.
    if (w > 34 && laneH >= 16) {
      const def = effectDef(e.type);
      const label = def?.label ?? e.type;
      g.save();
      g.beginPath(); g.rect(x0 + 3, top, w - 6, hh); g.clip();
      g.font = `${laneH >= 24 ? 11 : 10}px system-ui, sans-serif`;
      g.textBaseline = 'middle';
      // Dark text on pale fills (light theme), white with a shadow otherwise.
      const pale = !c.dark && e.type !== 'Off' && luminance(cols?.[0] ?? '#9ca3af') > 0.45;
      g.fillStyle = pale ? '#111827' : '#ffffff';
      g.shadowColor = pale ? 'transparent' : 'rgb(0 0 0 / 0.8)';
      g.shadowBlur = pale ? 0 : 2;
      g.fillText(label, x0 + 6, top + hh / 2);
      g.restore();
    }
    // Fade handles on selected effects.
    if (selected && curated && laneH >= 18 && w > 16) {
      const hx = [x0 + (e.ramp?.in ?? 0) * this.pxPerMs, x1 - (e.ramp?.out ?? 0) * this.pxPerMs];
      g.fillStyle = c.selOutline;
      for (const hxx of hx) { g.beginPath(); g.arc(Math.max(x0 + 4, Math.min(x1 - 4, hxx)), top + 3, 3, 0, Math.PI * 2); g.fill(); }
    }
    g.globalAlpha = 1;
  }

  private drawRuler(g: CanvasRenderingContext2D, c: Colors, lane: PinnedLane) {
    g.fillStyle = c.panel;
    g.fillRect(0, lane.y, this.w, lane.h);
    const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
    const step = steps.find((s) => s * this.pxPerMs >= 80) ?? 120000;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    for (let t = Math.floor(this.viewStartMs / step) * step; t <= this.viewEndMs; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      g.fillStyle = c.gridStrong;
      g.fillRect(x, lane.y + lane.h - 7, 1, 7);
      g.fillStyle = c.dim;
      g.fillText(formatTime(t, step < 1000), x + 4, lane.y + lane.h / 2 - 1);
    }
    const loop = this.h.loop();
    if (loop) {
      g.fillStyle = c.dark ? 'rgb(251 191 36 / 0.35)' : 'rgb(217 119 6 / 0.35)';
      g.fillRect(this.x(loop.start), lane.y + lane.h - 5, (loop.end - loop.start) * this.pxPerMs, 5);
    }
    g.fillStyle = c.line;
    g.fillRect(0, lane.y + lane.h - 1, this.w, 1);
  }

  private drawWave(g: CanvasRenderingContext2D, c: Colors, lane: PinnedLane) {
    g.fillStyle = c.bg;
    g.fillRect(0, lane.y, this.w, lane.h);
    const p = this.h.peaks;
    if (p) {
      const mid = lane.y + lane.h / 2, amp = lane.h / 2 - 3;
      g.fillStyle = c.wave;
      for (let x = 0; x < this.w; x++) {
        const a = Math.floor((this.t(x) / 1000) * p.binsPerSec);
        const b = Math.max(a + 1, Math.floor((this.t(x + 1) / 1000) * p.binsPerSec));
        if (a >= p.min.length || b <= 0) continue;
        let lo = 0, hi = 0;
        for (let i = Math.max(0, a); i < Math.min(p.min.length, b); i++) {
          if (p.min[i] < lo) lo = p.min[i];
          if (p.max[i] > hi) hi = p.max[i];
        }
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    g.fillStyle = c.line;
    g.fillRect(0, lane.y + lane.h - 1, this.w, 1);
  }

  private drawSections(g: CanvasRenderingContext2D, c: Colors, lane: PinnedLane, p: Project) {
    g.fillStyle = c.panel;
    g.fillRect(0, lane.y, this.w, lane.h);
    g.font = '600 11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const s of p.sections) {
      if (s.end < this.viewStartMs || s.start > this.viewEndMs) continue;
      const x0 = this.x(s.start), x1 = this.x(s.end);
      const hue = sectionHue(s.label);
      g.fillStyle = `hsl(${hue} 55% ${c.dark ? 30 : 82}%)`;
      g.fillRect(x0 + 1, lane.y + 2, Math.max(1, x1 - x0 - 2), lane.h - 4);
      if (x1 - x0 > 24) {
        g.save();
        g.beginPath(); g.rect(x0 + 1, lane.y, x1 - x0 - 4, lane.h); g.clip();
        g.fillStyle = c.dark ? `hsl(${hue} 70% 88%)` : `hsl(${hue} 60% 22%)`;
        g.fillText(s.label, Math.max(x0, 0) + 6, lane.y + lane.h / 2);
        g.restore();
      }
    }
    if (!p.sections.length) {
      g.fillStyle = c.faint;
      g.font = '11px system-ui, sans-serif';
      g.fillText('No sections. Drop a .xtiming with a Sections track here to add them.', 8, lane.y + lane.h / 2);
    }
    g.fillStyle = c.line;
    g.fillRect(0, lane.y + lane.h - 1, this.w, 1);
  }

  private drawTrack(g: CanvasRenderingContext2D, c: Colors, lane: Extract<PinnedLane, { kind: 'track' }>) {
    g.fillStyle = lane.active ? (c.dark ? '#1a1726' : '#f5f1ff') : c.bg;
    g.fillRect(0, lane.y, this.w, lane.h);
    if (!lane.hidden) {
      const marks = lane.track.marks;
      const t0 = this.viewStartMs, t1 = this.viewEndMs;
      let lo = 0, hi = marks.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (marks[m].end < t0) lo = m + 1; else hi = m; }
      const col = lane.active ? c.markActive : c.mark;
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'middle';
      for (let i = lo; i < marks.length; i++) {
        const m = marks[i];
        if (m.start > t1) break;
        const x0 = this.x(m.start), x1 = this.x(m.end);
        g.globalAlpha = 0.28;
        g.fillStyle = col;
        g.fillRect(x0, lane.y + 3, Math.max(1, x1 - x0 - 1), lane.h - 6);
        g.globalAlpha = 1;
        g.fillRect(Math.round(x0), lane.y + 2, 1.5, lane.h - 4);
        if (m.label && x1 - x0 > 16) {
          g.save();
          g.beginPath(); g.rect(x0, lane.y, x1 - x0 - 2, lane.h); g.clip();
          g.fillStyle = c.dim;
          g.fillText(m.label, x0 + 4, lane.y + lane.h / 2);
          g.restore();
        }
      }
    }
    g.fillStyle = c.line;
    g.fillRect(0, lane.y + lane.h - 1, this.w, 1);
  }

  private drawMinimap(g: CanvasRenderingContext2D, c: Colors, p: Project) {
    const y = this.rowsBottom;
    g.fillStyle = c.panel;
    g.fillRect(0, y, this.w, MINIMAP_H);
    g.fillStyle = c.line;
    g.fillRect(0, y, this.w, 1);
    const sx = (ms: number) => (ms / Math.max(1, this.durationMs)) * this.w;
    for (const s of p.sections) {
      g.fillStyle = `hsl(${sectionHue(s.label)} 50% ${c.dark ? 28 : 84}%)`;
      g.fillRect(sx(s.start), y + 3, Math.max(1, sx(s.end) - sx(s.start) - 1), MINIMAP_H - 6);
    }
    // Effect density.
    const buckets = new Float32Array(Math.max(1, Math.floor(this.w / 3)));
    for (const e of Object.values(p.effects)) {
      const a = Math.floor((e.startMs / this.durationMs) * buckets.length), b = Math.min(buckets.length - 1, Math.floor((e.endMs / this.durationMs) * buckets.length));
      for (let i = a; i <= b; i++) buckets[i]++;
    }
    const max = Math.max(1, ...buckets);
    g.fillStyle = c.accent;
    buckets.forEach((v, i) => { if (v) { const hh = 2 + (v / max) * (MINIMAP_H - 8); g.fillRect(i * 3, y + MINIMAP_H - 3 - hh, 2, hh); } });
    const vx0 = sx(this.viewStartMs), vx1 = sx(this.viewEndMs);
    g.strokeStyle = c.text;
    g.globalAlpha = 0.6;
    g.strokeRect(vx0 + 0.5, y + 1.5, Math.max(4, vx1 - vx0 - 1), MINIMAP_H - 3);
    g.globalAlpha = 1;
  }

  private drawFrame(nowMs: number) {
    const g = this.g;
    const dpr = window.devicePixelRatio || 1;
    const c = this.colors;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.stat, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const d = this.drag;
    const store = this.h.store;
    g.save();
    g.beginPath(); g.rect(0, this.rowsTop, this.w, this.rowsViewH); g.clip();
    if (d?.kind === 'create' && d.started) {
      const b = this.h.brush(d.slot.row.id);
      const ghost: Effect = { id: 'ghost', rowId: d.slot.row.id, layer: d.layer, startMs: Math.min(d.t0, d.t1), endMs: Math.max(d.t0, d.t1), type: b.type, params: b.params, colors: b.colors, ramp: b.rampIn || b.rampOut ? { in: b.rampIn ?? 0, out: b.rampOut ?? 0 } : undefined, source: 'manual' };
      const ly = this.slotY(d.slot) + (d.slot.row.collapsed ? 0 : d.layer * d.slot.laneH);
      this.drawEffect(g, c, ghost, ly, d.slot.laneH, true, false, d.slot.row);
    }
    if (d?.kind === 'move' && d.started) {
      const map = this.rowMapper(d.dRow);
      const pos = new Map(this.slots.map((s) => [s.row.id, s]));
      if (d.dRow) {
        // Highlight the rows the selection lands on.
        const targets = new Set(d.ids.map((id) => store.project.effects[id]).filter(Boolean).map((e) => map(e.rowId)));
        g.fillStyle = c.dark ? 'rgb(167 139 250 / 0.13)' : 'rgb(109 40 217 / 0.08)';
        for (const id of targets) { const s = pos.get(id); if (s) g.fillRect(0, this.slotY(s), this.w, s.h); }
      }
      for (const id of d.ids) {
        const e = store.project.effects[id];
        if (!e) continue;
        const slot = pos.get(map(e.rowId));
        if (!slot) continue;
        const layer = Math.max(0, Math.min(Math.max(1, slot.row.layers) - 1, e.layer + d.dLayer));
        const ly = this.slotY(slot) + (slot.row.collapsed ? 0 : layer * slot.laneH);
        this.drawEffect(g, c, { ...e, startMs: e.startMs + d.dt, endMs: e.endMs + d.dt }, ly, slot.laneH, true, false, slot.row);
      }
    }
    if (d?.kind === 'resize') {
      const pos = new Map(this.slots.map((s) => [s.row.id, s]));
      const sel = d.ids.map((id) => store.project.effects[id]).filter(Boolean);
      const lo = Math.min(...sel.map((x) => x.startMs)), hi = Math.max(...sel.map((x) => x.endMs));
      for (const e of sel) {
        const slot = pos.get(e.rowId);
        if (!slot) continue;
        let s = e.startMs, en = e.endMs;
        if (d.stretch && sel.length > 1) {
          const anchor = d.edge === 'start' ? hi : lo;
          const factor = d.edge === 'start' ? (hi - (lo + d.dt)) / (hi - lo) : (hi + d.dt - lo) / (hi - lo);
          s = anchor + (e.startMs - anchor) * factor; en = anchor + (e.endMs - anchor) * factor;
        } else if (d.edge === 'start') s = Math.min(e.endMs - store.project.frameMs, e.startMs + d.dt);
        else en = Math.max(e.startMs + store.project.frameMs, e.endMs + d.dt);
        const ly = this.slotY(slot) + (slot.row.collapsed ? 0 : e.layer * slot.laneH);
        this.drawEffect(g, c, { ...e, startMs: Math.min(s, en), endMs: Math.max(s, en) }, ly, slot.laneH, true, false, slot.row);
      }
    }
    if (d?.kind === 'ramp') {
      const e = store.project.effects[d.id];
      const slot = e && this.slots.find((s) => s.row.id === e.rowId);
      if (e && slot) {
        const ly = this.slotY(slot) + (slot.row.collapsed ? 0 : e.layer * slot.laneH);
        const ramp = { in: d.side === 'in' ? d.value : e.ramp?.in ?? 0, out: d.side === 'out' ? d.value : e.ramp?.out ?? 0 };
        this.drawEffect(g, c, { ...e, ramp }, ly, slot.laneH, true, false, slot.row);
      }
    }
    if (d?.kind === 'band' && d.started) {
      // Outline what the box will select, then the box itself.
      const caught = new Set(this.bandIds(d));
      g.strokeStyle = c.selOutline;
      g.lineWidth = 2;
      for (const s of this.visibleSlots()) for (let l = 0; l < Math.max(1, s.row.layers); l++) {
        for (const e of store.index.range(s.row.id, l, this.viewStartMs, this.viewEndMs)) {
          if (!caught.has(e.id)) continue;
          const ly = this.slotY(s) + (s.row.collapsed ? 0 : e.layer * s.laneH);
          g.strokeRect(this.x(e.startMs) + 1, ly + 3, Math.max(1, (e.endMs - e.startMs) * this.pxPerMs - 2), s.laneH - 6);
        }
      }
      g.lineWidth = 1;
      const bx0 = this.x(Math.min(d.t0, d.t1)), bx1 = this.x(Math.max(d.t0, d.t1));
      const by0 = this.rowsTop + Math.min(d.cy0, d.cy1) - this.scrollY, by1 = this.rowsTop + Math.max(d.cy0, d.cy1) - this.scrollY;
      g.fillStyle = c.dark ? 'rgb(167 139 250 / 0.12)' : 'rgb(109 40 217 / 0.1)';
      g.strokeStyle = c.accent;
      g.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
      g.strokeRect(bx0 + 0.5, by0 + 0.5, bx1 - bx0, by1 - by0);
    }
    // Hover highlight of the effect under the pointer.
    if (!d && this.hover?.zone === 'rows' && this.hover.effect && this.hover.slot) {
      const e = this.hover.effect, s = this.hover.slot;
      const ly = this.slotY(s) + (s.row.collapsed ? 0 : e.layer * s.laneH);
      g.strokeStyle = c.text;
      g.globalAlpha = 0.5;
      g.strokeRect(this.x(e.startMs) + 0.5, ly + 2.5, Math.max(1, (e.endMs - e.startMs) * this.pxPerMs - 1), s.laneH - 5);
      g.globalAlpha = 1;
    }
    g.restore();

    // Snap guide.
    if (this.guide) {
      const x = Math.round(this.x(this.guide.t)) + 0.5;
      g.strokeStyle = c.guide;
      g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.rowsBottom); g.stroke();
      g.setLineDash([]);
      g.font = '11px system-ui, sans-serif';
      const label = `${this.guide.label}  ${formatTime(this.guide.t)}`;
      const tw = g.measureText(label).width + 10;
      const lx = Math.min(this.w - tw - 2, x + 4);
      g.fillStyle = c.guide;
      g.fillRect(lx, 2, tw, 18);
      g.fillStyle = '#111';
      g.textBaseline = 'middle';
      g.fillText(label, lx + 5, 11);
    }

    // Playhead.
    const px = this.x(nowMs);
    if (px >= -2 && px <= this.w + 2) {
      g.fillStyle = c.cursor;
      g.fillRect(Math.round(px) - 1, 0, 2, this.rowsBottom);
      g.beginPath();
      g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.closePath(); g.fill();
    }
    const mx = (nowMs / Math.max(1, this.durationMs)) * this.w;
    g.fillRect(Math.round(mx), this.rowsBottom + 1, 1, MINIMAP_H - 1);
  }
}
