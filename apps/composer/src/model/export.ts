import { effectSettings, type EffectType } from '@stemlight/xlights/effects';
import { encodePalette } from '@stemlight/xlights/palette';
import { writeXsq, type XsqDocument, type XsqEffect, type XsqModel, type XsqTiming } from '@stemlight/xlights/xsq';
import type { Effect, Project, Row } from './types';

export type ExportOptions = {
  /** What to write as the media file: the audio file name (xLights looks in the show folder) or a typed path. */
  mediaFile: string;
  author?: string;
};

export type ExportReport = {
  errors: string[];
  warnings: string[];
  effectCount: number;
  rowCount: number;
};

function effectToXsq(e: Effect): XsqEffect {
  const pal = e.rawPalette ?? encodePalette(e.colors?.length ? e.colors.slice(0, 8) : ['#ffffff']);
  // Opaque (imported) effects keep their original settings string, untouched.
  const settings = e.raw ?? effectSettings(e.type as EffectType, e.params, e.ramp?.in ?? 0, e.ramp?.out ?? 0);
  return { name: e.type, startMs: e.startMs, endMs: e.endMs, settings, palette: pal };
}

/** Layers of a row's effects for export; empty layers are kept so layer numbers stay put. */
function rowLayers(row: Row, effects: Effect[]): XsqEffect[][] {
  const n = Math.max(1, row.layers, ...effects.map((e) => e.layer + 1));
  const layers: XsqEffect[][] = Array.from({ length: n }, () => []);
  for (const e of effects) layers[e.layer].push(effectToXsq(e));
  return layers;
}

/** Build the xLights document for a project, and say what was left out and why. */
export function projectToXsq(p: Project, opts: ExportOptions): { doc: XsqDocument; report: ExportReport } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byRow = new Map<string, Effect[]>();
  for (const e of Object.values(p.effects)) byRow.set(e.rowId, [...(byRow.get(e.rowId) ?? []), e]);

  // Invariants (the editor maintains them; this guards the file).
  for (const [rowId, list] of byRow) {
    const layers = new Map<number, Effect[]>();
    for (const e of list) {
      if (e.startMs % p.frameMs || e.endMs % p.frameMs) errors.push(`An effect on ${rowName(p, rowId)} at ${e.startMs} ms is off the ${p.frameMs} ms grid.`);
      if (e.endMs <= e.startMs) errors.push(`An effect on ${rowName(p, rowId)} at ${e.startMs} ms has no length.`);
      layers.set(e.layer, [...(layers.get(e.layer) ?? []), e]);
    }
    for (const l of layers.values()) {
      l.sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < l.length; i++) if (l[i].startMs < l[i - 1].endMs) errors.push(`Effects overlap on ${rowName(p, rowId)} at ${l[i].startMs} ms.`);
    }
  }

  const layoutNames = p.layout ? new Set([...p.layout.models.map((m) => m.name), ...p.layout.groups.map((g) => g.name)]) : undefined;
  if (!p.layout) warnings.push('No layout loaded, so model names are not checked. Rows are written under their own names.');

  const models: XsqModel[] = [];
  const byName = new Map<string, XsqModel>();
  let effectCount = 0;
  const skipped: string[] = [];
  for (const row of p.rows) {
    const effects = byRow.get(row.id) ?? [];
    if (row.kind === 'virtual' || !row.modelRef) {
      if (effects.length) skipped.push(`${row.name} (not mapped to a model yet)`);
      continue;
    }
    const [modelName, subName] = row.kind === 'submodel' ? splitRef(row.modelRef) : [row.modelRef, undefined];
    if (layoutNames && !layoutNames.has(modelName)) {
      if (effects.length) skipped.push(`${row.name} (not in the layout)`);
      continue;
    }
    let m = byName.get(modelName);
    if (!m) {
      m = { name: modelName, layers: [[]], submodels: [] };
      byName.set(modelName, m);
      models.push(m);
    }
    if (subName) m.submodels!.push({ name: subName, layers: rowLayers(row, effects) });
    else { m.layers = rowLayers(row, effects); m.collapsed = row.collapsed; }
    effectCount += effects.length;
  }
  if (skipped.length) warnings.push(`Left out (their effects are not exported): ${skipped.join(', ')}.`);

  // Single-color props only light up for white or their own color.
  const dark: string[] = [];
  for (const row of p.rows) {
    const m = p.layout?.models.find((x) => x.name === row.modelRef);
    if (!m?.singleColor) continue;
    const bad = (byRow.get(row.id) ?? []).filter((e) => {
      if (e.type === 'Off' || e.rawPalette) return false;
      const cols = e.colors ?? [];
      return !cols.some((c) => canShow(m.singleColor!, c));
    });
    if (bad.length) dark.push(`${row.name} (${bad.length})`);
  }
  if (dark.length) warnings.push(`These single-color props only light up in white or their own color, so some of their effects will stay dark: ${dark.join(', ')}.`);

  const visible = (id: string) => !p.view.hiddenTrackIds.includes(id);
  const ordered = [...p.timingTracks].sort((a, b) => p.view.trackOrder.indexOf(a.id) - p.view.trackOrder.indexOf(b.id));
  const timings: XsqTiming[] = [];
  if (p.sections.length) {
    timings.push({ name: uniqueName('Sections', ordered.map((t) => t.name)), layers: [p.sections.map((s) => ({ startMs: s.start, endMs: s.end, label: s.label }))] });
  }
  for (const t of ordered) {
    timings.push({
      name: t.name,
      layers: [t.marks, ...(t.layers ?? [])].map((l) => l.map((m) => ({ startMs: m.start, endMs: m.end, label: m.label }))),
      visible: visible(t.id),
      active: t.id === p.view.activeTrackId,
    });
  }

  const doc: XsqDocument = {
    author: opts.author,
    song: p.name,
    mediaFile: opts.mediaFile,
    frameMs: p.frameMs,
    durationMs: p.audio.durationMs,
    timings,
    models,
  };
  return { doc, report: { errors, warnings, effectCount, rowCount: models.length } };
}

export function exportXsq(p: Project, opts: ExportOptions): { xml: string; report: ExportReport } {
  const { doc, report } = projectToXsq(p, opts);
  return { xml: writeXsq(doc), report };
}

/**
 * The colors to use on a row: single-color props only show white or their own color, so
 * keep the colors they can show, or fall back to theirs.
 */
export function colorsForRow(p: Project, rowId: string | undefined, colors: string[]): string[] {
  const row = rowId ? p.rows.find((r) => r.id === rowId) : undefined;
  const single = row && p.layout?.models.find((m) => m.name === row.modelRef)?.singleColor;
  if (!single) return colors;
  const ok = colors.filter((c) => canShow(single, c));
  return ok.length ? ok : [single];
}

/** Whether a single-color prop of color `prop` lights up for palette color `c`. */
export function canShow(prop: string, c: string): boolean {
  const x = c.toLowerCase();
  if (x === prop.toLowerCase()) return true;
  const n = parseInt(x.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return r === g && g === b && r > 0; // white and greys
}

const rowName = (p: Project, id: string) => p.rows.find((r) => r.id === id)?.name ?? 'a deleted row';
const splitRef = (ref: string): [string, string] => {
  const i = ref.indexOf('/');
  return [ref.slice(0, i), ref.slice(i + 1)];
};
const uniqueName = (name: string, taken: string[]) => {
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) if (!taken.includes(`${name} ${i}`)) return `${name} ${i}`;
};
