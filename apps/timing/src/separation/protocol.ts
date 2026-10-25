import type { PitchFrames } from '../notes/basicPitch';
import type { Emissions } from '../align/ctc';
import type { StemName } from './htdemucs';

export type SeparatorModel = 'htdemucs' | 'roformer' | 'lead' | 'aligner' | 'notes';
/** Models that are downloaded (Basic Pitch ships with the app). */
export type PrefetchModel = Exclude<SeparatorModel, 'notes'>;

export type ToSeparator =
  /** HTDemucs: all four stems. */
  | { type: 'separate'; left: Float32Array; right: Float32Array; cpuOnly?: boolean }
  /** Mel-Band RoFormer: high-quality vocals only. */
  | { type: 'vocals-hq'; left: Float32Array; right: Float32Array }
  /** Karaoke RoFormer: the lead vocal alone, without backing vocals. */
  | { type: 'lead'; left: Float32Array; right: Float32Array }
  /** Basic Pitch note and onset probabilities of a stem (22.05 kHz mono). */
  | { type: 'notes'; audio: Float32Array }
  /** wav2vec2 character probabilities of vocals (16 kHz mono), for aligning lyrics. */
  | { type: 'emissions'; audio16k: Float32Array; cpuOnly?: boolean }
  /** Download, verify and store a model for later, without running it. */
  | { type: 'prefetch'; model: PrefetchModel }
  | { type: 'cancel' };

export type FromSeparator =
  | { type: 'download'; model: SeparatorModel; loaded: number; total: number; cached: boolean }
  | { type: 'backend'; model: SeparatorModel; backend: 'webgpu' | 'wasm'; threads: number }
  | { type: 'segment'; model: SeparatorModel; done: number; total: number }
  | { type: 'done'; stems: Record<StemName, Float32Array> }
  | { type: 'vocals-hq'; vocals: Float32Array }
  | { type: 'lead'; lead: Float32Array }
  | { type: 'emissions'; emissions: Emissions }
  | { type: 'notes'; frames: PitchFrames }
  | { type: 'prefetched'; model: PrefetchModel }
  | { type: 'error'; message: string };
