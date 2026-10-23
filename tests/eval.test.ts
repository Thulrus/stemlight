import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mixTracks } from '../src/analysis/analyze';
import { parseTimingTracks } from '../src/core/parseXTiming';
import { ANALYSIS_SR, computeFeatures } from '../src/dsp/features';
import { eventF } from '../src/eval/metrics';
import { decodeWithFfmpeg, privateAudio } from './audio';

const audio = privateAudio();
const ref = Object.fromEntries(
  parseTimingTracks(readFileSync(new URL('../fixtures/ThisIsHalloween.xlights.xtiming', import.meta.url), 'utf8')).map((t) => [t.name, t]),
);
const fmt = (m: { precision: number; recall: number; f: number; est: number; ref: number }) =>
  `F=${m.f.toFixed(3)} P=${m.precision.toFixed(3)} R=${m.recall.toFixed(3)} (est ${m.est}, ref ${m.ref})`;

describe.skipIf(!audio)('benchmark: This Is Halloween vs xLights built-in analysis', () => {
  it('scores beats, bars and sections', () => {
    const t0 = performance.now();
    const f = computeFeatures(decodeWithFfmpeg(audio!, ANALYSIS_SR), ANALYSIS_SR);
    const t1 = performance.now();
    const { rhythm, tracks } = mixTracks(f);
    const t2 = performance.now();
    const by = Object.fromEntries(tracks.map((t) => [t.name, t]));
    const starts = (name: string, src = by) => src[name].marks.map((m) => m.start);

    const beats = eventF(starts('Beats'), starts('Beats', ref), 0.07);
    const bars = eventF(starts('Bars'), starts('Bars', ref), 0.07);
    const refSec = starts('Sections', ref).slice(1);
    const sections = eventF(starts('Sections').slice(1), refSec, 3);
    const refBeatLabels = new Map(ref.Beats.marks.map((m) => [Math.round(m.start * 20), m.label]));
    const labelAgree = by.Beats.marks.filter((m) => refBeatLabels.get(Math.round(m.start * 20)) === m.label).length;

    console.log(
      [
        `features ${(t1 - t0).toFixed(0)} ms, tracks ${(t2 - t1).toFixed(0)} ms, tempo ${rhythm.bpm.toFixed(1)} BPM`,
        `Beats    ${fmt(beats)}`,
        `Bars     ${fmt(bars)}`,
        `Sections ${fmt(sections)}  (ours: ${by.Sections.marks.map((m) => m.label).join(', ')})`,
        `Beat labels matching xLights on shared beats: ${labelAgree}/${by.Beats.marks.length}`,
        `Phrases ${by.Phrases.marks.length}, Onsets ${by.Onsets.marks.length}, Energy ${by.Energy.marks.map((m) => m.label).join(' ')}`,
      ].join('\n'),
    );
    expect(beats.f).toBeGreaterThan(0.5);
  });
});
