import type { Player } from '@stemlight/audio/player';
import { defaultParams, effectDef, type EffectType } from '@stemlight/xlights/effects';
import { parseLayout } from '@stemlight/xlights/layout';
import type { ParamValue } from '@stemlight/xlights/settings';
import * as ops from '../model/ops';
import { colorName } from '../model/colors';
import { colorsForRow } from '../model/export';
import { makeRow, rowsFromLayout, uid } from '../model/project';
import { activeBoundaries } from '../model/snap';
import type { BrushState, Effect, Preset, Row, SnapMode } from '../model/types';
import { saveLastLayout, saveProject } from '../state/persist';
import type { Store } from '../state/store';
import { colorSetDialog, confirmDialog, exportDialog, keymapDialog, promptDialog, rowPickerDialog } from './dialogs';
import { formatTime, h, icon, ICONS, isTyping, toast } from './dom';
import { brushName, EffectBar } from './effectbar';
import { Inspector } from './inspector';
import { Preview } from './preview';
import { RowPanel } from './rows';
import { Timeline, type Peaks } from './timeline';

type Clip = { effects: Effect[]; rowOffset: Map<string, number>; t0: number };

export class Editor {
  readonly el: HTMLElement;
  private timeline!: Timeline;
  private rows!: RowPanel;
  private inspector!: Inspector;
  private bar!: EffectBar;
  private preview!: Preview;
  private workspace!: HTMLElement;
  private center!: HTMLElement;
  private timeEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private loopBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private saveEl!: HTMLElement;
  private snapSeg!: HTMLElement;
  private dragSeg!: HTMLElement;
  private nameBtn!: HTMLButtonElement;
  private filter = '';
  private loopRange: { start: number; end: number } | null = null;
  private loopOn = false;
  private clip?: Clip;
  private raf = 0;
  private saveTimer = 0;
  private unsub: () => void;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  constructor(root: HTMLElement, private readonly store: Store, private readonly player: Player, private readonly peaks: Peaks | undefined, private readonly onExit: () => void) {
    this.el = this.build();
    root.replaceChildren(this.el);
    this.mount();
    this.unsub = store.subscribe((ev) => this.onStore(ev));
    store.onDirty = () => this.scheduleSave();
    store.onNotice = (m) => toast(m);
    window.addEventListener('keydown', this.onKey);
    player.onEnded = () => this.syncTransport();
    this.tick();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.unsub();
    this.player.stop();
    this.timeline.destroy();
    void this.saveNow();
  }

  // ---------- layout ----------

  private build(): HTMLElement {
    const p = this.store.project;
    this.playBtn = h('button', { class: 'btn icon', title: 'Play / pause (Space)', onclick: () => this.togglePlay() }, icon(ICONS.play)) as HTMLButtonElement;
    this.timeEl = h('span', { class: 'mono time' });
    this.loopBtn = h('button', { class: 'btn icon', title: 'Loop (L): the selection, or the section at the playhead', onclick: () => this.toggleLoop() }, icon(ICONS.loop)) as HTMLButtonElement;
    const speed = h('select', { title: 'Playback speed (pitch drops at slower speeds)', onchange: (e: Event) => this.player.setPlaybackRate(Number((e.target as HTMLSelectElement).value)) },
      [1, 0.75, 0.5].map((r) => h('option', { value: r, selected: r === this.player.playbackRate }, `${r}×`)));
    this.snapSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Snapping' });
    this.dragSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Dragging on empty space' });
    this.undoBtn = h('button', { class: 'btn icon', onclick: () => this.undo() }, icon(ICONS.undo)) as HTMLButtonElement;
    this.redoBtn = h('button', { class: 'btn icon', onclick: () => this.redo() }, icon(ICONS.redo)) as HTMLButtonElement;
    this.saveEl = h('span', { class: 'save-state', 'aria-live': 'polite' }, 'Saved');
    this.nameBtn = h('button', { class: 'proj-name', title: 'Rename project', onclick: () => this.renameProjectPrompt() }, p.name) as HTMLButtonElement;
    const theme = h('button', { class: 'btn icon', title: 'Light / dark theme', onclick: () => this.toggleTheme() }, icon(document.documentElement.dataset.theme === 'light' ? ICONS.moon : ICONS.sun));
    const top = h('header', { class: 'topbar' },
      h('a', { class: 'brand-mini', href: './', title: 'All projects', onclick: (e: Event) => { e.preventDefault(); this.onExit(); } }, h('img', { src: '../favicon.svg', width: 18, height: 18, alt: '' }), 'Projects'),
      this.nameBtn,
      h('span', { class: 'sep' }),
      this.playBtn, this.timeEl, this.loopBtn, speed,
      h('span', { class: 'sep' }),
      h('span', { class: 'small muted' }, 'Drag'), this.dragSeg,
      h('span', { class: 'sep' }),
      h('span', { class: 'small muted' }, 'Snap'), this.snapSeg,
      h('span', { class: 'sep' }),
      this.undoBtn, this.redoBtn,
      h('span', { class: 'spacer' }),
      this.saveEl,
      h('button', { class: 'btn icon', title: 'Row list (Tab)', onclick: () => this.togglePanel('left') }, icon(ICONS.panelLeft)),
      h('button', { class: 'btn icon', title: 'Inspector (Tab)', onclick: () => this.togglePanel('right') }, icon(ICONS.panelRight)),
      h('button', { class: 'btn icon', title: 'Preview (P)', onclick: () => this.togglePanel('preview') }, icon(ICONS.preview)),
      theme,
      h('button', { class: 'btn icon', title: 'Keyboard shortcuts (?)', onclick: () => void keymapDialog() }, icon(ICONS.keyboard)),
      h('button', { class: 'btn primary', title: 'Export .xsq for xLights (Ctrl+E)', onclick: () => void this.export() }, icon(ICONS.download), 'Export'),
    );
    const left = h('aside', { class: 'left' });
    this.center = h('section', { class: 'center' });
    const right = h('aside', { class: 'right' });
    this.workspace = h('main', { class: 'workspace' }, left, this.center, right);
    const bar = h('footer', { class: 'effectbar' });
    const el = h('div', { class: 'editor' }, top, this.workspace, bar);
    (el as unknown as { parts: unknown }).parts = { left, right, bar };
    return el;
  }

  private mount() {
    const { left, right, bar } = (this.el as unknown as { parts: { left: HTMLElement; right: HTMLElement; bar: HTMLElement } }).parts;
    const store = this.store;
    this.timeline = new Timeline(this.center, {
      store,
      peaks: this.peaks,
      currentMs: () => this.player.currentTime * 1000,
      isPlaying: () => this.player.isPlaying,
      seek: (ms) => { this.player.seek(ms / 1000); this.preview?.invalidate(); },
      brush: (rowId) => this.brush(rowId),
      loop: () => (this.loopOn ? this.loopRange : null),
      setLoop: (r) => { this.loopRange = r; this.loopOn = !!r; this.syncTransport(); this.timeline.invalidate(); },
      rowFilter: () => this.filter,
      onView: () => this.rows?.sync(),
      onRename: (id, rect) => this.renameSection(id, rect),
      notice: (m) => toast(m),
    });
    const self = this;
    this.rows = new RowPanel(left, {
      store,
      timeline: this.timeline,
      get filter() { return self.filter; },
      setFilter: (q) => { this.filter = q; this.timeline.relayout(); this.rows.renderRows(); },
      openRowPicker: () => void this.openRowPicker(),
      addVirtualRow: () => void this.addVirtualRow(),
      editRow: (row, patch, label) => store.edit(label, (tx) => { tx.updateRow(row.id, patch); }),
    });
    this.inspector = new Inspector(right, {
      store,
      brush: () => this.brush(),
      setBrushType: (t) => this.pickType(t),
      pickColor: (hex, add) => this.pickColor(hex, add),
      setBrushParam: (id, v) => this.setBrushParam(id, v),
      setBrush: (patch) => this.setBrush(patch),
      editRow: (row, patch, label) => store.edit(label, (tx) => { tx.updateRow(row.id, patch); }),
      deleteRows: (ids) => void this.deleteRows(ids),
      renameProject: (n) => this.renameProject(n),
      visibleRows: () => this.timeline.slots.map((x) => x.row),
      moveSelectionToRow: (rowId) => this.moveSelectionToRow(rowId),
    });
    this.bar = new EffectBar(bar, { store, usePreset: (k) => this.usePreset(k), savePreset: (k) => this.savePreset(k), pickColor: (hex, add) => this.pickColor(hex, add), pickSet: (id) => this.store.setView({ colorSetId: id }), editSet: () => void this.editColorSet() });
    this.preview = new Preview(this.workspace, store, (rowId) => { store.selectRows([rowId]); this.timeline.revealRow(rowId); }, () => this.togglePanel('preview'));
    // Splitter for the row list width.
    const split = h('div', { class: 'splitter', title: 'Drag to resize' });
    left.append(split);
    split.addEventListener('pointerdown', (e) => {
      split.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => this.workspace.style.setProperty('--left-w', `${Math.max(160, Math.min(480, ev.clientX - left.getBoundingClientRect().left))}px`);
      const up = () => { split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
    });
    this.renderAll();
  }

  private renderAll() {
    this.timeline.relayout();
    this.rows.render();
    this.inspector.render();
    this.bar.render();
    this.preview.rebuild();
    this.syncTopbar();
    this.syncPanels();
  }

  private onStore(ev: string) {
    if (ev === 'project') {
      this.timeline.invalidate();
      this.inspector.render();
      this.preview.invalidate();
      this.syncTopbar();
    }
    if (ev === 'rows') {
      this.timeline.relayout();
      this.rows.render();
      this.preview.rebuild();
    }
    if (ev === 'view') {
      this.timeline.relayout();
      this.rows.render();
      this.bar.render();
      if (!this.store.selection.size) this.inspector.render();
      this.syncTopbar();
      this.syncPanels();
    }
    if (ev === 'selection') {
      this.timeline.invalidate();
      this.rows.renderRows();
      this.inspector.render();
      this.bar.render();
      this.preview.invalidate();
    }
  }

  private syncTopbar() {
    const p = this.store.project;
    this.nameBtn.textContent = p.name;
    this.undoBtn.disabled = !this.store.canUndo;
    this.redoBtn.disabled = !this.store.canRedo;
    this.undoBtn.title = this.store.canUndo ? `Undo ${this.store.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    this.redoBtn.title = this.store.canRedo ? `Redo ${this.store.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    const modes: [SnapMode, string, string][] = [
      ['marks', 'Marks', 'Snap to the active timing track (click a track name to pick it)'],
      ['any', 'All', 'Snap to the nearest mark on any visible track'],
      ['grid', '½', 'Snap to the active track and halfway between its marks'],
      ['off', 'Off', 'No snapping (frame grid only)'],
    ];
    this.snapSeg.replaceChildren(...modes.map(([m, label, tip]) => h('button', { class: p.view.snap === m ? 'on' : '', title: tip, onclick: () => this.store.setView({ snap: m }) }, label)));
    const drags: ['select' | 'draw', string, string][] = [
      ['select', 'Select', 'Dragging on empty space draws a selection box; Shift adds, Ctrl toggles (V)'],
      ['draw', 'Draw', 'Dragging on empty space draws an effect with the brush; Ctrl+drag still selects (B)'],
    ];
    this.dragSeg.replaceChildren(...drags.map(([m, label, tip]) => h('button', { class: p.view.dragMode === m ? 'on' : '', title: tip, onclick: () => this.store.setView({ dragMode: m }) }, label)));
    document.title = `${p.name} · Stemlight Composer`;
  }

  private syncPanels() {
    const v = this.store.project.view.panels;
    this.workspace.classList.toggle('no-left', !v.left);
    this.workspace.classList.toggle('no-right', !v.right);
    this.preview.el.hidden = !v.preview;
    this.preview.invalidate();
  }

  private syncTransport() {
    this.playBtn.replaceChildren(icon(this.player.isPlaying ? ICONS.pause : ICONS.play));
    this.loopBtn.classList.toggle('on', this.loopOn);
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    let t = this.player.currentTime * 1000;
    if (this.loopOn && this.loopRange && this.player.isPlaying && t >= this.loopRange.end) {
      this.player.seek(this.loopRange.start / 1000);
      t = this.loopRange.start;
    }
    this.timeEl.textContent = `${formatTime(t)} / ${formatTime(this.store.project.audio.durationMs, false)}`;
    this.preview.render(Math.round(t));
  };

  // ---------- brush ----------

  brush(rowId?: string): ops.Brush {
    const b = this.store.project.view.brush;
    const row = rowId ? this.store.project.rows.find((r) => r.id === rowId) : undefined;
    return { ...b, colors: colorsForRow(this.store.project, row?.id, b.colors) };
  }

  private setBrush(patch: Partial<BrushState>) {
    this.store.setView({ brush: { ...this.store.project.view.brush, ...patch } });
  }

  /** Change the brush's effect type; with effects selected, change theirs too. */
  private pickType(t: EffectType) {
    const b = this.store.project.view.brush;
    if (t !== b.type) this.setBrush({ type: t, params: {} });
    const ids = [...this.store.selection];
    if (ids.length) this.store.edit(`Change to ${effectDef(t)!.label}`, (tx) => { ops.patch(tx, ids, { type: t }); });
  }

  /**
   * A color from the color set. Click: it becomes the brush's (and the selected effects')
   * only color. Shift+click: add or remove it, for multi-color effects like washes and chases.
   */
  private pickColor(hex: string, add: boolean) {
    const toggle = (cols: string[]) => {
      if (!cols.includes(hex)) return [...cols, hex].slice(0, 8);
      return cols.length > 1 ? cols.filter((c) => c !== hex) : cols;
    };
    const b = this.store.project.view.brush;
    this.setBrush({ colors: add ? toggle(b.colors) : [hex] });
    const ids = [...this.store.selection];
    if (!ids.length) return;
    this.store.edit(add ? `Toggle ${colorName(hex)}` : `Color ${colorName(hex)}`, (tx) => {
      for (const id of ids) {
        const e = tx.get(id);
        if (e) ops.patch(tx, [id], { colors: add ? toggle(e.colors ?? []) : [hex] });
      }
    });
  }

  /** Edit the colors of the current set (a color picker per swatch). */
  private async editColorSet() {
    const p = this.store.project;
    const set = p.colorSets.find((x) => x.id === p.view.colorSetId) ?? p.colorSets[0];
    const colors = await colorSetDialog(set);
    if (!colors) return;
    this.store.edit(`Edit ${set.name} colors`, (tx) => { tx.setField('colorSets', tx.field('colorSets').map((x) => (x.id === set.id ? { ...x, colors } : x))); });
  }

  private setBrushParam(id: string, v: ParamValue) {
    const b = this.store.project.view.brush;
    this.setBrush({ params: { ...b.params, [id]: v } });
  }

  /** Make a preset the brush (keeping the current color unless the preset has its own). */
  private brushFromPreset(pr: Preset): BrushState {
    const b = this.store.project.view.brush;
    return { type: pr.type, params: { ...pr.params }, rampIn: pr.rampIn, rampOut: pr.rampOut, colors: [...(pr.colors ?? b.colors)] };
  }

  /**
   * A number key or preset button: the preset becomes the brush. With effects selected it is
   * applied to them; with rows selected it is dropped at the playhead.
   */
  private usePreset(key: string) {
    const pr = this.store.project.view.presets.find((x) => x.key === key);
    if (!pr) return;
    const brush = this.brushFromPreset(pr);
    this.store.setView({ brush });
    const ids = [...this.store.selection];
    if (ids.length) {
      this.store.edit(`Apply ${pr.name}`, (tx) => {
        ops.patch(tx, ids, { type: pr.type, params: { ...defaultParams(pr.type), ...pr.params }, rampIn: pr.rampIn, rampOut: pr.rampOut, colors: pr.colors });
      });
      return;
    }
    if (this.store.selectedRows.size) this.drop(pr.name);
  }

  /** Save the current brush into a number key (Shift+number, Shift+click a preset). */
  private savePreset(key: string) {
    const v = this.store.project.view;
    const b = v.brush;
    const old = v.presets.find((x) => x.key === key);
    const pal = b.colors.map(colorName).join(' + ');
    const name = `${brushName(b)}${pal ? ` · ${pal}` : ''}`;
    const preset: Preset = { key, name, type: b.type, params: { ...b.params }, rampIn: b.rampIn, rampOut: b.rampOut, colors: [...b.colors] };
    const presets = old ? v.presets.map((x) => (x.key === key ? preset : x)) : [...v.presets, preset];
    this.store.setView({ presets });
    toast(`Saved the brush to key ${key}: ${name}`, old ? { label: 'Undo', run: () => this.store.setView({ presets: v.presets }) } : undefined);
  }

  /**
   * Drop the brush on the selected rows, over the span between the marks around the playhead.
   * When stopped, the playhead then moves to the end of what was dropped, so repeated presses
   * lay down a run (one effect per beat, say).
   */
  private drop(label = 'Drop') {
    const store = this.store;
    const rows = this.timeline.slots.filter((s) => store.selectedRows.has(s.row.id)).map((s) => s.row.id);
    if (!rows.length) {
      toast('Click a row first: effects drop on the selected rows at the playhead.');
      return;
    }
    const t = this.player.currentTime * 1000;
    const b = activeBoundaries(store.project);
    const bounds = b.length ? b : [0, store.project.audio.durationMs];
    let end = -1;
    store.edit(label, (tx) => { rows.forEach((r) => {
      const e = ops.fillSpan(tx, r, t, this.brush(r), bounds);
      if (e) end = Math.max(end, e.endMs);
    }); return []; });
    // Leave nothing selected, so the next D or number key drops again rather than editing this one.
    store.select([]);
    if (end > 0 && !this.player.isPlaying) this.player.seek(end / 1000);
  }

  // ---------- transport ----------

  private togglePlay() {
    if (this.player.isPlaying) this.player.pause();
    else void this.player.play();
    this.syncTransport();
  }

  private toggleLoop() {
    if (this.loopOn) { this.loopOn = false; this.syncTransport(); this.timeline.invalidate(); return; }
    const sel = this.selected();
    const t = this.player.currentTime * 1000;
    const sec = this.store.project.sections.find((s) => t >= s.start && t < s.end);
    this.loopRange = sel.length
      ? { start: Math.min(...sel.map((e) => e.startMs)), end: Math.max(...sel.map((e) => e.endMs)) }
      : sec ? { start: sec.start, end: sec.end } : { start: this.timeline.viewStartMs, end: this.timeline.viewEndMs };
    this.loopOn = true;
    if (t < this.loopRange.start || t >= this.loopRange.end) this.player.seek(this.loopRange.start / 1000);
    this.syncTransport();
    this.timeline.invalidate();
    toast(`Looping ${formatTime(this.loopRange.start)} – ${formatTime(this.loopRange.end)}`);
  }

  // ---------- commands ----------

  private selected(): Effect[] {
    return [...this.store.selection].map((id) => this.store.project.effects[id]).filter((e): e is Effect => !!e);
  }

  private undo() {
    const l = this.store.undo();
    if (l) toast(`Undid: ${l}`);
  }

  private redo() {
    const l = this.store.redo();
    if (l) toast(`Redid: ${l}`);
  }

  private async export() {
    this.player.pause();
    this.syncTransport();
    await this.saveNow();
    const media = await exportDialog(this.store.project);
    if (media !== undefined) {
      if (media !== this.store.project.view.mediaPath) this.store.setView({ mediaPath: media });
      toast('Exported. Open it in xLights from your show folder.');
    }
  }

  private renameProject(name: string) {
    this.store.edit('Rename project', (tx) => { tx.setField('name', name); });
  }

  private async renameProjectPrompt() {
    const n = await promptDialog('Rename project', 'Name', this.store.project.name, 'Rename');
    if (n) this.renameProject(n);
  }

  private renameSection(id: string, rect: DOMRect) {
    const sec = this.store.project.sections.find((s) => s.id === id);
    if (!sec) return;
    const input = h('input', { type: 'text', class: 'rename-input', value: sec.label }) as HTMLInputElement;
    const c = this.center.getBoundingClientRect();
    Object.assign(input.style, { left: `${rect.left - c.left}px`, top: `${rect.top - c.top}px`, width: `${rect.width}px` });
    this.center.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove();
      if (save && v && v !== sec.label) {
        this.store.edit('Rename section', (tx) => { tx.setField('sections', this.store.project.sections.map((s) => (s.id === id ? { ...s, label: v } : s))); });
      }
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }

  private async addVirtualRow() {
    const name = await promptDialog('Add a row', 'Name (e.g. "Left arches"); map it to a model when you export', '', 'Add');
    if (!name) return;
    const sel = this.store.project.rows.findIndex((r) => this.store.selectedRows.has(r.id));
    const row = makeRow(name, 'virtual');
    this.store.edit('Add row', (tx) => {
      const rows = [...tx.rows];
      rows.splice(sel >= 0 ? sel + 1 : rows.length, 0, row);
      tx.setField('rows', rows);
    });
    this.store.selectRows([row.id]);
    this.timeline.revealRow(row.id);
  }

  private async deleteRows(ids: string[]) {
    const p = this.store.project;
    const all = new Set(ids);
    for (const r of p.rows) if (r.parentId && all.has(r.parentId)) all.add(r.id);
    const effects = Object.values(p.effects).filter((e) => all.has(e.rowId));
    if (effects.length && !(await confirmDialog('Remove rows?', `${all.size} row${all.size > 1 ? 's' : ''} and ${effects.length} effect${effects.length > 1 ? 's' : ''} will be removed. You can undo this.`, 'Remove'))) return;
    this.store.edit(all.size > 1 ? 'Remove rows' : 'Remove row', (tx) => {
      for (const e of effects) tx.del(e.id);
      tx.setField('rows', tx.rows.filter((r) => !all.has(r.id)));
      return [];
    });
    this.store.selectRows([]);
  }

  private async openRowPicker() {
    let layout = this.store.project.layout;
    if (!layout) {
      const file = await pickFile('.xml');
      if (!file) return;
      try {
        layout = parseLayout(await file.text());
      } catch (err) {
        toast(`That doesn't look like xlights_rgbeffects.xml (${(err as Error).message})`);
        return;
      }
      void saveLastLayout({ fileName: file.name, savedAt: Date.now(), layout });
      const l = layout;
      this.store.edit('Load layout', (tx) => { tx.setField('layout', l); });
    }
    const p = this.store.project;
    const current = new Set(p.rows.filter((r) => r.kind !== 'virtual' && r.modelRef).map((r) => r.modelRef!));
    const picked = await rowPickerDialog(layout, current.size ? current : new Set([...layout.groups.map((g) => g.name), ...layout.models.map((m) => m.name)]));
    if (!picked) return;
    const removed = p.rows.filter((r) => r.kind !== 'virtual' && r.modelRef && !picked.has(r.modelRef));
    const lost = Object.values(p.effects).filter((e) => removed.some((r) => r.id === e.rowId));
    if (lost.length && !(await confirmDialog('Remove rows?', `${removed.length} rows with ${lost.length} effects will be removed. You can undo this.`, 'Apply'))) return;
    // Rebuild in layout order, keeping existing rows (and their settings) where they still apply.
    const fresh = rowsFromLayout(layout, picked);
    const existing = new Map(p.rows.filter((r) => r.modelRef).map((r) => [r.modelRef!, r]));
    const idMap = new Map<string, string>();
    const rows: Row[] = fresh.map((r) => {
      const old = existing.get(r.modelRef!);
      if (old) idMap.set(r.id, old.id);
      return old ? { ...old } : r;
    }).map((r) => (r.parentId && idMap.has(r.parentId) ? { ...r, parentId: idMap.get(r.parentId) } : r));
    // Submodels picked without their parent model: keep them as top-level rows.
    const ids = new Set(rows.map((r) => r.id));
    for (const r of rows) if (r.parentId && !ids.has(r.parentId)) r.parentId = undefined;
    rows.push(...p.rows.filter((r) => r.kind === 'virtual'));
    this.store.edit('Choose rows', (tx) => {
      for (const e of lost) tx.del(e.id);
      tx.setField('rows', rows);
      return [];
    });
  }

  /** Move the selection so its top row lands on `rowId`, keeping the rows' spacing and the times. */
  private moveSelectionToRow(rowId: string) {
    const slots = this.timeline.slots;
    const pos = new Map(slots.map((x) => [x.row.id, x.index]));
    const sel = this.selected();
    const target = pos.get(rowId);
    if (!sel.length || target === undefined) return;
    const top = Math.min(...sel.map((e) => pos.get(e.rowId) ?? Infinity));
    const d = target - top;
    const name = slots[target].row.name;
    this.store.edit(`Move to ${name}`, (tx) => ops.move(tx, sel.map((e) => e.id), 0, (r) => slots[Math.max(0, Math.min(slots.length - 1, (pos.get(r) ?? 0) + d))].row.id));
    this.timeline.revealRow(rowId);
  }

  private copy() {
    const sel = this.selected();
    if (!sel.length) return;
    const pos = new Map(this.timeline.slots.map((s) => [s.row.id, s.index]));
    const top = Math.min(...sel.map((e) => pos.get(e.rowId) ?? 0));
    this.clip = {
      effects: sel.map((e) => ({ ...e })),
      rowOffset: new Map(sel.map((e) => [e.id, (pos.get(e.rowId) ?? top) - top])),
      t0: Math.min(...sel.map((e) => e.startMs)),
    };
    toast(`Copied ${sel.length} effect${sel.length > 1 ? 's' : ''}`);
  }

  private paste() {
    const c = this.clip;
    if (!c) return;
    const slots = this.timeline.slots;
    const target = slots.findIndex((s) => this.store.selectedRows.has(s.row.id));
    const base = target >= 0 ? target : slots.findIndex((s) => s.row.id === c.effects[0].rowId);
    if (base < 0) return;
    const t = this.player.currentTime * 1000;
    this.store.edit('Paste', (tx) => {
      const out: string[] = [];
      for (const e of c.effects) {
        const slot = slots[Math.min(slots.length - 1, base + (c.rowOffset.get(e.id) ?? 0))];
        const n = tx.place({ ...e, id: uid('e'), rowId: slot.row.id, layer: 0, startMs: t + e.startMs - c.t0, endMs: t + e.endMs - c.t0, source: 'manual', bindingId: undefined });
        if (n) out.push(n.id);
      }
      return out;
    });
  }

  private zoomToSelection() {
    const sel = this.selected();
    if (sel.length) this.timeline.zoomTo(Math.min(...sel.map((e) => e.startMs)), Math.max(...sel.map((e) => e.endMs)));
    else {
      const t = this.player.currentTime * 1000;
      const sec = this.store.project.sections.find((s) => t >= s.start && t < s.end);
      if (sec) this.timeline.zoomTo(sec.start, sec.end);
    }
  }

  private togglePanel(which: 'left' | 'right' | 'preview') {
    const v = this.store.project.view.panels;
    this.store.setView({ panels: { ...v, [which]: !v[which] } });
  }

  private toggleTheme() {
    const light = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    try { localStorage.setItem('stemlight-theme', light ? 'light' : 'dark'); } catch { /* ignore */ }
    this.timeline.invalidate();
    const btn = this.el.querySelector('.topbar button[title^="Light"]');
    btn?.replaceChildren(icon(light ? ICONS.moon : ICONS.sun));
  }

  // ---------- keyboard ----------

  private key(e: KeyboardEvent) {
    if (isTyping(e) || document.querySelector('dialog[open]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const store = this.store;
    const ids = [...store.selection];
    const bounds = () => activeBoundaries(store.project);
    const t = this.player.currentTime * 1000;
    const handled = () => e.preventDefault();

    if (ctrl) {
      switch (k.toLowerCase()) {
        case 'z': handled(); if (e.shiftKey) this.redo(); else this.undo(); return;
        case 'y': handled(); this.redo(); return;
        case 'a': {
          handled();
          const rows = store.selectedRows.size ? [...store.selectedRows] : store.project.rows.map((r) => r.id);
          store.select(rows.flatMap((r) => store.index.layers(r).flat().map((x) => x.id)));
          return;
        }
        case 'c': handled(); this.copy(); return;
        case 'x': handled(); this.copy(); store.edit('Cut', (tx) => { ops.remove(tx, ids); }); return;
        case 'v': handled(); this.paste(); return;
        case 'd': {
          handled();
          const sel = this.selected();
          if (!sel.length) return;
          const span = Math.max(...sel.map((x) => x.endMs)) - Math.min(...sel.map((x) => x.startMs));
          store.edit('Duplicate', (tx) => ops.move(tx, ids, span, (r) => r, { copy: true }));
          return;
        }
        case 'e': handled(); void this.export(); return;
        case 's': handled(); void this.saveNow().then(() => toast('Saved. (Projects save automatically after every change.)')); return;
        case 'arrowup': case 'arrowdown': {
          handled();
          const d = k === 'ArrowUp' ? -1 : 1;
          const pos = new Map(this.timeline.slots.map((s) => [s.row.id, s.index]));
          const slots = this.timeline.slots;
          store.edit('Move to row', (tx) => ops.move(tx, ids, 0, (r) => slots[Math.max(0, Math.min(slots.length - 1, (pos.get(r) ?? 0) + d))]?.row.id ?? r));
          return;
        }
      }
      return;
    }
    if (e.altKey) return;
    // Number keys: presets (Shift saves the brush to that key). D drops the brush.
    const digit = /^Digit(\d)$/.exec(e.code)?.[1];
    if (digit) {
      handled();
      if (e.shiftKey) this.savePreset(digit);
      else this.usePreset(digit);
      return;
    }
    switch (k) {
      case ' ': handled(); this.togglePlay(); return;
      case 'Enter': {
        handled();
        const sel = this.selected();
        void this.player.play(sel.length ? Math.min(...sel.map((x) => x.startMs)) / 1000 : undefined);
        this.syncTransport();
        return;
      }
      case 'Escape': this.timeline.cancelDrag(); store.select([]); store.selectRows([]); return;
      case 'Delete': case 'Backspace': handled(); if (ids.length) store.edit(ids.length > 1 ? 'Delete effects' : 'Delete effect', (tx) => { ops.remove(tx, ids); return []; }); return;
      case 'ArrowLeft': case 'ArrowRight': {
        handled();
        const d = k === 'ArrowLeft' ? -1 : 1;
        if (!ids.length) {
          // No selection: move the playhead to the previous/next mark.
          const b = bounds();
          const next = d > 0 ? b.find((x) => x > t + 1) : [...b].reverse().find((x) => x < t - 1);
          if (next !== undefined) this.player.seek(next / 1000);
          return;
        }
        if (e.shiftKey) store.edit('Nudge', (tx) => { ops.nudgeFrames(tx, ids, d); });
        else store.edit('Nudge to mark', (tx) => { ops.nudgeToMark(tx, ids, d as -1 | 1, bounds()); });
        return;
      }
      case '[': case ']': case '{': case '}': {
        handled();
        const d = k === '[' || k === '{' ? -1 : 1;
        store.edit('Move edge', (tx) => { ops.edgeToMark(tx, ids, e.shiftKey ? 'end' : 'start', d, bounds()); });
        return;
      }
    }
    switch (k.toLowerCase()) {
      case 'e': handled(); store.edit(e.shiftKey ? 'Shrink to mark' : 'Extend to mark', (tx) => { ops.edgeToMark(tx, ids, 'end', e.shiftKey ? -1 : 1, bounds()); }); return;
      case 's': {
        handled();
        if (e.shiftKey) store.edit('Split at marks', (tx) => { ops.splitAtMarks(tx, ids, bounds()); });
        else store.edit('Split', (tx) => ops.splitAt(tx, ids, t));
        return;
      }
      case 'm': handled(); store.edit('Merge', (tx) => ops.merge(tx, ids)); return;
      case 'd': handled(); this.drop(); return;
      case 'v': handled(); store.setView({ dragMode: 'select' }); return;
      case 'b': handled(); store.setView({ dragMode: 'draw' }); return;
      case 'g': handled(); store.edit('Close gaps', (tx) => { ops.closeGaps(tx, ids); }); return;
      case 'c': handled(); if (ids.length) store.edit('Apply colors', (tx) => { ops.patch(tx, ids, { colors: store.project.view.brush.colors }); }); return;
      case 'l': handled(); this.toggleLoop(); return;
      case 'z': handled(); if (e.shiftKey) this.timeline.fitAll(); else this.zoomToSelection(); return;
      case 'p': handled(); this.togglePanel('preview'); return;
      case 'tab': {
        handled();
        const v = store.project.view.panels;
        const show = !(v.left || v.right);
        store.setView({ panels: { ...v, left: show, right: show } });
        return;
      }
      case '/': handled(); this.rows.focusSearch(); return;
      case '?': handled(); void keymapDialog(); return;
    }
  }

  // ---------- saving ----------

  private scheduleSave() {
    this.saveEl.textContent = 'Saving…';
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 1000);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    const ok = await saveProject(this.store.project, this.store.history, thumbnail(this.store));
    this.saveEl.textContent = ok ? 'Saved' : 'Not saved';
    this.saveEl.title = ok ? 'Saved in this browser' : 'This browser refused to store the project (private window or storage full). Export to keep your work.';
  }
}

/** A small picture of the sequence for the recent-projects list. */
function thumbnail(store: Store): string | undefined {
  try {
    const p = store.project;
    const c = document.createElement('canvas');
    c.width = 240; c.height = 48;
    const g = c.getContext('2d')!;
    g.fillStyle = '#12151a';
    g.fillRect(0, 0, 240, 48);
    const rows = p.rows.filter((r) => !r.hidden);
    const rh = 48 / Math.max(1, rows.length);
    rows.forEach((r, i) => {
      for (const e of store.index.layers(r.id).flat()) {
        g.fillStyle = e.colors?.[0] ?? '#888';
        g.fillRect((e.startMs / p.audio.durationMs) * 240, i * rh, Math.max(1, ((e.endMs - e.startMs) / p.audio.durationMs) * 240), Math.max(1, rh - 0.5));
      }
    });
    return c.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

export function pickFile(accept: string, multiple = false): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple }) as HTMLInputElement;
    input.addEventListener('change', () => resolve(input.files?.[0]));
    input.addEventListener('cancel', () => resolve(undefined));
    input.click();
  });
}
