import { escapeXmlAttr, escapeXmlText } from './xml';

/**
 * Writes xLights sequences (.xsq). The layout follows SequenceFile::BuildDocument in
 * xLights 2026.17 (src-core/render/SequenceFile.cpp) and the fixtures it exported:
 * head, ColorPalettes, EffectDB, SequenceMedia, DataLayers, DisplayElements,
 * ElementEffects, lastView, TimingTags. Settings and palette strings are deduplicated
 * into the tables in order of first use, as xLights does, and effect ids are each
 * effect's index in its layer, written only when non-zero.
 */

export const XSQ_VERSION = '2026.17';

export type XsqMark = { startMs: number; endMs: number; label: string };

export type XsqTiming = {
  name: string;
  /** One or more layers of marks (lyric tracks use three: phrases, words, phonemes). */
  layers: XsqMark[][];
  visible?: boolean;
  active?: boolean;
  collapsed?: boolean;
  subType?: string;
};

export type XsqEffect = {
  /** xLights effect name, e.g. "On", "Color Wash". */
  name: string;
  startMs: number;
  endMs: number;
  /** Settings string (see settings.ts). */
  settings: string;
  /** Palette string (see palette.ts); empty for effects without one. */
  palette: string;
};

export type XsqModel = {
  name: string;
  /** Effect layers of the model itself; at least one (it may be empty). */
  layers: XsqEffect[][];
  /** Submodel rows nested under the model. */
  submodels?: { name: string; layers: XsqEffect[][] }[];
  visible?: boolean;
  collapsed?: boolean;
};

export type XsqDocument = {
  version?: string;
  author?: string;
  song?: string;
  artist?: string;
  album?: string;
  comment?: string;
  /** Media file name or path, as xLights should resolve it. */
  mediaFile: string;
  frameMs: 25 | 50;
  durationMs: number;
  timings: XsqTiming[];
  models: XsqModel[];
};

const bool = (b: boolean | undefined, dflt: boolean) => ((b ?? dflt) ? 'true' : 'false');
const text = (tag: string, value = '') => (value ? `<${tag}>${escapeXmlText(value)}</${tag}>` : `<${tag}></${tag}>`);

export function writeXsq(doc: XsqDocument): string {
  const settingsIdx = new Map<string, number>();
  const paletteIdx = new Map<string, number>();
  const ref = (map: Map<string, number>, s: string) => {
    let i = map.get(s);
    if (i === undefined) { i = map.size; map.set(s, i); }
    return i;
  };

  const effectLines = (layer: XsqEffect[], indent: string) => {
    const sorted = [...layer].sort((a, b) => a.startMs - b.startMs);
    return sorted.map((e, i) => {
      const attrs = [`ref="${ref(settingsIdx, e.settings)}"`, `name="${escapeXmlAttr(e.name)}"`];
      if (i) attrs.push(`id="${i}"`);
      attrs.push(`startTime="${Math.round(e.startMs)}"`, `endTime="${Math.round(e.endMs)}"`);
      if (e.palette) attrs.push(`palette="${ref(paletteIdx, e.palette)}"`);
      return `${indent}<Effect ${attrs.join(' ')} />`;
    });
  };
  const layerBlock = (tag: string, attrs: string, effects: string[], indent: string) =>
    effects.length ? [`${indent}<${tag}${attrs}>`, ...effects, `${indent}</${tag}>`] : [`${indent}<${tag}${attrs} />`];

  // Element effects first, so the palette and settings tables fill in document order.
  const elementEffects: string[] = [];
  for (const t of doc.timings) {
    elementEffects.push(`    <Element type="timing" name="${escapeXmlAttr(t.name)}">`);
    const layers = t.layers.length ? t.layers : [[]];
    for (const layer of layers) {
      const marks = [...layer].sort((a, b) => a.startMs - b.startMs).map(
        (m) => `        <Effect label="${escapeXmlAttr(m.label)}" startTime="${Math.round(m.startMs)}" endTime="${Math.round(m.endMs)}" />`,
      );
      elementEffects.push(...layerBlock('EffectLayer', '', marks, '      '));
    }
    elementEffects.push('    </Element>');
  }
  for (const m of doc.models) {
    elementEffects.push(`    <Element type="model" name="${escapeXmlAttr(m.name)}">`);
    const layers = m.layers.length ? m.layers : [[]];
    for (const layer of layers) elementEffects.push(...layerBlock('EffectLayer', '', effectLines(layer, '        '), '      '));
    for (const sm of m.submodels ?? []) {
      sm.layers.forEach((layer, j) => {
        if (!layer.length) return;
        const attrs = `${j > 0 ? ` layer="${j}"` : ''} name="${escapeXmlAttr(sm.name)}"`;
        elementEffects.push(...layerBlock('SubModelEffectLayer', attrs, effectLines(layer, '        '), '      '));
      });
    }
    elementEffects.push('    </Element>');
  }

  const displayElements = [
    ...doc.timings.map((t) => {
      const sub = t.subType ? ` subType="${escapeXmlAttr(t.subType)}"` : '';
      return `    <Element collapsed="${bool(t.collapsed, false)}" type="timing" name="${escapeXmlAttr(t.name)}" visible="${bool(t.visible, true)}" views="" active="${bool(t.active, false)}"${sub} />`;
    }),
    ...doc.models.map((m) => `    <Element collapsed="${bool(m.collapsed, false)}" type="model" name="${escapeXmlAttr(m.name)}" visible="${bool(m.visible, true)}" />`),
  ];

  const lines = [
    '<?xml version="1.0"?>',
    '<xsequence BaseChannel="0" ChanCtrlBasic="0" ChanCtrlColor="0" FixedPointTiming="1" ModelBlending="true">',
    '  <head>',
    `    ${text('version', doc.version ?? XSQ_VERSION)}`,
    `    ${text('author', doc.author)}`,
    `    ${text('author-email')}`,
    `    ${text('author-website')}`,
    `    ${text('song', doc.song)}`,
    `    ${text('artist', doc.artist)}`,
    `    ${text('album', doc.album)}`,
    `    ${text('MusicURL')}`,
    `    ${text('comment', doc.comment)}`,
    `    <sequenceTiming>${doc.frameMs} ms</sequenceTiming>`,
    '    <sequenceType>Media</sequenceType>',
    `    ${text('mediaFile', doc.mediaFile)}`,
    `    <sequenceDuration>${(doc.durationMs / 1000).toFixed(3)}</sequenceDuration>`,
    `    ${text('imageDir')}`,
    '  </head>',
    ...(paletteIdx.size
      ? ['  <ColorPalettes>', ...[...paletteIdx.keys()].map((p) => `    <ColorPalette>${escapeXmlText(p)}</ColorPalette>`), '  </ColorPalettes>']
      : ['  <ColorPalettes />']),
    ...(settingsIdx.size
      ? ['  <EffectDB>', ...[...settingsIdx.keys()].map((s) => `    <Effect>${escapeXmlText(s)}</Effect>`), '  </EffectDB>']
      : ['  <EffectDB />']),
    '  <SequenceMedia />',
    '  <DataLayers>',
    '    <DataLayer lor_params="0" channel_offset="0" num_channels="0" num_frames="0" data="&lt;rendered: erase-mode>" source="&lt;auto-generated>" name="Nutcracker" />',
    '  </DataLayers>',
    ...(displayElements.length ? ['  <DisplayElements>', ...displayElements, '  </DisplayElements>'] : ['  <DisplayElements />']),
    ...(elementEffects.length ? ['  <ElementEffects>', ...elementEffects, '  </ElementEffects>'] : ['  <ElementEffects />']),
    '  <lastView>0</lastView>',
    '  <TimingTags>',
    ...Array.from({ length: 10 }, (_, i) => `    <Tag number="${i}" position="-1" />`),
    '  </TimingTags>',
    '</xsequence>',
    '',
  ];
  return lines.join('\n');
}
