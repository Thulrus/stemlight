import type { StemName } from './htdemucs';

export type ToSeparator = { type: 'separate'; left: Float32Array; right: Float32Array } | { type: 'cancel' };

export type FromSeparator =
  | { type: 'download'; loaded: number; total: number; cached: boolean }
  | { type: 'backend'; backend: 'webgpu' | 'wasm'; threads: number }
  | { type: 'segment'; done: number; total: number }
  | { type: 'done'; stems: Record<StemName, Float32Array> }
  | { type: 'error'; message: string };
