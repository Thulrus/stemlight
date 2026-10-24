// Dev tool: run Whisper (word timestamps) on cached vocal stems and score it against the
// hand-made sequences. Run: STEMLIGHT_TOOLS=1 npx vitest run tools/whisper-eval.test.ts --disableConsoleIntercept
// MODEL=onnx-community/whisper-small_timestamped STEM=vocals_hq to vary.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { it } from 'vitest';
import { parseTimingTracks } from '../src/core/parseXTiming';
import { eventF } from '../src/eval/metrics';
import { parseModelEffects } from '../src/eval/xsq';
import { STEMS_DIR } from '../tests/audio';

env.cacheDir = new URL('../fixtures/private/models/hf/', import.meta.url).pathname;
const MODEL = process.env.MODEL ?? 'onnx-community/whisper-base_timestamped';
const STEM = process.env.STEM ?? 'vocals';
const only = process.env.CASE;
const allCases = [
  { xsq: 'ThisIsHalloweenFilm', song: '00 - 03 This Is Halloween', prefix: 'Pumpkin' },
  { xsq: 'GrinningGhosts1', song: 'Barenaked Ladies- Grim Grinning Ghosts (Haunted Mansion)  Best Quality', prefix: 'Circle' },
  { xsq: 'CandyGirl', song: 'Four Seasons - Billboard Top 100 of 1963 - 39 - Candy Girl', prefix: 'Circle' },
];
const cases = allCases.filter((c) => !only || c.xsq === only);
const words = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);

it('whisper word timing', async () => {
  const asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: { encoder_model: process.env.ENC ?? 'fp32', decoder_model_merged: 'q8' } as never, device: 'cpu' });
  for (const c of cases) {
    const path = `${STEMS_DIR}${c.song}/${STEM}.wav`;
    if (!existsSync(path)) { console.log('skip', c.song); continue; }
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
    const t0 = performance.now();
    const out = (await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language: 'english', task: 'transcribe' } as never)) as { text: string; chunks: { text: string; timestamp: [number, number | null] }[] };
    const secs = (performance.now() - t0) / 1000;
    writeFileSync(`${STEMS_DIR}${c.song}/whisper-${MODEL.split('/')[1]}-${STEM}.json`, JSON.stringify(out));
    const x = readFileSync(`fixtures/${c.xsq}.xsq`, 'utf8');
    const ref = [...new Set([...parseModelEffects(x)].filter(([k]) => k.startsWith(c.prefix)).flatMap(([, v]) => v.map((e) => e.start)))];
    const starts = out.chunks.map((w) => w.timestamp[0]);
    const r = eventF(starts, ref, 0.1);
    const r2 = eventF(starts, ref, 0.2);
    let lyricLine = '';
    if (c.xsq === 'CandyGirl') {
      const lyr = words(parseTimingTracks(x).find((t) => t.name === 'New Timing')!.marks.map((m) => m.label).join(' '));
      const got = words(out.text);
      const bag = new Map<string, number>();
      for (const w of lyr) bag.set(w, (bag.get(w) ?? 0) + 1);
      let hit = 0;
      for (const w of got) { const n = bag.get(w) ?? 0; if (n > 0) { hit++; bag.set(w, n - 1); } }
      lyricLine = ` | lyric words recalled ${(hit / lyr.length * 100).toFixed(0)}% (${got.length} words vs ${lyr.length})`;
    }
    console.log(`${c.xsq.padEnd(20)} ${secs.toFixed(0)}s, ${out.chunks.length} words; starts vs human ±100ms F${r.f.toFixed(3)} (P${r.precision.toFixed(2)} R${r.recall.toFixed(2)}), ±200ms F${r2.f.toFixed(3)}${lyricLine}`);
    console.log('   text:', out.text.slice(0, 220).replace(/\s+/g, ' '));
  }
}, 3_600_000);
