import type { AlignedWord } from '../align/align';
import type { Mark, Track } from '../core/types';
import type { Features } from '../dsp/features';
import { midiName } from '../dsp/pitch';
import type { PitchFrames } from '../notes/basicPitch';
import { DEFAULT_MELODY_PARAMS, melodyNotes, type MelodyParams, type PartNote } from '../notes/melody';
import type { StemName } from '../separation/htdemucs';
import { DEFAULT_PARAMS, mixTracks, type MixParams, type Rhythm } from './analyze';
import { lyricTracks } from './lyricTracks';
import { alignLyrics, type AsrWord } from './lyrics';
import { activitySpans, bassTracks, drumTracks, DEFAULT_STEM_PARAMS, presence, type StemParams } from './stems';
import { DEFAULT_SNAP_PARAMS, snapMarks, type SnapParams } from './snap';
import { attackOnsets, closeGaps, DEFAULT_VOCAL_PARAMS, frameDb, leadFrames, loudDb, partMelody, phrasesFrom, syllableSpans, vocalNotes, type VocalParams } from './vocals';

/** Audio a set of Basic Pitch frames was computed from. */
export type PitchSource = 'vocals' | 'lead' | 'backing' | 'other' | 'bass';

/** Everything the track builders can use; each later stage of processing fills in more. */
export type BuildInputs = {
  mix: Features;
  rhythm: Rhythm;
  stems: Partial<Record<StemName, Features>>;
  samples: Partial<Record<StemName, Float32Array>>;
  /** The lead singer alone (karaoke separation) and vocals minus lead. */
  lead?: Features;
  backing?: Features;
  pitch: Partial<Record<PitchSource, PitchFrames>>;
  /** Syllable onsets from the character model (greedy decoding), on all vocals and on the lead. */
  syllables?: number[];
  leadSyllables?: number[];
  /** Lyrics aligned letter by letter, or Whisper's words when not aligned. */
  aligned?: AlignedWord[];
  asrWords?: AsrWord[];
};

export type BuildParams = MixParams & StemParams & { vocals: VocalParams; melody: MelodyParams; snap: SnapParams };

/** Default parameters of every track builder. */
export const DEFAULT_BUILD_PARAMS: BuildParams = {
  ...DEFAULT_PARAMS,
  ...DEFAULT_STEM_PARAMS,
  vocals: DEFAULT_VOCAL_PARAMS,
  melody: DEFAULT_MELODY_PARAMS,
  snap: DEFAULT_SNAP_PARAMS,
};

const noteMark = (n: PartNote): Mark => ({ start: n.start, end: n.end, label: midiName(n.midi), strength: n.amp });

/** Tracks whose boundaries snap to the beat grid. */
const SNAPPED = new Set(['vocals-syllables', 'vocals-notes', 'vocals-backing-notes', 'other-melody', 'bass-notes', 'vocals-lyric-syllables', 'vocals-lyric-words']);

const track = (id: string, name: string, source: string, marks: Mark[], params: Record<string, number>): Track => ({ id, name, source, marks, params });

/** Every track for the inputs at hand, in display order: structure, vocals, drums, bass, instruments. */
export function buildTracks(inp: BuildInputs, p: BuildParams): Track[] {
  const { tracks: mix } = mixTracks(inp.mix, p, inp.rhythm);
  const out: Track[] = mix.filter((t) => ['mix-sections', 'mix-phrases', 'mix-bars', 'mix-beats'].includes(t.id));
  out.push(...vocalTracks(inp, p));
  const { drums, bass, other } = inp.stems;
  if (drums) out.push(...drumTracks(drums, p, presence(drums, inp.mix)));
  if (bass && inp.samples.bass) out.push(...bassTracks(bass, inp.samples.bass, p.bassNotes, presence(bass, inp.mix)));
  if (other) out.push(...instrumentTracks(inp, other, p));
  // Notes and syllables onto the beat grid where they're close to it.
  const beats = out.find((t) => t.id === 'mix-beats')?.marks.map((m) => m.start) ?? [];
  for (const t of out) if (SNAPPED.has(t.id)) t.marks = snapMarks(t.marks, beats, p.snap);
  // A track with no marks (e.g. Kick in a song without drums) is only clutter.
  return out.filter((t) => t.marks.length > 0);
}

function vocalTracks(inp: BuildInputs, p: BuildParams): Track[] {
  const vocals = inp.stems.vocals;
  if (!vocals) return [];
  const vp = p.vocals;
  const out: Track[] = [];

  // The sung line's notes (pitch), when the note model ran on the vocals.
  const frames = inp.pitch.vocals;
  const melody = frames ? partMelody(frames, vocals, vp.rangeDb, p.melody) : [];

  // Syllable onsets: from the character model when it ran, else from attacks in the vocal level.
  // With a separated lead, the lead's syllables where the lead sings and all vocals' elsewhere.
  const off = p.lyrics.offsetMs / 1000;
  let ctc = inp.syllables?.map((t) => t + off);
  if (ctc && inp.lead && inp.leadSyllables) {
    const use = leadFrames(vocals, inp.lead);
    const isLead = (t: number) => use[Math.max(0, Math.min(use.length - 1, Math.round(t * vocals.fps)))] === 1;
    ctc = [...inp.leadSyllables.map((t) => t + off).filter(isLead), ...ctc.filter((t) => !isLead(t))].sort((a, b) => a - b);
  }
  // (Vocal attacks catch more of shouted or spoken vocals, but split sung notes far too often.)
  const syllables = syllableSpans(ctc ?? attackOnsets(vocals, vp.rangeDb), vocals, vp);

  if (inp.aligned) {
    // Lyrics: their words, labeled syllables and the singing-face track, aligned to the vocals.
    out.push(...lyricTracks(inp.aligned, vocals, p.lyrics));
  } else {
    if (inp.asrWords) {
      const { lines, words } = alignLyrics(inp.asrWords, phrasesFrom(syllables, vp.breath), syllables);
      out.push(lines, words);
    }
    out.push(track('vocals-syllables', 'Vocal syllables', 'vocals', syllables, vp));
  }
  const sylForNotes = inp.aligned ? out.find((t) => t.id === 'vocals-lyric-syllables')!.marks : syllables;
  const notes = frames ? vocalNotes(sylForNotes, melody, vp) : [];
  if (frames) out.push(track('vocals-notes', 'Vocal notes', 'vocals', notes, { ...vp, ...p.melody }));
  // Phrases: where syllables and notes follow each other without a breath.
  out.unshift(track('vocals-phrases', 'Vocal phrases', 'vocals', phrasesFrom([...sylForNotes, ...notes], vp.breath), vp));

  // Backing vocals: harmonies, responses and groups, wherever they're a real part of the vocals.
  if (inp.backing && inp.lead) {
    const gated = backingLevel(inp.backing, vocals);
    const bf = inp.pitch.backing;
    const level = (t: number) => gated[Math.max(0, Math.min(gated.length - 1, Math.round(t * inp.backing!.fps)))];
    const notes = bf ? melodyNotes(bf, level, loudDb(frameDb(inp.backing)) - vp.rangeDb, p.melody).map(noteMark) : [];
    closeGaps(notes, vp.legato);
    const phrases = bf ? phrasesFrom(notes, vp.breath) : activitySpans(inp.backing, p.vocalPhrases, gated);
    out.push(track('vocals-backing', 'Backing vocals', 'vocals', phrases, vp));
    if (bf) out.push(track('vocals-backing-notes', 'Backing vocal notes', 'vocals', notes, { ...vp, ...p.melody }));
  }
  return out;
}

/** Backing level (dB) where it's a real part of the vocals (within 12 dB of them), not separation leftovers; −120 elsewhere. */
function backingLevel(backing: Features, vocals: Features): Float32Array {
  const b = frameDb(backing), v = frameDb(vocals);
  const n = Math.min(b.length, v.length);
  const out = new Float32Array(n).fill(-120);
  for (let i = 0; i < n; i++) if (b[i] - v[i] > -12) out[i] = b[i];
  return out;
}

/**
 * Instruments (the "other" stem: guitars, keys, strings, horns): the line that stands out,
 * as notes. Its accents are better served by Beats and the drum tracks.
 */
function instrumentTracks(inp: BuildInputs, other: Features, p: BuildParams): Track[] {
  const frames = inp.pitch.other;
  if (!frames) return [];
  const present = presence(other, inp.mix);
  const notes = partMelody(frames, other, p.vocals.rangeDb, p.melody).filter((n) => present(n.start));
  const marks = notes.map(noteMark);
  closeGaps(marks, p.vocals.legato);
  return [track('other-melody', 'Instrument melody', 'other', marks, p.melody)];
}
