import type { Mark, Track } from '../core/types';
import { frameToTime, type Features } from '../dsp/features';
import { estimateTempo, pickOnsets, trackBeats, trackDownbeats } from '../dsp/rhythm';
import { barFeatures, energyChanges, guessRoles, labelSegments, noveltyCurve, pickBoundaries, selfSimilarity } from '../dsp/structure';

/** Default parameters for every track the full-mix analysis produces. */
export const DEFAULT_PARAMS = {
  beats: { tightness: 100, priorBpm: 120 },
  onsets: { sensitivity: 0.5, minGap: 0.08 },
  sections: { sensitivity: 0.5, minBars: 4, similarity: 0.6 },
  phrases: { sensitivity: 0.5, minBars: 2 },
  energy: { thresholdDb: 4, spanBars: 2 },
} satisfies Record<string, Record<string, number>>;

export type MixParams = { [K in keyof typeof DEFAULT_PARAMS]: Record<keyof (typeof DEFAULT_PARAMS)[K], number> };

/** Intermediate rhythm result, reused by bar/section/energy builders. */
export type Rhythm = {
  bpm: number;
  beatFrames: number[];
  /** Position in bar per beat (0 = downbeat). */
  barPos: number[];
  /** Frame index of each downbeat. */
  barFrames: number[];
};

export function analyzeRhythm(f: Features, p: MixParams['beats'] = DEFAULT_PARAMS.beats): Rhythm {
  const bpm = estimateTempo(f.onset, f.fps, p.priorBpm);
  const beatFrames = trackBeats(f.onset, f.fps, bpm, p.tightness);
  const barPos = trackDownbeats(f, beatFrames);
  const barFrames = beatFrames.filter((_, i) => barPos[i] === 0);
  return { bpm, beatFrames, barPos, barFrames };
}

/** Turn ordered boundary times into contiguous spans, the last one ending at `end`. */
function contiguous(times: number[], end: number, label: (i: number) => string): Mark[] {
  return times.map((t, i) => ({ start: t, end: i + 1 < times.length ? times[i + 1] : end, label: label(i) }));
}

function medianInterval(times: number[]): number {
  if (times.length < 2) return 0.5;
  const d = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

export function beatsTrack(f: Features, r: Rhythm, params: Record<string, number>): Track {
  const times = r.beatFrames.map((t) => frameToTime(f, t));
  const end = Math.min(f.duration, (times[times.length - 1] ?? 0) + medianInterval(times));
  return {
    id: 'mix-beats', name: 'Beats', source: 'mix', params,
    marks: contiguous(times, end, (i) => String(r.barPos[i] + 1)),
  };
}

export function barsTrack(f: Features, r: Rhythm, params: Record<string, number>): Track {
  const times = r.barFrames.map((t) => frameToTime(f, t));
  const beatTimes = r.beatFrames.map((t) => frameToTime(f, t));
  const end = Math.min(f.duration, (beatTimes[beatTimes.length - 1] ?? 0) + medianInterval(beatTimes));
  return { id: 'mix-bars', name: 'Bars', source: 'mix', params, marks: contiguous(times, end, (i) => String(i + 1)) };
}

export function onsetsTrack(f: Features, p: MixParams['onsets']): Track {
  const step = 0.05;
  return {
    id: 'mix-onsets', name: 'Onsets', source: 'mix', params: p,
    marks: pickOnsets(f.onset, f.fps, p).map((o) => ({ start: o.time, end: o.time + step, strength: o.strength })),
  };
}

type Structure = { sections: Track; phrases: Track };

export function structureTracks(f: Features, r: Rhythm, ps: MixParams['sections'], pp: MixParams['phrases']): Structure {
  const empty = (id: string, name: string, params: Record<string, number>): Track => ({ id, name, source: 'mix', params, marks: [] });
  if (r.barFrames.length < 8) {
    return { sections: empty('mix-sections', 'Sections', ps), phrases: empty('mix-phrases', 'Phrases', pp) };
  }
  const barTimes = r.barFrames.map((t) => frameToTime(f, t));
  const feats = barFeatures(f, r.barFrames);
  const ssm = selfSimilarity(feats, 2);
  const nBars = barTimes.length;

  const secBounds = [0, ...pickBoundaries(noveltyCurve(ssm, 8), ps.minBars, ps.sensitivity), nBars];
  const letters = labelSegments(ssm, secBounds, ps.similarity);
  const loud = secBounds.slice(0, -1).map((a, i) => {
    const z = secBounds[i + 1];
    let acc = 0;
    for (let b = a; b < z; b++) acc += barLoudness(f, r.barFrames, b);
    return acc / (z - a);
  });
  const roles = guessRoles(letters, loud);
  // Sections cover the whole song, starting at 0 like xLights' own Sections track.
  const secTimes = secBounds.slice(0, -1).map((b, i) => (i === 0 ? 0 : barTimes[b]));
  const sections: Track = {
    id: 'mix-sections', name: 'Sections', source: 'mix', params: ps,
    marks: contiguous(secTimes, f.duration, (i) => `${letters[i]} ${roles[i]}`),
  };

  // Phrases: a finer novelty level, always including the section boundaries.
  const fine = pickBoundaries(noveltyCurve(ssm, 2), pp.minBars, pp.sensitivity);
  const all = [...new Set([...secBounds.slice(0, -1), ...fine])].sort((a, b) => a - b)
    .filter((b, i, arr) => i === 0 || secBounds.includes(b) || b - arr[i - 1] >= pp.minBars);
  let sec = 0;
  let idx = 0;
  const phraseLabels = all.map((b) => {
    while (sec + 1 < secBounds.length - 1 && b >= secBounds[sec + 1]) { sec++; idx = 0; }
    return `${letters[sec]}${++idx}`;
  });
  const phrases: Track = {
    id: 'mix-phrases', name: 'Phrases', source: 'mix', params: pp,
    marks: contiguous(all.map((b, i) => (i === 0 ? 0 : barTimes[b])), f.duration, (i) => phraseLabels[i]),
  };
  return { sections, phrases };
}

function barLoudness(f: Features, barFrames: number[], b: number): number {
  const a = barFrames[b];
  const z = b + 1 < barFrames.length ? barFrames[b + 1] : f.nFrames;
  let sq = 0;
  for (let t = a; t < z; t++) sq += f.rms[t] ** 2;
  return 10 * Math.log10(sq / Math.max(1, z - a) + 1e-12);
}

export function energyTrack(f: Features, r: Rhythm, p: MixParams['energy']): Track {
  const loud = r.barFrames.map((_, b) => barLoudness(f, r.barFrames, b));
  const changes = energyChanges(loud, p.spanBars, p.thresholdDb);
  return {
    id: 'mix-energy', name: 'Energy', source: 'mix', params: p,
    marks: changes.map((c) => {
      const t = frameToTime(f, r.barFrames[c.bar]);
      return { start: t, end: t + 0.05, label: c.kind, strength: Math.abs(c.amount) };
    }),
  };
}

/** All full-mix tracks, in display order. */
export function mixTracks(f: Features, params: MixParams = DEFAULT_PARAMS, rhythm?: Rhythm): { rhythm: Rhythm; tracks: Track[] } {
  const r = rhythm ?? analyzeRhythm(f, params.beats);
  const { sections, phrases } = structureTracks(f, r, params.sections, params.phrases);
  return {
    rhythm: r,
    tracks: [
      sections,
      phrases,
      barsTrack(f, r, params.beats),
      beatsTrack(f, r, params.beats),
      onsetsTrack(f, params.onsets),
      energyTrack(f, r, params.energy),
    ],
  };
}
