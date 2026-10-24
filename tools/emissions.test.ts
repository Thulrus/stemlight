// Dev tool: cache character-model emissions for every separated song's stem (benchmarks use them).
// Run: STEMLIGHT_TOOLS=1 npx vitest run tools/emissions.test.ts   (STEM=vocals|vocals_hq|lead, MODEL, ORT_EP)
import { existsSync, readdirSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { it } from 'vitest';
import { STEMS_DIR } from '../tests/audio';
import { cachedEmissions } from '../tests/emissions';

const MODELS = new URL('../fixtures/private/models/', import.meta.url).pathname;
const MODEL = process.env.MODEL ?? 'w2v-char/model.onnx';
const STEM = process.env.STEM ?? 'vocals';

it('caches emissions', async () => {
  let sess: ort.InferenceSession | undefined;
  const session = async () => (sess ??= await ort.InferenceSession.create(MODELS + MODEL, { executionProviders: [process.env.ORT_EP ?? 'cpu'] }));
  for (const song of readdirSync(STEMS_DIR)) {
    if (existsSync(`${STEMS_DIR}${song}/${STEM}.wav`)) await cachedEmissions(session, song, STEM, MODEL);
  }
}, 3_600_000);
