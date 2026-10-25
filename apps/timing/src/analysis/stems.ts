import type { Mark, Track } from '@stemlight/core/types';
import { bandOnset, frameToTime, type Features } from '../dsp/features';
import { decimate, hzToMidi, midiName, yin } from '../dsp/pitch';
import { pickOnsets } from '../dsp/rhythm';
import type { StemName } from '../separation/htdemucs';

export const DEFAULT_STEM_PARAMS = {
  kick: { sensitivity: 0.5, minGap: 0.1 },
  snare: { sensitivity: 0.5, minGap: 0.1 },
  hats: { sensitivity: 0.5, minGap: 0.07 },
  bassNotes: { thresholdDb: 30, minNote: 0.08, mergeGap: 0.05 },
  // Backing vocals by level, when there are no note frames for them.
  vocalPhrases: { thresholdDb: 12, mergeGap: 0.2, minDur: 0.3 },
  // Lyrics aligned to the vocals (see lyricTracks.ts). CTC letter spikes come ~50 ms after
  // the human-marked word onset on JamendoLyrics, hence the default offset.
  lyrics: { offsetMs: -40, decayDb: 15, maxHold: 2.5 },
} satisfies Record<string, Record<string, number>>;

export type StemParams = { [K in keyof typeof DEFAULT_STEM_PARAMS]: Record<keyof (typeof DEFAULT_STEM_PARAMS)[K], number> };

type Span = { start: number; end: number };

/** Frame level in dB from the short-window RMS, lightly smoothed (~35 ms). */
function levelDb(f: Features): Float32Array {
  const n = f.nFrames;
  const raw = Float32Array.from(f.rmsShort, (r) => 20 * Math.log10(r + 1e-9));
  const out = new Float32Array(n);
  const w = Math.max(1, Math.round(0.015 * f.fps));
  for (let i = 0; i < n; i++) {
    let acc = 0, cnt = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { acc += raw[j]; cnt++; }
    out[i] = acc / cnt;
  }
  return out;
}

/** The level a stem reaches when it is clearly playing: the 95th percentile of frame dB. */
function referenceDb(level: Float32Array): number {
  const sorted = Float32Array.from(level).sort();
  return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

/**
 * Where a stem is audibly active: level above (reference − thresholdDb), with 6 dB of
 * hysteresis, gaps shorter than mergeGap bridged and spans shorter than minDur dropped.
 * Separated stems carry low-level bleed from other instruments, which the relative
 * threshold ignores.
 */
export function activitySpans(f: Features, p: { thresholdDb: number; mergeGap: number; minDur: number }, level = levelDb(f)): Span[] {
  const ref = referenceDb(level);
  const on = Math.max(ref - p.thresholdDb, -60);
  const off = on - 6;
  const spans: Span[] = [];
  let start = -1;
  for (let i = 0; i < f.nFrames; i++) {
    if (start < 0 && level[i] > on) start = i;
    else if (start >= 0 && level[i] < off) {
      spans.push({ start: frameToTime(f, start), end: frameToTime(f, i) });
      start = -1;
    }
  }
  if (start >= 0) spans.push({ start: frameToTime(f, start), end: f.duration });
  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && s.start - prev.end < p.mergeGap) prev.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= p.minDur);
}

/**
 * Separated stems always carry some bleed, and peak-picking finds "hits" even in a stem
 * that's nearly silent (e.g. the drum stem of a song without drums). An event only counts
 * where the stem is within this many dB of the full mix at that moment.
 */
export const PRESENCE_DB = 18;

/** Per-frame: is this stem a real part of the sound right now? */
export type Presence = (time: number) => boolean;

export function presence(stem: Features, mix: Features | undefined): Presence {
  if (!mix) return () => true;
  const s = levelDb(stem);
  const m = levelDb(mix);
  const n = Math.min(s.length, m.length);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) ok[i] = s[i] - m[i] > -PRESENCE_DB ? 1 : 0;
  return (t) => {
    const i = Math.round(t * stem.fps);
    // Any frame within ±30 ms counts, so attacks right at a frame edge aren't lost.
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (ok[j]) return true;
    return false;
  };
}

const track = (stem: StemName, key: string, name: string, marks: Mark[], params: Record<string, number>): Track => ({
  id: `${stem}-${key}`, name, source: stem, marks, params,
});

const points = (times: { time: number; strength: number }[]): Mark[] =>
  times.map((o) => ({ start: o.time, end: o.time + 0.05, strength: o.strength }));

/**
 * Kick, snare and hats from the drum stem, by which bands an attack lands in:
 * kick = sub-150 Hz attack stronger than the 1.5–5 kHz noise band; snare = noise-band
 * attack that beats the low band
 * and has a 150 Hz–1 kHz body; hats/cymbals = attack above 6 kHz without that body.
 * Envelopes are each scaled to unit RMS, so the comparisons are between how unusual
 * the attack is in each band, not absolute energy.
 */
export function drumTracks(f: Features, p: Pick<StemParams, 'kick' | 'snare' | 'hats'>, present: Presence = () => true): Track[] {
  const low = bandOnset(f, 0, 150);
  const body = bandOnset(f, 150, 1000);
  const noise = bandOnset(f, 1500, 5000);
  const high = bandOnset(f, 6000, Infinity);
  const at = (env: Float32Array, t: number) => {
    const i = Math.round(t * f.fps);
    let m = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(env.length - 1, i + 2); j++) m = Math.max(m, env[j]);
    return m;
  };
  const kicks = pickOnsets(low, f.fps, p.kick).filter((o) => present(o.time) && at(low, o.time) > 1.2 * at(noise, o.time));
  const snares = pickOnsets(noise, f.fps, p.snare).filter(
    (o) => present(o.time) && at(body, o.time) > 0.5 * at(noise, o.time) && at(noise, o.time) > 0.8 * at(low, o.time),
  );
  const hats = pickOnsets(high, f.fps, p.hats).filter((o) => present(o.time) && at(body, o.time) < 0.5 * at(high, o.time));
  return [
    track('drums', 'kick', 'Kick', points(kicks), p.kick),
    track('drums', 'snare', 'Snare', points(snares), p.snare),
    track('drums', 'hats', 'Hats', points(hats), p.hats),
  ];
}

/**
 * Bass notes: YIN pitch on the bass stem (downsampled to ~5.5 kHz), voiced frames grouped
 * into notes by rounded MIDI pitch, split at re-articulations (bass onsets), labeled C2 etc.
 */
export function bassTracks(f: Features, samples: Float32Array, p: StemParams['bassNotes'], present: Presence = () => true): Track[] {
  const factor = 4;
  const sr = f.sr / factor;
  const pt = yin(decimate(samples, factor), sr, { fMin: 30, fMax: 400, hopSec: 0.01, threshold: 0.2 });
  const level = levelDb(f);
  const gate = Math.max(referenceDb(level) - p.thresholdDb, -60);
  const onsets = pickOnsets(f.onset, f.fps, { sensitivity: 0.5, minGap: 0.08 }).map((o) => o.time);

  // Per pitch frame: rounded MIDI note or -1, median-filtered to remove octave blips.
  const n = pt.f0.length;
  const raw = new Int16Array(n);
  for (let t = 0; t < n; t++) {
    const time = pt.offsetSec + t / pt.fps;
    const lv = level[Math.min(f.nFrames - 1, Math.round(time * f.fps))];
    raw[t] = pt.f0[t] > 0 && lv > gate && present(time) ? Math.round(hzToMidi(pt.f0[t])) : -1;
  }
  // YIN often jumps an octave for a few frames; fold short (< 80 ms) runs that sit
  // exactly an octave from the preceding pitch back onto it. Real octave moves last longer.
  const maxBlip = Math.round(0.08 * pt.fps);
  for (let t = 1; t < n; t++) {
    const prev = raw[t - 1];
    if (prev < 0 || raw[t] < 0 || Math.abs(Math.abs(raw[t] - prev) - 12) > 1) continue;
    let e = t;
    while (e < n && raw[e] === raw[t]) e++;
    if (e - t < maxBlip) raw.fill(prev, t, e);
  }
  const notes = new Int16Array(n);
  for (let t = 0; t < n; t++) {
    const win: number[] = [];
    for (let j = Math.max(0, t - 3); j <= Math.min(n - 1, t + 3); j++) win.push(raw[j]);
    win.sort((a, b) => a - b);
    notes[t] = win[win.length >> 1];
  }

  const marks: Mark[] = [];
  let onsetIdx = 0;
  let cur = -1, start = 0;
  const flush = (endT: number) => {
    if (cur >= 0) {
      const s = pt.offsetSec + start / pt.fps;
      const e = pt.offsetSec + endT / pt.fps;
      if (e - s >= p.minNote) marks.push({ start: s, end: e, label: midiName(cur) });
    }
  };
  for (let t = 0; t <= n; t++) {
    const v = t < n ? notes[t] : -1;
    const time = pt.offsetSec + t / pt.fps;
    let reattack = false;
    while (onsetIdx < onsets.length && onsets[onsetIdx] <= time) {
      if (onsets[onsetIdx] > pt.offsetSec + (start + 3) / pt.fps) reattack = true;
      onsetIdx++;
    }
    if (v !== cur || (reattack && v >= 0)) {
      flush(t);
      cur = v;
      start = t;
    }
  }
  // Bridge tiny gaps between different notes so legato lines read as connected spans.
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i].start - marks[i - 1].end;
    if (gap > 0 && gap < p.mergeGap) marks[i - 1].end = marks[i].start;
  }
  return [track('bass', 'notes', 'Bass notes', marks, p)];
}
