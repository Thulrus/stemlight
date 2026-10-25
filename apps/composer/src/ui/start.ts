import { downmix } from '@stemlight/audio/decode';
import type { Player } from '@stemlight/audio/player';
import { quantizeMarks } from '@stemlight/core/quantize';
import type { Track } from '@stemlight/core/types';
import { hashBytes } from '@stemlight/storage/idb';
import { parseLayout, type LayoutSnapshot } from '@stemlight/xlights/layout';
import { readTimingFile } from '@stemlight/xlights/timing';
import { newProject, timingTrack } from '../model/project';
import type { Mark, Project, TimingTrack } from '../model/types';
import { deleteProject, loadLastLayout, recentProjects, saveAudio, saveLastLayout, saveProject, type RecentEntry } from '../state/persist';
import { confirmDialog } from './dialogs';
import { formatTime, h, icon, ICONS, toast } from './dom';

export type Song = { file: File; bytes: ArrayBuffer; hash: string; buffer: AudioBuffer };

export type StartHost = {
  player: Player;
  /** Open a freshly created project (audio already decoded). */
  openNew(project: Project, song: Song): void;
  openRecent(id: string): void;
  /** Set when reopening a project whose audio isn't stored in this browser any more. */
  relink?: { project: Project; resolve: (song: Song) => void };
};

const AUDIO_RE = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i;
const isAudio = (f: File) => f.type.startsWith('audio/') || AUDIO_RE.test(f.name);

type PendingTrack = { name: string; layers: Mark[][]; source: TimingTrack['source']; from: string };

/**
 * Setup in one screen: drop the song (required), the layout and timing (optional), then
 * open the editor. Recent projects are listed underneath.
 */
export class StartScreen {
  private song?: Song;
  private layout?: { fileName: string; layout: LayoutSnapshot; remembered: boolean };
  private tracks = new Map<string, PendingTrack>();
  private frameMs: 25 | 50 = 50;
  private name = '';
  private busy = { song: '', timing: '' };
  private err = { song: '', layout: '', timing: '' };
  private recent: RecentEntry[] = [];
  private readonly el: HTMLElement;
  private readonly onDrop = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer?.files.length) void this.route([...e.dataTransfer.files]); };
  private readonly onDragOver = (e: DragEvent) => e.preventDefault();

  constructor(root: HTMLElement, private readonly host: StartHost) {
    this.el = h('div', { class: 'start' });
    root.replaceChildren(this.el);
    window.addEventListener('drop', this.onDrop);
    window.addEventListener('dragover', this.onDragOver);
    document.title = 'Stemlight Composer';
    void this.init();
  }

  destroy() {
    window.removeEventListener('drop', this.onDrop);
    window.removeEventListener('dragover', this.onDragOver);
  }

  private async init() {
    const last = await loadLastLayout();
    if (last && !this.layout) this.layout = { fileName: last.fileName, layout: last.layout, remembered: true };
    this.recent = await recentProjects();
    this.render();
  }

  /** Send dropped files to the right place by type. */
  private async route(files: File[]) {
    const audio = files.find(isAudio);
    if (audio) await this.loadSong(audio);
    for (const f of files) {
      if (/\.xml$/i.test(f.name)) await this.loadLayout(f);
      else if (/\.(xtiming|xsq)$/i.test(f.name)) await this.loadTiming(f);
      else if (f !== audio && !isAudio(f)) toast(`Not sure what to do with ${f.name}`);
    }
  }

  private async loadSong(file: File) {
    this.busy.song = 'Decoding…';
    this.err.song = '';
    this.render();
    try {
      const bytes = await file.arrayBuffer();
      const hash = await hashBytes(bytes);
      const buffer = await this.host.player.ctx.decodeAudioData(bytes.slice(0));
      this.song = { file, bytes, hash, buffer };
      if (!this.name || this.name === this.songName()) this.name = file.name.replace(/\.[^.]+$/, '');
      if (this.host.relink) {
        this.host.relink.resolve(this.song);
        return;
      }
    } catch (err) {
      this.err.song = `Couldn't read ${file.name} as audio (${(err as Error).message}).`;
    }
    this.busy.song = '';
    this.render();
  }

  private songName() { return this.song?.file.name.replace(/\.[^.]+$/, '') ?? ''; }

  private async loadLayout(file: File) {
    this.err.layout = '';
    try {
      const layout = parseLayout(await file.text());
      this.layout = { fileName: file.name, layout, remembered: false };
      void saveLastLayout({ fileName: file.name, savedAt: Date.now(), layout });
    } catch (err) {
      this.err.layout = `${file.name}: ${(err as Error).message}`;
    }
    this.render();
  }

  private async loadTiming(file: File) {
    this.err.timing = '';
    try {
      const timings = readTimingFile(await file.text());
      if (!timings.length) throw new Error('no timing tracks in it');
      for (const t of timings) {
        this.tracks.set(t.name, { name: t.name, layers: t.layers.map((l) => l.map((m) => ({ start: m.startMs, end: m.endMs, label: m.label }))), source: /\.xsq$/i.test(file.name) ? 'xsq' : 'xtiming', from: file.name });
      }
      toast(`${timings.length} timing track${timings.length > 1 ? 's' : ''} from ${file.name}`);
      if (/\.xsq$/i.test(file.name)) toast('Only the timing tracks of a sequence are imported for now; its effects stay in xLights.');
    } catch (err) {
      this.err.timing = `${file.name}: ${(err as Error).message}`;
    }
    this.render();
  }

  /** Beats, bars, sections and phrases in a few seconds, from the timing app's analysis (no models). */
  private async quickBeats() {
    if (!this.song) return;
    this.busy.timing = 'Listening…';
    this.render();
    try {
      const [{ default: AnalysisWorker }, { DEFAULT_BUILD_PARAMS }] = await Promise.all([
        import('@timing/analysis/worker?worker'),
        import('@timing/analysis/build'),
      ]);
      const sr = 22050;
      const mono = await downmix(this.song.buffer, sr);
      const worker: Worker = new AnalysisWorker();
      const tracks = await new Promise<Track[]>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          const m = e.data;
          if (m.type === 'progress') { this.busy.timing = `${m.stage}…`; this.render(); }
          else if (m.type === 'result') resolve(m.tracks);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage({ type: 'analyze', mono, sr, params: structuredClone(DEFAULT_BUILD_PARAMS) }, [mono.buffer]);
      });
      worker.terminate();
      const dur = this.song.buffer.duration;
      let n = 0;
      for (const t of tracks) {
        if (!t.marks.length) continue;
        const layers = [t.marks, ...(t.layers ?? [])].map((l) => quantizeMarks(l, this.frameMs, dur));
        this.tracks.set(t.name, { name: t.name, layers, source: 'quick', from: 'Quick beats' });
        n++;
      }
      toast(`${n} timing tracks from Quick beats`);
    } catch (err) {
      this.err.timing = `Quick beats failed: ${(err as Error).message}`;
    }
    this.busy.timing = '';
    this.render();
  }

  private async open() {
    const song = this.song;
    if (!song) return;
    const f = this.frameMs;
    const tracks: TimingTrack[] = [...this.tracks.values()].map((t) => timingTrack(t.name, t.layers, t.source, f));
    const project = newProject({
      name: this.name.trim() || this.songName() || 'Untitled',
      audio: { fileName: song.file.name, hash: song.hash, durationMs: Math.floor((song.buffer.duration * 1000) / f) * f },
      frameMs: f,
      tracks,
      layout: this.layout?.layout,
    });
    await saveAudio(song.hash, { name: song.file.name, type: song.file.type, bytes: song.bytes });
    await saveProject(project, { undo: [], redo: [] });
    this.destroy();
    this.host.openNew(project, song);
  }

  private zone(key: 'song' | 'layout' | 'timing', step: string, title: string, tag: string, accept: string, multiple: boolean, body: (Node | string | null)[], status: Node | string | null, done: boolean, onFiles: (fs: File[]) => void) {
    const input = h('input', { type: 'file', accept, multiple, onchange: (e: Event) => { const fs = [...((e.target as HTMLInputElement).files ?? [])]; if (fs.length) onFiles(fs); (e.target as HTMLInputElement).value = ''; } }) as HTMLInputElement;
    const el = h('div', {
      class: `drop${done ? ' done' : ''}`, role: 'button', tabindex: 0, 'aria-label': title,
      onclick: (e: Event) => { if (!(e.target as HTMLElement).closest('button, a, input')) input.click(); },
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
      ondragover: (e: DragEvent) => { e.preventDefault(); el.classList.add('over'); },
      ondragleave: () => el.classList.remove('over'),
      ondrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('over'); if (e.dataTransfer?.files.length) onFiles([...e.dataTransfer.files]); },
    }, h('h2', {}, h('span', { class: 'step' }, done ? '✓' : step), title, h('span', { class: 'tag' }, tag)), body, input,
      h('div', { class: `status${this.err[key] ? ' err' : ''}` }, this.err[key] || status));
    return el;
  }

  render() {
    const relink = this.host.relink;
    const song = this.song;
    const tracks = [...this.tracks.values()];
    const songZone = this.zone('song', '1', 'Song', 'required', 'audio/*,.mp3,.wav,.flac,.ogg,.m4a', false,
      [h('p', {}, relink ? `This project's audio (${relink.project.audio.fileName}) isn't stored in this browser any more. Drop the song to keep working.` : 'Drop an audio file: MP3, WAV, FLAC, OGG or M4A. It stays on this computer.')],
      this.busy.song || (song ? `${song.file.name} · ${formatTime(song.buffer.duration * 1000, false)}` : ''), !!song, (fs) => void this.loadSong(fs[0]));
    if (relink) {
      this.el.replaceChildren(h('div', { class: 'start-inner' }, this.header(), h('div', { class: 'drops', style: { gridTemplateColumns: '1fr' } }, songZone)));
      return;
    }
    const l = this.layout;
    const layoutZone = this.zone('layout', '2', 'Layout', 'optional', '.xml', false,
      [h('p', {}, 'Drop xlights_rgbeffects.xml from your show folder to get a row per model and group. Skip it to sequence on named rows and map them later.')],
      l ? h('div', {}, `${l.fileName}: ${l.layout.models.length} models, ${l.layout.groups.length} groups`, l.remembered ? h('span', { class: 'faint' }, ' (from last time) ') : ' ',
        h('button', { class: 'btn small ghost', onclick: () => { this.layout = undefined; this.render(); } }, 'Don’t use')) : '', !!l, (fs) => void this.loadLayout(fs[0]));
    const timingZone = this.zone('timing', '3', 'Timing', 'suggested', '.xtiming,.xsq', true,
      [h('p', {}, 'Drop .xtiming files (from Stemlight Timing or xLights), or an existing .xsq to reuse its timing tracks.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn small', disabled: !song || !!this.busy.timing, title: song ? 'Beats, bars, phrases and sections in a few seconds' : 'Drop the song first', onclick: () => void this.quickBeats() }, 'Quick beats'),
          h('a', { class: 'btn small ghost', href: '../timing/', target: '_blank', rel: 'noopener', title: 'Vocals, drums, notes and lyrics need the full analysis. Download the .xtiming there and drop it here.' }, 'More tracks in Stemlight Timing ↗'))],
      this.busy.timing || (tracks.length ? h('div', { class: 'chips' }, tracks.map((t) => h('span', { class: 'chip', title: t.from }, t.name))) : ''), tracks.length > 0, (fs) => { for (const f of fs) void this.loadTiming(f); });

    const nameInput = h('input', { type: 'text', value: this.name, placeholder: song ? this.songName() : 'Named after the song', oninput: (e: Event) => { this.name = (e.target as HTMLInputElement).value; },
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && song) void this.open(); } });
    const go = h('div', { class: 'start-go' },
      h('label', { class: 'field' }, h('span', {}, 'Project name'), nameInput),
      h('label', { class: 'field', style: { flex: '0 0 auto' } }, h('span', {}, 'Sequence timing'),
        h('select', { onchange: (e: Event) => { this.frameMs = Number((e.target as HTMLSelectElement).value) as 25 | 50; } },
          h('option', { value: 50, selected: this.frameMs === 50 }, '50 ms (xLights default)'), h('option', { value: 25, selected: this.frameMs === 25 }, '25 ms'))),
      h('button', { class: 'btn primary', disabled: !song, title: song ? '' : 'Drop the song first', onclick: () => void this.open() }, 'Open editor'));

    const recent = h('section', { class: 'recent' }, h('h2', {}, 'Recent projects'),
      this.recent.length ? h('div', { class: 'recent-list' }, this.recent.map((r) => h('div', { class: 'recent-item', role: 'button', tabindex: 0, onclick: (e: Event) => { if (!(e.target as HTMLElement).closest('.del')) this.host.openRecent(r.id); }, onkeydown: (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); this.host.openRecent(r.id); } } },
        r.thumb ? h('img', { src: r.thumb, alt: '' }) : h('div', { class: 'thumb' }),
        h('strong', {}, r.name),
        h('span', { class: 'small muted' }, `${formatTime(r.durationMs, false)} · ${r.rows} rows · ${r.effects} effects · ${new Date(r.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`),
        h('button', { class: 'btn small icon del', title: 'Delete project', 'aria-label': `Delete ${r.name}`, onclick: async () => {
          if (await confirmDialog('Delete project?', `"${r.name}" will be deleted from this browser. This can't be undone.`, 'Delete')) {
            await deleteProject(r.id);
            this.recent = this.recent.filter((x) => x.id !== r.id);
            this.render();
          }
        } }, icon(ICONS.trash, 14)))))
        : h('p', { class: 'empty-note' }, 'Projects you open are saved in this browser and listed here.'));

    this.el.replaceChildren(h('div', { class: 'start-inner' }, this.header(),
      h('p', { class: 'start-lede' }, 'Drop a song and start placing effects on its beats. Everything stays on this computer; export a .xsq for xLights when you’re done.'),
      h('div', { class: 'drops' }, songZone, layoutZone, timingZone), go, recent));
  }

  private header() {
    return h('div', { class: 'start-head' }, h('img', { src: '../favicon.svg', width: 28, height: 28, alt: '' }), h('h1', {}, 'Stemlight Composer'),
      h('span', { class: 'spacer', style: { flex: '1' } }), h('a', { href: '../' }, 'All Stemlight apps'));
  }
}
