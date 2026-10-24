import type { PitchFrames } from '../notes/basicPitch';
import type { Track } from '../core/types';
import type { StemName } from '../separation/htdemucs';
import type { WordHint } from '../align/align';
import type { Emissions } from '../align/ctc';
import type { LyricWord } from '../align/text';
import type { AsrWord } from './lyrics';
import type { BuildParams, PitchSource } from './build';

export type AllParams = BuildParams;
export type StemAudio = Partial<Record<StemName, Float32Array>>;

export type ToWorker =
  | { type: 'analyze'; mono: Float32Array; sr: number; params: AllParams }
  /** Add (or replace) stems for the current song and analyze them. */
  | { type: 'stems'; stems: StemAudio; sr: number; params: AllParams }
  /** Recognized words (Whisper); aligned to the vocal tracks on every run. */
  | { type: 'lyrics'; words: AsrWord[]; params: AllParams }
  /** The lead vocal alone (karaoke separation); backing vocals = vocals − lead. */
  | { type: 'lead'; lead: Float32Array; sr: number; params: AllParams }
  /** Basic Pitch frames of a part (the final vocals, backing vocals, "other" instruments), for note tracks. */
  | { type: 'pitch'; stem: PitchSource; frames: PitchFrames; params: AllParams }
  /** The pronunciation dictionary (public/cmudict.txt.gz, decompressed), sent once. */
  | { type: 'pron'; dict: string }
  /**
   * The aligner's character probabilities for all vocals (and the lead alone when separated),
   * for syllables, plus lyrics to align to the vocals: pasted lyrics, or Whisper's words with
   * their times as hints; no words means syllables only. Replaces any earlier alignment.
   */
  | { type: 'align'; emissions: Emissions; leadEmissions?: Emissions; words: LyricWord[]; hints?: WordHint[]; params: AllParams }
  /** Re-run track builders on the cached features with new parameters (no reprocessing). */
  | { type: 'rerun'; params: AllParams };

export type FromWorker =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'result'; tracks: Track[]; bpm: number; duration: number }
  | { type: 'error'; message: string };
