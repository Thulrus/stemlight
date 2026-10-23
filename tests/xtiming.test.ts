import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseTimingTracks } from '../src/core/parseXTiming';
import { quantizeMarks } from '../src/core/quantize';
import type { Track } from '../src/core/types';
import { escapeXmlAttr, toXTiming } from '../src/export/xtiming';
import { tracksToZip } from '../src/export/zip';

const fixture = readFileSync(new URL('../fixtures/ThisIsHalloween.xlights.xtiming', import.meta.url), 'utf8');
const xsq = readFileSync(new URL('../fixtures/ThisIsHalloweenFilm.xsq', import.meta.url), 'utf8');

describe('xtiming export', () => {
  it('reproduces the xLights-exported fixture byte for byte', () => {
    const tracks = parseTimingTracks(fixture);
    expect(tracks.map((t) => t.name)).toEqual(['Bars', 'Beats', 'Sections']);
    expect(toXTiming(tracks, { gridMs: 50 })).toBe(fixture);
  });

  it('agrees with the timing tracks stored in the .xsq', () => {
    const fromX = parseTimingTracks(fixture);
    const fromSeq = parseTimingTracks(xsq);
    expect(fromSeq.map((t) => t.name)).toEqual(fromX.map((t) => t.name));
    fromSeq.forEach((t, i) => expect(t.marks).toEqual(fromX[i].marks));
  });

  it('escapes labels and names', () => {
    expect(escapeXmlAttr(`a&b<"c">'`)).toBe('a&amp;b&lt;&quot;c&quot;&gt;&apos;');
    const t: Track = { id: 'x', name: 'Rock & Roll', source: 'mix', params: {}, marks: [{ start: 0, end: 0.1, label: '<1>' }] };
    const xml = toXTiming([t], { gridMs: 50 });
    expect(xml).toContain('name="Rock &amp; Roll"');
    expect(parseTimingTracks(xml)[0].marks[0].label).toBe('<1>');
  });

  it('zips one file per track with unique names', () => {
    const t: Track = { id: 'a', name: 'Kick/Snare', source: 'drums', params: {}, marks: [{ start: 1, end: 1.05 }] };
    const files = unzipSync(tracksToZip([t, { ...t, id: 'b' }], { gridMs: 50 }));
    expect(Object.keys(files)).toEqual(['Kick_Snare.xtiming', 'Kick_Snare (2).xtiming']);
    expect(strFromU8(files['Kick_Snare.xtiming'])).toContain('starttime="1000" endtime="1050"');
  });
});

describe('quantizeMarks', () => {
  it('snaps to the grid', () => {
    expect(quantizeMarks([{ start: 0.212, end: 0.61 }], 50)).toEqual([{ start: 200, end: 600, label: '' }]);
    expect(quantizeMarks([{ start: 0.212, end: 0.61 }], 25)).toEqual([{ start: 200, end: 600, label: '' }]);
    expect(quantizeMarks([{ start: 0.2374, end: 0.61 }], 25)).toEqual([{ start: 225, end: 600, label: '' }]);
  });

  it('gives point marks one grid step and merges hits in the same cell', () => {
    const q = quantizeMarks([{ start: 1.0, end: 1.0 }, { start: 1.01, end: 1.01 }, { start: 1.2, end: 1.2 }], 50);
    expect(q).toEqual([{ start: 1000, end: 1050, label: '' }, { start: 1200, end: 1250, label: '' }]);
  });

  it('never overlaps, keeps contiguous spans contiguous, and clamps to the duration', () => {
    const q = quantizeMarks([{ start: 0, end: 1.03 }, { start: 1.0, end: 2 }, { start: 1.99, end: 3.5 }], 50, 3.02);
    expect(q).toEqual([
      { start: 0, end: 1050, label: '' },
      { start: 1050, end: 2000, label: '' },
      { start: 2000, end: 3000, label: '' },
    ]);
    for (let i = 1; i < q.length; i++) expect(q[i].start).toBeGreaterThanOrEqual(q[i - 1].end);
  });
});
