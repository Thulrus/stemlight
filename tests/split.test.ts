import { describe, expect, it } from 'vitest';
import { snapMarks } from '../src/analysis/snap';
import { channelOf, labelMidi, splitTrack } from '../src/core/split';
import type { Track } from '../src/core/types';

const beats = (labels: string): Track => ({
  id: 'mix-beats', name: 'Beats', source: 'mix', params: {},
  marks: labels.split('').map((l, i) => ({ start: i * 0.5, end: (i + 1) * 0.5, label: l })),
});

describe('channel split', () => {
  it('alternates beats by beat number when bars are regular', () => {
    expect(channelOf(beats('34123412341234').marks, { channels: 2, by: 'turns' })).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    expect(channelOf(beats('12341234').marks, { channels: 4, by: 'turns' })).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('takes plain turns when beat numbers would put neighbours on one prop', () => {
    // 3/4 with two props, and bars of varying length (free tempo).
    expect(channelOf(beats('123123').marks, { channels: 2, by: 'turns' })).toEqual([0, 1, 0, 1, 0, 1]);
    expect(channelOf(beats('12341231234').marks, { channels: 2, by: 'turns' })).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('splits notes by pitch, low to high', () => {
    const t: Track = { id: 'x', name: 'Notes', source: 'other', params: {}, marks: ['A#3', 'F4', 'A#3', 'G4', 'C4', 'F4'].map((l, i) => ({ start: i, end: i + 1, label: l })) };
    const [low, high] = splitTrack(t, { channels: 2, by: 'pitch' });
    expect(low.name).toBe('Notes 1');
    expect(low.marks.map((m) => m.label)).toEqual(['A#3', 'A#3', 'C4']);
    expect(high.marks.map((m) => m.label)).toEqual(['F4', 'G4', 'F4']);
    expect(labelMidi('C4')).toBe(60);
    expect(labelMidi('F#5')).toBe(78);
    expect(labelMidi('3')).toBeUndefined();
  });
});

describe('beat snapping', () => {
  it('moves boundaries near the grid onto it and keeps touching marks touching', () => {
    const grid = [0, 0.5, 1, 1.5, 2];
    const marks = [{ start: 0.47, end: 1.08 }, { start: 1.08, end: 1.3 }, { start: 1.3, end: 1.92 }];
    const out = snapMarks(marks, grid, { division: 2, tolerance: 0.1 });
    expect(out.map((m) => [m.start, m.end])).toEqual([[0.5, 1], [1, 1.25], [1.25, 2]]);
    expect(snapMarks(marks, grid, { division: 0, tolerance: 0.1 })).toBe(marks);
  });
});
