import { applyChange, isEmptyChange, Tx, type Change } from '../model/change';
import { EffectIndex } from '../model/effectIndex';
import type { Project, ViewState } from '../model/types';

export const HISTORY_LIMIT = 500;

export type StoreEvent = 'project' | 'view' | 'selection' | 'rows';
export type History = { undo: Change[]; redo: Change[] };

/**
 * The single project store. The project is immutable: every edit is a Change committed
 * here, which updates the effect index incrementally, records undo history and triggers
 * autosave. View state (zoom, active track, panels) is saved but not undoable.
 */
export class Store {
  project: Project;
  readonly index: EffectIndex;
  private undoStack: Change[];
  private redoStack: Change[];
  /** Selected effect ids. */
  selection = new Set<string>();
  /** Selected row ids (target of number-key drops, section selection, inspector). */
  selectedRows = new Set<string>();
  private listeners = new Set<(e: StoreEvent) => void>();
  /** Called (debounced by the owner) whenever something worth saving changed. */
  onDirty?: () => void;
  /** Called when an edit was refused (e.g. locked rows). */
  onNotice?: (msg: string) => void;

  constructor(project: Project, history?: History) {
    this.project = project;
    this.index = new EffectIndex(project.effects);
    this.undoStack = history?.undo ?? [];
    this.redoStack = history?.redo ?? [];
  }

  get history(): History { return { undo: this.undoStack, redo: this.redoStack }; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent) {
    for (const fn of this.listeners) fn(e);
  }

  tx(): Tx {
    return new Tx(this.project, this.index);
  }

  /**
   * Commit a transaction as one undoable step. `select` sets the effect selection
   * afterwards (defaults to keeping the current one, minus deleted effects).
   */
  commit(tx: Tx, label: string, select?: string[]): Change | null {
    if (tx.lockedHit) this.onNotice?.('Locked rows were left unchanged.');
    const before = [...this.selection];
    const c = tx.commit(label);
    if (isEmptyChange(c)) return null;
    this.project = applyChange(this.project, c, 'forward', this.index);
    const after = select ?? before.filter((id) => this.project.effects[id]);
    c.selection = [before, after];
    this.undoStack.push(c);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.splice(0, this.undoStack.length - HISTORY_LIMIT);
    this.redoStack = [];
    this.selection = new Set(after);
    this.emit('project');
    // Rows and timing tracks change the layout (the lanes and rows on screen).
    if (c.fields.rows || c.fields.timingTracks) this.emit('rows');
    this.onDirty?.();
    return c;
  }

  /** Build and commit in one go. */
  edit(label: string, fn: (tx: Tx) => string[] | void): Change | null {
    const tx = this.tx();
    const sel = fn(tx);
    return this.commit(tx, label, sel ?? undefined);
  }

  undo(): string | undefined {
    const c = this.undoStack.pop();
    if (!c) return undefined;
    this.project = applyChange(this.project, c, 'back', this.index);
    this.redoStack.push(c);
    this.selection = new Set((c.selection?.[0] ?? []).filter((id) => this.project.effects[id]));
    this.emit('project');
    // Rows and timing tracks change the layout (the lanes and rows on screen).
    if (c.fields.rows || c.fields.timingTracks) this.emit('rows');
    this.onDirty?.();
    return c.label;
  }

  redo(): string | undefined {
    const c = this.redoStack.pop();
    if (!c) return undefined;
    this.project = applyChange(this.project, c, 'forward', this.index);
    this.undoStack.push(c);
    this.selection = new Set((c.selection?.[1] ?? []).filter((id) => this.project.effects[id]));
    this.emit('project');
    // Rows and timing tracks change the layout (the lanes and rows on screen).
    if (c.fields.rows || c.fields.timingTracks) this.emit('rows');
    this.onDirty?.();
    return c.label;
  }

  setView(patch: Partial<ViewState>) {
    this.project = { ...this.project, view: { ...this.project.view, ...patch } };
    this.emit('view');
    this.onDirty?.();
  }

  select(ids: Iterable<string>, mode: 'replace' | 'add' | 'toggle' = 'replace') {
    if (mode === 'replace') this.selection = new Set(ids);
    else for (const id of ids) {
      if (mode === 'toggle' && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit('selection');
  }

  selectRows(ids: Iterable<string>, mode: 'replace' | 'add' | 'toggle' = 'replace') {
    if (mode === 'replace') this.selectedRows = new Set(ids);
    else for (const id of ids) {
      if (mode === 'toggle' && this.selectedRows.has(id)) this.selectedRows.delete(id);
      else this.selectedRows.add(id);
    }
    this.emit('selection');
  }

  /** Notify listeners after a change made outside commit (e.g. replacing the project on load). */
  touch(e: StoreEvent = 'project') {
    this.emit(e);
  }
}
