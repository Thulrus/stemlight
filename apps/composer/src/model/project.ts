import type { LayoutModel, LayoutSnapshot } from '@stemlight/xlights/layout';
import type { Change } from './change';
import { copySets, DEFAULT_COLOR_SET } from './colors';
import type { Effect, Preset, Project, Row, RowKind, Section, TimingTrack } from './types';

let counter = 0;
/** Short unique ids (time + counter + random), stable across sessions. */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}


/** Row colors by xLights model type, for quick scanning. */
const TYPE_COLORS: [RegExp, string][] = [
  [/arch/i, '#f59e0b'],
  [/tree/i, '#22c55e'],
  [/matrix|cube/i, '#06b6d4'],
  [/star|spinner|wreath|circle/i, '#a855f7'],
  [/line|icicle|window|candy/i, '#3b82f6'],
  [/custom/i, '#ec4899'],
];
const GROUP_COLOR = '#94a3b8';
const VIRTUAL_COLOR = '#64748b';

export function colorForModel(m?: LayoutModel): string {
  if (!m) return VIRTUAL_COLOR;
  return TYPE_COLORS.find(([re]) => re.test(m.displayAs))?.[1] ?? '#eab308';
}

export const DEFAULT_ROW_HEIGHT = 30;
export const COMPACT_ROW_HEIGHT = 16;

export function makeRow(name: string, kind: RowKind, extra: Partial<Row> = {}): Row {
  return {
    id: uid('r'),
    name,
    kind,
    modelRef: kind === 'virtual' ? undefined : name,
    layers: 1,
    collapsed: false,
    expanded: false,
    height: DEFAULT_ROW_HEIGHT,
    color: kind === 'group' ? GROUP_COLOR : VIRTUAL_COLOR,
    hidden: false,
    muted: false,
    locked: false,
    ...extra,
  };
}

/**
 * Rows for a layout: groups first, then models in layout order, submodels nested under their
 * parent. Big layouts start with groups only (the user adds models from the row picker).
 */
export function rowsFromLayout(layout: LayoutSnapshot, pick?: Set<string>): Row[] {
  const big = layout.models.length > 40;
  const want = (name: string, isGroup: boolean) => (pick ? pick.has(name) : isGroup || !big);
  const rows: Row[] = [];
  for (const g of layout.groups) if (want(g.name, true)) rows.push(makeRow(g.name, 'group'));
  for (const m of layout.models) {
    if (!want(m.name, false)) continue;
    const parent = makeRow(m.name, 'model', { color: colorForModel(m) });
    rows.push(parent);
    for (const s of m.submodels) {
      rows.push(makeRow(s, 'submodel', { modelRef: `${m.name}/${s}`, parentId: parent.id, color: parent.color }));
    }
  }
  return rows;
}

/** Sections from a "Sections" timing track (Stemlight's or xLights'), if there is one. */
export function sectionsFromTracks(tracks: TimingTrack[]): Section[] {
  const t = tracks.find((x) => /^sections?$/i.test(x.name.trim()));
  if (!t) return [];
  return t.marks.map((m, i) => ({ id: uid('s'), label: m.label || `Section ${i + 1}`, start: m.start, end: m.end }));
}

export function newProject(init: {
  name: string;
  audio: Project['audio'];
  frameMs: 25 | 50;
  tracks: TimingTrack[];
  layout?: LayoutSnapshot;
}): Project {
  const sections = sectionsFromTracks(init.tracks);
  const tracks = sections.length ? init.tracks.filter((t) => !/^sections?$/i.test(t.name.trim())) : init.tracks;
  const rows = init.layout ? rowsFromLayout(init.layout) : [];
  const preferred = ['Beats', 'Bars', 'Phrases'];
  const active = preferred.map((n) => tracks.find((t) => t.name === n)).find(Boolean) ?? tracks[0];
  const now = Date.now();
  return {
    id: uid('p'),
    name: init.name,
    version: 1,
    createdAt: now,
    updatedAt: now,
    audio: init.audio,
    frameMs: init.frameMs,
    timingTracks: tracks,
    sections,
    rows,
    effects: {},
    colorSets: copySets(),
    bindings: [],
    recipes: [],
    layout: init.layout,
    view: {
      activeTrackId: active?.id,
      hiddenTrackIds: [],
      trackOrder: tracks.map((t) => t.id),
      snap: 'marks',
      dragMode: 'select',
      brush: { type: 'On', colors: ['#ffffff'], params: {}, rampIn: 0, rampOut: 0 },
      colorSetId: DEFAULT_COLOR_SET,
      presets: DEFAULT_PRESETS.map((x) => ({ ...x, params: { ...x.params } })),
      ripple: false,
      compact: false,
      panels: { left: true, right: true, preview: true },
    },
  };
}

/** The number-key presets a new project starts with: the effects porch sequencers reach for most. */
export const DEFAULT_PRESETS: Preset[] = [
  { key: '1', name: 'On', type: 'On', params: {}, rampIn: 0, rampOut: 0 },
  { key: '2', name: 'Fade out', type: 'On', params: { Eff_On_Start: 100, Eff_On_End: 0 }, rampIn: 0, rampOut: 0 },
  { key: '3', name: 'Fade in', type: 'On', params: { Eff_On_Start: 0, Eff_On_End: 100 }, rampIn: 0, rampOut: 0 },
  { key: '4', name: 'Color Wash', type: 'Color Wash', params: {}, rampIn: 0, rampOut: 0 },
  { key: '5', name: 'Twinkle', type: 'Twinkle', params: {}, rampIn: 0, rampOut: 0 },
  { key: '6', name: 'Shimmer', type: 'Shimmer', params: {}, rampIn: 0, rampOut: 0 },
  { key: '7', name: 'Chase', type: 'SingleStrand', params: {}, rampIn: 0, rampOut: 0 },
  { key: '8', name: 'Bars', type: 'Bars', params: {}, rampIn: 0, rampOut: 0 },
  { key: '9', name: 'Butterfly', type: 'Butterfly', params: {}, rampIn: 0, rampOut: 0 },
  { key: '0', name: 'Off', type: 'Off', params: {}, rampIn: 0, rampOut: 0 },
];

type Legacy = { palettes?: { id: string; colors: string[] }[] };

/** Effects saved before colors were stored on the effect pointed at a project palette. */
export function migrateEffect(e: Effect, palettes: Legacy['palettes']): Effect {
  if (Array.isArray(e.colors)) return e;
  const { paletteId, ...rest } = e as Effect & { paletteId?: string };
  return { ...rest, colors: [...(palettes?.find((x) => x.id === paletteId)?.colors ?? ['#ffffff'])].slice(0, 8) };
}

/** Undo history saved with older projects holds effects in the old shape too. */
export function migrateHistory<H extends { undo: Change[]; redo: Change[] }>(h: H | undefined, old: Project): H | undefined {
  const legacy = (old as Project & Legacy).palettes;
  if (!h || !legacy) return h;
  const fix = (c: Change): Change => {
    const effects: Change['effects'] = {};
    for (const [id, [a, b]] of Object.entries(c.effects)) effects[id] = [a && migrateEffect(a, legacy), b && migrateEffect(b, legacy)];
    const fields = { ...c.fields } as Record<string, unknown>;
    delete fields.palettes;
    return { ...c, effects, fields: fields as Change['fields'] };
  };
  return { ...h, undo: h.undo.map(fix), redo: h.redo.map(fix) };
}

/** Bring projects saved by older versions up to the current shape. */
export function normalizeProject(input: Project): Project {
  let p = input;
  const legacy = (p as Project & Legacy).palettes;
  const pal = (id?: string) => legacy?.find((x) => x.id === id)?.colors;
  if (legacy || !p.colorSets) {
    // Palettes referenced by id became colors stored on each effect, brush and preset.
    const effects: Record<string, Effect> = {};
    for (const [id, e] of Object.entries(p.effects)) effects[id] = migrateEffect(e, legacy);
    const { palettes: _drop, ...rest } = p as Project & Legacy;
    void _drop;
    p = { ...rest, effects, colorSets: p.colorSets ?? copySets(), rows: p.rows.map((r) => { const { defaultPaletteId: _d, ...rr } = r as Row & { defaultPaletteId?: string }; void _d; return rr; }) } as Project;
  }
  const v = p.view as Project['view'] & { brush: { params?: Record<string, unknown>; rampIn?: number; paletteId?: string } };
  let brush = v.brush as Project['view']['brush'] & { paletteId?: string };
  if (brush.rampIn === undefined) {
    // Old brushes kept params per effect type: { On: {...}, Twinkle: {...} }.
    const old = (brush.params ?? {}) as Record<string, unknown>;
    const mine = old[brush.type];
    brush = { ...brush, params: (mine && typeof mine === 'object' ? mine : {}) as Project['view']['brush']['params'], rampIn: 0, rampOut: 0 };
  }
  if (!brush.colors) {
    const { paletteId, ...b } = brush;
    brush = { ...b, colors: pal(paletteId) ?? ['#ffffff'] };
  }
  const presets = (v.presets ?? DEFAULT_PRESETS.map((x) => ({ ...x, params: { ...x.params } }))).map((pr) => {
    const old = pr as Preset & { paletteId?: string };
    if (old.paletteId === undefined) return pr;
    const { paletteId, ...rest } = old;
    return { ...rest, colors: pal(paletteId) };
  });
  // Earlier versions added a layer whenever effects overlapped; drop layers left empty.
  const used = new Map<string, number>();
  for (const e of Object.values(p.effects)) used.set(e.rowId, Math.max(used.get(e.rowId) ?? 0, e.layer + 1));
  const rows = p.rows.map((r) => {
    const n = Math.max(1, used.get(r.id) ?? 1);
    return r.layers > n ? { ...r, layers: n } : r;
  });
  return { ...p, rows, view: { ...v, brush, presets, dragMode: v.dragMode ?? 'select', colorSetId: v.colorSetId ?? DEFAULT_COLOR_SET } };
}

/** Section label without its number: "Chorus 2" → "chorus". */
export const baseLabel = (label: string) => label.trim().replace(/\s*\d+$/, '').toLowerCase();
