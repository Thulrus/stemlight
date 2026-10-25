# Stemlight Composer Spec

Oct 24, 2026 · @Geoff

## Purpose and principles

Stemlight Composer is a browser app that turns a song, its timing tracks and an xLights layout into a sequence (`.xsq`) that opens in xLights. It covers the 80% of sequencing that is about *what happens when*, and leaves pixel-level polish, rendering and output to xLights.

**Guiding principle: compose fast here, finish in xLights.** Every feature is judged by whether it makes placing, timing and arranging effects faster. Anything that is mainly about how an effect looks at the pixel level stays in xLights.

### Goals

- Get from a dropped song to a full, watchable rough sequence in under 30 minutes for a typical 3-minute song on a typical porch layout.
- Make timing the default: every create and edit action snaps to timing marks unless the user opts out.
- Make repetition cheap: a chorus sequenced once can be applied to every chorus in one action.
- Produce `.xsq` files that open in current xLights with no warnings, and survive a round trip (export, edit in xLights, re-import) without losing xLights-side work.
- Stay fully client-side: static hosting on GitHub Pages, no accounts, audio never leaves the machine.
- Feel like a modern editor: keyboard-first, instant feedback, unlimited undo, autosave.

### Non-goals

- Replacing xLights. The composer never talks to controllers, never renders `.fseq`, and never edits the layout.
- Supporting every xLights effect or every effect parameter.
- Pixel-accurate preview. The preview shows timing and color, not exact effect rendering.
- Collaboration or cloud sync.

## Repo and hosting

The composer lives in the existing `Thulrus/stemlight` repo as a second app, sharing code with the timing app through npm workspaces, and deploys to the same GitHub Pages site.

### URLs

| Path | What it is |
| --- | --- |
| `/stemlight/` | Landing page: what Stemlight is, cards for each app, links to docs and the repo |
| `/stemlight/timing/` | The current timing-track app (moved from the root) |
| `/stemlight/composer/` | The sequence composer |

### Repo layout

```
packages/
  core/        Track/Mark types, grid quantization, .xtiming read/write (moved from src/core, src/export)
  audio/       decoding, playback, stem mute/solo, audition clicks (from src/audio)
  timeline/    timeline canvas, waveform, zoom/scroll, mark rendering (extracted from src/ui)
  storage/     IndexedDB wrapper with namespaced stores; shared model cache
  xlights/     NEW: layout parser, .xsq reader/writer, effect settings codec
apps/
  timing/      current Stemlight app (analysis, separation, lyrics, align, notes stay here)
  composer/    new app
  landing/     static landing page
```

### Build and deploy

- Vite multi-page build: one HTML entry per app under `build.rollupOptions.input`, `base: '/stemlight/'`. Each app gets its own bundle; the landing page pulls in no app code.
- Separate HTML pages, not a single-page router, so deep links work on Pages without 404 workarounds.
- The existing GitHub Actions workflow builds once and publishes `dist/`.
- If the timing app relies on a cross-origin-isolation service worker for threaded WASM, its scope must cover `/stemlight/` so both apps get it. The composer itself does not need threads in v1.
- Shared IndexedDB origin: database names are namespaced per app (`stemlight-timing`, `stemlight-composer`) plus one shared `stemlight-shared` database for the model cache and handoff records (see the handoff in the user flow section).

### Tech choices

- TypeScript, Vite, same lint/test setup as the timing app.
- UI framework: match whatever the timing app uses so the timeline package is shared without wrappers. The editor surface itself (timeline, rows, effects) is Canvas 2D, not DOM; panels, inspector and dialogs are regular DOM.
- State: a single project store with immutable updates and a command log (undo/redo, autosave, and future recording all go through commands).
- XML via `DOMParser`/`XMLSerializer`; zip via the library the timing app already uses.

## Core concepts and data model

A project is a song plus timing tracks plus rows plus effects; everything else (sections, bindings, recipes) is a way of creating or arranging effects faster.

| Concept | What it is | Maps to in xLights |
| --- | --- | --- |
| Project | One song's sequence-in-progress, autosaved locally | One `.xsq` |
| Timing track | Named list of marks (start, end, label), read-only in the composer except for labels and nudges | Timing element |
| Row | A target for effects: a model, group, submodel, or a virtual row not yet mapped to a model | Model / group / submodel element |
| Layer | Rows hold one or more layers; effects on a layer cannot overlap | Effect layer |
| Effect | Type, start, end, palette, parameters, on one row layer | Effect + EffectDB entry |
| Palette | Named set of up to 8 colors, shared across effects | Color palette string |
| Section | Labeled time span (Intro, Verse 1, Chorus 2), usually from Stemlight's Sections track | Timing track (exported as one) |
| Binding | Live link between a row and a timing track that generates effects per mark | Plain effects at export |
| Recipe | Saved arrangement of effects across rows over one section, reusable | Nothing (composer-only) |

### Data shapes (TypeScript sketch)

```ts
interface Project {
  id: string; name: string; version: number;
  audio: { fileName: string; hash: string; durationMs: number };   // audio blob cached in IndexedDB by hash
  frameMs: 25 | 50;                       // sequence timing; all times snap to this grid
  timingTracks: TimingTrack[];            // from .xtiming import or Stemlight handoff
  sections: Section[];
  rows: Row[];                            // display order = array order
  effects: Record<string, Effect>;
  palettes: Palette[];
  bindings: Binding[];
  recipes: Recipe[];
  layout?: LayoutSnapshot;                // parsed from xlights_rgbeffects.xml
  passthrough?: XsqPassthrough;           // unknown .xsq content kept verbatim for round trips
}

interface Row { id: string; name: string; kind: 'model'|'group'|'submodel'|'virtual';
  modelRef?: string; parentId?: string; layers: number; collapsed: boolean; height: number;
  color?: string; hidden: boolean }

interface Effect { id: string; rowId: string; layer: number; startMs: number; endMs: number;
  type: EffectType; params: Record<string, number|string|boolean>; paletteId: string;
  ramp?: { in: number; out: number };     // fade in/out ms, the one 'value curve' v1 supports
  source: 'manual'|'binding'|'recipe'|'imported'; bindingId?: string;
  raw?: string }                          // original xLights settings string for imported/unknown effects

interface Binding { id: string; rowId: string; trackId: string; effectTemplate: EffectTemplate;
  range?: [number, number]; mode: 'perMark'|'markToNext'|'hold' }
```

### Invariants

- All times are integer milliseconds on the `frameMs` grid. Snapping happens in commands, never in rendering.
- No overlaps within a layer. Moves that would overlap either push into a new layer (default) or trim neighbors (Alt).
- Every mutation is a command with an inverse; the project store is never mutated directly. This gives undo/redo, autosave diffs and recording replay for free.
- Bound effects are regenerated whenever the binding or its track changes, and are never edited in place. Editing one detaches it (it becomes `manual`), with a toast offering "Detach all".

## User flow: from song to editor

Setup is one screen with three drop zones, and only the song is required; a user can be in the editor with timing marks visible within seconds.

### Start screen

1. **Song** (required): drop an audio file. Decoding and the waveform start immediately.
2. **Layout** (optional): drop `xlights_rgbeffects.xml` from the show folder. The composer lists models, groups and submodels and remembers the layout for the next project. Skip it and the user works on virtual rows, mapped later.
3. **Timing** (optional, strongly suggested): one of
   - drop one or more `.xtiming` files;
   - drop an existing `.xsq` (its timing tracks, rows and effects are imported; this is also the round-trip entry point);
   - **Analyze with Stemlight**: opens the timing app in a new tab with the same song, and its results come back automatically (handoff below);
   - **Quick beats**: run the lightweight beat/bar/section analysis from the shared core in-page, no models, a few seconds.
4. **Open editor.** Recent projects are listed underneath, with song name, last edited time and a thumbnail of the timeline.

### Stemlight handoff

Both apps share an origin, so the handoff is local and needs no server:

1. The composer writes a handoff request (`{projectId, audioHash}`) to the shared IndexedDB database and opens `/stemlight/timing/?handoff=<id>`.
2. The timing app loads the cached audio by hash, runs as usual, and shows a **Send to Composer** button next to Download.
3. Clicking it writes the selected tracks into the handoff record. The composer listens on a `BroadcastChannel` and imports them, with a toast: "14 timing tracks added from Stemlight."
4. Re-sending later replaces tracks with the same name and leaves bindings pointing at them; bound effects regenerate.

### Typical session after setup

1. Glance at the Sections track and rename sections if needed.
2. Lay down a base: bind the whole-house group to the Beats track with a soft pulse, or paint a Color Wash per section.
3. Sequence the first chorus carefully: vocals on the singing faces, drums on the arches, melody on the mega-tree.
4. Save the chorus as a recipe and apply it to the other choruses.
5. Watch it in the preview, fix anything that looks off.
6. Export `.xsq`, open it in xLights, fine-tune effects and render.

## Editor page layout

The editor is one screen: a timeline in the middle that takes most of the space, a row list on its left, an inspector on its right, and an effect bar and preview that can be docked or hidden. Nothing important lives in a modal or a menu more than one level deep.

| Region | Position | Contents |
| --- | --- | --- |
| Top bar | Top, full width | Project name, transport (play/pause, position, loop toggle, playback speed 0.5x/0.75x/1x), mode switcher (Select / Paint / Record), snap selector, undo/redo, Export button |
| Timing lanes | Top of timeline, pinned while scrolling rows | Waveform, Sections lane (colored blocks), then each timing track as a thin lane; lanes can be reordered, hidden, and one is marked as the **active snap track** |
| Row list | Left, resizable | Tree of groups, models and submodels; per row: color dot, mute (hide from preview), lock, layer count, height drag handle; search box on top |
| Timeline | Center | Effect blocks on rows, playhead, selection, loop region, minimap of the whole song along the bottom edge |
| Inspector | Right, collapsible | Selected effect(s): type, palette, the 2-5 curated params, fade in/out, start/end/duration fields; with nothing selected it shows the row or project settings |
| Effect bar | Bottom, single strip | The curated effects as large buttons with icons and number-key hints (1-9), current palette swatches, recent effect presets |
| Preview | Floating or docked panel, resizable | 2D layout preview driven by playback (see the preview section) |

### Layout behaviors

- Every panel collapses with a key (Tab toggles side panels, P toggles preview) so the timeline can go full screen on a laptop.
- The playhead follows playback with page-flip scrolling by default; holding the mouse over the timeline pauses auto-scroll.
- Zoom is continuous: Ctrl+wheel or pinch, anchored at the cursor. Shortcut presets zoom to the selection, to the current section, or to the whole song.
- The Sections lane doubles as navigation: clicking a section jumps there, double-clicking zooms to fit it and sets it as the loop region.
- Row heights are per row and remembered; a "compact" toggle shrinks all rows to show a 40-model layout at once.
- Minimum supported width is 1280 px. Mobile is out of scope; tablets may work but aren't a target.
- Light and dark themes, dark by default (sequencing happens at night, and it matches xLights users' expectations).

## Creating effects

The composer offers six ways to create effects, from one at a time to whole sections at once; the faster ones are what make it feel effortless, and all of them snap to the active timing track by default.

The **current brush** (effect type + palette + params, picked from the effect bar with keys 1-9) is what every creation method uses, so the user rarely touches the inspector while creating.

### 1. Click and drag (Select mode)

- Double-click an empty spot on a row: fills the span between the surrounding marks of the active snap track with the current brush.
- Drag on an empty spot: creates one effect from drag start to drag end, both edges snapped.
- Press a number key with the playhead over a row and that row selected: drops the brush from the mark at the playhead to the next mark.

### 2. Paint along marks (Paint mode)

Dragging across one or more rows creates **one effect per mark interval** under the drag, like painting a stripe of beats. Modifiers change the pattern:

- plain drag: every interval;
- Shift: every other interval (alternating on/off);
- Alt: alternate between the selected rows as it goes (left-right chase across arches);
- Ctrl: one effect per interval but with gaps of a set fraction (staccato).

Dragging vertically across rows while moving in time creates a diagonal: a chase where each row starts one mark later. This is the single most common pattern in porch shows and should take one gesture.

### 3. Record mode (play and tap)

The user plays the song and performs the lighting on the keyboard:

1. Arm rows: each armed row gets a key (A, S, D, F, J, K, L, ; by default), shown on the row header.
2. Play (optionally at 0.5x or 0.75x). Pressing a key starts an effect on its row, releasing ends it.
3. On stop, the take is quantized to the active snap track (start and end to the nearest mark, with a strength slider from 0 to 100%) and shown as a ghost layer to accept, redo, or keep only part of.
4. Takes can loop over a region, with each pass on a new layer or replacing the last.

Recording removes the hardest part of sequencing by hand: deciding exactly when. Most people can tap along to a song better than they can place marks with a mouse.

### 4. Bindings (follow a track)

A row can follow a timing track: select row(s), pick a track and an effect template, and the composer generates an effect per mark (or mark-to-next, or held across each labeled span). Examples:

- pumpkin faces follow Vocal syllables;
- arches follow Kick with a short On + fade-out;
- the mega-tree follows Lead melody, with color picked from the mark's note name.

Bindings are live: regenerating Stemlight's tracks or tuning their thresholds updates the effects. A binding can be limited to a time range (only during choruses) and can be **materialized** into plain effects at any time. Bound effects are drawn with a dashed outline and a link icon.

### 5. Sections and repetition

- Select everything in a section with one click on the section block (all rows, or only selected rows).
- **Apply to matching sections**: copy the selection to every section with the same base label (Chorus 1 to Chorus 2 and 3), aligned by section start and stretched to each section's length. Stretching maps marks to marks where the target has the same number of bars, and scales proportionally otherwise.
- **Recipes**: save a section's arrangement as a named recipe (rows, relative timing, brushes) and apply it to any section, including in another project with a compatible layout (rows matched by name or group).

### 6. Fill helpers

- **Fill section**: the current brush across the selected rows for the whole section (base washes).
- **Fill gaps**: fill every empty span on the selected rows with the brush (no dark gaps).
- **Chase generator**: pick rows in order, a direction (forward, back, bounce, center-out, random), a track for step timing and overlap; generates the chase.
- **Mirror**: copy selected effects from one row set to its mirror (left house half to right half) using the row order or a saved mapping.

## Editing effects

Editing is direct manipulation on the timeline plus keyboard nudges, and every edit snaps to marks unless the user holds a modifier or switches snapping off.

### Snapping

- Snap modes in the top bar: **Marks** (active snap track, default), **Any track** (nearest mark on any visible lane), **Grid** (frame grid, or a beat subdivision), **Off**.
- Holding Shift while dragging temporarily disables snapping; the frame grid always applies.
- Snap targets light up as a vertical guide while dragging, with the target's track name and label.
- Effect edges also snap to other effects' edges on adjacent rows (magnetic edges), so stacked effects line up.

### Selecting

- Click selects, Shift+click adds, Ctrl+click toggles, rubber-band drag in empty space selects everything it touches.
- Click a section block: select all effects in that section (on selected rows if any, otherwise all).
- Select similar: same type, same palette, same row, or same binding (`Ctrl+Shift+A` opens the menu).
- Selection is shown on the timeline and in the preview (selected rows glow).

### Changing length and position

- Drag an edge to resize; drag the body to move; Alt+drag to duplicate.
- With several effects selected, dragging any edge resizes them all by the same amount; Ctrl+edge-drag **stretches** the whole selection proportionally (useful for retiming a phrase).
- Arrow keys nudge the selection to the previous/next mark; Shift+arrow nudges by one frame; `[` and `]` move only the start or end edge to the previous/next mark.
- **Extend to next mark / shrink to previous mark** with `E` / `Shift+E`, the fastest way to grow or shrink a segment while playing.
- **Ripple** (toggle, off by default): moving or resizing pushes later effects on the same row instead of overlapping.
- Overlaps resolve per the invariant: moving onto an occupied span puts the effect on a new layer; Alt trims the neighbor instead.

### Splitting, merging, gaps

- `S` splits selected effects at the playhead; Alt+click on an effect splits it at the click (snapped).
- `M` merges adjacent selected effects on a row into one (keeps the first one's settings).
- **Close gaps**: extend each selected effect to meet the next one. **Add gaps**: trim each effect's end by a set amount (staccato), handy for pulses.
- Splitting at marks: "Split at every mark" turns one long effect into a run of per-mark effects with the same settings.

### Across rows

- Copy/paste keeps relative timing and row offsets; paste goes to the playhead on the selected row.
- Drag effects up/down to move between rows; Ctrl+up/down moves the selection one row.
- Change type, palette or a parameter for the whole selection from the inspector; mixed values show as "mixed".
- Pressing a number key with effects selected swaps their type to that brush (keeping timing), and `C` applies the current palette.

### Safety

- Unlimited undo/redo within a session, persisted with the project (last 500 commands).
- Autosave to IndexedDB after every command (debounced 1 s); a project is never lost on tab close.
- Snapshots: a manual "Save version" plus an automatic one before every export and every recipe or section apply, listed in a history panel.
- Locked rows ignore every edit and creation.

## Rows and channels

Rows come from the user's xLights layout, but the composer never requires one: users can sequence on virtual rows and map them to real models at export, which also makes recipes and shared sequences portable between layouts.

### From a layout

- Parse `xlights_rgbeffects.xml`: models (name, display type, pixel count, position and size for the preview), model groups (members), submodels (name, parent), and faces/states definitions (names only, for the Faces effect).
- Default row order: groups first, then models in layout order, submodels nested under their parent and collapsed.
- The user picks which elements appear (a checklist with "all groups" / "all models" shortcuts) and can reorder and save the row set as a **view**. A small layout gets everything; a big one starts with groups only.
- Layout changes: re-dropping the file updates rows by name; renamed or deleted models are flagged, and their effects stay on an orphaned row until remapped.

### Virtual rows

- Add a row with just a name ("Left arches", "Big tree"), optionally a pixel-count hint and shape for the preview.
- At export, every virtual row must be mapped to a model or group (or skipped); the mapping dialog auto-matches by name and remembers mappings per layout.
- This is also how a sequence or recipe made by someone else gets onto your layout: their rows become virtual rows mapped to yours.

### Row operations

- Add/remove layers (shown as sub-lanes); collapse a row to show layers merged.
- Mute (hide from preview only), solo (preview only this row), lock (no edits).
- Row color for quick scanning; defaults from the model's type.
- Group vs member conflicts: effects on a group and on its member both export (xLights blends them by its own rules). The composer warns, non-blocking, when a member's own effect overlaps its group's effect, since that's often unintended.

### Number of rows

The UI should stay smooth at 200 rows and 20,000 effects on a mid-range laptop: canvas rendering of only visible rows, effects indexed per row by time (sorted arrays or an interval tree), and no per-effect DOM nodes.

## Effects and parameters

v1 ships a curated set of about ten xLights effects, each exposing two to five parameters; every other parameter is written at xLights' defaults and tuned in xLights if needed.

| Key | Effect | Composer params | Typical use |
| --- | --- | --- | --- |
| 1 | On | brightness, fade in/out | Pulses, accents, base fills |
| 2 | Color Wash | palette cycle speed, fade in/out | Section backgrounds |
| 3 | Twinkle | density, speed | Calm passages, sparkle |
| 4 | Shimmer | speed, duty | Cymbals, hats, tension |
| 5 | Bars | direction, count, speed | Builds, sweeps |
| 6 | Single Strand (chase) | direction, chase size, speed | Running lights, chases |
| 7 | Spirals | direction, count, rotation | Mega-tree motion |
| 8 | Butterfly | style, speed | Busy, energetic choruses |
| 9 | Faces | face definition, phoneme track | Singing faces from Stemlight's Lyrics track |
| 0 | Off | none | Explicit blackout |

The list is a starting point to validate against what porch sequencers actually use most; the effect registry makes adding one a single file (schema + settings codec + preview approximation).

### Effect registry

Each effect is defined once:

```ts
interface EffectDef { type: EffectType; label: string; icon: string;
  params: ParamDef[];                     // name, kind (slider/enum/bool), range, default, xLights key
  toSettings(e: Effect): string;          // composer params -> xLights settings string, defaults for the rest
  fromSettings(s: string): Partial<Effect> | null;  // parse imported settings; null = keep as raw passthrough
  preview(e: Effect, t: number, model: PreviewModel): PixelColors }
```

Settings keys and defaults are taken from the fixture `.xsq` exported by xLights 2026.17 and from effects created in xLights by hand for each type, never from memory. One golden file per effect type is checked in.

### Palettes

- Up to 8 colors per palette, matching xLights. Palettes are named, shared, and shown as swatches in the effect bar.
- Starter palettes for common show themes (Halloween orange/purple/green, Christmas red/green/white, warm white, rainbow).
- Changing a palette updates every effect using it; "duplicate palette" for a variant.
- Row-default palettes: a row can have a default palette the brush picks up when painting on it.

### Ramps (the only value curve in v1)

Fade in and fade out per effect, in ms, drawn as triangles on the effect block and draggable from its corners. Exported as xLights' brightness/transition settings. General value curves, effect transitions beyond fade, and blend modes between layers stay in xLights.

### Unknown and imported effects

Effects from an imported `.xsq` whose type isn't in the registry, or whose settings the codec can't fully parse, become **opaque effects**: shown with their xLights name, fully movable, resizable, copyable and deletable, exported with their original settings string unchanged. This is what makes round trips safe.

## Preview

The preview answers "does the timing and color work?", not "what exactly will each pixel do?"; it ships in two levels, and xLights stays the real renderer.

| Level | What it draws | When |
| --- | --- | --- |
| 1. Row lights | One light (or a box) per row, colored by the active effect's palette and brightness, with fades; laid out as a strip, or at layout positions when a layout is loaded | First editor milestone, reuses the timing app's light preview |
| 2. Approximate pixels | Each model drawn at its layout position and shape (line, arch, circle, matrix, tree as cone outline) with per-pixel color from each effect's `preview()` approximation: chases move, bars sweep, twinkles sparkle | After the effect registry |

### Rules

- Runs on a single WebGL or Canvas 2D surface at display rate, driven by the audio clock (the same clock as the timeline playhead).
- Approximations only need to be recognizable. Each effect's `preview()` is a few dozen lines, not a port of xLights' renderer, and the panel says "Approximate preview, render in xLights for the real thing."
- Opaque (unknown) effects preview as a flat palette fill with a hatch pattern.
- Hover a model in the preview to highlight its row, and click to select its row; selected rows glow in the preview.
- Scrubbing the playhead updates the preview without audio; playback at reduced speed keeps it in sync.
- Optional: a "house photo" background image the user can drop in and scale under the layout, since many layouts are traced over a photo anyway.

## File formats and storage

The composer reads and writes xLights' own files and keeps its richer project state in a separate project file, so nothing composer-specific ever has to be squeezed into the `.xsq`.

| File | Read | Write | Notes |
| --- | --- | --- | --- |
| Audio (mp3, wav, ogg, flac, m4a) | Yes | No | Cached by content hash in IndexedDB |
| `.xtiming` | Yes | Yes | Shared codec from `packages/core` (already byte-exact against the fixture) |
| `xlights_rgbeffects.xml` | Yes | No | Layout is never edited |
| `.xsq` | Yes | Yes | Main export; round-trip import |
| `.stemlight.json` (project) | Yes | Yes | Full project incl. bindings, recipes, sections; no audio |
| `.stemlight-recipe.json` | Yes | Yes | One recipe, shareable |

### `.xsq` export

The structure below is from memory and must be confirmed against the fixture `.xsq` (xLights 2026.17) before any code is written; the fixture wins wherever they differ.

- Root element with a head block: xLights version, author, song and media file name, sequence timing ("25 ms" or "50 ms"), duration.
- Color palettes table and an effect settings table (EffectDB); effects reference entries by index, so identical settings are deduplicated.
- Display elements: one per timing track and per row, in row order, with visibility and collapse state.
- Element effects: per element, one block per layer, each effect with type name, start/end ms, settings ref and palette ref. Timing tracks export their marks with labels.
- Bindings and recipes export as the plain effects they produce. Sections export as a "Sections" timing track.
- Media file path: the user picks whether to write just the file name (default, xLights resolves it in the show folder) or a path they type.
- Output is validated before download: no overlaps within a layer, all times on the frame grid, every referenced model present in the loaded layout (or a warning if no layout was loaded).

### Round trip

1. Import parses everything it understands and keeps the rest: unknown head fields, unknown elements, unknown effect types and unparsed settings go into `passthrough` and opaque effects.
2. On export, passthrough content is written back unchanged and in its original position where possible.
3. A round-trip test (import fixture, export, diff) must produce no semantic differences: same effects, timings, settings strings and palettes. Byte-identical is a nice-to-have, not required.
4. Re-importing a sequence that was exported by the composer and then edited in xLights relinks it to its project (by an ID stored in an xLights-ignored field, if one exists, otherwise by song + row names) and offers to merge: xLights-side effects become opaque or parsed effects, composer bindings and recipes are kept.

### Local storage

- IndexedDB `stemlight-composer`: projects, command history, snapshots, saved layouts, palettes, recipes.
- IndexedDB `stemlight-shared`: audio blobs by hash, handoff records, model cache (owned by the timing app).
- Storage use is shown in a settings panel with per-project delete; the app asks for persistent storage (`navigator.storage.persist()`) on first project save.
- Project export/import (`.stemlight.json`) is the backup story; there is no cloud.

## Scope split: composer vs xLights

The composer owns time, structure and repetition; xLights owns appearance, layout, rendering and hardware. The test for any proposed feature: does it change *when* or *where* something happens (composer), or *how it looks at the pixel level* (xLights)?

| Area | In the composer | Left to xLights | Why |
| --- | --- | --- | --- |
| Timing tracks | Import, display, snap, rename labels, nudge marks | Creating marks by hand, lyric phoneme editing | Stemlight generates them; the composer consumes them |
| Effect placement and timing | Everything: create, resize, move, split, chase, record, bind, repeat | Nothing | This is the composer's reason to exist |
| Effect types | \~10 curated | All others (60+), shaders, video, pictures, text, DMX, moving heads | Long tail, each needs its own UI; opaque effects keep them safe |
| Effect parameters | 2-5 per effect, fade in/out | Full parameter panels, value curves, buffer/render style, transforms, rotozoom | Pixel-level look; the deep end of xLights' UI |
| Layers | Multiple layers per row, no overlap within a layer | Layer blend modes, mix settings, morph | Blending is a look decision |
| Colors | Palettes up to 8 colors | Per-effect color curves, gradients, sparkles | Palettes cover most porch sequencing |
| Layout | Read-only import, virtual rows, row views | Building models, wiring, start channels, 3D layout, submodel/face creation | Layout work is done once per show, in xLights |
| Preview | Approximate, timing-first | Accurate render, house preview, 3D | Reimplementing the renderer is a project in itself |
| Output | `.xsq`, `.xtiming`, project files | `.fseq` render, controller upload, FPP sync, playlists, schedules | Hardware stays where it's tested |
| Song structure | Sections, apply-to-matching-sections, recipes | Nothing equivalent | Composer-only advantage |

### Deferred, possibly later

- More effects in the registry, driven by what users ask for.
- Simple value curves (ramp, sine) on one or two params.
- MIDI controller input for record mode (natural fit: pads per row, velocity to brightness).
- Auto-suggest: "sequence this section for me" from tracks plus a style (calm, energetic), always generating ordinary editable effects.
- Sharing recipes through a public gallery (would need hosting beyond Pages, so not in the no-backend version).

## Keyboard map

Everything common has a single key, chosen so the left hand stays on the keyboard and the right on the mouse; the full map is shown with `?` and is remappable.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Enter | Play from selection start |
| L | Toggle loop on current selection or section |
| 1-9, 0 | Pick brush (or swap selected effects' type) |
| V / B / R | Select mode / Paint mode / Record mode |
| Arrow left/right | Nudge selection to previous/next mark |
| Shift+arrow | Nudge by one frame |
| \[ / \] | Move start / end edge to previous/next mark |
| E / Shift+E | Extend to next mark / shrink to previous mark |
| S | Split at playhead |
| M | Merge adjacent selected effects |
| C | Apply current palette to selection |
| Delete | Delete selection |
| Ctrl+D | Duplicate selection to the next matching span |
| Ctrl+up/down | Move selection one row |
| Ctrl+Shift+A | Select similar |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Z / Shift+Z | Zoom to selection / zoom to whole song |
| Tab | Toggle side panels |
| P | Toggle preview |
| Ctrl+E | Export |
| ? | Show keyboard map |

In Record mode, the armed-row keys (A, S, D, F, J, K, L, ;) take over and the other single-key shortcuts are suspended until playback stops.

## Milestones, testing and open questions

The first milestone is a throwaway spike that proves xLights accepts a generated `.xsq`; nothing else gets built until that works.

### Milestones

1. **C0, spike (go/no-go).** From the fixture layout and an `.xtiming`, write a `.xsq` with one On effect per mark on one model. Open it in xLights 2026.17, render, play. Then export one hand-made example of each curated effect from xLights and record its settings strings as golden files.
2. **R0, repo restructure.** Workspaces, `packages/core`, `audio`, `timeline`, `storage`, `xlights`; timing app moved to `/timing/`; landing page; multi-page build; deploy. The timing app must behave identically (existing tests pass).
3. **C1, editor core.** Start screen, `.xtiming` and layout import, row list, timeline with timing lanes, click/drag creation with snapping, select/move/resize/delete, inspector, undo/redo, autosave, `.xsq` export with the On and Color Wash effects, row-light preview.
4. **C2, fast creation.** Effect bar and brushes, all curated effects, palettes, Paint mode with modifiers and diagonal chases, split/merge/extend keys, copy/paste, sections lane and apply-to-matching-sections, fill helpers, chase generator, mirror.
5. **C3, record and bind.** Record mode with quantize and takes, bindings with live regeneration, Stemlight handoff (Send to Composer).
6. **C4, round trip.** `.xsq` import with passthrough and opaque effects, relink and merge on re-import, virtual rows and mapping dialog, project and recipe files.
7. **C5, preview level 2 and polish.** Approximate pixel preview at layout positions, house photo background, keyboard remapping, performance pass at 200 rows / 20,000 effects, first-run tutorial using a bundled public-domain song.

### Testing

- **Golden files:** per effect type, composer output for a given effect must reproduce the settings string from the hand-made xLights golden file.
- **Round trip:** import every fixture `.xsq`, export, compare semantically (effects, times, settings, palettes). Runs in CI.
- **Commands:** property tests that every command's inverse restores the project exactly, and that no command sequence produces overlaps or off-grid times.
- **Manual xLights check per milestone:** open the exported fixture sequence in current xLights, render, confirm no warnings, and note the xLights version in the release notes.
- **Usability benchmark:** time to sequence the first chorus of *This Is Halloween* on the fixture layout, measured on each milestone. Target for C3: a complete rough chorus in under 10 minutes.

### Open questions

- Does xLights tolerate a `.xsq` with missing optional head fields, or must every field be present? (C0 answers this.)
- Is there a field in `.xsq` that xLights preserves but ignores, for storing a composer project ID? If not, relinking relies on song + row names.
- How does xLights resolve a media file name with no path: show folder only, or also the media folder setting?
- Which effects do porch sequencers use most? Worth a quick poll on the xLights forum or Facebook groups before finalizing the curated set.
- Should faces (singing pumpkins) get special treatment, such as auto-binding a face row to the Lyrics track on import, since it's the most-requested use of Stemlight's vocal tracks?
- Recipe portability: is name matching enough, or does it need a role system ("main tree", "arches", "faces") assigned per layout?
- Name for the composer on the landing page.

## Decisions made during implementation

Changes to this spec from building C0, R0 and C1 and using them; where they differ from the sections above, these win.

- **Overlaps overwrite.** Dropping, moving, resizing or pasting onto an occupied span overwrites what is there (trimming or splitting it); undo brings it back. Layers are only added on request (row inspector → Add layer), and dragging into a lane of a multi-layer row targets that layer. Automatically adding a layer on every overlap made rows grow unexpectedly.
- **Drag modes.** Dragging on empty space either box-selects (Select, the default; `V`) or draws an effect (Draw; `B`). Ctrl+drag box-selects in both. Clicking an empty spot selects the row and moves the playhead there.
- **Brush and presets.** The brush has fades and brightness. `D` drops it on the selected rows over the span around the playhead, then moves the playhead to the end of the drop so repeated presses fill beat after beat. Number keys are presets (2 = Fade out: On from 100% to 0%), dropped the same way or applied to selected effects; Shift+number saves the brush to a key.
- **Colors.** Instead of named palettes, a project uses one color set (Basics, Christmas, Halloween, Patriotic, Valentine, Spring pastels; 6-10 colors, editable). Effects store their own 1-8 colors. Single-color props only light up in white or their own color in xLights, so effects on them keep to colors they can show, and export warns otherwise.
- **Repo.** One `package.json` with path aliases (`@stemlight/*`) instead of npm workspaces; the landing page is `apps/index.html`. The timing app keeps its original IndexedDB database so downloaded models stay cached.
- **Effect settings** come from xLights' effect metadata (resources/effectmetadata, 2026.17), bundled in `packages/xlights/metadata/`, rather than hand-made golden files. `npm run tool:xlights` renders composer output with a headless, sandboxed xLights and checks the lit frames.
- **Snap "Grid"** is "½": the active track's marks and halfway between them.
