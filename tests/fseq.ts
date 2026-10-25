import { zstdDecompressSync } from 'node:zlib';

/**
 * Minimal reader for xLights' rendered output (.fseq v2, uncompressed or zstd, with or
 * without sparse ranges). Used to check what xLights actually lit when it rendered a
 * sequence the composer wrote.
 */
export type Fseq = { channels: number; frames: number; stepMs: number; data: Uint8Array; at: (frame: number, channel: number) => number };

export function readFseq(buf: Uint8Array): Fseq {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== 'PSEQ') throw new Error('Not an fseq file');
  const dataOffset = dv.getUint16(4, true);
  const major = buf[7];
  if (major !== 2) throw new Error(`fseq v${major} not supported`);
  const channels = dv.getUint32(10, true);
  const frames = dv.getUint32(14, true);
  const stepMs = buf[18];
  const compression = buf[20] & 0x0f;
  const blockCount = ((buf[20] & 0xf0) << 4) | buf[21];
  const sparseCount = buf[22];
  let p = 32;
  const blocks: { first: number; len: number }[] = [];
  for (let i = 0; i < blockCount; i++, p += 8) blocks.push({ first: dv.getUint32(p, true), len: dv.getUint32(p + 4, true) });
  const ranges: [number, number][] = [];
  for (let i = 0; i < sparseCount; i++, p += 6) {
    const u24 = (o: number) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
    ranges.push([u24(p), u24(p + 3)]);
  }
  let raw: Uint8Array;
  if (compression === 0) raw = buf.subarray(dataOffset);
  else if (compression === 1) {
    const parts: Uint8Array[] = [];
    let off = dataOffset;
    for (const b of blocks) {
      if (!b.len) continue;
      parts.push(new Uint8Array(zstdDecompressSync(buf.subarray(off, off + b.len))));
      off += b.len;
    }
    raw = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) { raw.set(x, o); o += x.length; }
  } else throw new Error(`fseq compression ${compression} not supported`);
  const stored = ranges.length ? ranges.reduce((n, r) => n + r[1], 0) : channels;
  const at = (frame: number, ch: number) => {
    if (!ranges.length) return raw[frame * stored + ch];
    let base = 0;
    for (const [s, n] of ranges) {
      if (ch >= s && ch < s + n) return raw[frame * stored + base + ch - s];
      base += n;
    }
    return 0;
  };
  return { channels, frames, stepMs, data: raw, at };
}
