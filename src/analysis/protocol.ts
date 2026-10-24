import type { Track } from '../core/types';
import type { StemName } from '../separation/htdemucs';
import type { MixParams } from './analyze';
import type { StemParams } from './stems';

export type AllParams = MixParams & StemParams;
export type StemAudio = Partial<Record<StemName, Float32Array>>;

export type ToWorker =
  | { type: 'analyze'; mono: Float32Array; sr: number; params: AllParams }
  /** Add (or replace) stems for the current song and analyze them. */
  | { type: 'stems'; stems: StemAudio; sr: number; params: AllParams }
  /** Re-run track builders on the cached features with new parameters (no reprocessing). */
  | { type: 'rerun'; params: AllParams };

export type FromWorker =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'result'; tracks: Track[]; bpm: number; duration: number }
  | { type: 'error'; message: string };
