import { DEFAULT_PARAMS, type MixParams } from '../analysis/analyze';
import type { FromWorker, ToWorker } from '../analysis/protocol';
import { computePeaks, decodeFile } from '../audio/decode';
import { Player } from '../audio/player';
import { quantizeMarks, type MsMark } from '../core/quantize';
import type { GridMs, Track } from '../core/types';
import { ANALYSIS_SR } from '../dsp/features';
import { fileSafeName, toXTiming } from '../export/xtiming';
import { tracksToZip } from '../export/zip';
import { formatTime, LANE_H, RULER_H, Timeline, WAVE_H } from './timeline';

/** Which MixParams group feeds each generated track. */
const PARAM_GROUP: Record<string, keyof MixParams> = {
  'mix-beats': 'beats', 'mix-bars': 'beats', 'mix-onsets': 'onsets',
  'mix-sections': 'sections', 'mix-phrases': 'phrases', 'mix-energy': 'energy',
};

type Range = { label: string; min: number; max: number; step: number; hint: string };
const PARAM_RANGES: Record<keyof MixParams, Record<string, Range>> = {
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
  private params: MixParams = structuredClone(DEFAULT_PARAMS);
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
    $('#new-file').addEventListener('click', () => this.show('drop'));
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
    input.addEventListener('change', () => { if (input.files?.[0]) void this.load(input.files[0]); input.value = ''; });
    for (const ev of ['dragenter', 'dragover']) {
      document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragging'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragging'); });
    }
    document.addEventListener('drop', (e) => {
      const f = [...((e as DragEvent).dataTransfer?.files ?? [])].find((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(f.name));
      if (f) void this.load(f);
    });
  }

  private async load(file: File) {
    this.show('progress');
    this.progress(`Decoding ${file.name}`, 0.02);
    $('#progress-error').hidden = true;
    try {
      const { buffer, mono } = await decodeFile(file, this.player.ctx);
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
      this.params = structuredClone(DEFAULT_PARAMS);
      this.progress('Analyzing', 0.1);
      this.send({ type: 'analyze', mono, sr: ANALYSIS_SR, params: this.params }, [mono.buffer]);
    } catch (err) {
      this.fail(err instanceof Error ? `Could not decode this file: ${err.message}` : 'Could not decode this file.');
    }
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
        el('span', { class: 'lane-name', title: s.track.name }, s.track.name),
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

  private slider(group: keyof MixParams, key: string, r: Range) {
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
