import type { MsMark } from '@stemlight/core/quantize';

export type Channel = {
  id: string;
  name: string;
  hue: number;
  marks: MsMark[];
  /** Point events (one grid step long) flash and decay; spans stay lit for their length. */
  isPoint: boolean;
};

const CELL_W = 92;
const CELL_H = 64;
const DOT_R = 13;
/** How long a point event's flash takes to fade, seconds. */
const FLASH_DECAY = 0.15;
/** Length of the dip at a back-to-back span boundary, ms. */
const RETRIGGER_MS = 80;

/**
 * Mock light display: one dot per exported track, lit from the same quantized marks the
 * export contains, so you can see how the timing lines up with the music.
 */
export class LightPreview {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private channels: Channel[] = [];
  private last = -1;
  private cols = 1;

  constructor(private readonly host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lights-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Light preview: one dot per exported track');
    host.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    new ResizeObserver(() => { this.layout(); this.draw(this.last); }).observe(host);
  }

  setChannels(channels: Channel[]) {
    this.channels = channels;
    this.layout();
    this.draw(this.last);
  }

  /** Redraw for song time `t` (seconds). Cheap enough to call every animation frame. */
  render(t: number) {
    if (t === this.last) return;
    this.last = t;
    this.draw(t);
  }

  private layout() {
    const w = Math.max(CELL_W, this.host.clientWidth);
    this.cols = Math.max(1, Math.floor(w / CELL_W));
    const rows = Math.max(1, Math.ceil(this.channels.length / this.cols));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(rows * CELL_H * dpr);
    this.canvas.style.height = `${rows * CELL_H}px`;
  }

  /** Brightness 0..1 of a channel at time t. */
  private level(c: Channel, tMs: number): number {
    const m = c.marks;
    // Last mark starting at or before t.
    let lo = 0, hi = m.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid].start <= tMs) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0) return 0;
    const mark = m[idx];
    if (c.isPoint) {
      const dt = (tMs - mark.start) / 1000;
      return dt < 4 * FLASH_DECAY ? Math.exp(-dt / FLASH_DECAY) : 0;
    }
    if (tMs >= mark.end) return 0;
    // A span that starts right where the previous one ended gets a short dip, so a run of
    // back-to-back syllables or notes reads as separate re-triggers rather than one glow.
    const prev = m[idx - 1];
    const since = tMs - mark.start;
    if (prev && prev.end === mark.start && since < RETRIGGER_MS) return 0.15 + 0.85 * (since / RETRIGGER_MS);
    return 1;
  }

  private draw(t: number) {
    const dpr = window.devicePixelRatio || 1;
    const g = this.g;
    const w = this.canvas.width / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, this.canvas.height / dpr);
    const offsetX = (w - this.cols * CELL_W) / 2;
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const tMs = t * 1000;
    this.channels.forEach((c, i) => {
      const x = offsetX + (i % this.cols) * CELL_W + CELL_W / 2;
      const y = Math.floor(i / this.cols) * CELL_H + 8 + DOT_R;
      const v = t < 0 ? 0 : this.level(c, tMs);
      // Unlit bulb.
      g.shadowBlur = 0;
      g.fillStyle = `hsl(${c.hue} 25% 18%)`;
      g.beginPath();
      g.arc(x, y, DOT_R, 0, Math.PI * 2);
      g.fill();
      if (v > 0.02) {
        g.globalAlpha = v;
        g.shadowColor = `hsl(${c.hue} 100% 60%)`;
        g.shadowBlur = 22 * v;
        g.fillStyle = `hsl(${c.hue} 95% ${55 + 25 * v}%)`;
        g.beginPath();
        g.arc(x, y, DOT_R, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        g.shadowBlur = 0;
      }
      g.fillStyle = v > 0.02 ? '#f2f3f5' : '#8a8f9b';
      const label = c.name.length > 13 ? c.name.slice(0, 12) + '…' : c.name;
      g.fillText(label, x, y + DOT_R + 6);
    });
  }
}
