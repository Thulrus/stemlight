import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { basicPitchFrames, KEYS, type PitchFrames } from '../src/notes/basicPitch';
import { readWav16, STEMS_DIR } from './audio';

let session: Promise<ort.InferenceSession> | undefined;

/**
 * Basic Pitch frames of a cached stem (fixtures/private/stems/<song>/<stem>.wav, 22.05 kHz),
 * computed once and cached next to it as bp-<stem>.f32.
 */
export async function cachedPitch(song: string, stem: string, audio?: Float32Array): Promise<PitchFrames | undefined> {
  const cache = `${STEMS_DIR}${song}/bp-${stem}.f32`;
  if (existsSync(cache)) {
    const b = readFileSync(cache);
    const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const T = all[0];
    return { times: all.subarray(1, 1 + T), note: all.subarray(1 + T, 1 + T + T * KEYS), onset: all.subarray(1 + T + T * KEYS) };
  }
  const wav = `${STEMS_DIR}${song}/${stem}.wav`;
  if (!audio && !existsSync(wav)) return undefined;
  session ??= ort.InferenceSession.create(new URL('../src/notes/basic-pitch.onnx', import.meta.url).pathname);
  const f = await basicPitchFrames(await session, ort.Tensor as never, audio ?? readWav16(wav).samples);
  const T = f.times.length;
  const out = new Float32Array(1 + T + 2 * T * KEYS);
  out[0] = T;
  out.set(f.times, 1);
  out.set(f.note, 1 + T);
  out.set(f.onset, 1 + T + T * KEYS);
  writeFileSync(cache, Buffer.from(out.buffer));
  return f;
}
