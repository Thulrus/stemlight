// Dev tool (not part of `npm test`): Mel-Band RoFormer vocals for every song in example_data/,
// cached as fixtures/private/stems/<song>/vocals_hq.wav for benchmarking against HTDemucs vocals.
// Run: npm run tool:vocals-hq   (SONG=<part of file name> to pick one)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { it } from 'vitest';
import { RF_SR, separateVocalsRoformer } from '../src/separation/roformer';
import { decodeStereo, wavBytes } from '../tests/audio';

const SONGS = new URL('../example_data/', import.meta.url).pathname;
const OUT = new URL('../fixtures/private/stems/', import.meta.url).pathname;
const MODEL = new URL('../fixtures/private/models/mel-roformer.fp16.onnx', import.meta.url).pathname;

it('separates vocals with Mel-Band RoFormer', async () => {
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'], intraOpNumThreads: 0 });
  const only = process.env.SONG;
  // Benchmark songs first.
  const order = (n: string) => (/Candy|Grinning|Film|^00/.test(n) ? 0 : 1);
  const files = readdirSync(SONGS).filter((n) => /\.(mp3|wav|flac)$/i.test(n) && (!only || n.includes(only))).sort((a, b) => order(a) - order(b));
  for (const f of files) {
    const dir = OUT + f.replace(/\.[^.]+$/, '') + '/';
    if (existsSync(dir + 'vocals_hq.wav')) continue;
    mkdirSync(dir, { recursive: true });
    const { left, right } = decodeStereo(SONGS + f, RF_SR);
    const t0 = performance.now();
    const vocals = await separateVocalsRoformer(session, ort.Tensor as never, left, right, (d, n) => process.stdout.write(`\r${f}: ${d}/${n}`));
    console.log(`\n${f}: ${((performance.now() - t0) / 1000).toFixed(0)} s for ${(left.length / RF_SR).toFixed(0)} s audio`);
    writeFileSync(dir + 'vocals_hq.wav', wavBytes(vocals, 22050));
  }
}, 7_200_000);
