# Stemlight: development notes

For contributors. The [README](../README.md) is the user-facing introduction.

## Milestones

Stemlight Timing, milestones from [SPEC.md](../SPEC.md):

- [x] **M0**: decode audio, onset and beat detection on the full mix, quantize to a 25/50 ms grid, `.xtiming` export
- [x] **M1** (mostly): timeline with waveform, bars/beats/sections with labels, audition clicks, per-track tuning on cached analysis
- [x] **M2**: stem separation (HTDemucs via ONNX Runtime Web, WebGPU or WASM), user-supplied stems, kick/snare/hats, bass notes, vocal phrases and syllables
- [x] Light preview: one blinking light per exported track, in sync with playback
- [x] Optional high-quality vocals (Mel-Band RoFormer) and lyrics (Whisper) for better vocal tracks
- [x] Vocal timing from a speech model: lyrics (pasted or transcribed) aligned letter by letter, syllables and phonemes, a three-layer Lyrics track for singing faces; lead/backing vocal separation
- [x] Note tracks: the sung melody note by note, backing vocal notes, the instruments' melody (Basic Pitch + a Viterbi note decoder)
- [x] Split any track between several props (by turns or by pitch); optional snap to the beat grid
- [ ] **M3**: light editing, …
- [ ] **M4**: session save/load, presets

Stemlight Composer, milestones from [Stemlight Composer Spec.md](../Stemlight%20Composer%20Spec.md):

- [x] **C0**: `.xsq` writer checked against a real xLights (2026.19): sequences open without warnings and render frame-exactly (`npm run tool:xlights`)
- [x] **R0**: repo split into apps and shared packages, one build with three pages
- [x] **C1**: start screen with layout and timing import, row list, timeline with timing lanes, drag/double-click/number-key creation with snapping, select/move/resize/duplicate/delete, fades, nudges, split/merge, copy/paste, inspector, unlimited undo/redo, autosave, `.xsq` export of nine curated effects, row-light preview
- [ ] **C2**: Paint mode, sections and apply-to-matching-sections, recipes, fill helpers, chase generator, mirror, palette editing
- [ ] **C3**: Record mode, bindings, Send to Composer from the timing app
- [ ] **C4**: `.xsq` import with opaque effects and round trips, virtual row mapping, project and recipe files
- [ ] **C5**: approximate pixel preview, keyboard remapping, tutorial

Effect settings (key names, value formats, defaults) come from xLights' own effect metadata (`packages/xlights/metadata/`, from xLights 2026.17), and the tests reproduce the settings strings and sequences of the fixtures byte for byte.

## Building

```sh
npm install
npm run dev        # dev server: / (landing), /timing/, /composer/
npm test           # unit tests + benchmark
npm run build      # static build in dist/ (all three pages)
```

`npm run tool:xlights` (with `XLIGHTS=/path/to/xLights.AppImage`) renders sequences the composer writes with a real, headless xLights and checks which channels light up on which frames. xLights runs sandboxed: temporary `HOME`, settings and show folder, so your own xLights setup is never touched.

## Fixtures and benchmark

`fixtures/` holds a sequence (`.xsq`), layout and an `.xtiming` exported by xLights 2026.17. The exporter is tested to reproduce that `.xtiming` byte for byte.

Benchmarks need copyrighted audio, which stays out of git in `fixtures/private/`:

- `tests/eval.test.ts` compares Bars/Beats/Sections with xLights' own, given the song in `fixtures/private/`.
- `tests/bench.test.ts` (`npm run bench`) scores the tracks against five hand-made sequences in `fixtures/`. Each target is a group of props that follows one musical part, scored against the tracks meant to serve it (the best of them counts). Props whose effects tile a part are scored on start *and* end (both within 100 ms, 250 ms for whole phrases): a mark with the right start and the wrong length still has to be fixed by hand. Props that flash for a fixed short time are scored on starts. The cases: *Cara Mia Addio* (the lead soprano note by note, and an accompaniment alternated between two pumpkins), *Candy Girl* (lead, backing group, alternating beats, backing phrases), *Grim Grinning Ghosts* (syllable flashes, sung lines), the pumpkins in *This Is Halloween* and the drum circles in the Marilyn Manson *This Is Halloween*. It needs stems in `fixtures/private/stems/<song>/`, which `npm run tool:separate` creates from the songs in `example_data/` with the same separation code the browser runs, using `onnxruntime-node` and the model files in `fixtures/private/models/` (from https://huggingface.co/webnn/stem-separator). `VOCALS=vocals_hq` uses the RoFormer vocals (`npm run tool:vocals-hq`), `LEAD=1` adds lead/backing separation (`npm run tool:lead`), and the character model's output comes from `tools/emissions.test.ts`. Basic Pitch frames are computed and cached on first use. The app and the benchmark build tracks with the same code (`apps/timing/src/analysis/build.ts`).
  `tools/prop-matrix.test.ts` lists, for every prop, which tracks follow it best.

  Mean score per song, before and after the redesign around musical parts (old: onset- and level-based syllables and phrases, notes from Basic Pitch's own note decoding):

  | Configuration | Old pipeline | Now |
  |---|---|---|
  | Default without a GPU (HTDemucs vocals, speech-model syllables) | 0.345 | 0.37 |
  | High-quality vocals (the new default with a GPU) | n/a | 0.43 |
  | High-quality vocals + lead/backing | 0.376 | 0.44 |

  On *Cara Mia Addio* the lead voice went from 0.44 to 0.76 and the accompaniment is served by Beats split in two (0.79). Without high-quality vocals, the standard split loses that song's singer, so its lead scores 0.
- `tools/whisper-eval.test.ts` runs Whisper on cached vocal stems and scores its word timing and lyrics.

### Vocal timing benchmark (JamendoLyrics)

The hand-made sequences say whether tracks look right to a sequencer, but they mix syllable timing with taste (the pumpkins above flash on eighth notes while singing, not on every syllable). Word-level accuracy is measured on the English part of [JamendoLyrics](https://huggingface.co/datasets/jamendolyrics/jamendolyrics) (20 Creative Commons songs, 5,700 hand-annotated word onsets), downloaded into `fixtures/private/jamendo/` (`mp3/`, `lyrics/`, `words/`, `en.txt` listing the English songs):

```sh
SONGS_DIR=fixtures/private/jamendo/mp3 npm run tool:separate      # HTDemucs stems
SONGS_DIR=fixtures/private/jamendo/mp3 npm run tool:vocals-hq     # RoFormer vocals
SONGS_DIR=fixtures/private/jamendo/mp3 npm run tool:lead          # lead vocals (karaoke model)
STEM=vocals_hq npm run tool:align-eval                            # word onsets vs the annotation
```

`tools/syllable-eval.test.ts` scores lyric-free syllables, `tools/emissions.test.ts` caches the speech model's output for the benchmarks, and `tools/export/` holds the scripts that made the karaoke and alignment ONNX files. The tools take `ORT_EP=cuda` to use onnxruntime-node's CUDA provider (with the CUDA 13 runtime libraries on `LD_LIBRARY_PATH`).

Results with the true lyrics (word-onset error against the annotation; share of words within 100/200/300 ms, with the default −40 ms offset):

| Vocals the lyrics are aligned to | median | ≤100 ms | ≤200 ms | ≤300 ms |
|---|---|---|---|---|
| HTDemucs vocals | 39 ms | 82% | 91% | 94% |
| RoFormer vocals (high-quality vocals on) | 38 ms | 83% | 92% | 94% |

With Whisper's transcript instead of the real lyrics (`SRC=whisper`; scored on the 75% of words Whisper gets right):

| Word timing from Whisper's words | median | ≤100 ms | ≤200 ms | ≤300 ms |
|---|---|---|---|---|
| Whisper's own timestamps | 229 ms | 8% | 42% | 66% |
| Snapped to onset-based syllables (before this alignment) | 298 ms | 16% | 27% | 50% |
| Aligned letter by letter | 40 ms | 80% | 89% | 91% |

The fp16 model matches fp32; the 8-bit model loses about 3 points, so it isn't used. The larger wav2vec2-large-960h-lv60-self is better still (87% within 100 ms after its own offset) but would need its own hosting. Aligning to the lead vocal alone or mixing it in barely changes these averages and can pull a repeated line onto the wrong repeat when a group sings it, so lyrics align to all the vocals; the lead is used for syllables without lyrics and for the Backing vocals track.

```sh
npm run eval                      # Bars/Beats/Sections vs xLights
npm run bench                     # stem tracks vs hand-made sequences
```

## Layout

```
apps/index.html          landing page
apps/timing/src          the timing app:
  dsp                    FFT, spectral features, onsets, tempo, beat tracking, downbeats, structure
  analysis               features -> Track builders (build.ts: every track, shared by the app and the benchmark), analysis worker
  separation             HTDemucs and RoFormer pipelines (vocals, lead/backing), separation worker
  lyrics                 Whisper transcription (vocal-aware windows), lyrics worker
  align                  lyrics → letters, CTC forced alignment, syllables and phonemes (CMUdict), greedy syllables
  notes                  Basic Pitch notes and the lead line
  ui                     app shell
apps/composer/src        the composer:
  model                  project types, undoable changes (Tx), edit operations, snapping, export
  state                  project store (undo/redo, selection), IndexedDB persistence
  ui                     start screen, timeline canvas, row list, inspector, effect bar, preview, dialogs
packages/core            Track/Mark types, grid quantization, .xtiming read/write, zip, splitting a track between props
packages/audio           decoding, playback (speed, stem mute/solo, audition clicks)
packages/timeline        the timing app's timeline canvas and light preview
packages/storage         IndexedDB stores (per app, plus a shared one for audio)
packages/xlights         XML reader, layout parser, .xsq reader/writer, effect settings and palettes, effect metadata
```

Packages are imported as `@stemlight/<name>/<file>` (path aliases in `vite.config.ts` and `tsconfig.json`; one `package.json`).

Everything downstream of analysis only knows `Track`s, so new extractors plug in without touching the editor or exporters.
