import { computePeaks } from '@stemlight/audio/decode';
import { Player } from '@stemlight/audio/player';
import { migrateHistory, normalizeProject } from './model/project';
import type { Project } from './model/types';
import { loadAudio, loadProject, saveAudio, saveProject } from './state/persist';
import { Store, type History } from './state/store';
import { toast } from './ui/dom';
import { Editor } from './ui/editor';
import { StartScreen, type Song } from './ui/start';

/** Switches between the start screen and the editor; ?project=<id> reopens a project. */
export class App {
  private readonly player = new Player();
  private editor?: Editor;
  private start?: StartScreen;

  constructor(private readonly root: HTMLElement) {
    window.addEventListener('popstate', () => void this.route());
    window.addEventListener('pagehide', () => void this.editor?.saveNow());
  }

  async route() {
    const id = new URLSearchParams(location.search).get('project');
    if (id) await this.openRecent(id, false);
    else this.showStart();
  }

  private setUrl(id?: string) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('project', id); else url.searchParams.delete('project');
    if (url.href !== location.href) history.pushState(null, '', url);
  }

  showStart(relink?: { project: Project; resolve: (s: Song) => void }) {
    this.editor?.destroy();
    this.editor = undefined;
    this.start?.destroy();
    this.start = new StartScreen(this.root, {
      player: this.player,
      relink,
      openNew: (project, song) => {
        this.setUrl(project.id);
        this.openEditor(project, undefined, song.buffer);
      },
      openRecent: (id) => void this.openRecent(id),
    });
    if (!relink) this.setUrl();
  }

  async openRecent(id: string, push = true) {
    const loaded = await loadProject(id);
    if (!loaded) {
      toast('That project isn’t in this browser.');
      this.showStart();
      return;
    }
    const history = migrateHistory(loaded.history, loaded.project);
    const project = normalizeProject(loaded.project);
    if (push) this.setUrl(id);
    const stored = await loadAudio(project.audio.hash);
    let buffer: AudioBuffer | undefined;
    if (stored) {
      try { buffer = await this.player.ctx.decodeAudioData(stored.bytes.slice(0)); } catch { buffer = undefined; }
    }
    if (!buffer) {
      // The audio was cleared from this browser: ask for the song again.
      const song = await new Promise<Song>((resolve) => this.showStart({ project, resolve }));
      await saveAudio(song.hash, { name: song.file.name, type: song.file.type, bytes: song.bytes });
      project.audio = { ...project.audio, fileName: song.file.name, hash: song.hash };
      await saveProject(project, history ?? { undo: [], redo: [] });
      buffer = song.buffer;
    }
    this.openEditor(project, history, buffer);
  }

  private openEditor(project: Project, history: History | undefined, buffer: AudioBuffer) {
    this.start?.destroy();
    this.start = undefined;
    this.editor?.destroy();
    this.player.load(buffer);
    const store = new Store(project, history);
    // For debugging from the console (and UI tests): stemlightComposer.store.project
    (window as unknown as { stemlightComposer: unknown }).stemlightComposer = { store };
    this.editor = new Editor(this.root, store, this.player, computePeaks(buffer), () => this.showStart());
  }
}
