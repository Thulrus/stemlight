import { COMPACT_ROW_HEIGHT } from '../model/project';
import type { Project, Row, TimingTrack } from '../model/types';

/** Heights of the pinned lanes above the rows, px. */
export const RULER_H = 24;
export const WAVE_H = 46;
export const SECTIONS_H = 24;
export const TRACK_H = 20;
export const HIDDEN_TRACK_H = 9;
export const MINIMAP_H = 18;

export type PinnedLane =
  | { kind: 'ruler'; y: number; h: number }
  | { kind: 'wave'; y: number; h: number }
  | { kind: 'sections'; y: number; h: number }
  | { kind: 'track'; y: number; h: number; track: TimingTrack; hidden: boolean; active: boolean };

export function orderedTracks(p: Project): TimingTrack[] {
  const order = p.view.trackOrder;
  const pos = (id: string) => { const i = order.indexOf(id); return i < 0 ? 1e9 : i; };
  return [...p.timingTracks].sort((a, b) => pos(a.id) - pos(b.id));
}

export function pinnedLanes(p: Project): { lanes: PinnedLane[]; height: number } {
  const lanes: PinnedLane[] = [];
  let y = 0;
  const push = (l: PinnedLane) => { lanes.push(l); y += l.h; };
  push({ kind: 'ruler', y, h: RULER_H });
  push({ kind: 'wave', y, h: WAVE_H });
  push({ kind: 'sections', y, h: SECTIONS_H });
  for (const t of orderedTracks(p)) {
    const hidden = p.view.hiddenTrackIds.includes(t.id);
    push({ kind: 'track', y, h: hidden ? HIDDEN_TRACK_H : TRACK_H, track: t, hidden, active: t.id === p.view.activeTrackId });
  }
  return { lanes, height: y };
}

/** A row as laid out in the rows area (y relative to the top of the rows content). */
export type RowSlot = { row: Row; index: number; y: number; h: number; laneH: number; lanes: number; depth: number; hasChildren: boolean };

export function layoutRows(p: Project, filter = ''): { slots: RowSlot[]; height: number } {
  const q = filter.trim().toLowerCase();
  const byId = new Map(p.rows.map((r) => [r.id, r]));
  const parents = new Set(p.rows.filter((r) => r.parentId).map((r) => r.parentId!));
  const slots: RowSlot[] = [];
  let y = 0;
  for (const row of p.rows) {
    if (row.hidden) continue;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (q) {
      if (!row.name.toLowerCase().includes(q) && !(parent && parent.name.toLowerCase().includes(q) && parent.expanded)) continue;
    } else if (parent && (!parent.expanded || parent.hidden)) continue;
    const laneH = p.view.compact ? COMPACT_ROW_HEIGHT : row.height;
    const lanes = row.collapsed ? 1 : Math.max(1, row.layers);
    const h = laneH * lanes;
    slots.push({ row, index: slots.length, y, h, laneH, lanes, depth: parent ? 1 : 0, hasChildren: parents.has(row.id) });
    y += h;
  }
  return { slots, height: y };
}

/** Hue for a section label, so every "Chorus" gets the same color. */
export function sectionHue(label: string): number {
  const base = label.trim().replace(/\s*\d+$/, '').toLowerCase();
  const known: Record<string, number> = { intro: 200, verse: 145, chorus: 280, bridge: 30, outro: 210, 'pre-chorus': 330, prechorus: 330, solo: 50, break: 180, instrumental: 50 };
  if (base in known) return known[base];
  let hsh = 0;
  for (const c of base) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  return hsh % 360;
}
