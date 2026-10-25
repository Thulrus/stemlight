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

/**
 * Mel-Band RoFormer vocals (Kimberley Jensen's checkpoint, MIT) as exported to ONNX for the GPU
 * by audiojs: https://huggingface.co/audiojs/mel-roformer — pinned and checked by SHA-256.
 */
const RF_REVISION = 'c1aba02c00a0bee852d6754fe6ede8164f90a4b3';
export const ROFORMER_FILE: ModelFile = {
  name: 'mel-roformer.fp16.onnx',
  url: `https://huggingface.co/audiojs/mel-roformer/resolve/${RF_REVISION}/mel-roformer.fp16.onnx`,
  bytes: 464050097,
  sha256: 'adcbbb826f12453fbb86652b503242d565a9c81cdef1bca2fe0e54752eba91ef',
};

/**
 * wav2vec2-base-960h (Meta, Apache-2.0), a character CTC model, as converted to ONNX by Xenova:
 * https://huggingface.co/Xenova/wav2vec2-base-960h — for vocal syllables and aligning lyrics.
 * fp16 on GPUs with fp16 shaders, fp32 elsewhere (the 8-bit model loses ~3 points of word
 * timing accuracy on JamendoLyrics; fp16 matches fp32). Both take and return float32.
 */
const W2V_REVISION = 'a19f851b3d42865797e410752b4c570c871e4825';
const W2V_BASE = `https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/${W2V_REVISION}/onnx/`;
export const ALIGNER_FILES: Record<'fp16' | 'fp32', ModelFile> = {
  fp16: {
    name: 'wav2vec2-base-960h.fp16.onnx',
    url: W2V_BASE + 'model_fp16.onnx',
    bytes: 189192204,
    sha256: '378348ee38b739cc77e77e3fb8502f0f40ed53da0dbf7401b24c25c8fafe03de',
  },
  fp32: {
    name: 'wav2vec2-base-960h.onnx',
    url: W2V_BASE + 'model.onnx',
    bytes: 377887594,
    sha256: 'e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d',
  },
};
/** The aligner's vocab.json: blank "<pad>", word separator "|", A–Z and the apostrophe. */
export const ALIGNER_VOCAB: Record<string, number> = {
  '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '|': 4, E: 5, T: 6, A: 7, O: 8, N: 9, I: 10, H: 11, S: 12, R: 13, D: 14, L: 15,
  U: 16, M: 17, W: 18, C: 19, F: 20, G: 21, Y: 22, P: 23, B: 24, V: 25, K: 26, "'": 27, X: 28, J: 29, Q: 30, Z: 31,
};

/**
 * BS-RoFormer karaoke (anvuew, GPL-3.0; https://huggingface.co/anvuew/karaoke_bs_roformer),
 * exported for the browser with tools/export (8 s chunks, Split ops rewritten for WebGPU).
 * fp32 weights: fp16 would halve the download but needs GPUs with fp16 shaders. Set
 * VITE_LEAD_MODEL_URL to load it from elsewhere, e.g. a local copy in dev.
 */
export const LEAD_FILE: ModelFile = {
  name: 'bs-roformer-karaoke.onnx',
  url: import.meta.env.VITE_LEAD_MODEL_URL ?? 'https://huggingface.co/HiggityPiggity/stemlight-models/resolve/main/bs-roformer-karaoke.onnx',
  bytes: 209806570,
  sha256: '7bbf6a275f8468efa2e084f50437ee476faf61ad7de0bd21d8df9c23dea318a5',
};
