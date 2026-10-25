import type { MsMark } from '@stemlight/core/quantize';

export const RULER_H = 22;
export const WAVE_H = 72;
export const LANE_H = 30;

export type Peaks = { min: Float32Array; max: Float32Array; binsPerSec: number };
export type Lane = { id: string; marks: MsMark[]; hue: number; selected: boolean };

/** Colors come from CSS custom properties so the canvas follows the page theme. */
function themeColors(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: v('--lane-bg'), alt: v('--lane-alt'), grid: v('--grid'), text: v('--text-dim'),
    wave: v('--wave'), cursor: v('--cursor'), sel: v('--lane-sel'), markText: v('--mark-text'),
    dark: v('--is-dark') === '1',
  };
}

/**
 * Canvas timeline: ruler, waveform and one lane per track, with zoom (ctrl/⌘ + wheel),
 * horizontal scroll (wheel / shift+wheel), click-to-seek and a moving playhead.
 */
export class Timeline {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  duration = 0;
  viewStart = 0;
  pxPerSec = 40;
  cursor = 0;
  peaks?: Peaks;
  lanes: Lane[] = [];
  onSeek?: (t: number) => void;
  onViewChange?: () => void;
  private raf = 0;

  constructor(private readonly host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    host.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.render()).observe(host);
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.onSeek?.(this.xToTime(e.clientX - rect.left));
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.render());
  }

  get width() { return this.host.clientWidth; }
  get height() { return RULER_H + WAVE_H + this.lanes.length * LANE_H; }
  get viewEnd() { return this.viewStart + this.width / this.pxPerSec; }

  timeToX = (t: number) => (t - this.viewStart) * this.pxPerSec;
  xToTime = (x: number) => this.viewStart + x / this.pxPerSec;

  fit() {
    if (!this.duration) return;
    this.pxPerSec = Math.max(1, this.width / this.duration);
    this.viewStart = 0;
    this.changed();
  }

  zoom(factor: number, anchorX = this.width / 2) {
    const t = this.xToTime(anchorX);
    const minPx = this.duration ? this.width / this.duration : 1;
    this.pxPerSec = Math.max(minPx, Math.min(2000, this.pxPerSec * factor));
    this.viewStart = t - anchorX / this.pxPerSec;
    this.clampView();
    this.changed();
  }

  /** Keep the playhead visible while playing, paging forward like a DAW. */
  follow(t: number) {
    if (t > this.viewEnd - 0.05 * (this.viewEnd - this.viewStart) || t < this.viewStart) {
      this.viewStart = t - 0.1 * (this.width / this.pxPerSec);
      this.clampView();
      this.onViewChange?.();
    }
  }

  private clampView() {
    const span = this.width / this.pxPerSec;
    this.viewStart = Math.max(0, Math.min(this.viewStart, Math.max(0, this.duration - span)));
  }

  private changed() {
    this.onViewChange?.();
    this.render();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      this.zoom(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left);
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.viewStart += d / this.pxPerSec;
      this.clampView();
      this.changed();
    }
  }

  /** Coalesce redraws to one per animation frame. */
  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.width;
    const h = this.height;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.height = `${h}px`;
    }
    const g = this.g;
    const c = themeColors(this.host);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, h);

    this.drawRuler(c);
    this.drawWave(c);
    this.lanes.forEach((lane, i) => this.drawLane(lane, RULER_H + WAVE_H + i * LANE_H, i, c));

    const x = this.timeToX(this.cursor);
    if (x >= 0 && x <= w) {
      g.fillStyle = c.cursor;
      g.fillRect(Math.round(x) - 1, 0, 2, h);
    }
  }

  private drawRuler(c: ReturnType<typeof themeColors>) {
    const g = this.g;
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => s * this.pxPerSec >= 70) ?? 120;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    const first = Math.floor(this.viewStart / step) * step;
    for (let t = first; t <= this.viewEnd; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      g.fillStyle = c.grid;
      g.fillRect(x, RULER_H - 6, 1, 6);
      g.globalAlpha = 0.5;
      g.fillRect(x, RULER_H, 1, this.height - RULER_H);
      g.globalAlpha = 1;
      g.fillStyle = c.text;
      g.fillText(formatTime(t, step < 1), x + 4, RULER_H / 2);
    }
    g.fillStyle = c.grid;
    g.fillRect(0, RULER_H - 1, this.width, 1);
  }

  private drawWave(c: ReturnType<typeof themeColors>) {
    const p = this.peaks;
    if (!p) return;
    const g = this.g;
    const mid = RULER_H + WAVE_H / 2;
    const amp = WAVE_H / 2 - 4;
    g.fillStyle = c.wave;
    for (let x = 0; x < this.width; x++) {
      const a = Math.floor(this.xToTime(x) * p.binsPerSec);
      const b = Math.max(a + 1, Math.floor(this.xToTime(x + 1) * p.binsPerSec));
      if (a >= p.min.length || b <= 0) continue;
      let lo = 0, hi = 0;
      for (let i = Math.max(0, a); i < Math.min(p.min.length, b); i++) {
        if (p.min[i] < lo) lo = p.min[i];
        if (p.max[i] > hi) hi = p.max[i];
      }
      g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    g.fillStyle = c.grid;
    g.fillRect(0, RULER_H + WAVE_H - 1, this.width, 1);
  }

  private drawLane(lane: Lane, y: number, index: number, c: ReturnType<typeof themeColors>) {
    const g = this.g;
    g.fillStyle = lane.selected ? c.sel : index % 2 ? c.alt : c.bg;
    g.fillRect(0, y, this.width, LANE_H);
    const fill = `hsl(${lane.hue} 70% ${c.dark ? 55 : 45}% / ${c.dark ? 0.55 : 0.35})`;
    const edge = `hsl(${lane.hue} 75% ${c.dark ? 65 : 38}%)`;
    const t0 = this.viewStart * 1000;
    const t1 = this.viewEnd * 1000;
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    // Marks are sorted; binary-search the first visible one.
    let lo = 0, hi = lane.marks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (lane.marks[m].end < t0) lo = m + 1; else hi = m; }
    for (let i = lo; i < lane.marks.length; i++) {
      const m = lane.marks[i];
      if (m.start > t1) break;
      const x0 = this.timeToX(m.start / 1000);
      const x1 = this.timeToX(m.end / 1000);
      const wpx = x1 - x0;
      g.fillStyle = fill;
      g.fillRect(x0, y + 4, Math.max(1, wpx), LANE_H - 8);
      g.fillStyle = edge;
      g.fillRect(Math.round(x0), y + 3, wpx < 3 ? 2 : 1.5, LANE_H - 6);
      if (m.label && wpx > 14) {
        g.save();
        g.beginPath();
        g.rect(x0, y, wpx - 2, LANE_H);
        g.clip();
        g.fillStyle = c.markText;
        g.fillText(m.label, x0 + 4, y + LANE_H / 2);
        g.restore();
      }
    }
    g.fillStyle = c.grid;
    g.fillRect(0, y + LANE_H - 1, this.width, 1);
  }
}

export function formatTime(t: number, fine = false): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return fine ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
}
