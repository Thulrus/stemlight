/** A single timing mark. Times are in seconds. Point events are marks one grid step long. */
export type Mark = { start: number; end: number; label?: string; strength?: number };

/**
 * The core abstraction: everything downstream (timeline, export) only knows Tracks,
 * so new extractors can be added without touching anything else.
 */
export type Track = {
  id: string;
  name: string;
  /** Which audio the track came from, e.g. "mix", "drums", "vocals". */
  source: string;
  marks: Mark[];
  params: Record<string, number>;
};

export type GridMs = 25 | 50;
