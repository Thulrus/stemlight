import type { Track } from '../core/types';
import { parseTimingTracks } from '../core/parseXTiming';
import { eventF, spanOverlapF } from './metrics';
import { parseModelEffects, unionSpans } from './xsq';

/**
 * Ground truth from the user's hand-made sequences. Each case names which of our tracks a
 * hand-placed track or group of model effects follows (worked out by comparing them against
 * every stem; see the M2/M3 notes in the README).
 */
export type BenchCase = {
  id: string;
  xsq: string;
  song: string;
  /** Returns named scores (0..1) for our tracks against this sequence. */
  score: (xsq: string, ours: Record<string, Track>) => Record<string, number>;
};

type Span = { start: number; end: number };
const starts = (xs: Span[]) => [...new Set(xs.map((e) => Math.round(e.start * 1000) / 1000))];
const effects = (xsq: string, prefix: string, exclude?: string) =>
  [...parseModelEffects(xsq)].filter(([k]) => k.startsWith(prefix) && k !== exclude).flatMap(([, v]) => v);
const marks = (ours: Record<string, Track>, name: string) => ours[name]?.marks ?? [];

export const BENCH_CASES: BenchCase[] = [
  {
    id: 'halloween-film',
    xsq: 'ThisIsHalloweenFilm',
    song: '00 - 03 This Is Halloween',
    score: (xsq, ours) => {
      const pumpkins = effects(xsq, 'Pumpkin');
      return {
        'syllables vs pumpkins': eventF(starts(marks(ours, 'Vocal syllables')), starts(pumpkins), 0.1).f,
        'phrases vs pumpkin lines': eventF(starts(marks(ours, 'Vocal phrases')), starts(unionSpans(pumpkins, 0.15)), 0.25).f,
      };
    },
  },
  {
    id: 'candy-girl',
    xsq: 'CandyGirl',
    song: 'Four Seasons - Billboard Top 100 of 1963 - 39 - Candy Girl',
    score: (xsq, ours) => {
      const lyrics = parseTimingTracks(xsq).find((t) => t.name === 'New Timing')!.marks;
      return {
        'phrases vs lyric lines': eventF(starts(marks(ours, 'Vocal phrases')), starts(lyrics), 0.25).f,
        'phrase coverage vs lyric lines': spanOverlapF(marks(ours, 'Vocal phrases'), lyrics).f,
        'syllables vs circles': eventF(starts(marks(ours, 'Vocal syllables')), starts(effects(xsq, 'Circle')), 0.1).f,
      };
    },
  },
  {
    id: 'grinning-ghosts',
    xsq: 'GrinningGhosts1',
    song: 'Barenaked Ladies- Grim Grinning Ghosts (Haunted Mansion)  Best Quality',
    score: (xsq, ours) => ({
      'syllables vs circles': eventF(starts(marks(ours, 'Vocal syllables')), starts(effects(xsq, 'Circle')), 0.1).f,
    }),
  },
  {
    id: 'halloween-rock',
    xsq: 'ThisIsHalloweenRock',
    song: '03 This Is Halloween',
    score: (xsq, ours) => ({
      'kick+snare vs circles': eventF(starts([...marks(ours, 'Kick'), ...marks(ours, 'Snare')]), starts(effects(xsq, 'Circle')), 0.1).f,
    }),
  },
];
