import { children, parseXml } from './xml';
import type { XsqTiming } from './xsq';
import { readXsq } from './xsqRead';

/**
 * Timing tracks from an .xtiming file (one or many <timing> elements) or from an .xsq,
 * with every layer (lyric tracks have phrases, words and phonemes). Times in ms.
 */
export function readTimingFile(xml: string): XsqTiming[] {
  const root = parseXml(xml);
  if (root.name === 'xsequence') return readXsq(xml).timings;
  const timings = root.name === 'timing' ? [root] : children(root, 'timing');
  if (root.name !== 'timings' && root.name !== 'timing') throw new Error('Not an xLights timing file (.xtiming)');
  return timings.map((t) => ({
    name: t.attrs.name ?? 'Timing',
    subType: t.attrs.subType || undefined,
    layers: children(t, 'EffectLayer').map((l) =>
      children(l, 'Effect').map((e) => ({
        startMs: Math.round(Number(e.attrs.starttime ?? e.attrs.startTime ?? 0)),
        endMs: Math.round(Number(e.attrs.endtime ?? e.attrs.endTime ?? 0)),
        label: e.attrs.label ?? '',
      })),
    ),
  }));
}
