/// <reference lib="webworker" />
import { applyVocalPrior } from '../align/acoustic';
import { alignWords, type AlignedWord } from '../align/align';
import type { Emissions } from '../align/ctc';
import { greedySyllables } from '../align/greedy';
import { parsePronDict, type PronDict } from '../align/pron';
import { computeFeatures, type Features } from '../dsp/features';
import type { PitchFrames } from '../notes/basicPitch';
import type { StemName } from '../separation/htdemucs';
import { ALIGNER_VOCAB } from '../separation/model';
import { analyzeRhythm, type Rhythm } from './analyze';
import { buildTracks, type PitchSource } from './build';
import type { AsrWord } from './lyrics';
import type { AllParams, FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let features: Features | undefined;
let rhythm: Rhythm | undefined;
let rhythmKey = '';
let stemFeatures: Partial<Record<StemName, Features>> = {};
let stemSamples: Partial<Record<StemName, Float32Array>> = {};
let asrWords: AsrWord[] | undefined;
/** Lead vocal (karaoke separation) and what's left of the vocals without it. */
let leadFeatures: Features | undefined;
let backingFeatures: Features | undefined;
let dict: PronDict | undefined;
let aligned: AlignedWord[] | undefined;
/** Syllable onsets from the character model, in all vocals and in the lead. */
let syllables: number[] | undefined;
let leadSyllables: number[] | undefined;
let pitch: Partial<Record<PitchSource, PitchFrames>> = {};

/** Vocal level (dB) at each emission frame, from the stem's short-window RMS. */
function emissionLevels(f: Features, frames: number, frameSec: number, offsetSec: number): Float32Array {
  return Float32Array.from({ length: frames }, (_, t) => {
    const i = Math.min(f.nFrames - 1, Math.round((offsetSec + t * frameSec) * f.fps));
    return 20 * Math.log10(f.rmsShort[i] + 1e-9);
  });
}

const post = (m: FromWorker) => self.postMessage(m);

function run(params: AllParams) {
  if (!features) throw new Error('No audio analyzed yet');
  // Beat tracking is the only stage whose params force re-tracking; everything else reuses it.
  const key = JSON.stringify(params.beats);
  if (!rhythm || key !== rhythmKey) {
    post({ type: 'progress', stage: 'Tracking beats', fraction: 0.85 });
    rhythm = analyzeRhythm(features, params.beats);
    rhythmKey = key;
  }
  post({ type: 'progress', stage: 'Finding sections', fraction: 0.95 });
  const tracks = buildTracks({
    mix: features, rhythm, stems: stemFeatures, samples: stemSamples,
    lead: leadFeatures, backing: backingFeatures, pitch,
    syllables, leadSyllables, aligned, asrWords: aligned ? undefined : asrWords,
  }, params);
  post({ type: 'result', tracks, bpm: rhythm.bpm, duration: features.duration });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const msg = e.data;
    if (msg.type === 'analyze') {
      rhythm = undefined;
      stemFeatures = {};
      stemSamples = {};
      asrWords = undefined;
      leadFeatures = backingFeatures = undefined;
      aligned = undefined;
      syllables = leadSyllables = undefined;
      pitch = {};
      features = computeFeatures(msg.mono, msg.sr, (fr) =>
        post({ type: 'progress', stage: 'Analyzing the mix', fraction: 0.1 + 0.7 * fr }),
      );
      run(msg.params);
    } else if (msg.type === 'stems') {
      const names = Object.keys(msg.stems) as StemName[];
      names.forEach((name, i) => {
        stemSamples[name] = msg.stems[name];
        stemFeatures[name] = computeFeatures(msg.stems[name]!, msg.sr, (fr) =>
          post({ type: 'progress', stage: `Analyzing ${name}`, fraction: (i + fr) / names.length }),
        );
      });
      run(msg.params);
    } else if (msg.type === 'lyrics') {
      asrWords = msg.words;
      run(msg.params);
    } else if (msg.type === 'lead') {
      post({ type: 'progress', stage: 'Analyzing lead vocals', fraction: 0.5 });
      leadFeatures = computeFeatures(msg.lead, msg.sr);
      const vocals = stemSamples.vocals;
      if (vocals) {
        const backing = Float32Array.from(vocals, (v, i) => v - (msg.lead[i] ?? 0));
        backingFeatures = computeFeatures(backing, msg.sr);
      }
      run(msg.params);
    } else if (msg.type === 'pitch') {
      pitch[msg.stem] = msg.frames;
      run(msg.params);
    } else if (msg.type === 'pron') {
      dict = parsePronDict(msg.dict);
    } else if (msg.type === 'align') {
      post({ type: 'progress', stage: 'Aligning lyrics', fraction: 0.5 });
      const blank = ALIGNER_VOCAB['<pad>'];
      const withPrior = (em: Emissions, f: Features | undefined) => (f ? applyVocalPrior(em, emissionLevels(f, em.frames, em.frameSec, em.offsetSec), blank) : em);
      // Lyrics align to all the vocals: lines the group or a second voice sings are lyrics too,
      // and fusing in the lead alone pulled repeated phrases onto the wrong repeat.
      const em = withPrior(msg.emissions, stemFeatures.vocals);
      aligned = undefined;
      if (msg.words.length) {
        try {
          // Whisper's times keep each word near where it was heard (see alignWords).
          aligned = alignWords(em, ALIGNER_VOCAB, msg.words, { hints: msg.hints, dict });
        } catch (err) {
          // Shouldn't happen without hints; keep the lyric-free syllables if it does.
          console.warn('[align] lyrics alignment failed', err);
        }
      }
      // Syllables heard in all vocals, and in the lead alone where it sings (see buildTracks).
      syllables = greedySyllables(em, ALIGNER_VOCAB).map((x) => x.start);
      leadSyllables = msg.leadEmissions ? greedySyllables(withPrior(msg.leadEmissions, leadFeatures), ALIGNER_VOCAB).map((x) => x.start) : undefined;
      run(msg.params);
    } else if (msg.type === 'rerun') {
      run(msg.params);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
