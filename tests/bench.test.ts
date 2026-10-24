import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRhythm } from '../src/analysis/analyze';
import { buildTracks, DEFAULT_BUILD_PARAMS, type BuildInputs, type BuildParams } from '../src/analysis/build';
import { applyVocalPrior } from '../src/align/acoustic';
import { greedySyllables } from '../src/align/greedy';
import type { Track } from '../src/core/types';
import { computeFeatures, type Features } from '../src/dsp/features';
import { BENCH_CASES, scoreCase } from '../src/eval/bench';
import { STEM_NAMES, type StemName } from '../src/separation/htdemucs';
import { ALIGNER_VOCAB } from '../src/separation/model';
import { readWav16, STEMS_DIR } from './audio';
import { readEmissions } from './emissions';
import { cachedPitch } from './pitch';

/**
 * Benchmark configuration, mirroring the app's options:
 *   VOCALS=vocals_hq   high-quality vocals (Mel-Band RoFormer) instead of HTDemucs's
 *   LEAD=1             lead/backing separation
 *   SYL=none           no character model (syllables from vocal attacks)
 *   P='{"vocals":{…}}' parameter overrides
 */
const VOCALS = process.env.VOCALS ?? 'vocals';
const LEAD = process.env.LEAD === '1';
const SYL = process.env.SYL ?? 'ctc';

export const benchParams = (): BuildParams => {
  const base: BuildParams = structuredClone(DEFAULT_BUILD_PARAMS);
  const over = JSON.parse(process.env.P ?? '{}') as Record<string, Record<string, number>>;
  for (const [k, v] of Object.entries(over)) Object.assign((base as unknown as Record<string, object>)[k], v);
  return base;
};

const available = BENCH_CASES.filter((c) => existsSync(`${STEMS_DIR}${c.song}/drums.wav`) && existsSync(`${STEMS_DIR}${c.song}/${VOCALS}.wav`));

/** The app's tracks for one cached song; the mix is the sum of the stems (they reconstruct it at ~30 dB SNR). */
export async function analyzeCachedSong(song: string, params = benchParams()): Promise<Track[]> {
  const dir = `${STEMS_DIR}${song}/`;
  const stems: Partial<Record<StemName, Features>> = {};
  const samples: Partial<Record<StemName, Float32Array>> = {};
  for (const n of STEM_NAMES) {
    const w = readWav16(dir + (n === 'vocals' ? VOCALS : n) + '.wav');
    samples[n] = w.samples;
    stems[n] = computeFeatures(w.samples, w.sr);
  }
  const mixAudio = new Float32Array(samples.drums!.length);
  for (const n of STEM_NAMES) samples[n]!.forEach((v, i) => (mixAudio[i] += v));
  const mix = computeFeatures(mixAudio, 22050);
  const inp: BuildInputs = { mix, rhythm: analyzeRhythm(mix, params.beats), stems, samples, pitch: {} };
  inp.pitch.vocals = await cachedPitch(song, VOCALS);
  inp.pitch.other = await cachedPitch(song, 'other');
  const syl = (stem: string, f: Features) => {
    const em = readEmissions(song, stem);
    if (!em) return undefined;
    const db = Float32Array.from({ length: em.frames }, (_, t) => 20 * Math.log10(f.rmsShort[Math.min(f.nFrames - 1, Math.round((em.offsetSec + t * em.frameSec) * f.fps))] + 1e-9));
    return greedySyllables(applyVocalPrior(em, db, ALIGNER_VOCAB['<pad>']), ALIGNER_VOCAB).map((x) => x.start);
  };
  if (SYL === 'ctc') inp.syllables = syl(VOCALS, stems.vocals!);
  if (LEAD && existsSync(dir + 'lead.wav')) {
    const lead = readWav16(dir + 'lead.wav').samples;
    const backing = Float32Array.from(samples.vocals!, (v, i) => v - (lead[i] ?? 0));
    inp.lead = computeFeatures(lead, 22050);
    inp.backing = computeFeatures(backing, 22050);
    if (SYL === 'ctc') inp.leadSyllables = syl('lead', inp.lead);
    inp.pitch.backing = await cachedPitch(song, VOCALS === 'vocals_hq' ? 'backing' : 'backing-htdemucs', backing);
  }
  return buildTracks(inp, params);
}

describe.skipIf(available.length === 0)('benchmark: tracks vs hand-made sequences', () => {
  it('scores every available case', async () => {
    const all: number[] = [];
    const rows: string[] = [`config: VOCALS=${VOCALS} LEAD=${LEAD ? 1 : 0} SYL=${SYL}`];
    for (const c of available) {
      const xsq = readFileSync(new URL(`../fixtures/${c.xsq}.xsq`, import.meta.url), 'utf8');
      const tracks = await analyzeCachedSong(c.song);
      const scores = scoreCase(c, xsq, tracks);
      if (process.env.DUMP) writeFileSync(`${process.env.DUMP}/${c.xsq}.json`, JSON.stringify(Object.fromEntries(tracks.map((t) => [t.name, t.marks]))));
      const caseMean = scores.reduce((a, s) => a + s.f, 0) / scores.length;
      for (const s of scores) {
        rows.push(`  ${c.id.padEnd(16)} ${s.label.padEnd(18)} ${s.f.toFixed(3)}  P ${s.precision.toFixed(2)} R ${s.recall.toFixed(2)}  ${String(s.est).padStart(4)}/${String(s.ref).padEnd(4)} ${s.track}`);
      }
      all.push(caseMean);
    }
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    rows.push(`  ${'MEAN (per song)'.padEnd(35)} ${mean.toFixed(3)}`);
    console.log(rows.join('\n'));
    expect(mean).toBeGreaterThan(0.3);
  }, 600_000);
});
