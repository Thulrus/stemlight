import type { Track } from './types';

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag);
  return m ? unescape(m[1]) : undefined;
};

/**
 * Parse timing tracks from an .xtiming file or the timing <Element>s of an .xsq.
 * Regex-based so it runs in workers and Node without a DOM. Only the first
 * EffectLayer of each track is read.
 */
export function parseTimingTracks(xml: string, source = 'import'): Track[] {
  const tracks: Track[] = [];
  const blockRe = /<timing\b([^>]*)>([\s\S]*?)<\/timing>|<Element\b([^>]*\btype="timing"[^>]*)>([\s\S]*?)<\/Element>/g;
  for (const m of xml.matchAll(blockRe)) {
    const head = m[1] ?? m[3];
    const body = m[2] ?? m[4];
    const name = attr(head, 'name') ?? 'Timing';
    const layer = /<EffectLayer\b[^>]*>([\s\S]*?)<\/EffectLayer>/.exec(body)?.[1] ?? '';
    const marks = [...layer.matchAll(/<Effect\b[^>]*\/?>/g)].map((e) => ({
      start: Number(attr(e[0], 'starttime')) / 1000,
      end: Number(attr(e[0], 'endtime')) / 1000,
      label: attr(e[0], 'label') ?? '',
    }));
    tracks.push({ id: `${source}-${name}`, name, source, marks, params: {} });
  }
  return tracks;
}
