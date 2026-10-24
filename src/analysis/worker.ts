/// <reference lib="webworker" />
import { computeFeatures, type Features } from '../dsp/features';
import type { StemName } from '../separation/htdemucs';
import { analyzeRhythm, mixTracks, type Rhythm } from './analyze';
import { alignLyrics, type AsrWord } from './lyrics';
import type { AllParams, FromWorker, ToWorker } from './protocol';
import { stemTracks } from './stems';

declare const self: DedicatedWorkerGlobalScope;

let features: Features | undefined;
let rhythm: Rhythm | undefined;
let rhythmKey = '';
let stemFeatures: Partial<Record<StemName, Features>> = {};
let stemSamples: Partial<Record<StemName, Float32Array>> = {};
let lyricWords: AsrWord[] | undefined;

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
  const { tracks } = mixTracks(features, params, rhythm);
  const stems = stemTracks(stemFeatures, stemSamples, params, features);
  const phrases = stems.find((t) => t.id === 'vocals-phrases');
  const syllables = stems.find((t) => t.id === 'vocals-syllables');
  if (lyricWords && phrases && syllables) {
    const { lines, words } = alignLyrics(lyricWords, phrases.marks, syllables.marks);
    stems.splice(stems.indexOf(syllables) + 1, 0, lines, words);
  }
  // Sections, Phrases, Bars, Beats, then per-instrument tracks, then Onsets and Energy.
  tracks.splice(4, 0, ...stems);
  post({ type: 'result', tracks, bpm: rhythm.bpm, duration: features.duration });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const msg = e.data;
    if (msg.type === 'analyze') {
      rhythm = undefined;
      stemFeatures = {};
      stemSamples = {};
      lyricWords = undefined;
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
      lyricWords = msg.words;
      run(msg.params);
    } else if (msg.type === 'rerun') {
      run(msg.params);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
