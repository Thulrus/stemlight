import type { Mark } from '../core/types';
import type { Features } from '../dsp/features';
import { midiName } from '../dsp/pitch';
import { pickOnsets } from '../dsp/rhythm';
import type { PitchFrames } from '../notes/basicPitch';
import { DEFAULT_MELODY_PARAMS, melodyNotes, type PartNote } from '../notes/melody';

/** Frame level in dB of a stem (short-window RMS). */
export function frameDb(f: Features): Float32Array {
  return Float32Array.from(f.rmsShort, (r) => 20 * Math.log10(r + 1e-9));
}

/** The level a stem reaches when it is clearly sounding: the 95th percentile of frame dB. */
export function loudDb(db: Float32Array): number {
  const sorted = Float32Array.from(db).sort();
  return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

/** Level (dB) at song time t. */
export const levelAt = (f: Features, db: Float32Array) => (t: number) => db[Math.max(0, Math.min(db.length - 1, Math.round(t * f.fps)))];

export const DEFAULT_VOCAL_PARAMS = {
  /** How far below the loud vocal level singing still counts (dB). */
  rangeDb: 25,
  /** A syllable ends where the voice falls this far below the syllable's peak (dB). */
  decayDb: 15,
  /** Gaps shorter than this (s) are closed: the earlier syllable or note runs to the next. */
  legato: 0.2,
  /** Shortest syllable or note (s). */
  minDur: 0.08,
  /** Longest a syllable holds past its start when nothing follows (s). */
  maxHold: 4,
  /** A pause in the singing at least this long (s) ends a phrase. */
  breath: 0.4,
};
export type VocalParams = typeof DEFAULT_VOCAL_PARAMS;

/**
 * Sung syllables as spans: one per syllable onset (from the character model, or from vocal
 * attacks), each lasting while it's sung: until the next syllable, or until the voice falls
 * `decayDb` below the syllable's peak. Gaps shorter than `legato` are closed, so a line sung
 * smoothly reads as touching spans, which is how lights following a voice are sequenced.
 */
export function syllableSpans(onsets: number[], vocal: Features, p: VocalParams = DEFAULT_VOCAL_PARAMS): Mark[] {
  const db = frameDb(vocal);
  const gate = loudDb(db) - p.rangeDb;
  const fr = (t: number) => Math.max(0, Math.min(vocal.nFrames - 1, Math.round(t * vocal.fps)));
  const s = [...onsets].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] >= p.minDur);
  const marks: Mark[] = [];
  for (let i = 0; i < s.length; i++) {
    const start = s[i];
    const limit = Math.min(s[i + 1] ?? Infinity, start + p.maxHold, vocal.duration);
    // Peak within the attack, then the first frame below peak − decay (or below the gate).
    let peak = -Infinity;
    const a = fr(start), z = fr(limit);
    for (let j = a; j <= Math.min(z, a + Math.round(0.12 * vocal.fps)); j++) peak = Math.max(peak, db[j]);
    if (peak < gate) continue; // nothing audible here: a stray letter in the bleed
    let end = limit;
    for (let j = a + 1; j <= z; j++) {
      if (db[j] < Math.max(peak - p.decayDb, gate)) { end = j / vocal.fps; break; }
    }
    if (end - start >= p.minDur * 0.6) marks.push({ start, end });
  }
  closeGaps(marks, p.legato);
  return marks;
}

/** Close gaps shorter than `legato` between consecutive spans. */
export function closeGaps(marks: Mark[], legato: number) {
  for (let i = 0; i + 1 < marks.length; i++) {
    const gap = marks[i + 1].start - marks[i].end;
    if (gap < legato) marks[i].end = Math.max(marks[i].start + 0.01, Math.min(marks[i].end + Math.max(0, gap), marks[i + 1].start));
  }
}

/**
 * Sung notes: syllables split further where the pitch moves to a new note (a melisma, or a
 * slur from one note to the next), plus notes sung without a new syllable at all (vowels the
 * character model can't hear, like "ahh"). Labeled with the note name.
 */
export function vocalNotes(syllables: Mark[], melody: PartNote[], p: VocalParams = DEFAULT_VOCAL_PARAMS): Mark[] {
  const out: Mark[] = [];
  const label = (a: number, b: number) => {
    let best: PartNote | undefined, ov = 0;
    for (const n of melody) {
      if (n.end <= a || n.start >= b) continue;
      const o = Math.min(b, n.end) - Math.max(a, n.start);
      if (o > ov) { ov = o; best = n; }
    }
    return best ? midiName(best.midi) : undefined;
  };
  // Boundaries: syllable starts and note starts, deduplicated within minDur (syllables win).
  const bounds: { t: number; syl: boolean }[] = [
    ...syllables.map((s) => ({ t: s.start, syl: true })),
    ...melody.map((n) => ({ t: n.start, syl: false })),
  ].sort((a, b) => a.t - b.t);
  const kept: { t: number; syl: boolean }[] = [];
  for (const b of bounds) {
    const last = kept[kept.length - 1];
    if (last && b.t - last.t < p.minDur * 1.5) {
      if (b.syl && !last.syl) kept[kept.length - 1] = b;
      continue;
    }
    kept.push(b);
  }
  // Each boundary starts a span that ends at the next boundary or when neither the syllable
  // nor the note sounding there goes on.
  const sounding = [...syllables, ...melody.map((n) => ({ start: n.start, end: n.end }))].sort((a, b) => a.start - b.start);
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i].t;
    const next = kept[i + 1]?.t ?? Infinity;
    let end = t;
    for (const s of sounding) {
      if (s.start > t + 0.02) break;
      if (s.end > end) end = s.end;
    }
    end = Math.min(end, next);
    if (end - t >= p.minDur * 0.6) out.push({ start: t, end, label: label(t, end) });
  }
  closeGaps(out, p.legato);
  return out;
}

/** Notes of a part from its Basic Pitch frames and level. */
export function partMelody(frames: PitchFrames, f: Features, rangeDb: number, params = DEFAULT_MELODY_PARAMS): PartNote[] {
  const db = frameDb(f);
  return melodyNotes(frames, levelAt(f, db), loudDb(db) - rangeDb, params);
}

/**
 * The main vocal, frame by frame: the lead singer where the lead/backing separation found one,
 * else all the vocals. The separation hears a group singing in unison (or a lead it doesn't
 * recognize) as backing and returns silence, so following the lead alone loses whole verses.
 * Returns which frames use the lead.
 */
export function leadFrames(vocals: Features, lead: Features, marginDb = 10): Uint8Array {
  const v = frameDb(vocals), l = frameDb(lead);
  const n = Math.min(v.length, l.length);
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = l[i] > v[i] - marginDb ? 1 : 0;
  // Smooth over ~0.5 s so syllable tails don't flip sources.
  const w = Math.round(0.25 * vocals.fps);
  const out = new Uint8Array(n);
  let acc = 0;
  for (let i = 0; i < Math.min(n, w); i++) acc += raw[i];
  for (let i = 0; i < n; i++) {
    if (i + w < n) acc += raw[i + w];
    if (i - w - 1 >= 0) acc -= raw[i - w - 1];
    out[i] = acc * 2 > Math.min(n, i + w + 1) - Math.max(0, i - w) ? 1 : 0;
  }
  return out;
}

/** Sung phrases: runs of syllables and notes with no pause of `breath` seconds or more. */
export function phrasesFrom(spans: Mark[], breath: number, minDur = 0.3): Mark[] {
  const s = [...spans].sort((a, b) => a.start - b.start);
  const out: Mark[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start - last.end < breath) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out.filter((m) => m.end - m.start >= minDur);
}

/** Vocal attacks (onsets in the vocal stem) where the voice is audible: syllable onsets without the character model. */
export function attackOnsets(vocals: Features, rangeDb: number = DEFAULT_VOCAL_PARAMS.rangeDb): number[] {
  const db = frameDb(vocals);
  const gate = loudDb(db) - rangeDb;
  return pickOnsets(vocals.onset, vocals.fps, { sensitivity: 0.85, minGap: 0.1 })
    .map((o) => o.time)
    .filter((t) => db[Math.min(db.length - 1, Math.round((t + 0.03) * vocals.fps))] > gate);
}
