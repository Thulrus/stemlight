# Stemlight

**Auto-timing tracks for xLights.** Drop in a song and get timing tracks to import into your xLights sequence: song structure (sections, phrases, bars, beats), per-instrument tracks from stem separation (vocal phrases and syllables, backing vocals, kick, snare, hats, bass notes, the lead melody of guitars and keys), and, with lyrics, words, labeled syllables and a phrases/words/phonemes track for singing faces.

Everything runs in your browser. There's no server and your audio never leaves your machine.

## Status

Milestones from [SPEC.md](SPEC.md):

- [x] **M0**: decode audio, onset and beat detection on the full mix, quantize to a 25/50 ms grid, `.xtiming` export
- [x] **M1** (mostly): timeline with waveform, bars/beats/sections with labels, audition clicks, per-track tuning on cached analysis
- [x] **M2**: stem separation (HTDemucs via ONNX Runtime Web, WebGPU or WASM), user-supplied stems, kick/snare/hats, bass notes, vocal phrases and syllables
- [x] Light preview: one blinking light per exported track, in sync with playback
- [x] Optional high-quality vocals (Mel-Band RoFormer) and lyrics (Whisper) for better vocal tracks
- [x] Vocal timing from a speech model: lyrics (pasted or transcribed) aligned letter by letter, syllables and phonemes, a three-layer Lyrics track for singing faces; lead/backing vocal separation
- [x] Note tracks: lead melody and note onsets of guitars/keys, the sung melody (Basic Pitch)
- [ ] **M3**: light editing, …
- [ ] **M4**: session save/load, presets

## Using it

1. Open the app and drop an audio file. Structure tracks appear in a couple of seconds.
2. With **Separate stems** on, the song is split into drums, bass, vocals and other in the background, and the instrument tracks are added when it's done. The model (~170 MB) downloads once and is cached, and the stems for each song are cached too. Measured on a desktop: with WebGPU (RTX 3060) a 1:43 song separates in about 25 s; CPU-only (8 WASM threads) takes a little longer than the song itself (a 2:27 song took about 3 minutes).
   Already have stems from another tool? Drop them together with the song, named `drums`, `bass`, `vocals`, `other`.
   More options build on the stems:
   - **High-quality vocals** runs a second, vocals-only model (Mel-Band RoFormer, 464 MB) for a much cleaner vocal stem, which mainly improves Vocal phrases. It needs a GPU: about 100 s for a 3-minute song on an RTX 3060.
   - **Separate lead and backing vocals** runs a karaoke model (BS-RoFormer, 210 MB, GPU only) that takes the lead singer out of the vocals. Syllables and lyrics follow the lead, and harmonies, responses and "oohs" get their own **Backing vocals** track.
   - **Precise vocal syllables and lyric timing** (on by default) runs a speech model (wav2vec2, 190 MB on GPUs with fp16 support, else 380 MB) that hears where each sung consonant and vowel starts. Without lyrics it gives the **Vocal syllables** track; with lyrics it aligns them letter by letter.
   - **Transcribe lyrics** runs Whisper (about 300 MB) when you haven't pasted the lyrics. Whisper supplies the words; their timing comes from the speech model. Misheard words can be fixed afterwards with **Lyrics…** in the editor, which re-aligns in a moment.
   Pasting the real lyrics (one line per lyric line, repeats included) on the start screen gives the best result: **Lyric lines**, **Lyric words**, labeled **Vocal syllables**, and a **Lyrics** track with three layers (phrases, words, and Preston Blair phonemes: AI, E, O, U, etc, L, WQ, MBP, FV), which xLights singing faces use directly.
   The start screen lists every option with its model size and whether it's already downloaded, and can download the models ahead of time (so the first song doesn't wait). While a song is processing, a status panel above the timeline lists each step, and the editor says when more tracks are still on the way.
   Every song also gets note tracks from Basic Pitch (bundled, 230 KB): **Lead melody** (the riff, solo or piano line standing out of the guitars and keys), **Other note onsets** (strums, stabs, chord changes) and **Vocal notes** (the sung melody), labeled with note names.
3. Play it back and watch the **light preview** (one light per track checked for export), or turn on 🎧 on a track to hear a click on every mark. Use M/S to mute or solo stems. Tune with the sliders if needed.
3. Download one `.xtiming` with all selected tracks, or a zip with one file per track.
4. In xLights, import it with **Import Timing Track**.

### Browsers

Everything works in current Chrome, Edge and Firefox. GPU acceleration needs WebGPU: Chrome and Edge have it; Firefox on Linux doesn't ship it in stable releases yet, so there everything runs on the CPU (the app says so). The model downloads are cached by the browser, as are each song's stems and lyrics.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests + benchmark
npm run build      # static build in dist/
```

### Fixtures and benchmark

`fixtures/` holds a sequence (`.xsq`), layout and an `.xtiming` exported by xLights 2026.17. The exporter is tested to reproduce that `.xtiming` byte for byte.

Benchmarks need copyrighted audio, which stays out of git in `fixtures/private/`:

- `tests/eval.test.ts` compares Bars/Beats/Sections with xLights' own, given the song in `fixtures/private/`.
- `tests/stems-eval.test.ts` compares the stem tracks with the hand-placed effects in the fixture sequence (pumpkins follow the vocals). It needs stems in `fixtures/private/stems/<song>/`, which `npm run tool:separate` creates from the songs in `example_data/` with the same separation code the browser runs, using `onnxruntime-node` and the model files in `fixtures/private/models/` (from https://huggingface.co/webnn/stem-separator).

- `tests/bench.test.ts` (`npm run bench`) scores the vocal and drum tracks against four hand-made sequences in `fixtures/` (pumpkins in *This Is Halloween*, the hand-typed lyric track in *Candy Girl*, circles in *Grim Grinning Ghosts* and the Marilyn Manson *This Is Halloween*). `VOCALS=vocals_hq npm run bench` uses the RoFormer vocals, which `npm run tool:vocals-hq` creates.
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
src/core       Track/Mark types, grid quantization, .xtiming parsing
src/dsp        FFT, spectral features, onsets, tempo, beat tracking, downbeats, structure
src/analysis   features -> Track builders (full mix and per stem), analysis worker
src/separation HTDemucs and RoFormer pipelines (vocals, lead/backing), separation worker
src/lyrics     Whisper transcription (vocal-aware windows), lyrics worker
src/align      lyrics → letters, CTC forced alignment, syllables and phonemes (CMUdict), greedy syllables
src/notes      Basic Pitch notes and the lead line
src/export     .xtiming and zip writers
src/audio      decoding, playback with stem mute/solo and audition clicks
src/storage    IndexedDB cache for the model and per-song stems
src/ui         timeline canvas, light preview and app shell
```

Everything downstream of analysis only knows `Track`s, so new extractors plug in without touching the editor or exporters.

## License

[AGPL-3.0](LICENSE). Third-party notices are in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES). Stemlight is not affiliated with the xLights project.
