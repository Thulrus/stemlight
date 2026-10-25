import type { LayoutModel } from '@stemlight/xlights/layout';
import { canShow } from '../model/export';
import { effectLook, hexToRgb, type RGB } from '../model/look';
import type { Effect, Row } from '../model/types';
import type { Store } from '../state/store';
import { h, icon, ICONS } from './dom';

type Light = { key: string; label: string; rows: Row[]; model?: LayoutModel; x: number; y: number; w: number; h: number; selectRow?: string };

/**
 * Level-1 preview: one light per row (a strip), or each layout model at its position with
 * the color of the effects that reach it (its own row, its groups, its submodels). Driven
 * by the audio clock; shows timing and color, not xLights' exact rendering.
 */
export class Preview {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private lights: Light[] = [];
  private lastT = -1;
  private dirty = true;
  private hoverKey?: string;

  constructor(parent: HTMLElement, private readonly store: Store, private readonly onPickRow: (rowId: string) => void, private readonly onClose: () => void) {
    this.canvas = h('canvas', { 'aria-label': 'Light preview' });
    const head = h('header', {}, 'Preview', h('span', { class: 'spacer' }), h('button', { class: 'mini-btn', title: 'Hide preview (P)', onclick: () => this.onClose() }, icon(ICONS.close, 13)));
    this.el = h('div', { class: 'preview' }, head, this.canvas, h('div', { class: 'note' }, 'Approximate preview: render in xLights for the real thing'));
    parent.append(this.el);
    this.g = this.canvas.getContext('2d')!;
    // Default: bottom right of the timeline, clear of the inspector.
    const r = store.project.view.previewRect;
    const right = store.project.view.panels.right ? 300 : 12;
    // Place once the editor has its final size, and keep the panel inside it when it resizes.
    requestAnimationFrame(() => this.place(r ?? { x: parent.clientWidth - right - 372, y: parent.clientHeight - 262, w: 360, h: 240 }));
    new ResizeObserver(() => this.place({ x: this.el.offsetLeft, y: this.el.offsetTop, w: this.el.offsetWidth, h: this.el.offsetHeight })).observe(parent);
    this.dragHeader(head);
    new ResizeObserver(() => { this.resize(); this.saveRect(); }).observe(this.el);
    this.canvas.addEventListener('pointermove', (e) => { this.hoverKey = this.lightAt(e)?.key; this.dirty = true; this.canvas.style.cursor = this.hoverKey ? 'pointer' : 'default'; });
    this.canvas.addEventListener('pointerleave', () => { this.hoverKey = undefined; this.dirty = true; });
    this.canvas.addEventListener('click', (e) => { const l = this.lightAt(e); if (l?.selectRow) this.onPickRow(l.selectRow); });
    this.rebuild();
  }

  private place(r: { x: number; y: number; w: number; h: number }) {
    const parent = this.el.parentElement!;
    const w = Math.min(r.w, parent.clientWidth), hh = Math.min(r.h, parent.clientHeight);
    const x = Math.max(0, Math.min(r.x, parent.clientWidth - w));
    const y = Math.max(0, Math.min(r.y, parent.clientHeight - hh));
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
  }

  private saveTimer = 0;
  private saveRect() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const s = this.el.style;
      this.store.setView({ previewRect: { x: parseFloat(s.left), y: parseFloat(s.top), w: this.el.offsetWidth, h: this.el.offsetHeight } });
    }, 400);
  }

  private dragHeader(head: HTMLElement) {
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const x0 = e.clientX - this.el.offsetLeft, y0 = e.clientY - this.el.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => this.place({ x: ev.clientX - x0, y: ev.clientY - y0, w: this.el.offsetWidth, h: this.el.offsetHeight });
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); this.saveRect(); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.dirty = true;
  }

  /** Recompute which lights exist (rows or layout changed). */
  rebuild() {
    const p = this.store.project;
    const rows = p.rows.filter((r) => !r.hidden);
    this.lights = [];
    if (p.layout && p.layout.models.length) {
      // Rows that reach each model: its own row, its submodels, and every group containing it.
      const groupsOf = new Map<string, Set<string>>();
      const expand = (name: string, seen = new Set<string>()): string[] => {
        const g = p.layout!.groups.find((x) => x.name === name);
        if (!g || seen.has(name)) return [name.split('/')[0]];
        seen.add(name);
        return g.members.flatMap((m) => expand(m, seen));
      };
      for (const g of p.layout.groups) for (const m of expand(g.name)) groupsOf.set(m, (groupsOf.get(m) ?? new Set()).add(g.name));
      for (const m of p.layout.models) {
        const reach = rows.filter((r) => r.modelRef === m.name || r.modelRef?.startsWith(`${m.name}/`) || (r.kind === 'group' && groupsOf.get(m.name)?.has(r.modelRef ?? '')));
        const own = rows.find((r) => r.modelRef === m.name);
        this.lights.push({ key: m.name, label: m.name, rows: reach, model: m, x: m.x, y: m.y, w: m.w, h: m.h, selectRow: own?.id ?? reach[0]?.id });
      }
    } else {
      rows.forEach((r, i) => this.lights.push({ key: r.id, label: r.name, rows: [r], x: i, y: 0, w: 1, h: 1, selectRow: r.id }));
    }
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  private colorAt(light: Light, t: number, solo: boolean): RGB | null {
    let r = 0, g = 0, b = 0, any = false;
    for (const row of light.rows) {
      if (row.muted || (solo && !row.solo)) continue;
      const layers = this.store.index.layers(row.id);
      // The first layer with an active effect wins for that row (layer 1 is on top in xLights).
      for (let l = 0; l < layers.length; l++) {
        const e: Effect | undefined = this.store.index.at(row.id, l, t);
        if (!e) continue;
        const look = effectLook(e, t, light.key.length);
        if (look) {
          let rgb = look.rgb;
          const single = light.model?.singleColor;
          if (single) {
            // A single-color prop shows its own color, and only for white or that color.
            const hex = `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
            const k = canShow(single, hex) ? Math.max(...rgb) / 255 : 0;
            rgb = hexToRgb(single).map((v) => v * k) as RGB;
          }
          r += rgb[0] * look.level; g += rgb[1] * look.level; b += rgb[2] * look.level; any = true;
        }
        break;
      }
    }
    return any ? [Math.min(255, r), Math.min(255, g), Math.min(255, b)] : null;
  }

  private layoutBox(): (l: Light) => { x: number; y: number; w: number; h: number } {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight - 14;
    const p = this.store.project;
    if (p.layout && p.layout.models.length) {
      const bb = p.layout.bounds;
      const sx = (W - 24) / Math.max(1, bb.maxX - bb.minX), sy = (H - 24) / Math.max(1, bb.maxY - bb.minY);
      const s = Math.min(sx, sy);
      const ox = (W - (bb.maxX - bb.minX) * s) / 2, oy = (H - (bb.maxY - bb.minY) * s) / 2;
      return (l) => ({ x: ox + (l.x - bb.minX) * s, y: H - (oy + (l.y - bb.minY) * s), w: Math.max(6, l.w * s), h: Math.max(6, l.h * s) });
    }
    const n = Math.max(1, this.lights.length);
    const cols = Math.max(1, Math.min(n, Math.floor(W / 64)));
    const rowsN = Math.ceil(n / cols);
    const cw = W / cols, ch = Math.min(64, H / rowsN);
    return (l) => ({ x: (l.x % cols) * cw + cw / 2, y: Math.floor(l.x / cols) * ch + ch / 2 - 6, w: 22, h: 22 });
  }

  private lightAt(e: MouseEvent): Light | undefined {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const box = this.layoutBox();
    let best: Light | undefined, bd = 24;
    for (const l of this.lights) {
      const b = box(l);
      const dx = Math.max(0, Math.abs(x - b.x) - b.w / 2), dy = Math.max(0, Math.abs(y - b.y) - b.h / 2);
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }

  render(tMs: number) {
    if (this.el.hidden || (!this.dirty && tMs === this.lastT)) return;
    this.dirty = false;
    this.lastT = tMs;
    const g = this.g, dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, W, H);
    const box = this.layoutBox();
    const solo = this.store.project.rows.some((r) => r.solo);
    const selRows = this.store.selectedRows;
    const strip = !this.store.project.layout?.models.length;
    g.font = '10px system-ui, sans-serif';
    g.textAlign = 'center';
    for (const l of this.lights) {
      const b = box(l);
      const col = this.colorAt(l, tMs, solo);
      const lit = col && col[0] + col[1] + col[2] > 8;
      const fill = lit ? `rgb(${col[0] | 0} ${col[1] | 0} ${col[2] | 0})` : '#1c1f26';
      g.shadowBlur = lit ? 16 : 0;
      g.shadowColor = fill;
      g.fillStyle = fill;
      g.strokeStyle = fill;
      const display = l.model?.displayAs ?? '';
      if (strip || /circle|star|wreath|spinner|sphere/i.test(display) || (b.w / b.h < 3 && b.h / b.w < 3)) {
        g.beginPath();
        g.ellipse(b.x, b.y, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        if (/circle|wreath/i.test(display) && b.w > 18) { g.lineWidth = Math.max(2, b.w / 10); g.stroke(); } else g.fill();
      } else {
        g.lineWidth = Math.max(3, Math.min(8, b.w, b.h));
        g.lineCap = 'round';
        g.beginPath();
        if (b.w >= b.h) { g.moveTo(b.x - b.w / 2, b.y); g.lineTo(b.x + b.w / 2, b.y); } else { g.moveTo(b.x, b.y - b.h / 2); g.lineTo(b.x, b.y + b.h / 2); }
        g.stroke();
      }
      g.shadowBlur = 0;
      const selected = l.rows.some((r) => selRows.has(r.id) && (r.modelRef === l.key || r.id === l.key));
      if (selected || this.hoverKey === l.key) {
        g.strokeStyle = selected ? '#fbbf24' : '#9ca3af';
        g.lineWidth = 1.5;
        g.strokeRect(b.x - b.w / 2 - 4, b.y - b.h / 2 - 4, b.w + 8, b.h + 8);
      }
      if (strip || this.hoverKey === l.key) {
        g.fillStyle = lit ? '#e5e7eb' : '#6b7280';
        g.fillText(l.label.length > 12 ? `${l.label.slice(0, 11)}…` : l.label, b.x, b.y + b.h / 2 + 12);
      }
    }
    g.textAlign = 'left';
  }
}
