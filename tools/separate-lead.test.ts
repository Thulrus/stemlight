// Dev tool (not part of `npm test`): lead vocals (backing vocals removed) for every song, cached as
// fixtures/private/stems/<song>/lead.wav.
// Run: npm run tool:lead   (SONG=<part of file name>, SONGS_DIR, ORT_EP as for tool:separate)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { it } from 'vitest';
import { LEAD_MODEL, RF_SR, separateRoformer } from '../apps/timing/src/separation/roformer';
import { decodeStereo, wavBytes } from '../tests/audio';

const SONGS = process.env.SONGS_DIR ? process.env.SONGS_DIR.replace(/\/?$/, '/') : new URL('../example_data/', import.meta.url).pathname;
const OUT = new URL('../fixtures/private/stems/', import.meta.url).pathname;
const MODELS = new URL('../fixtures/private/models/karaoke/', import.meta.url).pathname;

it('separates lead vocals', async () => {
  // LEAD_ONNX/LEAD_OUT pick another export (e.g. the fp16 one the browser uses) and output name.
  const file = process.env.LEAD_ONNX ?? 'bs_karaoke.onnx';
  const session = await ort.InferenceSession.create(MODELS + file, { executionProviders: [process.env.ORT_EP ?? 'cpu'] });
  const only = process.env.SONG;
  const name = process.env.LEAD_OUT ?? 'lead.wav';
  for (const f of readdirSync(SONGS).filter((n) => /\.(mp3|wav|flac)$/i.test(n) && (!only || n.includes(only)))) {
    const dir = OUT + f.replace(/\.[^.]+$/, '') + '/';
    if (existsSync(dir + name)) continue;
    mkdirSync(dir, { recursive: true });
    const { left, right } = decodeStereo(SONGS + f, RF_SR);
    const t0 = performance.now();
    const lead = await separateRoformer(LEAD_MODEL, session, ort.Tensor as never, left, right);
    console.log(`${f}: ${((performance.now() - t0) / 1000).toFixed(0)} s for ${(left.length / RF_SR).toFixed(0)} s audio`);
    writeFileSync(dir + name, wavBytes(lead, 22050));
  }
}, 7_200_000);
