import type { Track } from '../core/types';
import { quantizeMarks } from '../core/quantize';

/** Version string written as SourceVersion; matches the xLights build the fixtures came from. */
export const XLIGHTS_SOURCE_VERSION = '2026.17';

export type ExportOptions = { gridMs: number; durationSec?: number; sourceVersion?: string };

export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function timingElement(track: Track, opts: ExportOptions): string {
  const version = opts.sourceVersion ?? XLIGHTS_SOURCE_VERSION;
  const marks = quantizeMarks(track.marks, opts.gridMs, opts.durationSec);
  const lines = [
    `<timing name="${escapeXmlAttr(track.name)}" subType="" SourceVersion="${escapeXmlAttr(version)}">`,
    '   <EffectLayer>',
    ...marks.map(
      (m) => `      <Effect label="${escapeXmlAttr(m.label)}" starttime="${m.start}" endtime="${m.end}" />`,
    ),
    '   </EffectLayer>',
    '</timing>',
  ];
  return lines.join('\n');
}

/**
 * Serialize tracks as an .xtiming file, byte-for-byte in the layout xLights itself
 * exports (see fixtures/ThisIsHalloween.xlights.xtiming). One file may hold many tracks.
 */
export function toXTiming(tracks: readonly Track[], opts: ExportOptions): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<timings>',
    ...tracks.map((t) => timingElement(t, opts)),
    '</timings>',
    '',
  ].join('\n');
}

/** Make a track name safe to use as a file name. */
export function fileSafeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';
}
