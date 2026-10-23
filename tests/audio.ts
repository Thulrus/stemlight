import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PRIVATE_DIR = fileURLToPath(new URL('../fixtures/private/', import.meta.url));

/** Copyrighted songs live in fixtures/private (gitignored); tests skip without them. */
export function privateAudio(): string | undefined {
  if (!existsSync(PRIVATE_DIR)) return undefined;
  const f = readdirSync(PRIVATE_DIR).find((n) => /halloween.*\.(mp3|wav|flac|ogg)$/i.test(n));
  return f ? PRIVATE_DIR + f : undefined;
}

/** Decode with ffmpeg to mono float32 at `sr`, mirroring what the browser decoder produces. */
export function decodeWithFfmpeg(path: string, sr: number): Float32Array {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
