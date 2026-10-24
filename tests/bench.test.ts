import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEM_PARAMS, stemTracks } from '../src/analysis/stems';
import type { Track } from '../src/core/types';
import { computeFeatures, type Features } from '../src/dsp/features';
import { BENCH_CASES } from '../src/eval/bench';
import { STEM_NAMES, type StemName } from '../src/separation/htdemucs';
import { readWav16, STEMS_DIR } from './audio';
import { readEmissions } from './emissions';
import { greedySyllables } from '../src/align/greedy';
import { ctcSyllableTrack } from '../src/analysis/lyricTracks';
import { ALIGNER_VOCAB } from '../src/separation/model';
import { alignWords } from '../src/align/align';
import { applyVocalPrior } from '../src/align/acoustic';
import { parsePronDict } from '../src/align/pron';
import { parseLyrics } from '../src/align/text';
import { lyricTracks, wordsFromAsr } from '../src/analysis/lyricTracks';
import { parseTimingTracks } from '../src/core/parseXTiming';
import { gunzipSync } from 'node:zlib';

const dict = parsePronDict(gunzipSync(readFileSync(new URL('../public/cmudict.txt.gz', import.meta.url))).toString('utf8'));
/**
 * Lyrics for SYL=lyrics: Candy Girl's hand-typed lyric track (real lyrics), else Whisper's cached
 * transcript of the song (words + time hints).
 */
function benchLyrics(song: string) {
  if (/Candy Girl/.test(song)) {
    const xsq = readFileSync(new URL('../fixtures/CandyGirl.xsq', import.meta.url), 'utf8');
    const lines = parseTimingTracks(xsq).find((t) => t.name === 'New Timing')!.marks.map((m) => m.label ?? '');
    return { words: parseLyrics(lines.join('\n')), hints: undefined };
  }
  const f = `${STEMS_DIR}${song}/whisper-whisper-small_timestamped-vocals_hq.json`;
  if (!existsSync(f)) return undefined;
  const out = JSON.parse(readFileSync(f, 'utf8')) as { chunks: { text: string; timestamp: [number, number | null] }[] };
  return wordsFromAsr(out.chunks.map((c) => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] })));
}

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
  const mixFeats = computeFeatures(mix, sr);
  const tracks = Object.fromEntries(stemTracks(feats, samples, DEFAULT_STEM_PARAMS, mixFeats).map((t) => [t.name, t]));
  // SYL=ctc: syllables from the character model's greedy decoding (emissions cached by tools/emissions).
  const em = process.env.SYL === 'ctc' ? readEmissions(song, vocalsFile) : undefined;
  const lyr = process.env.SYL === 'lyrics' ? benchLyrics(song) : undefined;
  const lem = lyr ? readEmissions(song, vocalsFile) : undefined;
  if (lyr && lem) {
    const f = feats.vocals!;
    const db = Float32Array.from({ length: lem.frames }, (_, t) => 20 * Math.log10(f.rmsShort[Math.min(f.nFrames - 1, Math.round((lem.offsetSec + t * lem.frameSec) * f.fps))] + 1e-9));
    const aligned = alignWords(applyVocalPrior(lem, db, 0), ALIGNER_VOCAB, lyr.words, { hints: lyr.hints, dict });
    const p = { ...DEFAULT_STEM_PARAMS.lyrics, offsetMs: Number(process.env.OFFSET ?? DEFAULT_STEM_PARAMS.lyrics.offsetMs) };
    for (const t of lyricTracks(aligned, f, p)) tracks[t.name] = t;
  }
  if (em) tracks['Vocal syllables'] = ctcSyllableTrack(greedySyllables(em, ALIGNER_VOCAB).map((x) => x.start), feats.vocals);
  return tracks;
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
