import type { LayoutSnapshot } from '@stemlight/xlights/layout';
import { COLOR_SETS, type ColorSet } from '../model/colors';
import { exportXsq } from '../model/export';
import type { Project } from '../model/types';
import { download, fileSafe, h } from './dom';

/** Show a <dialog> and resolve with its return value when it closes. */
function show(content: HTMLElement): Promise<string> {
  const dlg = h('dialog', {}, content);
  document.body.append(dlg);
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { resolve(dlg.returnValue); dlg.remove(); });
  });
}

export function confirmDialog(title: string, body: string, ok = 'OK'): Promise<boolean> {
  return show(h('form', { method: 'dialog', class: 'dlg' }, h('h2', {}, title), h('p', { class: 'muted', style: { margin: 0 } }, body),
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok', autofocus: true }, ok)))).then((v) => v === 'ok');
}

export async function promptDialog(title: string, label: string, value = '', ok = 'OK'): Promise<string | undefined> {
  const input = h('input', { type: 'text', value, autofocus: true, required: true }) as HTMLInputElement;
  const v = await show(h('form', { method: 'dialog', class: 'dlg' }, h('h2', {}, title), h('label', { class: 'field' }, h('span', {}, label), input),
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, ok))));
  return v === 'ok' ? input.value.trim() || undefined : undefined;
}

/** Export: media file name, validation, download. Returns the media path the user chose. */
export async function exportDialog(p: Project): Promise<string | undefined> {
  const media = h('input', { type: 'text', value: p.view.mediaPath ?? p.audio.fileName, spellcheck: false }) as HTMLInputElement;
  const report = h('div', {});
  const btn = h('button', { class: 'btn primary', value: 'ok' }, 'Download .xsq') as HTMLButtonElement;
  const refresh = () => {
    const { report: r } = exportXsq(p, { mediaFile: media.value.trim() || p.audio.fileName });
    report.replaceChildren(h('div', { style: { display: 'grid', gap: '8px' } },
      h('p', { style: { margin: 0 } }, `${r.effectCount} effects, ${r.rowCount} rows, ${p.timingTracks.length + (p.sections.length ? 1 : 0)} timing tracks, ${p.frameMs} ms timing.`),
      r.errors.length ? h('ul', { class: 'issues err' }, r.errors.slice(0, 8).map((e) => h('li', {}, e))) : null,
      r.warnings.length ? h('ul', { class: 'issues muted' }, r.warnings.map((e) => h('li', {}, e))) : null,
    ));
    btn.disabled = r.errors.length > 0;
  };
  media.addEventListener('input', refresh);
  refresh();
  const v = await show(h('form', { method: 'dialog', class: 'dlg' },
    h('h2', {}, 'Export to xLights'),
    h('label', { class: 'field' }, h('span', {}, 'Media file'), media,
      h('span', { class: 'small faint' }, 'Just the file name lets xLights find the song in your show folder. Type a full path if it lives elsewhere.')),
    report,
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Save the file into your show folder and open it in xLights (File → Open Sequence), then render.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), btn)));
  if (v !== 'ok') return undefined;
  const mediaFile = media.value.trim() || p.audio.fileName;
  const { xml, report: r } = exportXsq(p, { mediaFile });
  if (r.errors.length) return undefined;
  download(`${fileSafe(p.name)}.xsq`, xml, 'application/xml');
  return mediaFile;
}

/** Pick which layout elements get rows. Resolves with the chosen names, or undefined. */
export async function rowPickerDialog(layout: LayoutSnapshot, current: Set<string>): Promise<Set<string> | undefined> {
  const boxes: HTMLInputElement[] = [];
  const item = (name: string, sub = '') => {
    const cb = h('input', { type: 'checkbox', checked: current.has(name), value: name }) as HTMLInputElement;
    boxes.push(cb);
    return h('label', {}, cb, h('span', {}, name), sub ? h('span', { class: 'faint small' }, sub) : null);
  };
  const setAll = (pred: (name: string) => boolean, on: boolean) => { for (const b of boxes) if (pred(b.value)) b.checked = on; };
  const groups = new Set(layout.groups.map((g) => g.name));
  const subs = new Set(layout.models.flatMap((m) => m.submodels.map((s) => `${m.name}/${s}`)));
  const v = await show(h('form', { method: 'dialog', class: 'dlg' },
    h('h2', {}, 'Rows'),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Choose the groups, models and submodels to sequence. Unchecking a row removes it and its effects (you can undo).'),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'btn small', type: 'button', onclick: () => setAll((n) => groups.has(n), true) }, 'All groups'),
      h('button', { class: 'btn small', type: 'button', onclick: () => setAll((n) => !groups.has(n) && !subs.has(n), true) }, 'All models'),
      h('button', { class: 'btn small', type: 'button', onclick: () => setAll((n) => subs.has(n), true) }, 'All submodels'),
      h('button', { class: 'btn small', type: 'button', onclick: () => setAll(() => true, false) }, 'None')),
    h('div', { class: 'picker' },
      layout.groups.length ? h('div', { class: 'grp' }, 'Groups') : null,
      layout.groups.map((g) => item(g.name, `${g.members.length} members`)),
      h('div', { class: 'grp' }, 'Models'),
      layout.models.map((m) => [item(m.name, m.displayAs), m.submodels.map((s) => h('div', { style: { paddingLeft: '20px' } }, item(`${m.name}/${s}`, 'submodel')))])),
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, 'Apply'))));
  if (v !== 'ok') return undefined;
  return new Set(boxes.filter((b) => b.checked).map((b) => b.value));
}

/** A shortcut: keys (shown as key caps, alternatives split by " / ") or a mouse gesture. */
type Shortcut = { keys?: string; mouse?: string; what: string };
const k = (keys: string, what: string): Shortcut => ({ keys, what });
const m = (mouse: string, what: string): Shortcut => ({ mouse, what });

export const KEYMAP: [string, Shortcut[]][] = [
  ['Playback', [
    k('Space', 'Play / pause'),
    k('Enter', 'Play from the selection'),
    k('Home', 'Playhead to the start'),
    k('← / →', 'Playhead to the previous / next mark (nothing selected)'),
    k('L', 'Loop the selection, or the section at the playhead'),
  ]],
  ['Placing effects', [
    m('Click an empty spot', 'Select the row and move the playhead there'),
    k('D', 'Drop the brush on the selected rows at the playhead (repeat to fill beat after beat)'),
    k('1–9 / 0', 'Use a preset: drop it on the selected rows, or apply it to the selected effects'),
    k('Shift+1–9 / Shift+0', 'Save the brush to that key'),
    m('Drag on a row (Draw)', 'Draw an effect, snapped'),
    m('Double-click a row', 'Fill between the surrounding marks'),
    k('C', 'Apply the brush colors to the selection'),
    m('Shift+click a color', 'Add or remove a color (multi-color effects)'),
  ]],
  ['Selecting', [
    k('V / B', 'Dragging on empty space selects (V) or draws (B)'),
    m('Drag on empty space', 'Box select; Shift adds, Ctrl toggles'),
    m('Ctrl+drag', 'Box select in either mode'),
    m('Double-click a row name', 'Select all its effects'),
    m('Click a section', 'Jump there and select its effects (on the selected rows, if any)'),
    k('Ctrl+A', 'Select all effects (on the selected rows)'),
    k('Esc', 'Clear the selection'),
  ]],
  ['Editing', [
    m('Drag a selected effect', 'Move the selection, to other rows too'),
    m('Alt+drag', 'Duplicate'),
    m('Alt+click an effect', 'Split it at the click'),
    m('Ctrl+drag an edge', 'Stretch the selection'),
    m('Shift while dragging', 'No snapping'),
    k('← / →', 'Nudge the selection to the previous / next mark'),
    k('Shift+← / Shift+→', 'Nudge by one frame'),
    k('[ / ]', 'Start edge to the previous / next mark (Shift: end edge)'),
    k('E / Shift+E', 'Extend to the next mark / shrink to the previous one'),
    k('S', 'Split at the playhead'),
    k('Shift+S', 'Split at every mark'),
    k('M', 'Merge the selected effects on a row'),
    k('G', 'Close the gaps after the selected effects'),
    k('Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / cut / paste at the playhead'),
    k('Ctrl+D', 'Duplicate right after the selection'),
    k('Ctrl+↑ / Ctrl+↓', 'Move the selection one row'),
    k('Delete', 'Delete the selection'),
    k('Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'),
  ]],
  ['View', [
    k('Z / Shift+Z', 'Zoom to the selection / the whole song'),
    m('Ctrl+scroll', 'Zoom at the pointer'),
    m('Shift+scroll', 'Scroll in time'),
    m('Middle-drag', 'Pan'),
    k('Tab', 'Show / hide the side panels'),
    k('P', 'Show / hide the preview'),
    k('/', 'Find rows'),
    k('Ctrl+E', 'Export .xsq'),
    k('?', 'This list'),
  ]],
];

const keyCaps = (keys: string) => h('span', { class: 'keys' },
  keys.split(' / ').map((alt, i) => [i ? h('span', { class: 'faint' }, '/') : null, h('kbd', {}, alt)]));

export function keymapDialog(): Promise<string> {
  return show(h('form', { method: 'dialog', class: 'dlg wide' }, h('h2', {}, 'Keyboard and mouse'),
    h('div', { class: 'keymap' }, KEYMAP.map(([group, items]) => h('section', {},
      h('h3', {}, group),
      items.map((x) => h('div', { class: 'km-row' }, h('span', {}, x.what), x.keys ? keyCaps(x.keys) : h('span', { class: 'gesture' }, x.mouse)))))),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', value: 'ok', autofocus: true }, 'Close'))));
}

/** Edit a color set: a color picker per color, add or remove colors (1-10), reset to built-in. */
export async function colorSetDialog(set: ColorSet): Promise<string[] | undefined> {
  let colors = [...set.colors];
  const grid = h('div', { class: 'set-edit' });
  const builtIn = COLOR_SETS.find((x) => x.id === set.id);
  const draw = () => {
    grid.replaceChildren(
      ...colors.map((c, i) => h('div', { class: 'set-color' },
        h('input', { type: 'color', value: c, 'aria-label': `Color ${i + 1}`, oninput: (e: Event) => { colors[i] = (e.target as HTMLInputElement).value.toLowerCase(); } }),
        h('button', { type: 'button', class: 'mini-btn', title: 'Remove', disabled: colors.length <= 1, onclick: () => { colors.splice(i, 1); draw(); } }, '✕'))),
      colors.length < 10 ? h('button', { type: 'button', class: 'btn small', onclick: () => { colors.push('#ffffff'); draw(); } }, '+ Add') : '',
    );
  };
  draw();
  const v = await show(h('form', { method: 'dialog', class: 'dlg' },
    h('h2', {}, `${set.name} colors`),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Click a color to change it. Effects already placed keep their colors.'),
    grid,
    h('div', { class: 'actions' },
      builtIn ? h('button', { type: 'button', class: 'btn ghost', style: { marginRight: 'auto' }, onclick: () => { colors = [...builtIn.colors]; draw(); } }, 'Reset') : '',
      h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, 'Save'))));
  return v === 'ok' ? colors : undefined;
}
