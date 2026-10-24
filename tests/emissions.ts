import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { InferenceSession } from 'onnxruntime-node';
import * as ort from 'onnxruntime-node';
import { ctcEmissions, W2V_SR } from '../src/align/acoustic';
import type { Emissions } from '../src/align/ctc';
import { STEMS_DIR } from './audio';

export function load16k(path: string): Float32Array {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(W2V_SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

export const emissionsPath = (song: string, stem: string, model = 'w2v-char/model.onnx') =>
  `${STEMS_DIR}${song}/emis-${model.replace(/[/.]/g, '_')}-${stem}.f32`;

/** Cached emissions of a song's stem, or undefined. */
export function readEmissions(song: string, stem: string, model?: string): Emissions | undefined {
  const cache = emissionsPath(song, stem, model);
  if (!existsSync(cache)) return undefined;
  const b = readFileSync(cache);
  const [frames, vocab, frameSec, offsetSec] = new Float32Array(b.buffer, b.byteOffset, 4);
  return { frames, vocab, frameSec, offsetSec, logp: new Float32Array(b.buffer.slice(b.byteOffset + 16, b.byteOffset + b.byteLength)) };
}

/** Emissions of a song's stem (or `audioPath`), computed with `session()` and cached next to the stems. */
export async function cachedEmissions(session: () => Promise<InferenceSession>, song: string, stem: string, model = 'w2v-char/model.onnx', audioPath?: string): Promise<Emissions> {
  const hit = readEmissions(song, stem, model);
  if (hit) return hit;
  const em = await ctcEmissions(await session(), ort.Tensor as never, load16k(audioPath ?? `${STEMS_DIR}${song}/${stem}.wav`));
  const head = Float32Array.of(em.frames, em.vocab, em.frameSec, em.offsetSec);
  writeFileSync(emissionsPath(song, stem, model), Buffer.concat([Buffer.from(head.buffer), Buffer.from(em.logp.buffer)]));
  return em;
}
