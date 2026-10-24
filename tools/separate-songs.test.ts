// Dev tool (not part of `npm test`): separates every song in example_data/ with the same
// HTDemucs pipeline the browser uses, and caches the stems as WAVs in fixtures/private/stems/.
// Run: npm run tool:separate   (SONG=<part of file name> to pick one)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { it } from 'vitest';
import { STEM_NAMES } from '../src/separation/htdemucs';
import { separate, STEM_SR } from '../src/separation/separate';
import { decodeStereo, decodeWithFfmpeg, wavBytes } from '../tests/audio';

// SONGS_DIR=<dir> separates another folder (e.g. fixtures/private/jamendo/mp3/); ORT_EP=cuda uses
// onnxruntime-node's CUDA provider (needs the CUDA 13 runtime libraries on LD_LIBRARY_PATH).
const SONGS = process.env.SONGS_DIR ? process.env.SONGS_DIR.replace(/\/?$/, '/') : new URL('../example_data/', import.meta.url).pathname;
const OUT = new URL('../fixtures/private/stems/', import.meta.url).pathname;
const MODEL = new URL('../fixtures/private/models/htdemucs_fwd.onnx', import.meta.url).pathname;

it('separates example songs', async () => {
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: [process.env.ORT_EP ?? 'cpu'], intraOpNumThreads: 0 });
  const only = process.env.SONG;
  for (const f of readdirSync(SONGS).filter((n) => /\.(mp3|wav|flac)$/i.test(n) && (!only || n.includes(only)))) {
    const dir = OUT + f.replace(/\.[^.]+$/, '') + '/';
    if (existsSync(dir + 'vocals.wav')) continue;
    mkdirSync(dir, { recursive: true });
    const { left, right } = decodeStereo(SONGS + f, 44100);
    const t0 = performance.now();
    const stems = await separate(session, ort.Tensor as never, left, right, (d, n) => process.stdout.write(`\r${f}: ${d}/${n}`));
    const secs = (performance.now() - t0) / 1000;
    // Reconstruction check: the stems should sum back to the mix.
    const mix = decodeWithFfmpeg(SONGS + f, STEM_SR);
    let err = 0, pow = 0;
    for (let i = 0; i < Math.min(mix.length, stems.drums.length); i++) {
      const s = STEM_NAMES.reduce((a, n) => a + stems[n][i], 0);
      err += (s - mix[i]) ** 2; pow += mix[i] ** 2;
    }
    console.log(`\n${f}: ${secs.toFixed(0)} s for ${(left.length / 44100).toFixed(0)} s audio; mix reconstruction SNR ${(10 * Math.log10(pow / err)).toFixed(1)} dB`);
    for (const n of STEM_NAMES) writeFileSync(dir + n + '.wav', wavBytes(stems[n], STEM_SR));
  }
}, 3_600_000);
