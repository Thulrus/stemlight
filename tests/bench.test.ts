import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEM_PARAMS, stemTracks } from '../src/analysis/stems';
import type { Track } from '../src/core/types';
import { computeFeatures, type Features } from '../src/dsp/features';
import { BENCH_CASES } from '../src/eval/bench';
import { STEM_NAMES, type StemName } from '../src/separation/htdemucs';
import { readWav16, STEMS_DIR } from './audio';

const available = BENCH_CASES.filter((c) => existsSync(`${STEMS_DIR}${c.song}/vocals.wav`));

/** Stem tracks for one cached song; the mix is the sum of the stems (they reconstruct it at ~30 dB SNR). */
export function analyzeCachedSong(song: string): Record<string, Track> {
  const feats: Partial<Record<StemName, Features>> = {};
  const samples: Partial<Record<StemName, Float32Array>> = {};
  let sr = 22050;
  // VOCALS=vocals_hq benchmarks the Mel-Band RoFormer vocals in place of HTDemucs's.
  const vocalsFile = process.env.VOCALS ?? 'vocals';
  for (const n of STEM_NAMES) {
    const file = n === 'vocals' && existsSync(`${STEMS_DIR}${song}/${vocalsFile}.wav`) ? vocalsFile : n;
    const w = readWav16(`${STEMS_DIR}${song}/${file}.wav`);
    sr = w.sr;
    samples[n] = w.samples;
    feats[n] = computeFeatures(w.samples, sr);
  }
  const mix = new Float32Array(samples.vocals!.length);
  for (const n of STEM_NAMES) samples[n]!.forEach((v, i) => (mix[i] += v));
  return Object.fromEntries(stemTracks(feats, samples, DEFAULT_STEM_PARAMS, computeFeatures(mix, sr)).map((t) => [t.name, t]));
}

describe.skipIf(available.length === 0)('benchmark: stem tracks vs hand-made sequences', () => {
  it('scores every available case', () => {
    const all: number[] = [];
    const vocal: number[] = [];
    const rows: string[] = [];
    for (const c of available) {
      const xsq = readFileSync(new URL(`../fixtures/${c.xsq}.xsq`, import.meta.url), 'utf8');
      const scores = c.score(xsq, analyzeCachedSong(c.song));
      for (const [k, v] of Object.entries(scores)) {
        rows.push(`  ${c.id.padEnd(16)} ${k.padEnd(32)} ${v.toFixed(3)}`);
        all.push(v);
        if (/syllable|phrase/.test(k)) vocal.push(v);
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log([...rows, `  ${'MEAN (vocal)'.padEnd(49)} ${mean(vocal).toFixed(3)}`, `  ${'MEAN (all)'.padEnd(49)} ${mean(all).toFixed(3)}`].join('\n'));
    expect(mean(all)).toBeGreaterThan(0.4);
  });
});
