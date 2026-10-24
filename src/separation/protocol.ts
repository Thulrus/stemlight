import type { StemName } from './htdemucs';

export type SeparatorModel = 'htdemucs' | 'roformer';

export type ToSeparator =
  /** HTDemucs: all four stems. */
  | { type: 'separate'; left: Float32Array; right: Float32Array; cpuOnly?: boolean }
  /** Mel-Band RoFormer: high-quality vocals only. */
  | { type: 'vocals-hq'; left: Float32Array; right: Float32Array }
  | { type: 'cancel' };

export type FromSeparator =
  | { type: 'download'; model: SeparatorModel; loaded: number; total: number; cached: boolean }
  | { type: 'backend'; model: SeparatorModel; backend: 'webgpu' | 'wasm'; threads: number }
  | { type: 'segment'; model: SeparatorModel; done: number; total: number }
  | { type: 'done'; stems: Record<StemName, Float32Array> }
  | { type: 'vocals-hq'; vocals: Float32Array }
  | { type: 'error'; message: string };
