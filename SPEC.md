# Stemlight — Spec (v1)

Stemlight: auto-timing tracks for xLights. Splits a song into stems and structure, and produces timing tracks to import into xLights.

Public, open-source hobby project, licensed **AGPL-3.0**. Browser-only, hosted on GitHub Pages. No backend. Audio never leaves the user's machine.

Repo/Pages naming: use `stemlight` for the repo and Pages URL if available (check before creating). Don't put "xLights" in the project name; use it only in the tagline.

## 1. Goal

Take one audio file and produce **timing tracks** that match how a person would break the song apart: one track per instrument/voice, plus structure (sections, bars, beats). The user imports them into xLights and drops their own effects onto the marks.

**Explicitly out of scope for v1:** choosing effects, layout mapping, live preview, writing effects into sequences. The whole value of v1 is the quality of the timing tracks and the speed of getting them into xLights.

## 2. What the sample files tell us

(From `ThisIsHalloweenFilm.xsq` and `xlights_rgbeffects.xml`, xLights 2026.17. Treat them as fixtures in `/fixtures`.)

- Sequence timing is **50 ms**, and all marks in the file sit on a 50 ms grid (`FixedPointTiming="1"`). **Quantize every exported mark to 50 ms.** Make the grid configurable (25/50 ms).
- Timing tracks in an `.xsq` look like this, times in milliseconds:
  `<Element type="timing" name="Beats"><EffectLayer><Effect label="1" startTime="200" endTime="600" /></EffectLayer></Element>`
  and are also listed in `<DisplayElements>` with `type="timing"`.
- xLights' built-in analysis already gives **Bars, Beats (labeled 1-4) and Sections** (41 unlabeled sections in a 196 s song, which is over-segmented). So our baseline is: bars/beats at least as good, sections fewer and meaningful and labeled. The differentiator is **per-instrument tracks**, which xLights doesn't produce.
- How the user actually sequences, which tells us which tracks are valuable:
  - Relay channels (Circle-N, Single Line-N, single color) get long "On" blocks that follow sustained notes or instrument phrases, so we need **note/phrase spans with start and end**, not just hits.
  - Pixel pumpkins get many short "On" effects, 150-700 ms each, that look like **syllable/word timing** of the vocal.
  - Single Lines flash on beats in the intro, so we need **beat/hit events**.
  - RGB-Strip gets a new effect per section, so we need **section boundaries**.
- Layout has single-color relay models and pixel models side by side. Not needed in v1, but it shows the future mapping step must treat on/off-only models differently from pixel models.

## 3. Architecture

Vite + TypeScript, static build, deployed via GitHub Actions to Pages. Heavy work in Web Workers with progress reporting. State is one project JSON the user can save/reload.

Pipeline: `decode → (optional) stem separation → per-stem analysis → Track objects → editor → exporters`

**Track** is the core abstraction. Everything downstream (editor, export) only knows Tracks, so new extractors can be added without touching anything else.
```ts
type Mark = { start: number; end: number; label?: string; strength?: number }; // seconds
type Track = { id: string; name: string; source: string; marks: Mark[]; params: Record<string, number> };
```
Point events are marks with a short duration (e.g. one grid step). Spans are marks with real durations.

## 4. Stem separation

- Demucs (htdemucs: drums, bass, vocals, other) via onnxruntime-web, WebGPU with WASM fallback. Optional 6-stem variant (adds guitar, piano) as an "experimental" toggle.
- Model files are large and GitHub Pages files are capped at 100 MB, so host weights elsewhere (e.g. Hugging Face) if they exceed that, and cache in IndexedDB. **Verify the current ONNX export, size and license before committing to a source.**
- Must also accept **user-supplied stems** (drag in drums.wav, vocals.wav, etc.) so the separator is optional and people with better tools (or a GPU box) can use them.
- Show a progress bar; expect minutes on CPU. Cache results per file hash.

## 5. Track catalog

One track per musical part, with the mark type each produces. Sequencers follow a part (a singer, a backing group, an accompaniment figure) and snap effects to its marks, so span marks must have the right start **and** end: a note lasts as long as it sounds, and in a smooth line marks touch.

| Source | Tracks | Marks |
|---|---|---|
| Drums | Kick, Snare, Hats/cymbals (split by band after separation) | point |
| Bass | Bass notes | span (onset to offset) + pitch label |
| Vocals | Vocal phrases (runs of syllables and notes without a breath) | span |
| Vocals | Vocal syllables (speech model, or vocal attacks), held while sung | span |
| Vocals | Vocal notes: syllables split where the pitch moves to a new note | span + pitch label |
| Backing vocals (with lead separation) | Backing vocals (phrases), Backing vocal notes | span (+ pitch label) |
| Other (guitars, keys, strings) | Instrument melody: the line that stands out | span + pitch label |
| Full mix | Beats (labeled 1-4), Bars (numbered) | span |
| Full mix | Sections (labeled A/B/C... and a coarse "intro/verse/chorus" guess), plus a finer "phrases" level | span |

Any track can be split between several props on export, taking turns (Beats by beat number) or by pitch. Tracks with no marks are left out.

Quality is measured against hand-made sequences (tests/bench.test.ts), on start and end of each mark.

Each track has user-adjustable parameters (sensitivity/threshold, minimum gap, merge gap for spans, quantize grid) with a live re-run on the cached analysis, not a full reprocess.

Stretch for vocals: word-level timing via an in-browser Whisper (word timestamps) or forced alignment if the user pastes lyrics. Treat as v1.1, and note that Whisper word timestamps are approximate.

**Licensing (decided):** the project is AGPL-3.0, so Essentia.js (AGPL) is allowed for beat/onset/segmentation work. Basic Pitch is Apache-2.0 and Demucs is MIT, both compatible. Still verify the license of every dependency and model weight file before adding it, and include a THIRD_PARTY_LICENSES file plus an AGPL source-offer link in the app footer.

## 6. Export (the riskiest part: build against fixtures)

Do not guess formats. Ask the user to export a small timing track from xLights as a fixture, then match it exactly.

1. **`.xtiming` per track**, bundled as a zip, with a "download all" button. Use the xLights-exported fixture as the template.
2. **Timing-only `.xsq`** (head + DisplayElements + timing ElementEffects, using the structure in the fixture) so all tracks can be brought in at once via xLights' sequence import, if that works in practice. Test in xLights; if it doesn't import cleanly, drop it.
3. Later: an "On effects on chosen model" export. The fixture shows this needs an EffectDB entry, a palette entry, and per-model effect rows referencing them by index, which is simple but needs care.

Labels: beats 1-4 cycling and bars numbered, matching what xLights produces. Sections labeled (A, B, C...) instead of blank.

## 7. UI (v1)

1. Drop audio (and optionally stems). Options: separate stems yes/no, grid size.
2. Processing screen with progress.
3. **Multi-lane timeline**: waveform on top, one lane per track, zoom/scroll, play/pause with a moving cursor, mute/solo per stem.
4. **Audition**: play the original audio with a click/tick on a selected track's marks, so the user can hear whether the timing is right without opening xLights.
5. Per-track controls: sensitivity, min gap, merge gap, rename, delete, duplicate.
6. Light editing: drag mark edges, add/delete marks, snap to grid, nudge the whole track.
7. Export panel: pick tracks, pick format, download.

## 8. Milestones

- **M0 (one session):** decode audio, onset + beat detection on the full mix, quantize to grid, export one `.xtiming`, import into xLights. Proves the export path.
- **M1:** timeline viewer, bars/beats/sections with labels, audition clicks.
- **M2:** stem separation (and user-supplied stems), drum split into kick/snare/hat, bass and vocal phrase tracks.
- **M3:** note tracks for melodic stems, per-track parameter tuning, light editing, zip export.
- **M4:** vocal word timing, session save/load, polish, shareable presets.
- **Later:** layout import (`xlights_rgbeffects.xml`), recipes, model mapping, `.xsq` effect export, live preview.

## 9. Test plan

- Use `ThisIsHalloweenFilm.xsq` as ground truth: compare our Beats/Bars/Sections against xLights' own, and compare our vocal/instrument spans against the user's hand-placed "On" effects (e.g. Circle-N long blocks, Pumpkin short blocks). Report overlap/F-score so tuning is measurable.
- Add 3-5 more songs of different genres (the user supplies them) and keep expected-track screenshots.
- Always check imported results inside xLights, not just that the file parses.

## 10. Open questions for the user

- Which xLights versions must the export support (2026.17 only, or older)?
- Which songs should be the first benchmarks?
