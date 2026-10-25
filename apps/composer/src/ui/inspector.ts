import { EFFECTS, effectDef, type EffectType, type ParamDef } from '@stemlight/xlights/effects';
import type { ParamValue } from '@stemlight/xlights/settings';
import * as ops from '../model/ops';
import type { BrushState, Effect, Project, Row } from '../model/types';
import { brushName } from './effectbar';
import { colorName } from '../model/colors';
import type { Store } from '../state/store';
import { formatTime, h } from './dom';

export type InspectorHost = {
  store: Store;
  setBrushType(type: EffectType): void;
  pickColor(hex: string, add: boolean): void;
  setBrushParam(id: string, v: ParamValue): void;
  setBrush(patch: Partial<BrushState>): void;
  brush(): ops.Brush;
  editRow(row: Row, patch: Partial<Row>, label: string): void;
  deleteRows(ids: string[]): void;
  renameProject(name: string): void;
  visibleRows(): Row[];
  moveSelectionToRow(rowId: string): void;
};

const fmtParam = (p: ParamDef, v: ParamValue) => p.kind === 'bool' ? (v ? 'on' : 'off') : p.kind === 'enum' ? String(v) : `${Number(v).toFixed(p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0)}${p.unit ?? ''}`;

const parseTime = (s: string): number | undefined => {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  return Math.round(((m[1] ? Number(m[1]) * 60 : 0) + Number(m[2])) * 1000);
};

/**
 * The right panel. With effects selected: type, colors, the curated parameters, fades and
 * times (mixed values marked). With only rows selected: row settings. Otherwise the brush
 * and project details. Re-rendered on selection changes, not on every frame.
 */
export class Inspector {
  constructor(private readonly el: HTMLElement, private readonly host: InspectorHost) {}

  render() {
    const { store } = this.host;
    const p = store.project;
    const effects = [...store.selection].map((id) => p.effects[id]).filter((e): e is Effect => !!e);
    const content = effects.length ? this.effectsView(effects, p) : store.selectedRows.size ? this.rowsView(p) : this.projectView(p);
    // Keep focus in a field the user is typing in.
    const active = document.activeElement as HTMLElement | null;
    const key = active?.dataset?.key;
    this.el.replaceChildren(h('div', { class: 'inspector' }, content));
    if (key) (this.el.querySelector(`[data-key="${key}"]`) as HTMLElement | null)?.focus();
  }

  private edit(label: string, fn: (ids: string[]) => ops.EffectPatch) {
    const ids = [...this.host.store.selection];
    this.host.store.edit(label, (tx) => { ops.patch(tx, ids, fn(ids)); });
  }

  private typeGrid(current: string | undefined, onPick: (t: EffectType) => void) {
    return h('div', { class: 'type-grid' }, EFFECTS.map((d) =>
      h('button', { class: current === d.type ? 'on' : '', title: `${d.hint} (${d.key})`, onclick: () => onPick(d.type) }, d.label)));
  }

  /**
   * The current color set as buttons. `state` says whether each color is on all of the
   * effects ('on'), some of them ('part') or none. Colors outside the set are listed after.
   */
  private colorPicker(colorsOf: string[][]) {
    const p = this.host.store.project;
    const set = p.colorSets.find((x) => x.id === p.view.colorSetId) ?? p.colorSets[0];
    const all = (c: string) => colorsOf.every((cs) => cs.includes(c));
    const some = (c: string) => colorsOf.some((cs) => cs.includes(c));
    const others = [...new Set(colorsOf.flat())].filter((c) => !set.colors.includes(c));
    const btn = (c: string) => h('button', {
      class: `color-btn${all(c) ? ' on' : some(c) ? ' part' : ''}`, style: { background: c },
      title: `${colorName(c)}. Shift+click adds or removes it.`, 'aria-label': colorName(c),
      onclick: (e: MouseEvent) => this.host.pickColor(c, e.shiftKey),
    });
    return h('div', { style: { display: 'grid', gap: '6px' } },
      h('div', { class: 'insp-colors' }, set.colors.map(btn)),
      others.length ? h('div', { class: 'sub' }, 'Not in this set: ', h('span', { class: 'insp-colors', style: { display: 'inline-flex', verticalAlign: 'middle' } }, others.map(btn))) : '',
      h('div', { class: 'sub' }, `${set.name} set. Click a color to use it; Shift+click to add another (washes and chases blend between them).`));
  }

  private paramControl(p: ParamDef, value: ParamValue, mixed: boolean, onChange: (v: ParamValue, commit: boolean) => void) {
    const out = h('output', {}, mixed ? '' : fmtParam(p, value));
    let ctl: HTMLElement;
    if (p.kind === 'enum') {
      ctl = h('select', { 'data-key': p.id, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value, true) },
        mixed ? h('option', { value: '', selected: true, disabled: true }, 'mixed') : null,
        (p.options ?? []).map((o) => h('option', { value: o, selected: !mixed && o === value }, o)));
    } else if (p.kind === 'bool') {
      ctl = h('input', { type: 'checkbox', 'data-key': p.id, checked: !mixed && !!value, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked, true) });
      return h('label', { class: `param${mixed ? ' mixed' : ''}`, style: { gridTemplateColumns: 'auto 1fr' } }, ctl, h('span', {}, p.label));
    } else {
      ctl = h('input', {
        type: 'range', min: p.min, max: p.max, step: p.step, value: Number(value), 'data-key': p.id,
        oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); out.textContent = fmtParam(p, v); onChange(v, false); },
        onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value), true),
      });
    }
    return h('label', { class: `param${mixed ? ' mixed' : ''}` }, h('span', {}, p.label), out, ctl);
  }

  private effectsView(effects: Effect[], p: Project) {
    const types = new Set(effects.map((e) => e.type));
    const type = types.size === 1 ? effects[0].type : undefined;
    const def = type ? effectDef(type) : undefined;
    const single = effects.length === 1 ? effects[0] : undefined;
    const opaque = effects.filter((e) => !effectDef(e.type));
    const rows = new Set(effects.map((e) => e.rowId));
    const rowName = rows.size === 1 ? p.rows.find((r) => r.id === effects[0].rowId)?.name : `${rows.size} rows`;
    const parts: Node[] = [
      h('div', {}, h('h3', {}, single ? (def?.label ?? single.type) : `${effects.length} effects`), h('div', { class: 'sub' }, rowName ?? '', single?.source === 'binding' ? ' · bound' : '')),
    ];
    parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Effect'),
      this.typeGrid(type, (t) => this.edit(`Change to ${effectDef(t)!.label}`, () => ({ type: t }))),
      opaque.length ? h('p', { class: 'sub', style: { margin: 0 } }, `${opaque.length === effects.length ? 'This is' : `${opaque.length} are`} an xLights effect the composer doesn't edit (${[...new Set(opaque.map((e) => e.type))].join(', ')}). It can be moved, resized and copied, and keeps its xLights settings.`) : null));
    if (def && def.params.length) {
      parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Parameters'),
        def.params.map((prm) => {
          const vals = new Set(effects.map((e) => String(e.params[prm.id] ?? prm.default)));
          const v = effects[0].params[prm.id] ?? prm.default;
          let pending: ParamValue | undefined;
          return this.paramControl(prm, v, vals.size > 1, (nv, commit) => {
            pending = nv;
            if (commit && pending !== undefined) this.edit(`Change ${prm.label.toLowerCase()}`, () => ({ params: { [prm.id]: pending! } }));
          });
        })));
    }
    if (!opaque.length) {
      const fin = new Set(effects.map((e) => e.ramp?.in ?? 0)), fout = new Set(effects.map((e) => e.ramp?.out ?? 0));
      const fadeField = (label: string, vals: Set<number>, key: 'rampIn' | 'rampOut') =>
        h('label', {}, label, h('input', {
          type: 'number', min: 0, step: p.frameMs, 'data-key': key, placeholder: vals.size > 1 ? 'mixed' : '', value: vals.size > 1 ? '' : [...vals][0],
          onchange: (e: Event) => { const v = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); this.edit(key === 'rampIn' ? 'Fade in' : 'Fade out', () => ({ [key]: v })); },
        }));
      parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Fades (ms)'),
        h('div', { class: 'times', style: { gridTemplateColumns: '1fr 1fr' } }, fadeField('Fade in', fin, 'rampIn'), fadeField('Fade out', fout, 'rampOut')),
        h('div', { class: 'sub' }, 'Or drag the dots at the top corners of a selected effect.')));
    }
    parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Colors'), this.colorPicker(effects.map((e) => e.colors ?? []))));
    const rowList = this.host.visibleRows();
    const firstRow = rowList.find((r) => rows.has(r.id));
    parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, rows.size > 1 ? 'Move to rows' : 'Move to row'),
      h('select', { 'data-key': 'move-row', 'aria-label': 'Move the selection to a row', onchange: (e: Event) => this.host.moveSelectionToRow((e.target as HTMLSelectElement).value) },
        rowList.map((r) => h('option', { value: r.id, selected: r === firstRow }, r.name))),
      h('div', { class: 'sub' }, rows.size > 1 ? 'The top row of the selection goes to the row picked; the others keep their spacing. Or drag the selection, or press Ctrl+↑/↓.' : 'Or drag the selection up or down, or press Ctrl+↑/↓.')));
    if (single) {
      const timeField = (label: string, value: number, key: string, apply: (v: number) => [number, number]) =>
        h('label', {}, label, h('input', {
          type: 'text', value: formatTime(value), 'data-key': key, spellcheck: false,
          onchange: (e: Event) => {
            const v = parseTime((e.target as HTMLInputElement).value);
            if (v === undefined) { (e.target as HTMLInputElement).value = formatTime(value); return; }
            const [s, en] = apply(v);
            this.host.store.edit('Set time', (tx) => { ops.setTimes(tx, single.id, s, en); });
          },
        }));
      parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Time'),
        h('div', { class: 'times' },
          timeField('Start', single.startMs, 't-start', (v) => [v, Math.max(v + p.frameMs, single.endMs)]),
          timeField('End', single.endMs, 't-end', (v) => [single.startMs, v]),
          timeField('Length', single.endMs - single.startMs, 't-len', (v) => [single.startMs, single.startMs + v]))));
    } else {
      const lo = Math.min(...effects.map((e) => e.startMs)), hi = Math.max(...effects.map((e) => e.endMs));
      parts.push(h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Time'), h('div', { class: 'sub mono' }, `${formatTime(lo)} – ${formatTime(hi)}`)));
    }
    return parts;
  }

  private rowsView(p: Project) {
    const rows = p.rows.filter((r) => this.host.store.selectedRows.has(r.id));
    if (rows.length !== 1) {
      return [h('h3', {}, `${rows.length} rows`), h('p', { class: 'sub' }, 'D (or a number key) drops the brush on these rows at the playhead. Clicking a section selects its effects on these rows.'),
        h('button', { class: 'btn small', onclick: () => this.host.deleteRows(rows.map((r) => r.id)) }, 'Remove rows')];
    }
    const r = rows[0];
    const count = this.host.store.index.layers(r.id).reduce((n, l) => n + l.length, 0);
    const model = p.layout?.models.find((m) => m.name === r.modelRef);
    const group = p.layout?.groups.find((g) => g.name === r.modelRef);
    return [
      h('div', {}, h('h3', {}, h('span', { class: 'swatches', style: { width: '10px', background: r.color } }), r.name), h('div', { class: 'sub' }, `${r.kind}${model ? ` · ${model.displayAs} · ${model.pixels} px` : ''}${group ? ` · ${group.members.length} members` : ''} · ${count} effects`)),
      r.kind === 'virtual' ? h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: r.name, 'data-key': 'row-name', onchange: (e: Event) => this.host.editRow(r, { name: (e.target as HTMLInputElement).value.trim() || r.name }, 'Rename row') })) : null,
      h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Row'),
        h('label', { class: 'param', style: { gridTemplateColumns: '1fr auto' } }, h('span', {}, 'Color'), h('input', { type: 'color', value: r.color, onchange: (e: Event) => this.host.editRow(r, { color: (e.target as HTMLInputElement).value }, 'Row color') })),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn small', onclick: () => this.host.editRow(r, { layers: r.layers + 1, collapsed: false }, 'Add layer') }, 'Add layer'),
          h('button', { class: 'btn small', disabled: r.layers <= 1 || this.host.store.index.layer(r.id, r.layers - 1).length > 0, title: 'Removes the last layer when it is empty', onclick: () => this.host.editRow(r, { layers: r.layers - 1 }, 'Remove layer') }, 'Remove layer'),
          h('button', { class: 'btn small', onclick: () => this.host.deleteRows([r.id]) }, 'Remove row'))),
    ];
  }

  private projectView(p: Project) {
    const b = this.host.brush();
    const vb = p.view.brush;
    const def = effectDef(b.type)!;
    const effects = Object.keys(p.effects).length;
    return [
      h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Project'), h('input', { type: 'text', value: p.name, 'data-key': 'proj-name', onchange: (e: Event) => this.host.renameProject((e.target as HTMLInputElement).value.trim() || p.name) }))),
      h('div', { class: 'insp-section' }, h('div', { class: 'title' }, `Brush: ${brushName(vb)}`),
        h('p', { class: 'sub', style: { margin: 0 } }, 'What drag, double-click and D create. Set it up here, then Shift+click a key in the bar (or press Shift+1…9) to keep it on that key.'),
        this.typeGrid(b.type, (t) => this.host.setBrushType(t)),
        def.params.map((prm) => this.paramControl(prm, b.params[prm.id] ?? prm.default, false, (v, commit) => { if (commit) this.host.setBrushParam(prm.id, v); })),
        h('div', { class: 'times', style: { gridTemplateColumns: '1fr 1fr' } },
          h('label', {}, 'Fade in (ms)', h('input', { type: 'number', min: 0, step: p.frameMs, value: vb.rampIn, 'data-key': 'brush-in', onchange: (e: Event) => this.host.setBrush({ rampIn: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) }) })),
          h('label', {}, 'Fade out (ms)', h('input', { type: 'number', min: 0, step: p.frameMs, value: vb.rampOut, 'data-key': 'brush-out', onchange: (e: Event) => this.host.setBrush({ rampOut: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) }) }))),
        this.colorPicker([vb.colors])),
      h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Getting around'),
        h('ul', { class: 'hint-list small' },
          h('li', {}, 'Click a row, then press D to drop the brush on the beat at the playhead. Keep pressing D to fill beat after beat.'),
          h('li', {}, 'Number keys pick a preset (2 is Fade out) and drop it the same way.'),
          h('li', {}, 'Drag on empty space to box-select (or switch Drag to Draw to draw effects); double-click to fill between marks.'),
          h('li', {}, 'Effects snap to the highlighted timing track. Click a track name to change it; hold Shift to place freely.'),
          h('li', {}, 'Drag a selection to move it, even to other rows; Alt+drag copies. Drag edges to resize.'),
          h('li', {}, 'Drop more .xtiming files here any time to add timing tracks.'),
          h('li', {}, 'Space plays; arrows nudge to the next mark. Press ? for every key.'))),
      h('div', { class: 'insp-section' }, h('div', { class: 'title' }, 'Song'),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Audio'), h('dd', {}, p.audio.fileName),
          h('dt', {}, 'Length'), h('dd', {}, formatTime(p.audio.durationMs)),
          h('dt', {}, 'Timing'), h('dd', {}, `${p.frameMs} ms frames`),
          h('dt', {}, 'Layout'), h('dd', {}, p.layout ? `${p.layout.models.length} models, ${p.layout.groups.length} groups` : 'none'),
          h('dt', {}, 'Rows'), h('dd', {}, String(p.rows.length)),
          h('dt', {}, 'Effects'), h('dd', {}, String(effects)))),
    ];
  }
}
