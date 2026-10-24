import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEM_PARAMS, stemTracks } from '../src/analysis/stems';
import type { Track } from '../src/core/types';
import { computeFeatures, type Features } from '../src/dsp/features';
import { eventF, spanOverlapF } from '../src/eval/metrics';
import { parseModelEffects, unionSpans } from '../src/eval/xsq';
import { STEM_NAMES, type StemName } from '../src/separation/htdemucs';
import { readWav16, STEMS_DIR } from './audio';

const HALLOWEEN = '00 - 03 This Is Halloween';
const songs = existsSync(STEMS_DIR) ? readdirSync(STEMS_DIR).filter((d) => existsSync(`${STEMS_DIR}${d}/vocals.wav`)) : [];
const f3 = (x: number) => x.toFixed(3);

/** Stem tracks for one cached song; the mix is the sum of the stems (they reconstruct it at ~30 dB SNR). */
function analyzeSong(song: string): { tracks: Track[]; ms: number } {
  const t0 = performance.now();
  const feats: Partial<Record<StemName, Features>> = {};
  const samples: Partial<Record<StemName, Float32Array>> = {};
  let sr = 22050;
  for (const n of STEM_NAMES) {
    const w = readWav16(`${STEMS_DIR}${song}/${n}.wav`);
    sr = w.sr;
    samples[n] = w.samples;
    feats[n] = computeFeatures(w.samples, sr);
  }
  const mix = new Float32Array(samples.vocals!.length);
  for (const n of STEM_NAMES) samples[n]!.forEach((v, i) => (mix[i] += v));
  const tracks = stemTracks(feats, samples, DEFAULT_STEM_PARAMS, computeFeatures(mix, sr));
  return { tracks, ms: performance.now() - t0 };
}

describe.skipIf(!songs.includes(HALLOWEEN))('benchmark: stem tracks vs hand-placed effects (This Is Halloween)', () => {
  it('scores vocal and instrument tracks', () => {
    const { tracks, ms } = analyzeSong(HALLOWEEN);
    const by = Object.fromEntries(tracks.map((t) => [t.name, t]));
    const fx = parseModelEffects(readFileSync(new URL('../fixtures/ThisIsHalloweenFilm.xsq', import.meta.url), 'utf8'));
    const pumpkins = [...fx].filter(([k]) => k.startsWith('Pumpkin')).flatMap(([, v]) => v);
    const pumpkinStarts = [...new Set(pumpkins.map((e) => e.start))];
    const lines = unionSpans(pumpkins, 0.15);

    const syl = eventF(by['Vocal syllables'].marks.map((m) => m.start), pumpkinStarts, 0.1);
    const cover = spanOverlapF(by['Vocal phrases'].marks, unionSpans(pumpkins));
    const phr = eventF(by['Vocal phrases'].marks.map((m) => m.start), lines.map((s) => s.start), 0.25);
    console.log([
      `analysis ${ms.toFixed(0)} ms`,
      ...tracks.map((t) => {
        const d = t.marks.map((m) => m.end - m.start).sort((a, b) => a - b);
        return `  ${t.name.padEnd(16)} ${String(t.marks.length).padStart(4)} marks, median ${f3(d[d.length >> 1] ?? 0)} s  e.g. ${t.marks.slice(10, 14).map((m) => `${m.start.toFixed(2)}${m.label ? ' ' + m.label : ''}`).join(', ')}`;
      }),
      `Vocal syllables vs pumpkin starts (±100 ms): F=${f3(syl.f)} P=${f3(syl.precision)} R=${f3(syl.recall)} (est ${syl.est}, ref ${syl.ref})`,
      `Vocal phrase starts vs pumpkin line starts (±250 ms): F=${f3(phr.f)} (est ${phr.est}, ref ${phr.ref}); coverage F=${f3(cover.f)}`,
    ].join('\n'));
    expect(syl.f).toBeGreaterThan(0.7);
    expect(phr.f).toBeGreaterThan(0.55);
  });
});

describe.skipIf(songs.length < 2)('stem tracks across genres (sanity, no ground truth)', () => {
  it('prints mark counts per song', () => {
    const rows = songs.map((song) => {
      const { tracks } = analyzeSong(song);
      return `${song.slice(0, 30).padEnd(30)} ${tracks.map((t) => `${t.name.replace(/^Vocal /, 'V.')} ${t.marks.length}`).join(' | ')}`;
    });
    console.log(rows.join('\n'));
  });
});
