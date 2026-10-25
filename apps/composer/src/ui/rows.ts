import type { Row } from '../model/types';
import type { Store } from '../state/store';
import { h, icon, ICONS } from './dom';
import { RULER_H } from './geometry';
import type { Timeline } from './timeline';

export type RowPanelHost = {
  store: Store;
  timeline: Timeline;
  filter: string;
  setFilter(q: string): void;
  openRowPicker(): void;
  addVirtualRow(): void;
  editRow(row: Row, patch: Partial<Row>, label: string): void;
};

/**
 * Left panel: headers for the pinned timing lanes (set the active snap track, hide a
 * track), then the row list, kept in step with the canvas rows (same heights, same scroll).
 */
export class RowPanel {
  private readonly heads: HTMLElement;
  private readonly list: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly foot: HTMLElement;
  private search!: HTMLInputElement;

  constructor(el: HTMLElement, private readonly host: RowPanelHost) {
    this.heads = h('div', { class: 'lane-heads' });
    this.inner = h('div', { class: 'row-list-inner' });
    this.list = h('div', { class: 'row-list' }, this.inner);
    this.foot = h('div', { class: 'row-foot', style: { display: 'flex', gap: '6px', padding: '6px', borderTop: '1px solid var(--line)' } });
    el.append(this.heads, this.list, this.foot);
    this.list.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) host.timeline.zoomAt(Math.exp(-e.deltaY * 0.0025));
      else host.timeline.scrollBy(e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    }, { passive: false });
    this.list.addEventListener('click', (e) => this.onClick(e));
    this.list.addEventListener('dblclick', (e) => this.onDouble(e));
    this.list.addEventListener('pointerdown', (e) => this.onGrip(e));
  }

  render() {
    const { store, timeline } = this.host;
    const p = store.project;
    // Lane heads: the first one hosts the row search (it sits beside the ruler).
    this.heads.replaceChildren();
    for (const lane of timeline.lanes) {
      if (lane.kind === 'ruler') {
        this.search = h('input', { type: 'text', placeholder: 'Find rows…', value: this.host.filter, 'aria-label': 'Find rows', oninput: (e: Event) => this.host.setFilter((e.target as HTMLInputElement).value) }) as HTMLInputElement;
        this.heads.append(h('div', { class: 'lane-head ruler', style: { height: `${RULER_H}px` } }, this.search));
      } else if (lane.kind === 'wave') {
        this.heads.append(h('div', { class: 'lane-head', style: { height: `${lane.h}px` } }, h('span', { class: 'name' }, p.audio.fileName)));
      } else if (lane.kind === 'sections') {
        this.heads.append(h('div', { class: 'lane-head', style: { height: `${lane.h}px` }, title: 'Click a section to jump there and select its effects. Double-click to zoom and loop it. Right-click to rename.' }, h('span', { class: 'name' }, `Sections${p.sections.length ? ` (${p.sections.length})` : ''}`)));
      } else {
        const t = lane.track;
        const eyeBtn = h('button', { class: 'mini-btn', title: lane.hidden ? 'Show track' : 'Hide track', 'data-hide': t.id }, icon(lane.hidden ? ICONS.eyeOff : ICONS.eye, 13));
        const head = h('div', {
          class: `lane-head track${lane.active ? ' active' : ''}${lane.hidden ? ' hidden-track' : ''}`,
          style: { height: `${lane.h}px` },
          title: lane.active ? `${t.name}: effects snap to this track` : `Click to snap to ${t.name}`,
          'data-track': t.id,
        }, h('span', { class: 'snapdot' }), h('span', { class: 'name' }, t.name), h('span', { class: 'faint small' }, String(t.marks.length)), eyeBtn);
        head.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-hide]')) {
            const hidden = p.view.hiddenTrackIds.includes(t.id) ? p.view.hiddenTrackIds.filter((x) => x !== t.id) : [...p.view.hiddenTrackIds, t.id];
            store.setView({ hiddenTrackIds: hidden });
          } else store.setView({ activeTrackId: t.id, hiddenTrackIds: p.view.hiddenTrackIds.filter((x) => x !== t.id) });
        });
        if (lane.hidden) head.style.fontSize = '10px';
        this.heads.append(head);
      }
    }
    this.heads.style.height = `${timeline.pinnedH}px`;
    this.renderRows();
    this.foot.replaceChildren(
      h('button', { class: 'btn small', onclick: () => this.host.openRowPicker(), title: p.layout ? 'Choose which models and groups from your layout get rows' : 'Load your xLights layout to pick models' }, icon(ICONS.rows, 14), 'Rows…'),
      h('button', { class: 'btn small', onclick: () => this.host.addVirtualRow(), title: 'A row with just a name, mapped to a model later' }, icon(ICONS.plus, 14), 'Add row'),
    );
  }

  renderRows() {
    const { store, timeline } = this.host;
    const sel = store.selectedRows;
    this.inner.replaceChildren();
    if (!timeline.slots.length) {
      const p = store.project;
      this.inner.append(h('div', { class: 'rows-empty' },
        this.host.filter ? 'No rows match.' : p.layout ? 'No rows shown. Use Rows… to pick models.' : 'No layout loaded. Add rows by name, or load xlights_rgbeffects.xml with Rows….'));
    }
    for (const s of timeline.slots) {
      const r = s.row;
      const caret = s.hasChildren ? h('span', { class: 'caret', 'data-expand': r.id, title: r.expanded ? 'Hide submodels' : 'Show submodels' }, r.expanded ? '▾' : '▸') : h('span', { class: 'caret' });
      const tools = h('span', { class: 'tools' },
        r.layers > 1 ? h('button', { class: 'mini-btn', 'data-collapse': r.id, title: r.collapsed ? 'Show layers' : 'Merge layers into one lane' }, `${r.layers}L`) : null,
        h('button', { class: `mini-btn${r.solo ? ' on' : ''}`, 'data-solo': r.id, title: 'Solo in preview' }, 'S'),
        h('button', { class: `mini-btn${r.muted ? ' on' : ''}`, 'data-mute': r.id, title: r.muted ? 'Show in preview' : 'Hide from preview (mute)' }, icon(r.muted ? ICONS.eyeOff : ICONS.eye, 13)),
        h('button', { class: `mini-btn${r.locked ? ' on' : ''}`, 'data-lock': r.id, title: r.locked ? 'Unlock row' : 'Lock row (no edits)' }, icon(r.locked ? ICONS.lock : ICONS.unlock, 13)),
      );
      const kind = r.kind === 'group' ? 'group' : r.kind === 'virtual' ? 'virtual' : r.kind === 'submodel' ? 'sub' : '';
      this.inner.append(h('div', {
        class: `row-head${sel.has(r.id) ? ' sel' : ''}${r.locked ? ' locked' : ''}${r.muted ? ' muted' : ''}${s.depth ? ' sub' : ''}`,
        style: { top: `${s.y}px`, height: `${s.h}px`, alignItems: s.lanes > 1 ? 'flex-start' : 'center', paddingTop: s.lanes > 1 ? `${(s.laneH - 16) / 2}px` : '0' },
        'data-row': r.id,
        title: r.modelRef && r.modelRef !== r.name ? `${r.name} → ${r.modelRef}` : r.name,
      }, caret, h('span', { class: 'dot', style: { background: r.color } }), h('span', { class: 'name' }, r.name), kind ? h('span', { class: 'kind' }, kind) : null, tools, h('span', { class: 'grip', 'data-grip': r.id })));
    }
    this.sync();
  }

  /** Follow the canvas's vertical scroll and lane heights. */
  sync() {
    this.inner.style.transform = `translateY(${-this.host.timeline.scrollY}px)`;
    this.inner.style.height = `${this.host.timeline.rowsHeight}px`;
  }

  focusSearch() {
    this.search?.focus();
    this.search?.select();
  }

  private rowOf(e: Event): Row | undefined {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-row]')?.dataset.row;
    return this.host.store.project.rows.find((r) => r.id === id);
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const row = this.rowOf(e);
    if (!row) return;
    const { store } = this.host;
    if (t.closest('[data-expand]')) return this.host.editRow(row, { expanded: !row.expanded }, row.expanded ? 'Hide submodels' : 'Show submodels');
    if (t.closest('[data-collapse]')) return this.host.editRow(row, { collapsed: !row.collapsed }, 'Merge layers');
    if (t.closest('[data-mute]')) return this.host.editRow(row, { muted: !row.muted }, row.muted ? 'Unmute row' : 'Mute row');
    if (t.closest('[data-solo]')) return this.host.editRow(row, { solo: !row.solo }, row.solo ? 'Unsolo row' : 'Solo row');
    if (t.closest('[data-lock]')) return this.host.editRow(row, { locked: !row.locked }, row.locked ? 'Unlock row' : 'Lock row');
    if (t.closest('[data-grip]')) return;
    if (e.shiftKey) {
      // Range select from the last selected row.
      const slots = this.host.timeline.slots;
      const last = slots.findIndex((s) => store.selectedRows.has(s.row.id));
      const here = slots.findIndex((s) => s.row.id === row.id);
      if (last >= 0) {
        const [a, b] = [Math.min(last, here), Math.max(last, here)];
        store.selectRows(slots.slice(a, b + 1).map((s) => s.row.id), 'add');
        return;
      }
    }
    const toggle = e.ctrlKey || e.metaKey;
    // A plain click moves the focus to the row: number keys then drop the brush on it.
    if (!toggle) store.select([]);
    store.selectRows([row.id], toggle ? 'toggle' : 'replace');
  }

  private onDouble(e: MouseEvent) {
    const row = this.rowOf(e);
    if (!row || (e.target as HTMLElement).closest('button')) return;
    // Double-click a row name: select all its effects.
    const ids = this.host.store.index.layers(row.id).flat().map((x) => x.id);
    this.host.store.select(ids);
  }

  private onGrip(e: PointerEvent) {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-grip]')?.dataset.grip;
    const row = id && this.host.store.project.rows.find((r) => r.id === id);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY, h0 = row.height;
    const el = e.target as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let height = h0;
    const move = (ev: PointerEvent) => {
      height = Math.max(14, Math.min(120, Math.round(h0 + (ev.clientY - y0) / Math.max(1, row.collapsed ? 1 : row.layers))));
      const head = el.parentElement!;
      head.style.height = `${height * (row.collapsed ? 1 : row.layers)}px`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (height !== h0) this.host.editRow(row, { height }, 'Row height');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
}
