// Dev tool: transcribe JamendoLyrics vocal stems with Whisper the way the app does (vocal-aware
// windows, word timestamps), cached as whisper-app-<stem>.json next to the stems.
// Run: STEMLIGHT_TOOLS=1 npx vitest run tools/whisper-jamendo.test.ts --disableConsoleIntercept   (STEM, DEVICE=cpu|cuda)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { it } from 'vitest';
import { transcribeVocals } from '../src/lyrics/transcribe';
import { WHISPER_MODEL, WHISPER_REVISION } from '../src/lyrics/protocol';
import { STEMS_DIR } from '../tests/audio';
import { load16k } from '../tests/emissions';

env.cacheDir = new URL('../fixtures/private/models/hf/', import.meta.url).pathname;
const JAM = new URL('../fixtures/private/jamendo/', import.meta.url).pathname;
const STEM = process.env.STEM ?? 'vocals_hq';

it('transcribes Jamendo vocals', async () => {
  const device = (process.env.DEVICE ?? 'cpu') as 'cpu';
  const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL, { revision: WHISPER_REVISION, device, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } } as never);
  for (const song of readFileSync(JAM + 'en.txt', 'utf8').trim().split('\n')) {
    const out = `${STEMS_DIR}${song}/whisper-app-${STEM}.json`;
    if (existsSync(out) || !existsSync(`${STEMS_DIR}${song}/${STEM}.wav`)) continue;
    const t0 = performance.now();
    const words = await transcribeVocals(load16k(`${STEMS_DIR}${song}/${STEM}.wav`), async (chunk) =>
      (await asr(chunk, { return_timestamps: 'word', language: 'english', task: 'transcribe', max_new_tokens: 200 } as never)) as never);
    writeFileSync(out, JSON.stringify(words));
    console.log(`${song}: ${words.length} words in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
}, 7_200_000);
