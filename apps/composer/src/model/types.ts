import type { EffectType } from '@stemlight/xlights/effects';
import type { LayoutSnapshot } from '@stemlight/xlights/layout';
import type { ParamValue } from '@stemlight/xlights/settings';
import type { ColorSet } from './colors';

/** A timing mark in integer milliseconds on the project's frame grid. */
export type Mark = { start: number; end: number; label: string };

export type TimingTrack = {
  id: string;
  name: string;
  marks: Mark[];
  /** Extra layers (lyric tracks: words, phonemes), shown and exported but not snapped to. */
  layers?: Mark[][];
  source: 'xtiming' | 'xsq' | 'quick' | 'stemlight';
};

export type Section = { id: string; label: string; start: number; end: number };

export type RowKind = 'model' | 'group' | 'submodel' | 'virtual';

export type Row = {
  id: string;
  name: string;
  kind: RowKind;
  /** Layout element this row targets: model or group name, or "Parent/Sub" for submodels. */
  modelRef?: string;
  parentId?: string;
  /** Number of effect layers (sub-lanes). */
  layers: number;
  /** Layers shown merged in one lane. */
  collapsed: boolean;
  /** Children (submodels) shown. */
  expanded: boolean;
  /** Height of one layer lane, px. */
  height: number;
  color: string;
  hidden: boolean;
  /** Hidden from the preview only. */
  muted: boolean;
  /** Preview only this row (and other soloed rows). */
  solo?: boolean;
  locked: boolean;
};

export type Effect = {
  id: string;
  rowId: string;
  layer: number;
  startMs: number;
  endMs: number;
  /** A curated effect type, or any other xLights effect name for opaque (imported) effects. */
  type: EffectType | string;
  params: Record<string, ParamValue>;
  /** 1-8 colors, written as the effect's xLights palette. */
  colors: string[];
  /** Fade in / out, ms. */
  ramp?: { in: number; out: number };
  source: 'manual' | 'binding' | 'recipe' | 'imported';
  bindingId?: string;
  /** Original xLights settings string, for opaque effects (written back unchanged). */
  raw?: string;
  /** Original palette string, for opaque effects. */
  rawPalette?: string;
};



export type BrushState = {
  type: EffectType;
  colors: string[];
  /** Parameters of `type` (missing ones use the effect's defaults). */
  params: Record<string, ParamValue>;
  /** Fade in / out, ms. */
  rampIn: number;
  rampOut: number;
};

/** A saved brush on a number key. Without colors it keeps the current ones. */
export type Preset = {
  key: string;
  name: string;
  type: EffectType;
  params: Record<string, ParamValue>;
  rampIn: number;
  rampOut: number;
  colors?: string[];
};

export type SnapMode = 'marks' | 'any' | 'grid' | 'off';

/** Editor view state saved with the project (not undoable). */
export type ViewState = {
  activeTrackId?: string;
  hiddenTrackIds: string[];
  trackOrder: string[];
  snap: SnapMode;
  /** What dragging on empty space does: draw a selection box, or draw an effect. */
  dragMode: 'select' | 'draw';
  pxPerSec?: number;
  viewStartMs?: number;
  scrollY?: number;
  /** The active brush: what every creation method uses. */
  brush: BrushState;
  /** The color set in use. */
  colorSetId: string;
  /** Brushes on the number keys (1-9, 0). */
  presets: Preset[];
  ripple: boolean;
  compact: boolean;
  panels: { left: boolean; right: boolean; preview: boolean };
  previewRect?: { x: number; y: number; w: number; h: number };
  mediaPath?: string;
};

export type Project = {
  id: string;
  name: string;
  version: 1;
  createdAt: number;
  updatedAt: number;
  audio: { fileName: string; hash: string; durationMs: number };
  frameMs: 25 | 50;
  timingTracks: TimingTrack[];
  sections: Section[];
  rows: Row[];
  effects: Record<string, Effect>;
  /** The color sets of this project (built-in ones, possibly edited). */
  colorSets: ColorSet[];
  /** Live links between rows and tracks (milestone C3). */
  bindings: unknown[];
  /** Saved arrangements (milestone C2). */
  recipes: unknown[];
  layout?: LayoutSnapshot;
  view: ViewState;
};
