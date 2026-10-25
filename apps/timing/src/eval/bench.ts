import { splitTrack, type Split } from '@stemlight/core/split';
import type { Track } from '@stemlight/core/types';
import { eventF, spanF, within } from './metrics';
import { parseModelEffects } from './xsq';

/**
 * Ground truth from the user's hand-made sequences. Each target names a group of props that
 * follow one musical part, and the tracks meant to serve it (the best of them counts: the user
 * picks the track that fits). Props whose effects tile a part are scored on start *and* end
 * (spanF): a mark with the right start but the wrong length still has to be fixed by hand.
 * Props that flash for a fixed short time are scored on starts.
 */
export type BenchTarget = {
  label: string;
  props: string[];
  /** Track names; "A+B" merges two tracks' marks. */
  tracks: string[];
  metric: 'span' | 'start';
  /** Tolerance (s) for each boundary; default 0.1. */
  tol?: number;
  /**
   * The props share the part between them: the track is split into one channel per prop
   * (core/split), and each prop is scored against its channel (the best assignment counts).
   */
  split?: Split['by'];
};

export type BenchCase = { id: string; xsq: string; song: string; targets: BenchTarget[] };

const VOCALS = ['Vocal syllables', 'Vocal notes'];
const PUMPKINS = ['Pumpkin1', 'Pumpkin2', 'Pumpkin3', 'Pumpkin4', 'Pumpkin5', 'Pumpkin Prime'];
const CIRCLES = ['Circle-1', 'Circle-2', 'Circle-3', 'Circle-4', 'Circle-5'];

export const BENCH_CASES: BenchCase[] = [
  {
    // Lead soprano note by note; an accompaniment playing one note per beat, alternated
    // between two pumpkins (low note, high note).
    id: 'cara-mia', xsq: 'CaraMia', song: 'Portal2-12-Cara_Mia_Addio',
    targets: [
      { label: 'lead voice', props: ['Pumpkin1'], tracks: VOCALS, metric: 'span' },
      { label: 'accompaniment', props: ['Pumpkin3', 'Pumpkin4'], tracks: ['Beats'], metric: 'span' },
      { label: 'accomp. split', props: ['Pumpkin3', 'Pumpkin4'], tracks: ['Beats'], metric: 'span', split: 'turns' },
    ],
  },
  {
    // Circle-1 follows the lead, Circles 2–5 the backing group, Single Line/-2 alternate beats,
    // Single Line-3 the backing group's phrases.
    id: 'candy-girl', xsq: 'CandyGirl', song: 'Four Seasons - Billboard Top 100 of 1963 - 39 - Candy Girl',
    targets: [
      { label: 'lead voice', props: ['Circle-1'], tracks: VOCALS, metric: 'span' },
      { label: 'backing voices', props: ['Circle-2'], tracks: ['Backing vocal notes', ...VOCALS], metric: 'span' },
      { label: 'beats', props: ['Single Line', 'Single Line-2'], tracks: ['Beats'], metric: 'span' },
      { label: 'beats split', props: ['Single Line', 'Single Line-2'], tracks: ['Beats'], metric: 'span', split: 'turns' },
      { label: 'backing phrases', props: ['Single Line-3'], tracks: ['Backing vocals', 'Vocal phrases'], metric: 'span', tol: 0.25 },
    ],
  },
  {
    // Circles flash (~150 ms) on the sung syllables; Single Line-3 holds through sung lines.
    id: 'grinning-ghosts', xsq: 'GrinningGhosts1', song: 'Barenaked Ladies- Grim Grinning Ghosts (Haunted Mansion)  Best Quality',
    targets: [
      { label: 'syllable flashes', props: ['Circle-1'], tracks: VOCALS, metric: 'start' },
      { label: 'sung lines', props: ['Single Line-3'], tracks: ['Vocal phrases'], metric: 'span', tol: 0.25 },
    ],
  },
  {
    // Pumpkins flash with the singing (each pumpkin a voice, often all together).
    id: 'halloween-film', xsq: 'ThisIsHalloweenFilm', song: '00 - 03 This Is Halloween',
    targets: PUMPKINS.map((p) => ({ label: p.toLowerCase(), props: [p], tracks: VOCALS, metric: 'start' as const })),
  },
  {
    // Circles flash on the drum hits.
    id: 'halloween-rock', xsq: 'ThisIsHalloweenRock', song: '03 This Is Halloween',
    targets: CIRCLES.map((p) => ({ label: p.toLowerCase(), props: [p], tracks: ['Kick+Snare'], metric: 'start' as const })),
  },
];

export type TargetScore = { label: string; track: string; f: number; precision: number; recall: number; est: number; ref: number };

/** Score each target: the best of its tracks, within the time the props are in use. */
export function scoreCase(c: BenchCase, xsq: string, tracks: Track[]): TargetScore[] {
  const effects = parseModelEffects(xsq);
  const byName = new Map(tracks.map((t) => [t.name, t]));
  const marksOf = (name: string) => name.split('+').flatMap((n) => byName.get(n)?.marks ?? []).sort((a, b) => a.start - b.start);
  return c.targets.map((t) => {
    const ref = t.props.flatMap((p) => effects.get(p) ?? []).sort((a, b) => a.start - b.start);
    const lo = ref[0].start - 0.5, hi = Math.max(...ref.map((e) => e.end)) + 0.5;
    const tol = t.tol ?? 0.1;
    const score = (est: { start: number; end: number }[], r: { start: number; end: number }[]) =>
      t.metric === 'span' ? spanF(est, r, tol) : eventF(est.map((m) => m.start), r.map((x) => x.start), tol);
    let best: TargetScore = { label: t.label, track: '-', f: 0, precision: 0, recall: 0, est: 0, ref: ref.length };
    for (const name of t.tracks) {
      let s: Omit<TargetScore, 'label' | 'track'>;
      if (t.split) {
        // Each prop against one channel; try every rotation of the channels.
        const n = t.props.length;
        const chans = splitTrack({ id: name, name, source: '', params: {}, marks: marksOf(name) }, { channels: n, by: t.split }).map((c) => within(c.marks, lo, hi));
        const refs = t.props.map((p) => effects.get(p) ?? []);
        s = { f: 0, precision: 0, recall: 0, est: 0, ref: ref.length };
        for (let rot = 0; rot < n; rot++) {
          const parts = refs.map((r, i) => score(chans[(i + rot) % n], r));
          const avg = (k: 'f' | 'precision' | 'recall') => parts.reduce((a, x) => a + x[k], 0) / n;
          if (avg('f') > s.f) s = { f: avg('f'), precision: avg('precision'), recall: avg('recall'), est: parts.reduce((a, x) => a + x.est, 0), ref: ref.length };
        }
      } else {
        s = score(within(marksOf(name), lo, hi), ref);
      }
      if (s.f > best.f || best.track === '-') best = { label: t.label, track: name, f: s.f, precision: s.precision, recall: s.recall, est: s.est, ref: s.ref };
    }
    return best;
  });
}
