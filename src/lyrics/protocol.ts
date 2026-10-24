import type { AsrWord } from '../analysis/lyrics';

export type ToLyrics =
  | { type: 'transcribe'; audio16k: Float32Array; cpuOnly?: boolean }
  /** Download Whisper into the browser cache for later. */
  | { type: 'prefetch' }
  | { type: 'cancel' };

export type FromLyrics =
  | { type: 'download'; loaded: number; total: number }
  | { type: 'backend'; backend: 'webgpu' | 'wasm' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; words: AsrWord[] }
  | { type: 'prefetched' }
  | { type: 'error'; message: string };

/** Whisper small with word-timestamp heads (OpenAI Whisper, Apache-2.0 / MIT), ONNX by onnx-community. */
export const WHISPER_MODEL = 'onnx-community/whisper-small_timestamped';
export const WHISPER_REVISION = '65caa70f294b46e1c33ff820aae6b16d048ab818';
/** Approximate download: 8-bit weights on CPU (~250 MB), 4-bit on the GPU (~300 MB). */
export const WHISPER_BYTES = 249_000_000;
export const WHISPER_GPU_BYTES = 300_000_000;
