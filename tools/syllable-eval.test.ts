// Dev tool: how well the lyric-free syllable detector (attackOnsets) finds syllables, on
// JamendoLyrics. Reference syllable onsets come from aligning the dataset's lyrics to the same
// vocals (word onsets within ~50 ms of the human annotation; see tools/align-eval). Needs the
// emissions cached by align-eval for the stem.
// Run: STEMLIGHT_TOOLS=1 npx vitest run tools/syllable-eval.test.ts --disableConsoleIntercept   (STEM=vocals|vocals_hq|lead)
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { it } from 'vitest';
import { alignWords, type CharVocab } from '../src/align/align';
import { greedySyllables } from '../src/align/greedy';
import { parsePronDict } from '../src/align/pron';
import { parseLyrics } from '../src/align/text';
import { attackOnsets } from '../src/analysis/vocals';
import { computeFeatures } from '../src/dsp/features';
import { eventF } from '../src/eval/metrics';
import { readWav16, STEMS_DIR } from '../tests/audio';
import { readEmissions } from '../tests/emissions';

const JAM = new URL('../fixtures/private/jamendo/', import.meta.url).pathname;
const MODELS = new URL('../fixtures/private/models/', import.meta.url).pathname;
const STEM = process.env.STEM ?? 'vocals';
const dict = parsePronDict(gunzipSync(readFileSync(new URL('../public/cmudict.txt.gz', import.meta.url))).toString('utf8'));
const vocab = JSON.parse(readFileSync(MODELS + 'w2v-char/vocab.json', 'utf8')) as CharVocab;

it('scores lyric-free syllables', () => {
  const songs = readFileSync(JAM + 'en.txt', 'utf8').trim().split('\n');
  const rows: string[] = [];
  let hits = 0, est = 0, ref = 0, wHits = 0, wRef = 0;
  for (const song of songs) {
    const em = readEmissions(song, STEM);
    // REF_MODEL=w2v-large/model.onnx takes the reference syllables from a different network;
    // REF_STEM aligns the reference on another stem (e.g. vocals_hq when scoring the lead).
    const refEm = readEmissions(song, process.env.REF_STEM ?? STEM, process.env.REF_MODEL);
    if (!em || !refEm) continue;
    const words = parseLyrics(readFileSync(`${JAM}lyrics/${song}.txt`, 'utf8'));
    const refOn = alignWords(refEm, vocab, words, { dict }).flatMap((w) => w.syllables.map((s) => s.start - (process.env.REF_MODEL ? 0.06 : 0.04)));
    const w = readWav16(`${STEMS_DIR}${song}/${STEM}.wav`);
    const f = computeFeatures(w.samples, w.sr);
    const syl = process.env.METHOD === 'greedy'
      ? greedySyllables(em, vocab, Number(process.env.MIN_PROB ?? 0.3)).map((s) => s.start - 0.04)
      : attackOnsets(f);
    const r = eventF(syl, refOn, 0.1);
    // Independent check: recall of the human-annotated word onsets (each starts a syllable).
    const human = readFileSync(`${JAM}words/${song}.csv`, 'utf8').trim().split('\n').slice(1).map((l) => +l.split(',')[0]);
    const rw = eventF(syl, human, 0.1);
    hits += r.hits; est += r.est; ref += r.ref; wHits += rw.hits; wRef += rw.ref;
    rows.push(`${song.slice(0, 34).padEnd(35)} F ${r.f.toFixed(3)}  P ${r.precision.toFixed(2)}  R ${r.recall.toFixed(2)}  word R ${rw.recall.toFixed(2)}  (${r.est} vs ${r.ref})`);
  }
  const P = hits / est, R = hits / ref;
  console.log([`stem ${STEM}`, ...rows, `${'ALL'.padEnd(35)} F ${((2 * P * R) / (P + R)).toFixed(3)}  P ${P.toFixed(2)}  R ${R.toFixed(2)}  word R ${(wHits / wRef).toFixed(2)}`].join('\n'));
}, 600_000);
