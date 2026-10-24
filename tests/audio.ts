import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PRIVATE_DIR = fileURLToPath(new URL('../fixtures/private/', import.meta.url));

/** Copyrighted songs live in fixtures/private (gitignored); tests skip without them. */
export function privateAudio(): string | undefined {
  if (!existsSync(PRIVATE_DIR)) return undefined;
  const f = readdirSync(PRIVATE_DIR).find((n) => /halloween.*\.(mp3|wav|flac|ogg)$/i.test(n));
  return f ? PRIVATE_DIR + f : undefined;
}

/**
 * Decode with ffmpeg to mono float32 at `sr`, mirroring the browser decoder. The explicit
 * (L+R)/2 pan matches Web Audio's downmix; ffmpeg's `-ac 1` scales differently.
 */
export function decodeWithFfmpeg(path: string, sr: number): Float32Array {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-af', 'pan=mono|c0=0.5*c0+0.5*c1', '-ar', String(sr), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Decode to planar stereo float32 at `sr`. */
export function decodeStereo(path: string, sr: number): { left: Float32Array; right: Float32Array } {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '2', '-ar', String(sr), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  const inter = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = inter.length / 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = inter[2 * i]; right[i] = inter[2 * i + 1]; }
  return { left, right };
}

/** Minimal 16-bit mono WAV writer for caching stems. */
export function wavBytes(x: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + 2 * i);
  return b;
}

/** Read a 16-bit PCM mono WAV (as written by wavBytes). */
export function readWav16(path: string): { samples: Float32Array; sr: number } {
  const b = readFileSync(path);
  const sr = b.readUInt32LE(24);
  let p = 12;
  while (b.toString('ascii', p, p + 4) !== 'data') p += 8 + b.readUInt32LE(p + 4);
  const len = b.readUInt32LE(p + 4) / 2;
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) samples[i] = b.readInt16LE(p + 8 + 2 * i) / 32767;
  return { samples, sr };
}

export const STEMS_DIR = fileURLToPath(new URL('../fixtures/private/stems/', import.meta.url));
