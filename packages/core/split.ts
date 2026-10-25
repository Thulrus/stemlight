import type { Mark, Track } from './types';

/**
 * How to share one track's marks among several props:
 * - 'turns': take turns (on Beats: by beat number, so beat 1 always lands on the same prop);
 * - 'pitch': by pitch, lowest notes on the first channel (for note tracks labeled C4, F#5, …).
 */
export type SplitMode = 'turns' | 'pitch';
export type Split = { channels: number; by: SplitMode };

const NOTE = /^([A-G])(#?)(-?\d+)$/;
const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a note label like "F#4", or undefined. */
export function labelMidi(label: string | undefined): number | undefined {
  const m = label ? NOTE.exec(label.trim().split(' ')[0]) : null;
  return m ? 12 * (Number(m[3]) + 1) + STEPS[m[1]] + (m[2] ? 1 : 0) : undefined;
}

/** Whether a track's marks are labeled with notes (so it can split by pitch). */
export const hasPitch = (t: Track) => t.marks.length > 0 && t.marks.filter((m) => labelMidi(m.label) !== undefined).length >= 0.8 * t.marks.length;

/** Channel per mark. */
export function channelOf(marks: Mark[], split: Split): number[] {
  const n = Math.max(1, Math.round(split.channels));
  if (n === 1) return marks.map(() => 0);
  if (split.by === 'pitch') {
    const pitches = marks.map((m) => labelMidi(m.label));
    const known = pitches.filter((p): p is number => p !== undefined).sort((a, b) => a - b);
    if (known.length) {
      // Bands by quantile, so each channel gets a fair share of the notes.
      const edges = Array.from({ length: n - 1 }, (_, i) => known[Math.floor(((i + 1) * known.length) / n)]);
      let last = 0;
      return pitches.map((p) => {
        if (p === undefined) return last;
        let c = 0;
        while (c < edges.length && p >= edges[c]) c++;
        return (last = c);
      });
    }
  }
  // Beats are labeled with their position in the bar: keep each beat number on one channel,
  // when bars are regular and divide evenly. Otherwise (3/4 with two channels, or bars of
  // varying length in free tempo) a beat number can repeat on neighbours, so plain turns.
  const beatNos = marks.map((m) => (/^\d+$/.test(m.label ?? '') ? Number(m.label) : undefined));
  if (beatNos.every((b) => b !== undefined)) {
    const bars: number[] = [];
    for (let i = 1, len = 1; i <= beatNos.length; i++, len++) {
      if (i === beatNos.length || beatNos[i] === 1) { bars.push(len); len = 0; }
    }
    const inner = bars.slice(1, -1);
    const perBar = Math.max(0, ...beatNos.map((b) => b!));
    const regular = inner.filter((l) => l === perBar).length >= 0.95 * inner.length;
    if (perBar > 1 && perBar % n === 0 && regular) return beatNos.map((b) => (b! - 1) % n);
  }
  return marks.map((_, i) => i % n);
}

/** The track as `channels` tracks, named "<name> 1", "<name> 2", … (all layers follow the first). */
export function splitTrack(t: Track, split: Split): Track[] {
  const n = Math.max(1, Math.round(split.channels));
  if (n === 1) return [t];
  const ch = channelOf(t.marks, split);
  return Array.from({ length: n }, (_, c) => ({
    ...t,
    id: `${t.id}#${c + 1}`,
    name: `${t.name} ${c + 1}`,
    marks: t.marks.filter((_, i) => ch[i] === c),
    layers: undefined,
  }));
}
