/**
 * HTDemucs v4 (Meta, MIT) as converted to ONNX by the WebNN team (MIT):
 * https://huggingface.co/webnn/stem-separator — pinned to a revision and checked by SHA-256.
 */
const REVISION = 'b56f9e66ceffca2401f83d2469dadaddd06e4994';
const BASE = `https://huggingface.co/webnn/stem-separator/resolve/${REVISION}/onnx/`;

export type ModelFile = { name: string; url: string; bytes: number; sha256: string };

export const HTDEMUCS_FILES: ModelFile[] = [
  {
    name: 'htdemucs_fwd.onnx',
    url: BASE + 'htdemucs_fwd.onnx',
    bytes: 2385507,
    sha256: '555f511fb653348a1c9495ab6b6091767d1920798f3fba68629a1fe5b135a45f',
  },
  {
    name: 'htdemucs_fwd.onnx.data',
    url: BASE + 'htdemucs_fwd.onnx.data',
    bytes: 168361984,
    sha256: '23a7c68669c041363caaef94641e961dc8c4e16b9891cb87f58f0e199a5e8820',
  },
];

export const MODEL_TOTAL_BYTES = HTDEMUCS_FILES.reduce((a, f) => a + f.bytes, 0);
export const MODEL_CACHE_KEY = (f: ModelFile) => `model:${f.sha256}`;
