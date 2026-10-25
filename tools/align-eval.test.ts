// Dev tool: lyrics-to-audio alignment on JamendoLyrics (English), scored against its
// hand-annotated word onsets. Needs `npm run tool:separate` / `tool:vocals-hq` run with
// SONGS_DIR=fixtures/private/jamendo/mp3 first, and the models in fixtures/private/models/.
// Run: npm run tool:align-eval   (STEM=vocals|vocals_hq|lead|mix, MODEL=w2v-char/model.onnx, SONG=<part>)
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as ort from 'onnxruntime-node';
import { it } from 'vitest';
import { applyVocalPrior, frameLevels } from '../apps/timing/src/align/acoustic';
import { alignWords, type CharVocab } from '../apps/timing/src/align/align';
import { parsePronDict } from '../apps/timing/src/align/pron';
import { fuseEmissions } from '../apps/timing/src/align/ctc';
import { readEmissions } from '../tests/emissions';
import { normWord, parseLyrics } from '../apps/timing/src/align/text';
import { STEMS_DIR } from '../tests/audio';
import { cachedEmissions, load16k } from '../tests/emissions';
import { matchWords, scoreOnsets } from '../apps/timing/src/eval/align';
import { wordsFromAsr } from '../apps/timing/src/analysis/lyricTracks';
import { alignLyrics, type AsrWord } from '../apps/timing/src/analysis/lyrics';
import { attackOnsets, DEFAULT_VOCAL_PARAMS, phrasesFrom, syllableSpans } from '../apps/timing/src/analysis/vocals';
import { computeFeatures } from '../apps/timing/src/dsp/features';
import { readWav16 } from '../tests/audio';

const JAM = new URL('../fixtures/private/jamendo/', import.meta.url).pathname;
const MODELS = new URL('../fixtures/private/models/', import.meta.url).pathname;
const MODEL = process.env.MODEL ?? 'w2v-char/model.onnx';
const STEM = process.env.STEM ?? 'vocals_hq';
/** Where the words come from: the true lyrics, or Whisper's transcript (raw timing, the old snapping, or aligned). */
const SRC = process.env.SRC ?? 'lyrics';
const dict = parsePronDict(gunzipSync(readFileSync(new URL('../public/cmudict.txt.gz', import.meta.url))).toString('utf8'));

it('aligns JamendoLyrics', async () => {
  let sess: ort.InferenceSession | undefined;
  const session = async () => (sess ??= await ort.InferenceSession.create(MODELS + MODEL, { executionProviders: [process.env.ORT_EP ?? 'cpu'] }));
  const vocab = JSON.parse(readFileSync(MODELS + MODEL.replace(/\/[^/]+$/, '/vocab.json'), 'utf8')) as CharVocab;
  const meta = new Map(readFileSync(JAM + 'JamendoLyrics.csv', 'utf8').trim().split('\n').slice(1).map((l) => {
    const c = l.split(',');
    return [c[1].replace(/\.mp3$/, ''), { genre: c[4], poly: c[8] === 'true' }];
  }));
  // STEM=a+b fuses the emissions of two stems (see fuseEmissions), FUSE_W weighting the first.
  const stems = STEM.split('+');
  const songs = readFileSync(JAM + 'en.txt', 'utf8').trim().split('\n').filter((s) => (!process.env.SONG || s.includes(process.env.SONG)) && (STEM === 'mix' || stems.every((st) => existsSync(`${STEMS_DIR}${s}/${st}.wav`))));
  const all: number[] = [];
  const rows: string[] = [];
  for (const song of songs) {
    let em = stems.length > 1
      ? fuseEmissions(readEmissions(song, stems[0], MODEL)!, readEmissions(song, stems[1], MODEL)!, Number(process.env.FUSE_W ?? 0.5))
      : await cachedEmissions(session, song, STEM, MODEL, STEM === 'mix' ? `${JAM}mp3/${song}.mp3` : undefined);
    const priorStem = STEM === 'mix' ? 'vocals' : stems[0];
    if (process.env.PRIOR !== '0') em = applyVocalPrior(em, frameLevels(em, load16k(`${STEMS_DIR}${song}/${priorStem}.wav`)), vocab['<pad>'] ?? 0, Number(process.env.QUIET_DB ?? 30), Number(process.env.PENALTY ?? 8));
    const words = parseLyrics(readFileSync(`${JAM}lyrics/${song}.txt`, 'utf8'));
    const ref = readFileSync(`${JAM}words/${song}.csv`, 'utf8').trim().split('\n').slice(1).map((l) => +l.split(',')[0]);
    if (words.length !== ref.length) { rows.push(`${song}: ${words.length} words vs ${ref.length} annotated, skipped`); continue; }
    const off = Number(process.env.OFFSET ?? 0);
    let est: number[];
    let matched = '';
    if (SRC === 'lyrics') {
      const aligned = alignWords(em, vocab, words, { dict });
      est = words.map((_, i) => (aligned[i]?.start ?? NaN) + off);
    } else {
      // Transcribed lyrics: score the words that match the true lyrics; the rest count as misses.
      const asr = JSON.parse(readFileSync(`${STEMS_DIR}${song}/whisper-app-${stems[0]}.json`, 'utf8')) as AsrWord[];
      const { words: tw, hints } = wordsFromAsr(asr);
      let times: number[];
      if (SRC === 'whisper-raw') times = hints.map((h) => h!.start);
      else if (SRC === 'whisper-old') {
        const w = readWav16(`${STEMS_DIR}${song}/${stems[0]}.wav`);
        const vf = computeFeatures(w.samples, w.sr);
        const syl = syllableSpans(attackOnsets(vf), vf);
        const old = alignLyrics(asr, phrasesFrom(syl, DEFAULT_VOCAL_PARAMS.breath), syl).words.marks;
        // alignLyrics drops some words; match its own labels instead.
        const pairs = matchWords(old.map((m) => normWord(m.label ?? '')), words.map((x) => x.norm));
        est = words.map(() => NaN);
        for (const [i, j] of pairs) est[j] = old[i].start + off;
        matched = ` matched ${pct(pairs.length / words.length)}`;
        times = [];
      } else {
        const aligned = alignWords(em, vocab, tw, { hints, dict });
        times = tw.map((_, i) => aligned[i]?.start ?? NaN);
      }
      if (SRC !== 'whisper-old') {
        const pairs = matchWords(tw.map((x) => x.norm), words.map((x) => x.norm));
        est = words.map(() => NaN);
        for (const [i, j] of pairs) est[j] = times[i] + off;
        matched = ` matched ${pct(pairs.length / words.length)}`;
      }
    }
    // Score only matched words for transcripts (misses are reported separately as "matched").
    const keep = est!.map((e, i) => [e, ref[i]] as const).filter(([e]) => SRC === 'lyrics' || !Number.isNaN(e));
    const s = scoreOnsets(keep.map((x) => x[0]), keep.map((x) => x[1]));
    all.push(...keep.map(([e, r]) => e - r));
    const m = meta.get(song)!;
    rows.push(`${song.slice(0, 34).padEnd(35)} ${m.genre.padEnd(10)} ${m.poly ? 'poly' : '    '}  ${fmt(s)}${matched}`);
  }
  const tot = scoreOnsets(all, all.map(() => 0));
  console.log([`model ${MODEL}, stem ${STEM}, words from ${SRC}`, ...rows, `${'ALL'.padEnd(52)}${fmt(tot)}`].join('\n'));
}, 3_600_000);

const fmt = (s: ReturnType<typeof scoreOnsets>) =>
  `mean |err| ${(s.meanAbs * 1000).toFixed(0).padStart(4)} ms  median ${(s.medianAbs * 1000).toFixed(0).padStart(4)} ms  bias ${(s.bias * 1000).toFixed(0).padStart(4)} ms  ≤100 ${pct(s.within[0])} ≤200 ${pct(s.within[1])} ≤300 ${pct(s.within[2])}`;
const pct = (x: number) => `${(x * 100).toFixed(0).padStart(3)}%`;

