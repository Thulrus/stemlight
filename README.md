# Stemlight

Free, in-browser tools for xLights sequencing, published at one site with a landing page:

- **Stemlight Timing** (`/timing/`): auto-timing tracks from a song. Described below.
- **Stemlight Composer** (`/composer/`): a fast sequence editor that writes `.xsq` files for xLights. See [Composer](#composer) and [Stemlight Composer Spec.md](Stemlight%20Composer%20Spec.md).

## Stemlight Timing

**Auto-timing tracks for xLights.** Drop in a song and get timing tracks to import into your xLights sequence: song structure (sections, phrases, bars, beats), and one track per musical part from stem separation (vocal phrases, syllables and notes, backing vocals, kick, snare, hats, bass notes, the instruments' melody), and, with lyrics, words, labeled syllables and a phrases/words/phonemes track for singing faces. Marks have a start *and* an end: a sung note lasts as long as it's sung, so an effect snapped to it needs no fixing. Any track can be split between several props (alternate beats between two pumpkins, or low notes on one and high notes on another).

Everything runs in your browser. There's no server and your audio never leaves your machine.

### Status

Milestones from [SPEC.md](SPEC.md):

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

### Using it

1. Open the app and drop an audio file. Structure tracks appear in a couple of seconds.
2. With **Separate stems** on, the song is split into drums, bass, vocals and other in the background, and the instrument tracks are added when it's done. The model (~170 MB) downloads once and is cached, and the stems for each song are cached too. Measured on a desktop: with WebGPU (RTX 3060) a 1:43 song separates in about 25 s; CPU-only (8 WASM threads) takes a little longer than the song itself (a 2:27 song took about 3 minutes).
   Already have stems from another tool? Drop them together with the song, named `drums`, `bass`, `vocals`, `other`.
   More options build on the stems:
   - **High-quality vocals** (on by default when there's a GPU) runs a second, vocals-only model (Mel-Band RoFormer, 464 MB) for a much cleaner vocal stem, which improves every vocal track. The standard split can lose unusual voices entirely: in Portal 2's *Cara Mia Addio* it puts the opera singer in "other", leaving the vocal tracks empty. It needs a GPU: about 100 s for a 3-minute song on an RTX 3060.
   - **Separate lead and backing vocals** runs a karaoke model (BS-RoFormer, 210 MB, GPU only) that takes the lead singer out of the vocals. Syllables follow the lead where there is one, and harmonies, responses and "oohs" get **Backing vocals** (phrases) and **Backing vocal notes**. Where the model hears no lead (a group singing in unison, which it calls backing), the vocal tracks follow all the vocals.
   - **Precise vocal syllables and lyric timing** (on by default) runs a speech model (wav2vec2, 190 MB on GPUs with fp16 support, else 380 MB) that hears where each sung consonant and vowel starts. Without lyrics it gives the **Vocal syllables** track; with lyrics it aligns them letter by letter.
   - **Transcribe lyrics** runs Whisper (about 300 MB) when you haven't pasted the lyrics. Whisper supplies the words; their timing comes from the speech model. Misheard words can be fixed afterwards with **Lyrics…** in the editor, which re-aligns in a moment. Whisper only knows English here; on singing in other languages it writes nonsense, so paste the lyrics instead (its stock filler, like "Music." and "Thank you.", is dropped).
   Pasting the real lyrics (one line per lyric line, repeats included) on the start screen gives the best result: **Lyric lines**, **Lyric words**, labeled **Vocal syllables**, and a **Lyrics** track with three layers (phrases, words, and Preston Blair phonemes: AI, E, O, U, etc, L, WQ, MBP, FV), which xLights singing faces use directly.
   The start screen lists every option with its model size and whether it's already downloaded, and can download the models ahead of time (so the first song doesn't wait). While a song is processing, a status panel above the timeline lists each step, and the editor says when more tracks are still on the way.
   The vocal tracks: **Vocal phrases** (sung lines, broken at breaths), **Vocal syllables** (one mark per syllable, lasting while it's sung, touching the next in a smooth line), and **Vocal notes** (syllables split further where the singer moves to a new note, labeled with note names: what to follow for a melisma or an opera line). Note tracks come from Basic Pitch (bundled, 230 KB), decoded into one line per part; **Instrument melody** follows the line that stands out of the guitars, keys and strings.
   Tracks with no marks (Kick in a song without drums) are left out.
3. Play it back and watch the **light preview** (one light per track checked for export), or turn on 🎧 on a track to hear a click on every mark. Use M/S to mute or solo stems. Tune with the sliders if needed.
   To share a part between several props, select its track and set **Split into props**: *taking turns* (Beats alternate by beat number when the bars are regular, so beat 1 always lands on the same prop) or *by pitch* (note tracks: low notes on the first prop, high on the last). The export then has one track per prop, "Beats 1", "Beats 2", …. Note and syllable tracks can also **snap to beats** (off by default), for sequences drawn on the beat grid.
3. Download one `.xtiming` with all selected tracks, or a zip with one file per track.
4. In xLights, import it with **Import Timing Track**.

#### Browsers

Everything works in current Chrome, Edge and Firefox. GPU acceleration needs WebGPU: Chrome and Edge have it; Firefox on Linux doesn't ship it in stable releases yet, so there everything runs on the CPU (the app says so). The model downloads are cached by the browser, as are each song's stems and lyrics.

## Composer

Drop a song (plus, optionally, `xlights_rgbeffects.xml` and `.xtiming` files, or **Quick beats** for beats, bars, phrases and sections in seconds), then lay out effects on a timeline where everything snaps to the active timing track. Export a `.xsq`, open it in xLights, fine-tune and render.

Status (milestones from the composer spec):

- [x] **C0**: `.xsq` writer checked against a real xLights (2026.19): sequences open without warnings and render frame-exactly (`npm run tool:xlights`)
- [x] **R0**: repo split into apps and shared packages, one build with three pages
- [x] **C1**: start screen with layout and timing import, row list, timeline with timing lanes, drag/double-click/number-key creation with snapping, select/move/resize/duplicate/delete, fades, nudges, split/merge, copy/paste, inspector, unlimited undo/redo, autosave, `.xsq` export of nine curated effects, row-light preview
- [ ] **C2**: Paint mode, sections and apply-to-matching-sections, recipes, fill helpers, chase generator, mirror, palette editing
- [ ] **C3**: Record mode, bindings, Send to Composer from the timing app
- [ ] **C4**: `.xsq` import with opaque effects and round trips, virtual row mapping, project and recipe files
- [ ] **C5**: approximate pixel preview, keyboard remapping, tutorial

Effect settings (key names, value formats, defaults) come from xLights' own effect metadata (`packages/xlights/metadata/`, from xLights 2026.17), and the tests reproduce the settings strings and sequences of the fixtures byte for byte. Colors come from a color set (Basics, Christmas, Halloween, Patriotic, Valentine, Spring pastels; 6-10 colors each, editable per project): click a color to use it, Shift+click to add more for washes and chases. Single-color props (relay channels, single-color strings) only light up in white or their own color in xLights, so effects on them keep to colors they can show, and export warns about any that can't.

The fastest way to lay effects down: click a spot on a row, then press `D` to drop the brush on that beat (keep pressing to fill beat after beat), or a number key to drop a preset (`2` is Fade out: full brightness fading to zero over the effect). Set the brush up in the inspector (effect, brightness, fades, color) and press Shift+number to keep it on that key. Press `?` in the editor for every shortcut. Projects are saved in the browser (IndexedDB) after every change.

## Development

```sh
npm install
npm run dev        # dev server: / (landing), /timing/, /composer/
npm test           # unit tests + benchmark
npm run build      # static build in dist/ (all three pages)
```

`npm run tool:xlights` (with `XLIGHTS=/path/to/xLights.AppImage`) renders sequences the composer writes with a real, headless xLights and checks which channels light up on which frames. xLights runs sandboxed: temporary `HOME`, settings and show folder, so your own xLights setup is never touched.

### Fixtures and benchmark

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

#### Vocal timing benchmark (JamendoLyrics)

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

### Layout

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

## License

[AGPL-3.0](LICENSE). Third-party notices are in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES). Stemlight is not affiliated with the xLights project.
