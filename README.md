# Stemlight

**Auto-timing tracks for xLights.** Drop in a song and get timing tracks to import into your xLights sequence: song structure (sections, phrases, bars, beats), per-instrument tracks from stem separation (vocal phrases and syllables, kick, snare, hats, bass notes, accents), and optionally lyric lines and words labeled with what's sung.

Everything runs in your browser. There's no server and your audio never leaves your machine.

## Status

Milestones from [SPEC.md](SPEC.md):

- [x] **M0**: decode audio, onset and beat detection on the full mix, quantize to a 25/50 ms grid, `.xtiming` export
- [x] **M1** (mostly): timeline with waveform, bars/beats/sections with labels, audition clicks, per-track tuning on cached analysis
- [x] **M2**: stem separation (HTDemucs via ONNX Runtime Web, WebGPU or WASM), user-supplied stems, kick/snare/hats, bass notes, vocal phrases and syllables
- [x] Light preview: one blinking light per exported track, in sync with playback
- [x] Optional high-quality vocals (Mel-Band RoFormer) and lyrics (Whisper) for better vocal tracks
- [ ] **M3**: note tracks, light editing, …
- [ ] **M4**: vocal word timing, session save/load, presets

## Using it

1. Open the app and drop an audio file. Structure tracks appear in a couple of seconds.
2. With **Separate stems** on, the song is split into drums, bass, vocals and other in the background, and the instrument tracks are added when it's done. The model (~170 MB) downloads once and is cached, and the stems for each song are cached too. Measured on a desktop: with WebGPU (RTX 3060) a 1:43 song separates in about 25 s; CPU-only (8 WASM threads) takes a little longer than the song itself (a 2:27 song took about 3 minutes).
   Already have stems from another tool? Drop them together with the song, named `drums`, `bass`, `vocals`, `other`.
   Two more options build on the stems:
   - **High-quality vocals** runs a second, vocals-only model (Mel-Band RoFormer, 464 MB) for a much cleaner vocal stem, which mainly improves Vocal phrases. It needs a GPU: about 100 s for a 3-minute song on an RTX 3060.
   - **Transcribe lyrics** runs Whisper (about 300 MB) on the vocals and adds **Lyric lines** and **Lyric words** tracks labeled with the words. Timing comes from the vocal tracks; Whisper only supplies the text, so expect a few misheard words. About a minute for a 3-minute song on a GPU.
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

```sh
npm run eval                      # Bars/Beats/Sections vs xLights
npm run bench                     # stem tracks vs hand-made sequences
```

### Layout

```
src/core       Track/Mark types, grid quantization, .xtiming parsing
src/dsp        FFT, spectral features, onsets, tempo, beat tracking, downbeats, structure
src/analysis   features -> Track builders (full mix and per stem), analysis worker
src/separation HTDemucs and Mel-Band RoFormer pipelines, separation worker
src/lyrics     Whisper transcription (vocal-aware windows), lyrics worker
src/export     .xtiming and zip writers
src/audio      decoding, playback with stem mute/solo and audition clicks
src/storage    IndexedDB cache for the model and per-song stems
src/ui         timeline canvas, light preview and app shell
```

Everything downstream of analysis only knows `Track`s, so new extractors plug in without touching the editor or exporters.

## License

[AGPL-3.0](LICENSE). Third-party notices are in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES). Stemlight is not affiliated with the xLights project.
