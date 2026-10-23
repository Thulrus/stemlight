# Stemlight

**Auto-timing tracks for xLights.** Drop in a song and get timing tracks (sections, phrases, bars, beats, onsets, energy changes) to import into your xLights sequence. Per-instrument tracks from stem separation are next.

Everything runs in your browser. There's no server and your audio never leaves your machine.

## Status

Milestones from [SPEC.md](SPEC.md):

- [x] **M0**: decode audio, onset and beat detection on the full mix, quantize to a 25/50 ms grid, `.xtiming` export
- [x] **M1** (mostly): timeline with waveform, bars/beats/sections with labels, audition clicks, per-track tuning on cached analysis
- [ ] **M2**: stem separation (Demucs) and user-supplied stems, kick/snare/hat, bass and vocal phrase tracks
- [ ] **M3**: note tracks, light editing, …
- [ ] **M4**: vocal word timing, session save/load, presets

## Using it

1. Open the app and drop an audio file.
2. Play it back and turn on 🎧 on a track to hear a click on every mark. Tune with the sliders if needed.
3. Download one `.xtiming` with all selected tracks, or a zip with one file per track.
4. In xLights, import it with **Import Timing Track**.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests + benchmark
npm run build      # static build in dist/
```

### Fixtures and benchmark

`fixtures/` holds a sequence (`.xsq`), layout and an `.xtiming` exported by xLights 2026.17. The exporter is tested to reproduce that `.xtiming` byte for byte.

To run the benchmark against xLights' own Bars/Beats/Sections, put the matching song in `fixtures/private/` (gitignored, never committed) and run:

```sh
npx vitest run tests/eval.test.ts --disableConsoleIntercept
```

### Layout

```
src/core       Track/Mark types, grid quantization, .xtiming parsing
src/dsp        FFT, spectral features, onsets, tempo, beat tracking, downbeats, structure
src/analysis   features -> Track builders, Web Worker
src/export     .xtiming and zip writers
src/audio      decoding, playback with audition clicks
src/ui         timeline canvas and app shell
```

Everything downstream of analysis only knows `Track`s, so new extractors plug in without touching the editor or exporters.

## License

[AGPL-3.0](LICENSE). Third-party notices are in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES). Stemlight is not affiliated with the xLights project.
