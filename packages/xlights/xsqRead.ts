import { child, children, parseXml, type XNode } from './xml';
import type { XsqDocument, XsqEffect, XsqMark, XsqModel, XsqTiming } from './xsq';

/**
 * Reads an .xsq into the same shape the writer takes. What it doesn't model (fixed timing
 * tracks, strands and nodes, jukebox, effect symbols, …) is listed in `unsupported`, so
 * callers can warn or keep the source; full passthrough comes with round-trip import.
 */
export type XsqRead = XsqDocument & { unsupported: string[] };

const int = (s: string | undefined) => Math.round(Number(s ?? 0));

export function readXsq(xml: string): XsqRead {
  const root = parseXml(xml);
  if (root.name !== 'xsequence') throw new Error('Not an xLights sequence (.xsq)');
  const head = child(root, 'head');
  const h = (k: string) => child(head, k)?.text.trim() ?? '';
  const unsupported = new Set<string>();

  const palettes = children(child(root, 'ColorPalettes'), 'ColorPalette').map((n) => n.text);
  const settings = children(child(root, 'EffectDB'), 'Effect').map((n) => n.text);

  const display = new Map<string, XNode>();
  for (const e of children(child(root, 'DisplayElements'), 'Element')) display.set(`${e.attrs.type}:${e.attrs.name}`, e);

  const readEffects = (layer: XNode): XsqEffect[] =>
    children(layer, 'Effect').map((e) => ({
      name: e.attrs.name ?? '',
      startMs: int(e.attrs.startTime),
      endMs: int(e.attrs.endTime),
      settings: e.attrs.ref !== undefined ? (settings[int(e.attrs.ref)] ?? '') : '',
      palette: e.attrs.palette !== undefined ? (palettes[int(e.attrs.palette)] ?? '') : '',
    }));

  const timings: XsqTiming[] = [];
  const models: XsqModel[] = [];
  for (const el of children(child(root, 'ElementEffects'), 'Element')) {
    const name = el.attrs.name ?? '';
    const d = display.get(`${el.attrs.type}:${name}`);
    const flag = (k: string, dflt: boolean) => {
      const v = d?.attrs[k];
      return v === undefined ? dflt : v === 'true' || v === '1';
    };
    if (el.attrs.type === 'timing') {
      if (el.attrs.fixed) unsupported.add('fixed timing tracks');
      const layers = children(el, 'EffectLayer').map((l): XsqMark[] =>
        children(l, 'Effect').map((e) => ({ startMs: int(e.attrs.startTime), endMs: int(e.attrs.endTime), label: e.attrs.label ?? '' })),
      );
      timings.push({ name, layers, visible: flag('visible', true), active: flag('active', false), collapsed: flag('collapsed', false), subType: d?.attrs.subType });
    } else {
      const subs = new Map<string, XsqEffect[][]>();
      for (const s of children(el, 'SubModelEffectLayer')) {
        const sName = s.attrs.name ?? '';
        const layers = subs.get(sName) ?? [];
        layers[int(s.attrs.layer)] = readEffects(s);
        subs.set(sName, layers);
      }
      if (children(el, 'Strand').length) unsupported.add('strand and node effects');
      models.push({
        name,
        layers: children(el, 'EffectLayer').map(readEffects),
        submodels: [...subs].map(([n, layers]) => ({ name: n, layers: Array.from(layers, (l) => l ?? []) })),
        visible: flag('visible', true),
        collapsed: flag('collapsed', false),
      });
    }
  }
  for (const tag of ['Jukebox', 'EffectSymbols', 'SequenceFaces', 'SongStructure']) {
    const n = child(root, tag);
    if (n && n.children.length) unsupported.add(tag);
  }

  const timing = h('sequenceTiming').match(/\d+/)?.[0];
  return {
    version: h('version'),
    author: h('author'),
    song: h('song'),
    artist: h('artist'),
    album: h('album'),
    comment: h('comment'),
    mediaFile: h('mediaFile'),
    frameMs: timing === '25' ? 25 : 50,
    durationMs: Math.round(Number(h('sequenceDuration') || 0) * 1000),
    timings,
    models,
    unsupported: [...unsupported],
  };
}
