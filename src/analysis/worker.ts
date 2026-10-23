/// <reference lib="webworker" />
import { computeFeatures, type Features } from '../dsp/features';
import { analyzeRhythm, mixTracks, type MixParams, type Rhythm } from './analyze';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let features: Features | undefined;
let rhythm: Rhythm | undefined;
let rhythmKey = '';

const post = (m: FromWorker) => self.postMessage(m);

function run(params: MixParams) {
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
  post({ type: 'result', tracks, bpm: rhythm.bpm, duration: features.duration });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const msg = e.data;
    if (msg.type === 'analyze') {
      rhythm = undefined;
      features = computeFeatures(msg.mono, msg.sr, (fr) =>
        post({ type: 'progress', stage: 'Analyzing spectrum', fraction: 0.1 + 0.7 * fr }),
      );
      run(msg.params);
    } else if (msg.type === 'rerun') {
      run(msg.params);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
