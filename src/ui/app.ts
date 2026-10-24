import { DEFAULT_PARAMS } from '../analysis/analyze';
import type { AllParams, FromWorker, StemAudio, ToWorker } from '../analysis/protocol';
import { DEFAULT_STEM_PARAMS } from '../analysis/stems';
import { computePeaks, decodeFile, decodeMono, stemFromFileName, toStereo } from '../audio/decode';
import { Player } from '../audio/player';
import { quantizeMarks, type MsMark } from '../core/quantize';
import type { GridMs, Track } from '../core/types';
import { ANALYSIS_SR } from '../dsp/features';
import { fileSafeName, toXTiming } from '../export/xtiming';
import { SAMPLE_RATE as SEPARATOR_SR, STEM_NAMES, type StemName } from '../separation/htdemucs';
import { MODEL_TOTAL_BYTES } from '../separation/model';
import type { FromSeparator, ToSeparator } from '../separation/protocol';
import { hashBytes, idbGet, idbPut } from '../storage/idb';
import { tracksToZip } from '../export/zip';
import { formatTime, LANE_H, RULER_H, Timeline, WAVE_H } from './timeline';

const defaultParams = (): AllParams => structuredClone({ ...DEFAULT_PARAMS, ...DEFAULT_STEM_PARAMS });
const STEM_LABEL: Record<StemName, string> = { drums: 'Drums', bass: 'Bass', vocals: 'Vocals', other: 'Other' };
const STEM_CACHE_VERSION = 1;

/** Which parameter group feeds each generated track. */
const PARAM_GROUP: Record<string, keyof AllParams> = {
  'mix-beats': 'beats', 'mix-bars': 'beats', 'mix-onsets': 'onsets',
  'mix-sections': 'sections', 'mix-phrases': 'phrases', 'mix-energy': 'energy',
  'drums-kick': 'kick', 'drums-snare': 'snare', 'drums-hats': 'hats', 'bass-notes': 'bassNotes',
  'vocals-phrases': 'vocalPhrases', 'vocals-syllables': 'vocalSyllables', 'other-accents': 'otherAccents',
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
  vocalSyllables: {
    thresholdDb: { label: 'Range (dB)', min: 6, max: 40, step: 1, hint: 'Higher counts quieter syllables.' },
    sensitivity: sensitivity('Higher splits words into more syllables.'),
    minDur: { label: 'Shortest syllable (s)', min: 0.05, max: 0.5, step: 0.01, hint: 'Syllables shorter than this are merged.' },
  },
  otherAccents: { sensitivity: sensitivity('Higher finds more, softer accents in guitars, keys, strings and horns.'), minGap },
  beats: {
    priorBpm: { label: 'Tempo guess (BPM)', min: 60, max: 200, step: 1, hint: 'Biases the tempo search; change it if beats are double or half speed.' },
    tightness: { label: 'Tightness', min: 20, max: 400, step: 10, hint: 'Higher keeps beats evenly spaced; lower follows the music more loosely.' },
  },
  onsets: {
    sensitivity: { label: 'Sensitivity', min: 0, max: 1, step: 0.05, hint: 'Higher finds more, softer hits.' },
    minGap: { label: 'Min gap (s)', min: 0.03, max: 0.5, step: 0.01, hint: 'Hits closer than this are merged.' },
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
  energy: {
    thresholdDb: { label: 'Threshold (dB)', min: 1, max: 12, step: 0.5, hint: 'Loudness change needed to mark a rise or drop.' },
    spanBars: { label: 'Window (bars)', min: 1, max: 8, step: 1, hint: 'Bars compared before and after each point.' },
  },
};

type TrackState = { track: Track; include: boolean; nudgeMs: number; hue: number; userName?: string };

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
  private tracks: TrackState[] = [];
  private deleted = new Set<string>();
  private params: AllParams = defaultParams();
  private separator?: Worker;
  private separating = false;
  /** Stems were sent for analysis and their tracks haven't arrived yet. */
  private stemsPending = false;
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

  mount() {
    this.timeline = new Timeline($('#lane-canvas'));
    this.timeline.onSeek = (t) => { this.player.seek(t); this.timeline.cursor = t; this.timeline.render(); this.updateTime(); };
    this.player.onEnded = () => this.updatePlayButton();

    this.bindDrop();
    this.bindToolbar();
    $<HTMLSelectElement>('#grid').addEventListener('change', (e) => this.setGrid(Number((e.target as HTMLSelectElement).value) as GridMs));
    $<HTMLSelectElement>('#grid-start').addEventListener('change', (e) => this.setGrid(Number((e.target as HTMLSelectElement).value) as GridMs));
    $('#export-xtiming').addEventListener('click', () => this.exportCombined());
    $('#export-zip').addEventListener('click', () => this.exportZip());
    $('#new-file').addEventListener('click', () => { this.cancelSeparation(); this.show('drop'); });
    $('#stem-cancel').addEventListener('click', () => this.cancelSeparation());
    const sep = $<HTMLInputElement>('#opt-separate');
    try { sep.checked = localStorage.getItem('stemlight.separate') !== '0'; } catch { /* storage blocked */ }
    sep.addEventListener('change', () => { try { localStorage.setItem('stemlight.separate', sep.checked ? '1' : '0'); } catch { /* ignore */ } });
    this.tick();
  }

  // ---- screens ---------------------------------------------------------------

  private show(screen: 'drop' | 'progress' | 'editor') {
    for (const s of ['drop', 'progress', 'editor']) $(`#screen-${s}`).hidden = s !== screen;
    if (screen !== 'editor') this.player.pause();
    if (screen === 'editor') this.timeline.render();
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
    this.stemsPending = false;
    const supplied = new Map<StemName, File>();
    const others: File[] = [];
    for (const f of files) {
      const stem = stemFromFileName(f.name);
      if (stem && !supplied.has(stem)) supplied.set(stem, f);
      else others.push(f);
    }
    const file = others[0] ?? files[0];
    if (!others.length) supplied.forEach((f, k) => { if (f === file) supplied.delete(k); });
    this.wantStems = $<HTMLInputElement>('#opt-separate').checked;
    this.show('progress');
    this.progress(`Decoding ${file.name}`, 0.02);
    $('#progress-error').hidden = true;
    this.setStemStatus();
    this.renderStemStrip();
    try {
      const bytes = await file.arrayBuffer();
      this.fileHash = await hashBytes(bytes);
      const { buffer, mono } = await decodeFile(new File([bytes], file.name), this.player.ctx);
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
      this.progress('Analyzing', 0.1);
      this.send({ type: 'analyze', mono, sr: ANALYSIS_SR, params: this.params }, [mono.buffer]);
      if (supplied.size) void this.loadSuppliedStems(supplied, id);
      else if (this.wantStems) void this.loadOrSeparateStems(buffer, id);
    } catch (err) {
      this.fail(err instanceof Error ? `Could not decode this file: ${err.message}` : 'Could not decode this file.');
    }
  }

  // ---- stems -------------------------------------------------------------------

  private async loadSuppliedStems(files: Map<StemName, File>, id: number) {
    this.setStemStatus(`Decoding ${files.size} stem file${files.size > 1 ? 's' : ''}…`);
    try {
      const stems: StemAudio = {};
      for (const [name, f] of files) stems[name] = await decodeMono(f, this.player.ctx, ANALYSIS_SR);
      if (id === this.loadId) this.useStems(stems, 'your stem files');
    } catch (err) {
      this.setStemStatus(`Could not decode the stem files: ${err instanceof Error ? err.message : err}`, true);
    }
  }

  private stemCacheKey() {
    return `stems:v${STEM_CACHE_VERSION}:${this.fileHash}`;
  }

  private async loadOrSeparateStems(buffer: AudioBuffer, id: number) {
    const cached = await idbGet<Record<string, Int16Array>>(this.stemCacheKey());
    if (id !== this.loadId) return;
    if (cached) {
      const stems: StemAudio = {};
      for (const n of STEM_NAMES) if (cached[n]) stems[n] = Float32Array.from(cached[n], (v) => v / 32767);
      this.useStems(stems, 'cache');
      return;
    }
    this.separating = true;
    this.setStemStatus('Preparing stem separation…', false, true);
    const { left, right } = await toStereo(buffer, SEPARATOR_SR);
    if (id !== this.loadId) return;
    const started = performance.now();
    let segStart = 0;
    let backend = '';
    this.separator ??= new Worker(new URL('../separation/worker.ts', import.meta.url), { type: 'module' });
    this.separator.onmessage = (e: MessageEvent<FromSeparator>) => {
      if (id !== this.loadId) return;
      const m = e.data;
      if (m.type === 'download') {
        const mb = (n: number) => (n / 1e6).toFixed(0);
        this.setStemStatus(m.cached ? 'Loading the separation model…' : `Downloading the separation model (one time): ${mb(m.loaded)} / ${mb(MODEL_TOTAL_BYTES)} MB`, false, true, m.loaded / m.total);
      } else if (m.type === 'backend') {
        backend = m.backend === 'webgpu' ? 'GPU' : `CPU, ${m.threads} thread${m.threads > 1 ? 's' : ''}`;
        segStart = performance.now();
      } else if (m.type === 'segment') {
        const per = m.done ? (performance.now() - segStart) / m.done : 0;
        const left = per ? Math.ceil((per * (m.total - m.done)) / 1000) : 0;
        const eta = m.done ? ` · about ${left >= 90 ? `${Math.round(left / 60)} min` : `${left} s`} left` : '';
        this.setStemStatus(`Separating stems (${backend}): ${m.done} / ${m.total}${eta}`, false, true, m.done / m.total);
      } else if (m.type === 'done') {
        this.separating = false;
        console.info(`Stem separation took ${((performance.now() - started) / 1000).toFixed(1)} s on ${backend}`);
        const toCache = Object.fromEntries(STEM_NAMES.map((n) => [n, Int16Array.from(m.stems[n], (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))]));
        void idbPut(this.stemCacheKey(), toCache);
        this.useStems(m.stems, 'separation');
      } else if (m.type === 'error') {
        this.separating = false;
        this.setStemStatus(m.message === 'cancelled' ? 'Stem separation cancelled.' : `Stem separation failed: ${m.message}`, m.message !== 'cancelled');
      }
    };
    this.separator.postMessage({ type: 'separate', left, right } satisfies ToSeparator, [left.buffer, right.buffer]);
  }

  private cancelSeparation() {
    if (this.separating) this.separator?.postMessage({ type: 'cancel' } satisfies ToSeparator);
    this.separating = false;
  }

  private useStems(stems: StemAudio, from: string) {
    this.player.loadStems(stems, ANALYSIS_SR);
    this.renderStemStrip();
    const names = (Object.keys(stems) as StemName[]).map((n) => STEM_LABEL[n].toLowerCase());
    this.stemsPending = true;
    this.setStemStatus(`Analyzing stems from ${from}: ${names.join(', ')}…`, false, true);
    const copy: StemAudio = {};
    for (const [k, v] of Object.entries(stems)) copy[k as StemName] = v.slice();
    this.send({ type: 'stems', stems: copy, sr: ANALYSIS_SR, params: this.params }, Object.values(copy).map((v) => v.buffer));
  }

  /** The banner above the timeline. No text hides it. */
  private setStemStatus(text = '', error = false, busy = false, fraction?: number) {
    const box = $('#stem-status');
    box.hidden = !text;
    box.classList.toggle('error', error);
    $('#stem-status-text').textContent = text;
    const bar = $<HTMLProgressElement>('#stem-progress');
    bar.hidden = fraction === undefined;
    if (fraction !== undefined) bar.value = fraction;
    $('#stem-cancel').hidden = !this.separating || !busy;
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
    this.worker.postMessage(msg, transfer);
  }

  private onWorker(msg: FromWorker) {
    if (msg.type === 'progress') {
      if (!$('#screen-progress').hidden) this.progress(msg.stage, msg.fraction);
    } else if (msg.type === 'error') {
      this.fail(`Analysis failed: ${msg.message}`);
    } else {
      const first = this.tracks.length === 0;
      this.mergeTracks(msg.tracks);
      const n = msg.tracks.filter((t) => t.source !== 'mix').length;
      if (this.stemsPending && n) {
        this.stemsPending = false;
        this.setStemStatus(`Added ${n} instrument tracks from the stems.`);
        setTimeout(() => { if (!this.separating && !this.stemsPending) this.setStemStatus(); }, 4000);
      }
      $('#file-name').textContent = this.fileName;
      $('#file-meta').textContent = `${formatTime(msg.duration)} · ${msg.bpm.toFixed(1)} BPM`;
      this.show('editor');
      if (first) this.timeline.fit();
      this.refresh();
    }
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
      include.addEventListener('change', () => { s.include = include.checked; this.renderExport(); });
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
        el('span', { class: 'lane-count' }, String(s.track.marks.length)),
        audition,
      );
      row.style.height = `${LANE_H}px`;
      row.style.setProperty('--hue', String(s.hue));
      const select = () => { this.selectedId = id; this.refresh(); };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
      heads.append(row);
    }
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

    const group = PARAM_GROUP[s.track.id];
    const sliders = group ? Object.entries(PARAM_RANGES[group]).map(([key, r]) => this.slider(group, key, r)) : [];
    const shared = group === 'beats' ? el('p', { class: 'muted small' }, 'Beats and Bars share these settings.') : '';

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
      ...sliders,
      shared,
      nudgeRow,
      el('div', { class: 'row actions' }, dup, del),
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
      return shift ? { ...s.track, marks: s.track.marks.map((m) => ({ ...m, start: m.start + shift, end: m.end + shift })) } : s.track;
    });
  }

  private renderExport() {
    const n = this.tracks.filter((s) => s.include).length;
    $('#export-count').textContent = `${n} of ${this.tracks.length} tracks selected`;
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
