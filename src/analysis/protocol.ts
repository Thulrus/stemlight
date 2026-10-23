import type { Track } from '../core/types';
import type { MixParams } from './analyze';

export type ToWorker =
  | { type: 'analyze'; mono: Float32Array; sr: number; params: MixParams }
  /** Re-run track builders on the cached features with new parameters (no reprocessing). */
  | { type: 'rerun'; params: MixParams };

export type FromWorker =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'result'; tracks: Track[]; bpm: number; duration: number }
  | { type: 'error'; message: string };
