import { DEFAULT_BUILD_PARAMS } from '../analysis/build';
import type { AllParams, FromWorker, StemAudio, ToWorker } from '../analysis/protocol';
import type { PitchSource } from '../analysis/build';
import { computePeaks, decodeFile, decodeMono, resample, stemFromFileName, toStereo } from '@stemlight/audio/decode';
import { Player } from '@stemlight/audio/player';
import { quantizeMarks, type MsMark } from '@stemlight/core/quantize';
import type { GridMs, Track } from '@stemlight/core/types';
import { ANALYSIS_SR } from '../dsp/features';
import { fileSafeName, toXTiming } from '@stemlight/core/xtiming';
import { channelOf, hasPitch, splitTrack, type Split } from '@stemlight/core/split';
import { SAMPLE_RATE as SEPARATOR_SR, STEM_NAMES, type StemName } from '../separation/htdemucs';
import type { FromSeparator, ToSeparator } from '../separation/protocol';
import { hashBytes, idbDelete, idbGet, idbKeys, idbPut } from '@stemlight/storage/idb';
import type { AsrWord } from '../analysis/lyrics';
import { WHISPER_BYTES, type FromLyrics, type ToLyrics } from '../lyrics/protocol';
import { tracksToZip } from '@stemlight/core/zip';
import { gunzipSync, strFromU8 } from 'fflate';
import type { WordHint } from '../align/align';
import type { Emissions } from '../align/ctc';
import { parseLyrics, type LyricWord } from '../align/text';
import { wordsFromAsr } from '../analysis/lyricTracks';
import { W2V_SR } from '../align/acoustic';
import { LightPreview } from '@stemlight/timeline/lights';
import { formatTime, LANE_H, RULER_H, Timeline, WAVE_H } from '@stemlight/timeline/timeline';
import { cachedModels, detectGpu, Downloader, formatMB, modelBytes, MODELS, removeModels, type Gpu, type ModelId, type OptionKey } from './models';

const toInt16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
const fromInt16 = (x: Int16Array) => Float32Array.from(x, (v) => v / 32767);
/** Lyric words back to text, one lyric line per line (for editing Whisper's transcript). */
const lyricLines = (words: LyricWord[]) =>
  words.reduce<string[][]>((lines, w) => ((lines[w.line] ??= []).push(w.text), lines), []).filter(Boolean).map((l) => l.join(' ')).join('\n');
/** " · about 40 s left" once a rate is known. */
function eta(since: number, done: number, total: number) {
  if (!done) return '';
  const left = Math.ceil((((performance.now() - since) / done) * (total - done)) / 1000);
  return ` · about ${left >= 90 ? `${Math.round(left / 60)} min` : `${left} s`} left`;
}
/** Saved per-song results (stems, vocals, lyrics, vocal timing); models are stored as "model:…". */
const songCacheKeys = async () => (await idbKeys()).filter((k) => !k.startsWith('model:'));
const defaultParams = (): AllParams => structuredClone(DEFAULT_BUILD_PARAMS);
const STEM_LABEL: Record<StemName, string> = { drums: 'Drums', bass: 'Bass', vocals: 'Vocals', other: 'Other' };
/** Bump a kind's version when its output changes, so stale cached results aren't reused. */
/** Step detail for a result loaded from an earlier run of the same song. */
const REUSED = 'reused from an earlier run';
const CACHE_VERSION = { stems: 1, 'vocals-hq': 1, lead: 1, lyrics: 2, emissions: 2 } as const;

/** Which parameter groups feed each generated track (shown in this order in the inspector). */
const PARAM_GROUPS: Record<string, (keyof AllParams)[]> = {
  'mix-beats': ['beats'], 'mix-bars': ['beats'], 'mix-sections': ['sections'], 'mix-phrases': ['phrases'],
  'drums-kick': ['kick'], 'drums-snare': ['snare'], 'drums-hats': ['hats'], 'bass-notes': ['bassNotes', 'snap'],
  'vocals-phrases': ['vocals'], 'vocals-syllables': ['vocals', 'snap'], 'vocals-notes': ['melody', 'vocals', 'snap'],
  'vocals-backing': ['vocals', 'melody'], 'vocals-backing-notes': ['melody', 'snap'], 'other-melody': ['melody', 'snap'],
  'vocals-lyric-lines': ['lyrics'], 'vocals-lyric-words': ['lyrics', 'snap'], 'vocals-lyric-syllables': ['lyrics', 'snap'], 'vocals-lyrics': ['lyrics'],
};
/** Inspector headings for groups shared by several tracks. */
const GROUP_TITLE: Partial<Record<keyof AllParams, string>> = {
  vocals: 'Singing (shared by the vocal tracks)',
  melody: 'Notes (shared by the note tracks)',
  snap: 'Snap to beats (shared)',
  lyrics: 'Lyric timing (shared)',
  beats: 'Beats and Bars',
};

type Range = { label: string; min: number; max: number; step: number; hint: string };
const sensitivity = (hint: string): Range => ({ label: 'Sensitivity', min: 0, max: 1, step: 0.05, hint });
const minGap: Range = { label: 'Min gap (s)', min: 0.03, max: 0.5, step: 0.01, hint: 'Hits closer than this are merged.' };
const PARAM_RANGES: Record<keyof AllParams, Record<string, Range>> = {
  kick: { sensitivity: sensitivity('Higher finds softer kicks.'), minGap },
  snare: { sensitivity: sensitivity('Higher finds softer snare hits and ghost notes.'), minGap },
  hats: { sensitivity: sensitivity('Higher finds softer hats and cymbals.'), minGap },
  bassNotes: {
    thresholdDb: { label: 'Range (dB)', min: 10, max: 50, step: 1, hint: 'How far below the loudest bass a note may be and still count.' },
    minNote: { label: 'Shortest note (s)', min: 0.03, max: 0.5, step: 0.01, hint: 'Shorter notes are dropped.' },
    mergeGap: { label: 'Join gap (s)', min: 0, max: 0.3, step: 0.01, hint: 'Gaps shorter than this between notes are closed.' },
  },
  vocalPhrases: {
    thresholdDb: { label: 'Range (dB)', min: 6, max: 40, step: 1, hint: 'Higher counts quieter singing as part of a phrase.' },
    mergeGap: { label: 'Breath gap (s)', min: 0.05, max: 1.5, step: 0.05, hint: 'Pauses shorter than this don’t end a phrase.' },
    minDur: { label: 'Shortest phrase (s)', min: 0.1, max: 3, step: 0.05, hint: 'Shorter phrases are dropped.' },
  },
  vocals: {
    rangeDb: { label: 'Range (dB)', min: 10, max: 45, step: 1, hint: 'How far below the loudest singing a voice still counts; higher catches quieter singing (and more bleed).' },
    decayDb: { label: 'Release (dB)', min: 6, max: 30, step: 1, hint: 'A syllable ends when the voice fades this far below its peak; higher holds longer.' },
    legato: { label: 'Join gap (s)', min: 0, max: 0.6, step: 0.01, hint: 'Gaps shorter than this between syllables or notes are closed, so a smooth line reads as touching marks.' },
    minDur: { label: 'Shortest (s)', min: 0.03, max: 0.4, step: 0.01, hint: 'Syllables and notes shorter than this are merged into their neighbours.' },
    breath: { label: 'Phrase break (s)', min: 0.1, max: 2, step: 0.05, hint: 'A pause in the singing at least this long ends a phrase.' },
    maxHold: { label: 'Longest hold (s)', min: 0.5, max: 8, step: 0.1, hint: 'How long a syllable may last when nothing follows it.' },
  },
  melody: {
    voicing: { label: 'Note threshold', min: 0.1, max: 0.8, step: 0.05, hint: 'How sure the note model must be that a note sounds; lower finds quieter notes (and more stray ones).' },
    changeCost: { label: 'Steadiness', min: 0, max: 10, step: 0.5, hint: 'Higher ignores vibrato, slides and blips; lower follows every change of note.' },
    minNote: { label: 'Shortest note (s)', min: 0.03, max: 0.4, step: 0.01, hint: 'Shorter pitch changes stay part of the note around them.' },
    reattack: { label: 'Re-sung note', min: 0.3, max: 1, step: 0.05, hint: 'Lower splits a held pitch more readily where it is sung or played again.' },
    legato: { label: 'Join gap (s)', min: 0, max: 0.6, step: 0.01, hint: 'Gaps shorter than this between notes are closed.' },
  },
  snap: {
    division: { label: 'Grid (steps per beat)', min: 0, max: 4, step: 1, hint: '0 = off. 1 snaps to beats, 2 to half beats, 4 to quarter beats.' },
    tolerance: { label: 'Snap distance (s)', min: 0.02, max: 0.2, step: 0.01, hint: 'Only marks this close to a grid line move onto it.' },
  },
  lyrics: {
    offsetMs: { label: 'Offset (ms)', min: -200, max: 200, step: 10, hint: 'Shifts every word, syllable and phoneme start earlier (−) or later (+).' },
    decayDb: { label: 'Release (dB)', min: 6, max: 30, step: 1, hint: 'A held word ends when the voice fades this far below its peak; higher holds longer.' },
    maxHold: { label: 'Longest hold (s)', min: 0.2, max: 5, step: 0.1, hint: 'How long a word may be held after its last letter.' },
  },
  beats: {
    priorBpm: { label: 'Tempo guess (BPM)', min: 60, max: 200, step: 1, hint: 'Biases the tempo search; change it if beats are double or half speed.' },
    tightness: { label: 'Tightness', min: 20, max: 400, step: 10, hint: 'Higher keeps beats evenly spaced; lower follows the music more loosely.' },
  },
  sections: {
    sensitivity: { label: 'Sensitivity', min: 0, max: 1, step: 0.05, hint: 'Higher splits the song into more sections.' },
    minBars: { label: 'Min length (bars)', min: 2, max: 16, step: 1, hint: 'Shortest allowed section.' },
    similarity: { label: 'Repeat threshold', min: 0.3, max: 0.95, step: 0.05, hint: 'How alike two sections must be to share a letter.' },
  },
  phrases: {
    sensitivity: { label: 'Sensitivity', min: 0, max: 1, step: 0.05, hint: 'Higher finds more phrase breaks.' },
    minBars: { label: 'Min length (bars)', min: 1, max: 8, step: 1, hint: 'Shortest allowed phrase.' },
  },
};

/** A stage of processing a song, shown in the status panel. */
type StepId = 'mix' | 'stems' | 'notes' | 'hq' | 'lead' | 'lyrics' | 'align' | 'tracks';
type Step = { id: StepId; label: string; state: 'pending' | 'active' | 'done' | 'skipped' | 'failed'; detail?: string; note?: string; fraction?: number };

type TrackState = {
  track: Track; include: boolean; nudgeMs: number; hue: number; userName?: string;
  /** Exported as several tracks, one per prop sharing the part (see core/split). */
  split?: Split;
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...children);
  return e;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class App {
  private readonly player = new Player();
  private worker?: Worker;
  private timeline!: Timeline;
  private lights!: LightPreview;
  private tracks: TrackState[] = [];
  private deleted = new Set<string>();
  private params: AllParams = defaultParams();
  private separator?: Worker;
  private lyricsWorker?: Worker;
  private separating = false;
  /** Messages sent to the analysis worker whose results haven't come back yet. */
  private pendingAnalysis = 0;
  /** The current song's processing steps, for the status panel. */
  private steps: Step[] = [];
  private statusOpen = false;
  private statusDismissed = false;
  private readonly downloader = new Downloader();
  /** The files of the current song, for re-running it. */
  private lastFiles: File[] = [];
  /** The lyrics came from the user (pasted or edited), not from Whisper. */
  private lyricsFromUser = false;
  /** Songs with results saved in this browser (by file hash). */
  private savedSongs = 0;
  /** WebGPU support, once detected (until then everything counts as available). */
  private gpu?: Gpu;
  private cached = new Set<ModelId>();
  private options = Object.fromEntries(MODELS.map((m) => [m.option, m.defaultOn])) as Record<OptionKey, boolean>;
  private fileHash = '';
  private loadId = 0;
  private wantStems = true;
  private gridMs: GridMs = 50;
  private selectedId?: string;
  private auditionId?: string;
  private fileName = '';
  private duration = 0;
  private hueSeed = 0;
  private rerunTimer?: number;
  /** The aligner's output for this song's (best) vocals, kept so edited lyrics re-align instantly. */
  private emissions?: Emissions;
  /** The lyrics last aligned, as text (pasted, or Whisper's transcript one line per lyric line). */
  private lyricsText = '';
  private pronSent = false;
  /** The vocals lyrics align to: all vocals, plus the lead alone when separated. */
  private alignSources: { audio: Float32Array; variant: string }[] = [];
  /** The lead vocal's emissions, fused with the full vocals' (see fuseEmissions). */
  private leadEmissions?: Emissions;

  mount() {
    this.timeline = new Timeline($('#lane-canvas'));
    this.lights = new LightPreview($('#lights'));
    const panel = $<HTMLDetailsElement>('#lights-panel');
    try { panel.open = localStorage.getItem('stemlight.lights') !== '0'; } catch { /* storage blocked */ }
    panel.addEventListener('toggle', () => { try { localStorage.setItem('stemlight.lights', panel.open ? '1' : '0'); } catch { /* ignore */ } });
    this.timeline.onSeek = (t) => { this.player.seek(t); this.timeline.cursor = t; this.timeline.render(); this.updateTime(); };
    this.player.onEnded = () => this.updatePlayButton();

    this.bindDrop();
    this.bindToolbar();
    $<HTMLSelectElement>('#grid').addEventListener('change', (e) => this.setGrid(Number((e.target as HTMLSelectElement).value) as GridMs));
    $<HTMLSelectElement>('#grid-start').addEventListener('change', (e) => this.setGrid(Number((e.target as HTMLSelectElement).value) as GridMs));
    $('#export-xtiming').addEventListener('click', () => this.exportCombined());
    $('#export-zip').addEventListener('click', () => this.exportZip());
    $('#new-file').addEventListener('click', () => {
      if (this.separating && !confirm('This song is still being processed. Stop and start a new song?')) return;
      this.cancelSeparation();
      this.endSteps('Cancelled');
      this.show('drop');
    });
    $('#stem-cancel').addEventListener('click', () => this.cancelSeparation());
    $('#rerun').addEventListener('click', () => void this.rerunFresh());
    $('#status-rerun').addEventListener('click', () => void this.rerunFresh());
    $('#edit-lyrics').addEventListener('click', () => this.openLyricsDialog());
    $<HTMLDialogElement>('#lyrics-dialog').addEventListener('close', () => {
      const dlg = $<HTMLDialogElement>('#lyrics-dialog');
      if (dlg.returnValue === 'align') void this.realign($<HTMLTextAreaElement>('#lyrics-edit').value);
    });
    $('#status-toggle').addEventListener('click', () => { this.statusOpen = !this.statusOpen; this.renderStatus(); });
    $('#status-dismiss').addEventListener('click', () => { this.statusDismissed = true; this.renderStatus(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.renderStatus(); });
    window.addEventListener('beforeunload', (e) => {
      // Leaving mid-way loses the work (and a half-finished download).
      if (this.separating || this.downloader.busy) e.preventDefault();
    });
    this.bindModels();
    this.tick();
  }

  // ---- screens ---------------------------------------------------------------

  private show(screen: 'drop' | 'progress' | 'editor') {
    for (const s of ['drop', 'progress', 'editor']) $(`#screen-${s}`).hidden = s !== screen;
    if (screen !== 'editor') this.player.pause();
    if (screen === 'editor') this.timeline.render();
    if (screen === 'drop') void this.refreshModels();
  }

  // ---- processing options and models -------------------------------------------------

  /** Whether an option is on (GPU-only options are off without a GPU). */
  private optOn(key: OptionKey) {
    const m = MODELS.find((x) => x.option === key)!;
    return this.options[key] && !(m.gpuOnly && this.gpu && !this.gpu.gpu);
  }

  private bindModels() {
    for (const m of MODELS) {
      try { const v = localStorage.getItem(`stemlight.${m.option}`); if (v !== null) this.options[m.option] = v === '1'; } catch { /* storage blocked */ }
    }
    this.downloader.onChange = () => {
      // A model finished (or the queue stopped): look again at what's stored.
      if (this.downloader.current?.id !== this.lastDownload) void this.refreshModels();
      else this.renderModels();
      this.lastDownload = this.downloader.current?.id;
    };
    $('#models-download').addEventListener('click', () => {
      void this.downloader.download(MODELS.filter((m) => this.optOn(m.option) && !this.cached.has(m.id)).map((m) => m.id));
    });
    $('#models-stop').addEventListener('click', () => this.downloader.stop());
    $('#songs-clear').addEventListener('click', async () => {
      if (!confirm('Clear the stems, vocals and lyrics saved for every song? Songs will be fully processed again next time.')) return;
      for (const k of await songCacheKeys()) await idbDelete(k);
      void this.refreshModels();
    });
    $('#models-remove').addEventListener('click', async () => {
      if (!confirm('Remove the downloaded models from this browser? They’ll download again when a song needs them.')) return;
      await removeModels();
      void this.refreshModels();
    });
    this.renderModels();
    void detectGpu().then((g) => { this.gpu = g; void this.refreshModels(); });
  }

  private lastDownload?: ModelId;

  private async refreshModels() {
    if (!this.gpu) return this.renderModels();
    this.cached = await cachedModels(this.gpu);
    this.savedSongs = new Set((await songCacheKeys()).map((k) => k.split(':')[2])).size;
    this.renderModels();
  }

  /**
   * Process the current song again from scratch: forget its saved stems, vocals, lyrics and
   * vocal timing, then load it as if new (with the current options).
   */
  private async rerunFresh() {
    if (!this.lastFiles.length) return;
    const msg = this.separating
      ? 'This song is still being processed. Stop and start over from scratch?'
      : 'Process this song again from scratch? Results saved from earlier runs (stems, vocals, lyrics) are discarded, and track edits (names, nudges, slider settings) are reset.';
    if (!confirm(msg)) return;
    this.cancelSeparation();
    const hash = this.fileHash;
    for (const k of await songCacheKeys()) if (k.split(':')[2] === hash) await idbDelete(k);
    // Keep lyrics the user typed; a Whisper transcript is made again.
    $<HTMLTextAreaElement>('#lyrics-text').value = this.lyricsFromUser ? this.lyricsText : '';
    void this.load(this.lastFiles);
  }

  /** The model list on the start screen: what each option needs, and whether it's here yet. */
  private renderModels() {
    const g = this.gpu;
    const sizeOf = (id: ModelId) => modelBytes(id, g ?? { gpu: true, f16: true });
    const dl = this.downloader;
    const rows = MODELS.map((m) => {
      const noGpu = !!g && m.gpuOnly && !g.gpu;
      const box = el('input', { type: 'checkbox', id: `opt-${m.option}`, checked: this.options[m.option] && !noGpu });
      box.disabled = noGpu || (m.sub && !this.options.separate);
      box.addEventListener('change', () => {
        this.options[m.option] = box.checked;
        try { localStorage.setItem(`stemlight.${m.option}`, box.checked ? '1' : '0'); } catch { /* ignore */ }
        this.renderModels();
      });
      const tags: string[] = [];
      if (m.gpuOnly) tags.push(noGpu ? 'Needs a GPU, none found' : 'Needs a GPU');
      else if (m.gpuPreferred && g && !g.gpu) tags.push('Slow without a GPU');

      let status: HTMLElement;
      if (noGpu) status = el('span', { class: 'model-chip off' }, 'Unavailable');
      else if (this.cached.has(m.id)) status = el('span', { class: 'model-chip ok' }, '✓ Downloaded');
      else if (dl.current?.id === m.id) {
        const pct = dl.current.total ? Math.min(1, dl.current.loaded / dl.current.total) : 0;
        status = el('span', { class: 'model-chip busy' },
          Object.assign(el('progress', { max: 1 }), { value: pct }),
          `${Math.round(pct * 100)}%`);
      } else if (dl.queued(m.id)) status = el('span', { class: 'model-chip' }, 'Queued');
      else {
        status = el('button', { class: 'btn small', type: 'button' }, 'Download');
        status.setAttribute('aria-label', `Download the ${m.model} model (${formatMB(sizeOf(m.id))})`);
        status.addEventListener('click', () => void dl.download([m.id]));
      }
      return el('li', { class: `model-row${m.sub ? ' sub' : ''}${box.disabled ? ' disabled' : ''}` },
        el('label', { class: 'model-main', htmlFor: box.id },
          box,
          el('span', { class: 'model-text' },
            el('span', { class: 'model-title' }, m.title, ...tags.map((t) => el('span', { class: 'model-tag' }, t))),
            el('span', { class: 'muted small' }, m.desc),
          ),
        ),
        el('span', { class: 'model-meta' },
          el('span', { class: 'model-size small muted', title: `${m.model} model` }, formatMB(sizeOf(m.id))),
          status,
        ),
      );
    });
    $('#model-list').replaceChildren(...rows);

    // Summary and bulk actions.
    const selected = MODELS.filter((m) => this.optOn(m.option) && (!m.sub || this.options.separate));
    const missing = selected.filter((m) => !this.cached.has(m.id));
    const missingBytes = missing.reduce((a, m) => a + sizeOf(m.id), 0);
    const summary = $('#model-summary');
    summary.className = `small${selected.length && !missing.length ? ' ok' : ''}`;
    summary.textContent = dl.busy
      ? 'Downloading… You can drop a song now: its tracks start right away, and the models are used as soon as they’re ready.'
      : !selected.length
      ? 'No models selected: you’ll get the always-included tracks only.'
      : !missing.length
        ? `✓ All ${selected.length} selected model${selected.length > 1 ? 's are' : ' is'} downloaded. Songs start processing right away.`
        : `${formatMB(missingBytes)} still to download for the selected options. This happens automatically the first time a song needs it, or you can do it now.`;
    const btn = $<HTMLButtonElement>('#models-download');
    btn.disabled = dl.busy || !missing.length;
    btn.textContent = dl.busy
      ? `Downloading ${dl.current ? MODELS.find((m) => m.id === dl.current!.id)!.model : ''}…`
      : missing.length ? `Download selected (${formatMB(missingBytes)})` : 'Selected models downloaded';
    $('#models-stop').hidden = !dl.busy;
    $('#models-remove').hidden = dl.busy || !this.cached.size;
    const clear = $('#songs-clear');
    clear.hidden = !this.savedSongs;
    clear.textContent = `Clear saved song results (${this.savedSongs} song${this.savedSongs === 1 ? '' : 's'})`;
    const err = $('#model-error');
    err.hidden = !dl.error;
    err.textContent = dl.error ?? '';

    const note = $('#gpu-note');
    note.hidden = !g;
    if (g) {
      note.className = `gpu-note small${g.gpu ? ' ok' : ' warn'}`;
      note.textContent = g.gpu
        ? '✓ GPU found: models run on your graphics card (WebGPU).'
        : /firefox/i.test(navigator.userAgent)
          ? 'No GPU available: Firefox doesn’t offer WebGPU on this system yet. Models run on the CPU, which works but is several times slower, and GPU-only options are off. Chrome or Edge can use your GPU.'
          : 'No usable GPU (WebGPU) found: models run on the CPU, which works but is slower, and GPU-only options are off.';
    }
  }

  private progress(stage: string, fraction: number) {
    $('#progress-stage').textContent = stage;
    $<HTMLProgressElement>('#progress-bar').value = fraction;
  }

  private bindDrop() {
    const zone = $('#dropzone');
    const input = $<HTMLInputElement>('#file-input');
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files?.length) void this.load([...input.files]); input.value = ''; });
    for (const ev of ['dragenter', 'dragover']) {
      document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragging'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragging'); });
    }
    document.addEventListener('drop', (e) => {
      const files = [...((e as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(f.name));
      if (files.length) void this.load(files);
    });
  }

  /**
   * Load a song, optionally with user-supplied stems (files named drums/bass/vocals/other).
   * The full-mix tracks show up first; stems (supplied, cached or separated in the
   * background) are analyzed and added when ready.
   */
  private async load(files: File[]) {
    this.cancelSeparation();
    const id = ++this.loadId;
    const supplied = new Map<StemName, File>();
    const others: File[] = [];
    for (const f of files) {
      const stem = stemFromFileName(f.name);
      if (stem && !supplied.has(stem)) supplied.set(stem, f);
      else others.push(f);
    }
    const file = others[0] ?? files[0];
    if (!others.length) supplied.forEach((f, k) => { if (f === file) supplied.delete(k); });
    this.wantStems = this.optOn('separate');
    this.lastFiles = files;
    this.lyricsText = $<HTMLTextAreaElement>('#lyrics-text').value.trim();
    this.lyricsFromUser = !!this.lyricsText;
    this.planPipeline(supplied);
    this.show('progress');
    this.progress(`Decoding ${file.name}`, 0.02);
    $('#progress-error').hidden = true;
    this.renderStemStrip();
    try {
      const bytes = await file.arrayBuffer();
      this.fileHash = await hashBytes(bytes);
      const { buffer, mono } = await decodeFile(new File([bytes], file.name), this.player.ctx, ANALYSIS_SR);
      if (id !== this.loadId) return;
      this.fileName = file.name;
      this.duration = buffer.duration;
      this.player.load(buffer);
      this.timeline.duration = buffer.duration;
      this.timeline.peaks = computePeaks(buffer);
      this.timeline.cursor = 0;
      this.tracks = [];
      this.deleted.clear();
      this.selectedId = undefined;
      this.auditionId = 'mix-beats';
      this.params = defaultParams();
      this.emissions = this.leadEmissions = undefined;
      this.alignSources = [];
      this.progress('Analyzing', 0.1);
      this.send({ type: 'analyze', mono, sr: ANALYSIS_SR, params: this.params }, [mono.buffer]);
      if (supplied.size || this.wantStems) void this.stemPipeline(buffer, supplied, id);
    } catch (err) {
      this.fail(err instanceof Error ? `Could not decode this file: ${err.message}` : 'Could not decode this file.');
    }
  }

  /** The steps this song will go through, from the options and any supplied stems. */
  private planPipeline(supplied: Map<StemName, File>) {
    const steps: [StepId, string][] = [['mix', 'Beats, bars and sections']];
    if (supplied.size || this.wantStems) {
      const ownVocals = supplied.has('vocals');
      const pasted = !!this.lyricsText;
      const transcribe = !pasted && this.optOn('lyrics');
      steps.push(['stems', supplied.size ? 'Your stem files' : 'Stem separation (drums, bass, vocals, other)']);
      if (this.optOn('hqVocals') && !ownVocals) steps.push(['hq', 'High-quality vocals']);
      if (this.optOn('lead') && !ownVocals) steps.push(['lead', 'Lead and backing vocals']);
      steps.push(['notes', 'Notes and melodies']);
      if (transcribe) steps.push(['lyrics', 'Lyrics transcription']);
      if (pasted || transcribe || this.optOn('align')) steps.push(['align', pasted || transcribe ? 'Lyric alignment' : 'Precise vocal syllables']);
      steps.push(['tracks', 'Final tracks']);
    }
    this.plan(steps);
    this.step('mix', { state: 'active' });
  }

  // ---- stems, high-quality vocals, lyrics ------------------------------------------

  private cacheKey(kind: keyof typeof CACHE_VERSION, variant = '') {
    return `${kind}:v${CACHE_VERSION[kind]}:${this.fileHash}${variant ? ':' + variant : ''}`;
  }

  /**
   * Everything after the mix analysis, in the background: stems (user files, cache or HTDemucs),
   * then optionally Mel-Band RoFormer vocals, then optionally Whisper lyrics on the best vocals.
   * Each stage adds or refines tracks as it finishes.
   */
  private async stemPipeline(buffer: AudioBuffer, supplied: Map<StemName, File>, id: number) {
    const wantHq = this.optOn('hqVocals');
    const wantLyrics = this.optOn('lyrics');
    const wantLead = this.optOn('lead');
    const wantAlign = this.optOn('align');
    const live = () => id === this.loadId;
    /** Update a step, unless a newer song has replaced this one. */
    const step = (s: StepId, patch: Partial<Step>) => { if (live()) this.step(s, patch); };
    let stereo: { left: Float32Array; right: Float32Array } | undefined;
    const getStereo = async () => (stereo ??= await toStereo(buffer, SEPARATOR_SR));
    this.separating = true;
    let current: StepId = 'stems';
    try {
      // Models downloading from the start screen finish first (they'd otherwise download twice).
      if (this.downloader.busy) {
        step('stems', { state: 'active', detail: 'waiting for the model download to finish…' });
        await this.downloader.idle();
        if (!live()) return;
      }

      // 1. Stems.
      let stems: StemAudio;
      step('stems', { state: 'active' });
      if (supplied.size) {
        step('stems', { detail: `decoding ${supplied.size} file${supplied.size > 1 ? 's' : ''}…` });
        stems = {};
        for (const [name, f] of supplied) stems[name] = await decodeMono(f, this.player.ctx, ANALYSIS_SR);
      } else {
        const cached = await idbGet<Record<string, Int16Array>>(this.cacheKey('stems'));
        if (cached) {
          stems = {};
          for (const n of STEM_NAMES) if (cached[n]) stems[n] = fromInt16(cached[n]);
          step('stems', { state: 'done', detail: REUSED });
        } else {
          step('stems', { detail: 'preparing…' });
          const { left, right } = await getStereo();
          let m: FromSeparator;
          try {
            m = await this.separatorJob({ type: 'separate', left: left.slice(), right: right.slice() }, 'stems', 'separating', live);
          } catch (err) {
            if (!(err instanceof Error && err.message === 'needs-gpu-memory')) throw err;
            // Out of GPU memory: start over on the CPU in a fresh worker.
            this.freeSeparator();
            step('stems', { note: 'The GPU ran out of memory, so stems were separated on the CPU. Closing other GPU-heavy tabs or apps can help.' });
            m = await this.separatorJob({ type: 'separate', left: left.slice(), right: right.slice(), cpuOnly: true }, 'stems', 'separating', live);
          }
          if (m.type !== 'done') return;
          stems = m.stems;
          void idbPut(this.cacheKey('stems'), Object.fromEntries(STEM_NAMES.map((n) => [n, toInt16(m.stems[n])])));
        }
      }
      if (!live()) return;
      this.useStems(stems);
      step('stems', { state: 'done' });

      let vocals = stems.vocals;
      let vocalsVariant = 'htdemucs';
      /** The lead singer alone, when separated: aligned together with the full vocals. */
      let leadVocals: Float32Array | undefined;

      // 2. High-quality vocals (GPU only).
      if (wantHq && !supplied.has('vocals') && vocals) {
        current = 'hq';
        step('hq', { state: 'active' });
        const cached = await idbGet<Int16Array>(this.cacheKey('vocals-hq'));
        let hq: Float32Array | undefined = cached ? fromInt16(cached) : undefined;
        if (!hq) {
          step('hq', { detail: 'preparing…' });
          const { left, right } = await getStereo();
          try {
            const m = await this.separatorJob({ type: 'vocals-hq', left: left.slice(), right: right.slice() }, 'hq', 'separating', live);
            if (m.type === 'vocals-hq') {
              hq = m.vocals;
              void idbPut(this.cacheKey('vocals-hq'), toInt16(hq));
            }
          } catch (err) {
            if (err instanceof Error && err.message === 'needs-gpu') step('hq', { state: 'skipped', note: 'High-quality vocals need a GPU (WebGPU), so the standard vocals were used.' });
            else if (err instanceof Error && err.message === 'needs-gpu-memory') step('hq', { state: 'skipped', note: 'There wasn’t enough free GPU memory for high-quality vocals, so the standard vocals were used. Closing other GPU-heavy tabs or apps can help.' });
            else throw err;
          }
        }
        if (!live()) return;
        if (hq) {
          vocals = hq;
          vocalsVariant = 'roformer';
          this.useStems({ vocals: hq });
          step('hq', { state: 'done', detail: cached ? REUSED : undefined });
        }
      }

      // 3. Lead vocals without the backing vocals (GPU only).
      if (wantLead && !supplied.has('vocals') && vocals) {
        current = 'lead';
        step('lead', { state: 'active' });
        const cached = await idbGet<Int16Array>(this.cacheKey('lead'));
        let lead: Float32Array | undefined = cached ? fromInt16(cached) : undefined;
        if (!lead) {
          step('lead', { detail: 'preparing…' });
          const { left, right } = await getStereo();
          try {
            const m = await this.separatorJob({ type: 'lead', left: left.slice(), right: right.slice() }, 'lead', 'separating', live);
            if (m.type === 'lead') {
              lead = m.lead;
              void idbPut(this.cacheKey('lead'), toInt16(lead));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'cancelled') throw err;
            if (msg === 'needs-gpu') step('lead', { state: 'skipped', note: 'Separating lead and backing vocals needs a GPU (WebGPU), so it was skipped.' });
            else if (msg === 'needs-gpu-memory') step('lead', { state: 'skipped', note: 'There wasn’t enough free GPU memory to separate lead and backing vocals. Closing other GPU-heavy tabs or apps can help.' });
            else {
              // E.g. the model couldn't be downloaded: the rest of the pipeline doesn't need it.
              console.warn('[separator] lead vocals failed', err);
              step('lead', { state: 'failed', note: `Separating lead and backing vocals failed (${msg}), so it was skipped.` });
            }
            this.freeSeparator();
          }
        }
        if (!live()) return;
        if (lead) {
          leadVocals = lead;
          this.send({ type: 'lead', lead: lead.slice(), sr: ANALYSIS_SR, params: this.params });
          step('lead', { state: 'done', detail: cached ? REUSED : undefined });
        }
      }

      // Notes (Basic Pitch, small and quick even on the CPU): the instruments' line, the sung
      // melody in the final vocals (after high-quality vocals), and the backing vocals.
      current = 'notes';
      step('notes', { state: 'active' });
      const noteSources: [PitchSource, Float32Array | undefined, string][] = [
        ['other', stems.other, 'instrument notes'],
        ['vocals', vocals, 'vocal melody'],
        ['backing', leadVocals && vocals ? Float32Array.from(vocals, (v, i) => v - (leadVocals![i] ?? 0)) : undefined, 'backing vocal notes'],
      ];
      for (const [src, audio, what] of noteSources) {
        if (!audio) continue;
        const m = await this.separatorJob({ type: 'notes', audio: audio.slice() }, 'notes', what, live);
        if (!live()) return;
        if (m.type === 'notes') this.send({ type: 'pitch', stem: src, frames: m.frames, params: this.params }, [m.frames.note.buffer, m.frames.onset.buffer, m.frames.times.buffer]);
      }
      step('notes', stems.other || vocals ? { state: 'done' } : { state: 'skipped', detail: 'no vocals or other stem' });

      // The separation models hold several hundred MB; free them before Whisper loads.
      // (They reload from the IndexedDB cache in seconds for the next song.)
      this.freeSeparator();

      // 4. Lyrics: pasted, else transcribed by Whisper; then aligned to the vocals.
      let lyricWords: LyricWord[] = this.lyricsText ? parseLyrics(this.lyricsText) : [];
      let hints: WordHint[] | undefined;
      if (!lyricWords.length && wantLyrics && vocals) {
        current = 'lyrics';
        step('lyrics', { state: 'active' });
        const key = this.cacheKey('lyrics', vocalsVariant);
        let words = await idbGet<AsrWord[]>(key);
        const reused = !!words;
        if (!words) {
          step('lyrics', { detail: 'preparing…' });
          const audio16k = await resample(vocals, ANALYSIS_SR, 16000);
          try {
            words = await this.lyricsJob(audio16k.slice(), live);
          } catch (err) {
            if (!(err instanceof Error && err.message === 'needs-gpu-memory')) throw err;
            this.lyricsWorker?.terminate();
            this.lyricsWorker = undefined;
            step('lyrics', { note: 'The GPU ran out of memory, so lyrics were transcribed on the CPU.' });
            words = await this.lyricsJob(audio16k, live, true);
          }
          if (words) void idbPut(key, words);
        }
        // Whisper holds a lot of GPU memory; free it (it reloads from the browser cache).
        this.lyricsWorker?.terminate();
        this.lyricsWorker = undefined;
        if (!live()) return;
        if (!words) throw new Error('no lyrics were returned');
        // Whisper's own timing first; the letter-level alignment below refines it.
        this.send({ type: 'lyrics', words, params: this.params });
        ({ words: lyricWords, hints } = wordsFromAsr(words));
        this.lyricsText = lyricLines(lyricWords);
        step('lyrics', { state: 'done', detail: reused ? REUSED : `${words.length} words` });
      }
      if (vocals) this.alignSources = [{ audio: vocals, variant: vocalsVariant }, ...(leadVocals ? [{ audio: leadVocals, variant: 'lead' }] : [])];
      // Pasted or transcribed lyrics always get aligned; without lyrics, the same model still
      // gives precise syllables.
      if (vocals && (lyricWords.length || wantAlign)) {
        current = 'align';
        try {
          await this.alignLyrics(lyricWords, hints, live);
        } catch (err) {
          if (err instanceof Error && err.message === 'cancelled') throw err;
          console.warn('[lyrics] vocal timing failed', err);
          step('align', { state: 'failed', note: `Precise vocal timing failed (${err instanceof Error ? err.message : String(err)}).` });
        }
        this.freeSeparator();
      }
      if (!live()) return;
      this.separating = false;
      // Steps the song had no input for (e.g. supplied stems without vocals).
      for (const s of this.steps) {
        if (s.id === 'tracks') continue;
        if (s.state === 'pending') s.state = 'skipped';
        else if (s.state === 'active') Object.assign(s, { state: 'done', fraction: undefined });
      }
      this.step('tracks', { state: 'active', detail: 'adding the last tracks…' });
      this.maybeFinish();
    } catch (err) {
      this.separating = false;
      if (/crashed/.test(String(err))) {
        this.lyricsWorker?.terminate();
        this.lyricsWorker = undefined;
      }
      if (!live()) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'cancelled') this.endSteps('Cancelled');
      else {
        this.step(current, { state: 'failed', note: `Something went wrong: ${msg}` });
        this.endSteps('Not run');
      }
    }
  }

  /**
   * Run one separator job, mirroring its progress in the step list.
   * `doing` describes the work (e.g. "separating"), shown with the backend and progress.
   */
  private separatorJob(msg: ToSeparator, stepId: StepId, doing: string, live: () => boolean): Promise<FromSeparator> {
    this.separator ??= new Worker(new URL('../separation/worker.ts', import.meta.url), { type: 'module' });
    const worker = this.separator;
    let segStart = 0;
    let backend = '';
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromSeparator>) => {
        if (!live()) return;
        const m = e.data;
        if (m.type === 'download') {
          const what = { htdemucs: 'separation model', roformer: 'high-quality vocal model', lead: 'lead vocal model', aligner: 'vocal timing model', notes: 'note model' }[m.model];
          this.step(stepId, m.cached
            ? { detail: `loading the ${what}…`, fraction: undefined }
            : m.loaded >= m.total
              ? { detail: `checking and storing the ${what}…`, fraction: undefined }
              : { detail: `downloading the ${what} (one time): ${formatMB(m.loaded)} of ${formatMB(m.total)}`, fraction: m.loaded / m.total });
        } else if (m.type === 'backend') {
          backend = m.backend === 'webgpu' ? 'GPU' : `CPU, ${m.threads} thread${m.threads > 1 ? 's' : ''}`;
          this.showCpuHint(m.backend === 'wasm');
          segStart = performance.now();
          // The first progress update can take a while on the CPU.
          this.step(stepId, { detail: `${doing} on the ${backend}: starting…`, fraction: 0 });
        } else if (m.type === 'segment') {
          this.step(stepId, { detail: `${doing} on the ${backend}: ${Math.round((100 * m.done) / m.total)}%${eta(segStart, m.done, m.total)}`, fraction: m.done / m.total });
        } else if (m.type === 'error') {
          reject(new Error(m.message));
        } else {
          resolve(m);
        }
      };
      worker.onerror = (e) => { e.preventDefault(); reject(new Error(e.message || 'the separation worker crashed (possibly out of memory)')); };
      const transfer = 'left' in msg ? [msg.left.buffer, msg.right.buffer] : [];
      worker.postMessage(msg, transfer);
    });
  }

  /** Transcribe vocals (16 kHz mono) with Whisper, mirroring progress in the step list. */
  private lyricsJob(audio16k: Float32Array, live: () => boolean, cpuOnly = false): Promise<AsrWord[] | undefined> {
    this.lyricsWorker ??= new Worker(new URL('../lyrics/worker.ts', import.meta.url), { type: 'module' });
    const worker = this.lyricsWorker;
    let start = 0;
    let backend = '';
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromLyrics>) => {
        if (!live()) return resolve(undefined);
        const m = e.data;
        if (m.type === 'download') {
          const total = Math.max(m.total, WHISPER_BYTES);
          this.step('lyrics', { detail: `downloading the lyrics model (one time): ${formatMB(m.loaded)} of ${formatMB(total)}`, fraction: m.loaded / total });
        } else if (m.type === 'backend') {
          backend = m.backend === 'webgpu' ? 'GPU' : 'CPU';
          this.showCpuHint(m.backend === 'wasm');
          start = performance.now();
          this.step('lyrics', { detail: `transcribing on the ${backend}: starting…`, fraction: 0 });
        } else if (m.type === 'progress') {
          this.step('lyrics', { detail: `transcribing on the ${backend}: ${m.done} of ${m.total} passages${eta(start, m.done, m.total)}`, fraction: m.done / m.total });
        } else if (m.type === 'error') {
          reject(new Error(m.message));
        } else if (m.type === 'done') {
          resolve(m.words);
        }
      };
      worker.onerror = (e) => { e.preventDefault(); reject(new Error(e.message || 'the lyrics worker crashed (possibly out of memory)')); };
      worker.postMessage({ type: 'transcribe', audio16k, cpuOnly } satisfies ToLyrics, [audio16k.buffer]);
    });
  }

  /**
   * Align lyric words to the vocals: character probabilities from the aligner model for each
   * vocal source (cached per song and stem), then Viterbi alignment in the analysis worker.
   */
  private async alignLyrics(words: LyricWord[], hints: WordHint[] | undefined, live: () => boolean) {
    const step = (patch: Partial<Step>) => { if (live()) this.step('align', patch); };
    step({ state: 'active' });
    const out: Emissions[] = [];
    for (const [i, src] of this.alignSources.entries()) {
      const key = this.cacheKey('emissions', src.variant);
      let em = await idbGet<Emissions>(key);
      if (!em) {
        const part = this.alignSources.length > 1 ? (i ? 'lead vocal: ' : 'all vocals: ') : '';
        step({ detail: `${part}preparing…` });
        const audio16k = await resample(src.audio, ANALYSIS_SR, W2V_SR);
        let m: FromSeparator;
        try {
          m = await this.separatorJob({ type: 'emissions', audio16k: audio16k.slice() }, 'align', `${part}listening`, live);
        } catch (err) {
          if (!(err instanceof Error && err.message === 'needs-gpu-memory')) throw err;
          this.freeSeparator();
          step({ note: 'The GPU ran out of memory, so vocal timing ran on the CPU.' });
          m = await this.separatorJob({ type: 'emissions', audio16k, cpuOnly: true }, 'align', `${part}listening`, live);
        }
        if (m.type !== 'emissions') return;
        em = m.emissions;
        void idbPut(key, em);
      }
      if (!live()) return;
      out.push(em);
    }
    [this.emissions, this.leadEmissions] = out;
    if (!this.emissions) return;
    await this.sendPron();
    this.send({ type: 'align', emissions: this.emissions, leadEmissions: this.leadEmissions, words, hints, params: this.params });
    step({ state: 'done' });
  }

  /** Stop the separation worker, freeing its models' memory (they reload from IndexedDB). */
  private freeSeparator() {
    this.separator?.terminate();
    this.separator = undefined;
  }

  /** The pronunciation dictionary, for syllables and phonemes; loaded once per page. */
  private async sendPron() {
    if (this.pronSent) return;
    try {
      const res = await fetch(new URL('../cmudict.txt.gz', document.baseURI));
      if (!res.ok) throw new Error(String(res.status));
      // Some servers send .gz files with Content-Encoding: gzip, so the browser has already
      // decompressed them; only gunzip what still starts with the gzip magic bytes.
      const bytes = new Uint8Array(await res.arrayBuffer());
      const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
      this.send({ type: 'pron', dict: strFromU8(gz ? gunzipSync(bytes) : bytes) });
      this.pronSent = true;
    } catch (err) {
      // Without it, syllables come from spelling rules and there's no phoneme layer.
      console.warn('[lyrics] pronunciation dictionary unavailable', err);
    }
  }

  private openLyricsDialog() {
    const dlg = $<HTMLDialogElement>('#lyrics-dialog');
    $<HTMLTextAreaElement>('#lyrics-edit').value = this.lyricsText;
    const canAlign = !this.separating && this.alignSources.length > 0;
    $<HTMLButtonElement>('#lyrics-align').disabled = !canAlign;
    $('#lyrics-dialog-note').textContent = this.separating
      ? 'The song is still being processed; you can align lyrics once it’s done.'
      : !this.alignSources.length
        ? 'Lyrics are aligned to the separated vocals. Turn on “Separate stems” and load the song again.'
        : this.emissions ? '' : 'The first alignment downloads the vocal timing model (once) and takes a little longer.';
    dlg.showModal();
  }

  /** Align edited or newly pasted lyrics from the editor. */
  private async realign(text: string) {
    const words = parseLyrics(text);
    this.lyricsText = text.trim();
    this.lyricsFromUser = true;
    if (!words.length || this.separating || !this.alignSources.length) return;
    const id = this.loadId;
    const live = () => id === this.loadId;
    this.plan([['align', 'Lyric alignment'], ['tracks', 'Updated lyric tracks']]);
    try {
      if (!this.emissions) {
        this.separating = true;
        await this.alignLyrics(words, undefined, live);
        this.freeSeparator();
      } else {
        this.send({ type: 'align', emissions: this.emissions, leadEmissions: this.leadEmissions, words, params: this.params });
        this.step('align', { state: 'done' });
      }
      this.separating = false;
      if (!live()) return;
      this.step('tracks', { state: 'active' });
      this.maybeFinish();
    } catch (err) {
      this.separating = false;
      if (!live()) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'cancelled') this.endSteps('Cancelled');
      else {
        this.step('align', { state: 'failed', note: `Aligning the lyrics failed: ${msg}` });
        this.endSteps('Not run');
      }
    }
  }

  private showCpuHint(onCpu: boolean) {
    $('#stem-hint').hidden = !onCpu;
    $('#stem-hint').textContent = /firefox/i.test(navigator.userAgent)
      ? 'Firefox doesn’t offer WebGPU on this system yet, so this runs on the CPU. Chrome or Edge can use your GPU, which is several times faster.'
      : 'No usable GPU (WebGPU) was found, so this runs on the CPU. It still works, just slower.';
  }

  private cancelSeparation() {
    if (this.separating) {
      this.separator?.postMessage({ type: 'cancel' } satisfies ToSeparator);
      this.lyricsWorker?.postMessage({ type: 'cancel' } satisfies ToLyrics);
    }
    this.separating = false;
  }

  private useStems(stems: StemAudio) {
    this.player.loadStems(stems, ANALYSIS_SR);
    this.renderStemStrip();
    const copy: StemAudio = {};
    for (const [k, v] of Object.entries(stems)) copy[k as StemName] = v.slice();
    this.send({ type: 'stems', stems: copy, sr: ANALYSIS_SR, params: this.params }, Object.values(copy).map((v) => v.buffer));
  }

  // ---- processing status -------------------------------------------------------------

  private plan(steps: [StepId, string][]) {
    this.steps = steps.map(([id, label]) => ({ id, label, state: 'pending' }));
    this.statusOpen = false;
    this.statusDismissed = false;
    $('#stem-hint').hidden = true;
    this.renderStatus();
  }

  /** Update one step; a new state clears the previous state's progress and detail. */
  private step(id: StepId, patch: Partial<Step>) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    if (patch.state && patch.state !== s.state) {
      s.fraction = undefined;
      if (!('detail' in patch)) s.detail = undefined;
    }
    Object.assign(s, patch);
    this.renderStatus();
  }

  /** Close out unfinished steps (after a cancel or an error); the mix analysis finishes on its own. */
  private endSteps(why: string) {
    for (const s of this.steps) {
      if (s.id !== 'mix' && s.state === 'pending' || s.state === 'active') Object.assign(s, { state: 'skipped', detail: why, fraction: undefined });
    }
    this.renderStatus();
  }

  /** The pipeline is done once its last analysis results are in. */
  private maybeFinish() {
    if (this.separating || this.pendingAnalysis > 0) return;
    const s = this.steps.find((x) => x.id === 'tracks');
    if (s && (s.state === 'active' || s.state === 'pending')) this.step('tracks', { state: 'done' });
  }

  private isBusy() {
    return this.steps.some((s) => s.state === 'pending' || s.state === 'active');
  }

  /** The processing panel above the timeline, the export notice and the tab title. */
  private renderStatus() {
    const steps = this.steps;
    const busy = this.isBusy();
    const finished = steps.filter((s) => s.state !== 'pending' && s.state !== 'active').length;
    const active = steps.find((s) => s.state === 'active');
    const fraction = steps.length ? (finished + (active?.fraction ?? 0)) / steps.length : 0;
    const failed = steps.some((s) => s.state === 'failed');
    const cancelled = steps.some((s) => s.detail === 'Cancelled');
    const notes = steps.filter((s) => s.note).length;

    const box = $('#status');
    box.hidden = !steps.length || (this.statusDismissed && !busy);
    box.dataset.state = busy ? 'busy' : failed ? 'error' : notes || cancelled ? 'warn' : 'done';
    $('#status-icon').textContent = busy ? '' : failed ? '!' : notes || cancelled ? '!' : '✓';
    const n = this.tracks.length;
    const ready = `${n} track${n === 1 ? '' : 's'} ready to export`;
    $('#status-title').textContent = busy
      ? `Still working: step ${Math.min(finished + 1, steps.length)} of ${steps.length}`
      : cancelled ? 'Cancelled' : failed ? 'Finished, with problems' : 'All done';
    $('#status-sub').textContent = busy
      ? 'New tracks are added as each step finishes. You can play and edit in the meantime.'
      : notes ? `${ready}. See the notes below.` : `${ready}.`;
    // Say so when saved results were used: they may come from an older version of the app.
    const reused = !busy && steps.some((s) => s.detail === REUSED);
    if (reused) $('#status-sub').textContent += ' Some steps reused results saved from an earlier run.';
    $('#status-rerun').hidden = !reused;
    const bar = $<HTMLProgressElement>('#status-bar');
    bar.hidden = !busy;
    bar.value = fraction;
    const open = busy || this.statusOpen || failed || notes > 0;
    const toggle = $('#status-toggle');
    toggle.hidden = busy || failed || notes > 0;
    toggle.textContent = this.statusOpen ? 'Hide steps' : 'Show steps';
    toggle.setAttribute('aria-expanded', String(open));
    $('#stem-cancel').hidden = !busy || !this.separating;
    $('#status-dismiss').hidden = busy;
    if (!busy) $('#stem-hint').hidden = true;

    const list = $('#status-steps');
    list.hidden = !open;
    list.replaceChildren(...steps.map((s) => {
      const li = el('li', { class: `step ${s.state}` },
        el('span', { class: 'step-icon', ariaHidden: 'true' }, { done: s.note ? '!' : '✓', active: '', pending: '', skipped: '–', failed: '!' }[s.state]),
        el('span', { class: 'step-label' }, s.label),
        el('span', { class: 'step-state visually-hidden' }, ` (${{ done: 'done', active: 'in progress', pending: 'waiting', skipped: 'skipped', failed: 'failed' }[s.state]})`),
      );
      if (s.detail) li.append(el('span', { class: 'step-detail muted' }, s.detail));
      if (s.state === 'active' && s.fraction !== undefined) li.append(Object.assign(el('progress', { class: 'step-bar', max: 1 }), { value: s.fraction }));
      if (s.note) li.append(el('span', { class: 'step-note' }, s.note));
      return li;
    }));

    $('#export-busy').hidden = !busy;
    const pending = document.querySelector<HTMLElement>('.lane-pending');
    if (pending) pending.hidden = !busy;
    document.title = busy ? `${Math.round(fraction * 100)}% · Stemlight` : document.hidden && steps.length && !this.statusDismissed ? '✓ Done · Stemlight' : 'Stemlight';
  }

  private renderStemStrip() {
    const strip = $('#stem-strip');
    const names = this.player.stemNames;
    strip.hidden = names.length === 0;
    strip.replaceChildren(
      el('span', { class: 'strip-label' }, 'Stems'),
      ...STEM_NAMES.filter((n) => names.includes(n)).map((n) => {
        const mute = el('button', { class: `ms${this.player.isMuted(n) ? ' on' : ''}`, title: `Mute ${STEM_LABEL[n]}` }, 'M');
        const solo = el('button', { class: `ms solo${this.player.isSoloed(n) ? ' on' : ''}`, title: `Solo ${STEM_LABEL[n]}` }, 'S');
        mute.setAttribute('aria-pressed', String(this.player.isMuted(n)));
        solo.setAttribute('aria-pressed', String(this.player.isSoloed(n)));
        mute.onclick = () => { this.player.toggleMute(n); this.renderStemStrip(); };
        solo.onclick = () => { this.player.toggleSolo(n); this.renderStemStrip(); };
        return el('span', { class: 'stem-chip' }, STEM_LABEL[n], mute, solo);
      }),
    );
  }

  private fail(message: string) {
    this.show('progress');
    $('#progress-error').hidden = false;
    $('#progress-error-text').textContent = message;
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    if (!this.worker) {
      this.worker = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
      this.worker.onerror = (e) => this.fail(`Analysis failed: ${e.message}`);
    }
    if (msg.type !== 'pron') this.pendingAnalysis++;
    this.worker.postMessage(msg, transfer);
  }

  private onWorker(msg: FromWorker) {
    if (msg.type === 'progress') {
      if (!$('#screen-progress').hidden) this.progress(msg.stage, msg.fraction);
      return;
    }
    // Every message but 'pron' gets exactly one result or error back.
    this.pendingAnalysis = Math.max(0, this.pendingAnalysis - 1);
    if (msg.type === 'error') {
      this.fail(`Analysis failed: ${msg.message}`);
      return;
    }
    const first = this.tracks.length === 0;
    this.mergeTracks(msg.tracks);
    $('#file-name').textContent = this.fileName;
    $('#file-meta').textContent = `${formatTime(msg.duration)} · ${msg.bpm.toFixed(1)} BPM`;
    this.show('editor');
    if (first) this.timeline.fit();
    this.refresh();
    if (this.steps.find((s) => s.id === 'mix')?.state === 'active') this.step('mix', { state: 'done' });
    this.maybeFinish();
    this.renderStatus();
  }

  /** Replace generated tracks with fresh results, keeping user renames, nudges, deletions and duplicates. */
  private mergeTracks(fresh: Track[]) {
    const old = new Map(this.tracks.map((s) => [s.track.id, s]));
    const next: TrackState[] = [];
    for (const t of fresh) {
      if (this.deleted.has(t.id)) continue;
      const prev = old.get(t.id);
      next.push(prev ? { ...prev, track: { ...t, name: prev.userName ?? t.name } } : { track: t, include: true, nudgeMs: 0, hue: this.nextHue() });
      // Keep user duplicates right after their original.
      for (const s of this.tracks) if (s.track.id.startsWith(`${t.id}~`)) next.push(s);
    }
    // Copies whose original was deleted stay too.
    for (const s of this.tracks) if (s.track.id.includes('~') && !next.includes(s)) next.push(s);
    this.tracks = next;
  }

  private nextHue() {
    // Golden-angle spacing keeps neighboring lanes distinguishable.
    return Math.round((200 + 137.5 * this.hueSeed++) % 360);
  }

  // ---- toolbar & transport -----------------------------------------------------

  private bindToolbar() {
    $('#play').addEventListener('click', () => this.togglePlay());
    $('#zoom-in').addEventListener('click', () => this.timeline.zoom(1.5));
    $('#zoom-out').addEventListener('click', () => this.timeline.zoom(1 / 1.5));
    $('#zoom-fit').addEventListener('click', () => this.timeline.fit());
    $<HTMLInputElement>('#music-vol').addEventListener('input', (e) => this.player.setMusicVolume(Number((e.target as HTMLInputElement).value)));
    $<HTMLInputElement>('#click-vol').addEventListener('input', (e) => this.player.setClickVolume(Number((e.target as HTMLInputElement).value)));
    document.addEventListener('keydown', (e) => {
      if ($('#screen-editor').hidden) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea, [contenteditable]')) return;
      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'Home') { this.timeline.onSeek?.(0); }
      else if (e.key === '+' || e.key === '=') this.timeline.zoom(1.5);
      else if (e.key === '-') this.timeline.zoom(1 / 1.5);
    });
  }

  private togglePlay() {
    if (this.player.isPlaying) this.player.pause();
    else void this.player.play();
    this.updatePlayButton();
  }

  private updatePlayButton() {
    const playing = this.player.isPlaying;
    $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#play').classList.toggle('playing', playing);
  }

  private updateTime() {
    $('#time').textContent = `${formatTime(this.player.currentTime, true)} / ${formatTime(this.duration, true)}`;
  }

  private tick = () => {
    this.lights.render(this.player.currentTime);
    if (this.player.isPlaying) {
      const t = this.player.currentTime;
      this.timeline.cursor = t;
      this.timeline.follow(t);
      this.timeline.render();
      this.updateTime();
    }
    requestAnimationFrame(this.tick);
  };

  // ---- tracks ------------------------------------------------------------------

  private quantized(s: TrackState): MsMark[] {
    const shift = s.nudgeMs / 1000;
    const marks = shift ? s.track.marks.map((m) => ({ ...m, start: m.start + shift, end: m.end + shift })) : s.track.marks;
    return quantizeMarks(marks, this.gridMs, this.duration);
  }

  private setGrid(g: GridMs) {
    this.gridMs = g;
    $<HTMLSelectElement>('#grid').value = String(g);
    $<HTMLSelectElement>('#grid-start').value = String(g);
    if (this.tracks.length) this.refresh();
  }

  /** Re-render lanes, headers, inspector and audition after any change. */
  private refresh() {
    this.timeline.lanes = this.tracks.map((s) => ({ id: s.track.id, marks: this.quantized(s), hue: s.hue, selected: s.track.id === this.selectedId }));
    this.lights.setChannels(this.tracks.flatMap((s, i) => {
      if (!s.include) return [];
      const marks = this.timeline.lanes[i].marks;
      const durs = marks.map((m) => m.end - m.start).sort((a, b) => a - b);
      // Back-to-back spans (beats, bars, sections) would just stay lit; flash at each boundary instead.
      const touching = marks.filter((m, j) => j > 0 && m.start === marks[j - 1].end).length;
      const isPoint = (durs[durs.length >> 1] ?? 0) <= this.gridMs * 1.5 || touching > 0.8 * (marks.length - 1);
      if (!s.split) return [{ id: s.track.id, name: s.track.name, hue: s.hue, marks, isPoint }];
      // A split track lights one lamp per prop; touching marks no longer touch within a channel.
      const ch = channelOf(marks, s.split);
      return Array.from({ length: s.split.channels }, (_, c) => ({
        id: `${s.track.id}#${c + 1}`, name: `${s.track.name} ${c + 1}`, hue: (s.hue + c * 40) % 360,
        marks: marks.filter((_, j) => ch[j] === c), isPoint: (durs[durs.length >> 1] ?? 0) <= this.gridMs * 1.5,
      }));
    }));
    this.timeline.render();
    this.renderHeads();
    this.renderInspector();
    this.renderExport();
    const aud = this.tracks.find((s) => s.track.id === this.auditionId);
    this.player.setAudition(aud ? this.quantized(aud) : []);
    this.updateTime();
  }

  private renderHeads() {
    const heads = $('#lane-heads');
    heads.replaceChildren(
      el('div', { class: 'lane-head ruler-head' }),
      el('div', { class: 'lane-head wave-head', title: this.fileName }, el('span', { class: 'wave-label' }, 'Mix')),
    );
    $('.ruler-head').style.height = `${RULER_H}px`;
    $('.wave-head').style.height = `${WAVE_H}px`;
    for (const s of this.tracks) {
      const id = s.track.id;
      const include = el('input', { type: 'checkbox', checked: s.include, title: 'Include in export' });
      include.setAttribute('aria-label', `Export ${s.track.name}`);
      include.addEventListener('click', (e) => e.stopPropagation());
      include.addEventListener('change', () => { s.include = include.checked; this.refresh(); });
      const audition = el('button', { class: `icon-btn audition${this.auditionId === id ? ' on' : ''}`, title: 'Audition: click on this track while playing', innerHTML: ICONS.headphones });
      audition.setAttribute('aria-pressed', String(this.auditionId === id));
      audition.setAttribute('aria-label', `Audition ${s.track.name}`);
      audition.addEventListener('click', (e) => {
        e.stopPropagation();
        this.auditionId = this.auditionId === id ? undefined : id;
        this.refresh();
      });
      const row = el('div', { class: `lane-head${this.selectedId === id ? ' selected' : ''}`, tabIndex: 0 },
        include,
        el('span', { class: 'swatch' }),
        el('span', { class: 'lane-name', title: `${s.track.name} (from ${s.track.source})` }, s.track.name),
        el('span', { class: `lane-src src-${s.track.source}` }, s.track.source === 'mix' ? '' : s.track.source),
        el('span', { class: 'lane-count', title: s.split ? `Split into ${s.split.channels} props` : `${s.track.marks.length} marks` }, s.split ? `×${s.split.channels}` : String(s.track.marks.length)),
        audition,
      );
      row.style.height = `${LANE_H}px`;
      row.style.setProperty('--hue', String(s.hue));
      const select = () => { this.selectedId = id; this.refresh(); };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
      heads.append(row);
    }
    // While processing, a hint that the list isn't complete yet.
    const pending = el('div', { class: 'lane-head lane-pending' }, el('span', { class: 'spinner', ariaHidden: 'true' }), 'More tracks on the way…');
    pending.hidden = !this.isBusy();
    heads.append(pending);
  }

  private renderInspector() {
    const box = $('#inspector');
    const s = this.tracks.find((t) => t.track.id === this.selectedId);
    if (!s) {
      box.replaceChildren(el('p', { class: 'muted' }, 'Select a track to rename it, tune its detection, or nudge it.'));
      return;
    }
    const name = el('input', { type: 'text', value: s.track.name, class: 'text-input' });
    name.setAttribute('aria-label', 'Track name');
    name.addEventListener('change', () => {
      const v = name.value.trim() || s.track.name;
      s.track = { ...s.track, name: v };
      s.userName = v;
      this.refresh();
    });

    const nudge = (dir: number) => { s.nudgeMs += dir * this.gridMs; this.refresh(); };
    const nudgeRow = el('div', { class: 'row' },
      el('span', { class: 'field-label' }, 'Nudge'),
      Object.assign(el('button', { class: 'btn small' }, `−${this.gridMs} ms`), { onclick: () => nudge(-1) }),
      el('span', { class: 'mono nudge-val' }, `${s.nudgeMs > 0 ? '+' : ''}${s.nudgeMs} ms`),
      Object.assign(el('button', { class: 'btn small' }, `+${this.gridMs} ms`), { onclick: () => nudge(1) }),
    );

    const groups = PARAM_GROUPS[s.track.id.split('~')[0]] ?? [];
    const sliders = s.track.id.includes('~') ? [] : groups.flatMap((g) => {
      const title = groups.length > 1 || GROUP_TITLE[g] ? el('h4', { class: 'group-title' }, GROUP_TITLE[g] ?? '') : '';
      return [title, ...Object.entries(PARAM_RANGES[g]).map(([key, r]) => this.slider(g, key, r))];
    });

    const dup = el('button', { class: 'btn' }, 'Duplicate');
    dup.onclick = () => {
      const copy: TrackState = { ...s, hue: this.nextHue(), userName: `${s.track.name} copy`, track: { ...s.track, id: `${s.track.id.split('~')[0]}~${Date.now()}`, name: `${s.track.name} copy`, params: {}, marks: s.track.marks.map((m) => ({ ...m })) } };
      this.tracks.splice(this.tracks.indexOf(s) + 1, 0, copy);
      this.selectedId = copy.track.id;
      this.refresh();
    };
    const del = el('button', { class: 'btn danger' }, 'Delete');
    del.onclick = () => {
      this.tracks = this.tracks.filter((t) => t !== s);
      if (!s.track.id.includes('~')) this.deleted.add(s.track.id);
      if (this.auditionId === s.track.id) this.auditionId = undefined;
      this.selectedId = undefined;
      this.refresh();
    };

    box.replaceChildren(
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
      el('p', { class: 'muted small' }, `${s.track.marks.length} marks · from ${s.track.source}${s.track.id.includes('~') ? ' (copy, fixed)' : ''}`),
      this.splitRow(s),
      ...sliders,
      nudgeRow,
      el('div', { class: 'row actions' }, dup, del),
    );
  }

  /** Share the track among several props: export it as one track per channel. */
  private splitRow(s: TrackState) {
    const n = s.split?.channels ?? 1;
    const count = el('select', { class: 'select' }, ...[1, 2, 3, 4, 5, 6].map((k) => el('option', { value: String(k), selected: k === n }, k === 1 ? 'No' : `${k} channels`)));
    count.setAttribute('aria-label', 'Split into channels');
    const pitchOk = hasPitch(s.track);
    const by = el('select', { class: 'select' },
      el('option', { value: 'turns', selected: s.split?.by !== 'pitch' }, 'taking turns'),
      ...(pitchOk ? [el('option', { value: 'pitch', selected: s.split?.by === 'pitch' }, 'by pitch, low to high')] : []));
    by.setAttribute('aria-label', 'How to split');
    by.hidden = n === 1;
    const update = () => {
      const k = Number(count.value);
      s.split = k > 1 ? { channels: k, by: by.value as Split['by'] } : undefined;
      this.refresh();
    };
    count.addEventListener('change', update);
    by.addEventListener('change', update);
    return el('div', { class: 'field' },
      el('span', { class: 'field-label' }, 'Split into props'),
      el('div', { class: 'row' }, count, by),
      el('span', { class: 'muted small' }, n > 1
        ? `Exported as ${n} tracks, “${s.track.name} 1” to “${s.track.name} ${n}”, one per prop.${s.split?.by === 'pitch' ? '' : s.track.id === 'mix-beats' ? ' Beats alternate by beat number when the bars are regular.' : ''}`
        : 'Share this track among several props, e.g. alternate beats between two pumpkins, or low and high notes.'),
    );
  }

  private slider(group: keyof AllParams, key: string, r: Range) {
    const params = this.params[group] as Record<string, number>;
    const out = el('output', { class: 'mono' }, String(params[key]));
    const input = el('input', { type: 'range', min: String(r.min), max: String(r.max), step: String(r.step), value: String(params[key]) });
    input.setAttribute('aria-label', r.label);
    input.addEventListener('input', () => {
      params[key] = Number(input.value);
      out.textContent = input.value;
      // Debounce: re-run on the cached analysis once the slider settles.
      clearTimeout(this.rerunTimer);
      this.rerunTimer = window.setTimeout(() => this.send({ type: 'rerun', params: this.params }), 120);
    });
    return el('label', { class: 'field', title: r.hint },
      el('span', { class: 'field-label' }, r.label, out),
      input,
      el('span', { class: 'muted small' }, r.hint),
    );
  }

  // ---- export -------------------------------------------------------------------

  private exportable(): Track[] {
    return this.tracks.filter((s) => s.include).map((s) => {
      const shift = s.nudgeMs / 1000;
      const move = (marks: Track['marks']) => marks.map((m) => ({ ...m, start: m.start + shift, end: m.end + shift }));
      const t = shift ? { ...s.track, marks: move(s.track.marks), layers: s.track.layers?.map(move) } : s.track;
      return s.split ? splitTrack(t, s.split) : [t];
    }).flat();
  }

  private renderExport() {
    const n = this.tracks.filter((s) => s.include).length;
    const files = this.tracks.filter((s) => s.include).reduce((a, s) => a + (s.split?.channels ?? 1), 0);
    $('#export-count').textContent = `${n} of ${this.tracks.length} tracks selected${files > n ? ` (${files} after splitting)` : ''}`;
    for (const id of ['#export-xtiming', '#export-zip']) $<HTMLButtonElement>(id).disabled = n === 0;
  }

  private baseName() {
    return fileSafeName(this.fileName.replace(/\.[^.]+$/, ''));
  }

  private exportCombined() {
    const xml = toXTiming(this.exportable(), { gridMs: this.gridMs, durationSec: this.duration });
    download(`${this.baseName()}.xtiming`, xml, 'application/xml');
  }

  private exportZip() {
    const zip = tracksToZip(this.exportable(), { gridMs: this.gridMs, durationSec: this.duration });
    download(`${this.baseName()} timing.zip`, zip as BlobPart, 'application/zip');
  }
}

export const ICONS = {
  headphones: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5" fill="currentColor"/><rect x="17" y="14" width="4" height="6" rx="1.5" fill="currentColor"/></svg>',
};
