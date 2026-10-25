import { child, children, parseXml, type XNode } from './xml';

/**
 * What the composer needs from an xLights layout (xlights_rgbeffects.xml): models with a
 * rough position and size for the preview, groups with their members, and the names of
 * submodels, faces and states. The layout is only ever read, never written.
 */
export type LayoutModel = {
  name: string;
  /** xLights DisplayAs, e.g. "Arches", "Tree 360", "Matrix", "Single Line", "Circle". */
  displayAs: string;
  /** Approximate pixel (node) count. */
  pixels: number;
  /** Center of the model in layout coordinates (y up), and approximate extent. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Model color for single-color strings ("Single Color Custom" etc.), if set. */
  color?: string;
  stringType?: string;
  /**
   * For single-color props ("Single Color Red", "Single Color Custom", …): the one color the
   * prop can show. xLights lights such a prop only for effects in white or in this color.
   */
  singleColor?: string;
  submodels: string[];
  faces: string[];
  states: string[];
};

export type LayoutGroup = { name: string; members: string[] };

export type LayoutSnapshot = {
  models: LayoutModel[];
  groups: LayoutGroup[];
  /** Bounding box of all models, for fitting the preview. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  xlightsVersion?: string;
};

const num = (n: XNode, k: string, d = 0) => {
  const v = Number(n.attrs[k]);
  return Number.isFinite(v) ? v : d;
};

function pixelCount(m: XNode): number {
  const strings = num(m, 'NumStrings', num(m, 'parm1', 1)) || 1;
  const nodes = num(m, 'NodesPerString', num(m, 'parm2', 1)) || 1;
  return Math.max(1, nodes * strings);
}

/** Center and extent; exact sizes depend on the model type, this only needs to look right. */
function geometry(m: XNode): { x: number; y: number; w: number; h: number } {
  const x = num(m, 'WorldPosX');
  const y = num(m, 'WorldPosY');
  const sx = Math.abs(num(m, 'ScaleX', 1));
  const sy = Math.abs(num(m, 'ScaleY', 1));
  const display = m.attrs.DisplayAs ?? '';
  if (display === 'Single Line' || display === 'Two Point' || 'X2' in m.attrs) {
    const x2 = num(m, 'X2') * sx;
    const y2 = num(m, 'Y2') * sy;
    return { x: x + x2 / 2, y: y + y2 / 2, w: Math.max(1, Math.abs(x2)), h: Math.max(1, Math.abs(y2)) };
  }
  if (m.attrs.PointData) {
    const pts = m.attrs.PointData.split(',').map(Number);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 3) { xs.push(pts[i] * sx); ys.push(pts[i + 1] * sy); }
    if (xs.length) {
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      return { x: x + (minX + maxX) / 2, y: y + (minY + maxY) / 2, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }
  }
  return { x, y, w: sx, h: sy };
}

const SINGLE: Record<string, string> = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', white: '#ffffff', intensity: '#ffffff' };
function singleColor(stringType: string | undefined, custom: string | undefined): string | undefined {
  const m = /^single color\s*(\w+)?/i.exec(stringType ?? '');
  if (!m) return undefined;
  const kind = (m[1] ?? 'white').toLowerCase();
  if (kind === 'custom') return /^#[0-9a-f]{6}$/i.test(custom ?? '') ? custom!.toLowerCase() : '#ffffff';
  return SINGLE[kind] ?? '#ffffff';
}

export function parseLayout(xml: string): LayoutSnapshot {
  const root = parseXml(xml);
  if (root.name !== 'xrgb') throw new Error('Not an xLights layout (expected xlights_rgbeffects.xml)');
  const models: LayoutModel[] = children(child(root, 'models'), 'model').map((m) => {
    const g = geometry(m);
    return {
      name: m.attrs.name ?? '',
      displayAs: m.attrs.DisplayAs ?? '',
      pixels: pixelCount(m),
      ...g,
      color: m.attrs.CustomColor || undefined,
      stringType: m.attrs.StringType,
      singleColor: singleColor(m.attrs.StringType, m.attrs.CustomColor),
      submodels: children(m, 'subModel').map((s) => s.attrs.name).filter(Boolean),
      faces: children(m, 'faceInfo').map((f) => f.attrs.Name).filter(Boolean),
      states: children(m, 'stateInfo').map((f) => f.attrs.Name).filter(Boolean),
    };
  }).filter((m) => m.name);
  const groups: LayoutGroup[] = children(child(root, 'modelGroups'), 'modelGroup').map((g) => ({
    name: g.attrs.name ?? '',
    members: (g.attrs.models ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  })).filter((g) => g.name);
  const bounds = models.length
    ? {
        minX: Math.min(...models.map((m) => m.x - m.w / 2)),
        maxX: Math.max(...models.map((m) => m.x + m.w / 2)),
        minY: Math.min(...models.map((m) => m.y - m.h / 2)),
        maxY: Math.max(...models.map((m) => m.y + m.h / 2)),
      }
    : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const version = child(child(root, 'settings'), 'xlightsVersion')?.attrs.value;
  return { models, groups, bounds, xlightsVersion: version };
}
