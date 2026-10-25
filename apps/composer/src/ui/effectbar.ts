import { defaultParams, effectDef, type EffectType } from '@stemlight/xlights/effects';
import type { ParamValue } from '@stemlight/xlights/settings';
import { colorName } from '../model/colors';
import type { Preset } from '../model/types';
import type { Store } from '../state/store';
import { h, swatches } from './dom';

/** Small glyphs that hint at what each effect does. */
const GLYPHS: Record<EffectType, string> = {
  On: '<rect x="4" y="5" width="16" height="10" rx="2" fill="currentColor"/>',
  'Color Wash': '<defs><linearGradient id="cw" x1="0" x2="1"><stop offset="0" stop-color="#f97316"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#22c55e"/></linearGradient></defs><rect x="3" y="5" width="18" height="10" rx="2" fill="url(#cw)"/>',
  Twinkle: '<g fill="currentColor"><circle cx="5" cy="6" r="1.6"/><circle cx="12" cy="4" r="1"/><circle cx="18" cy="8" r="1.8"/><circle cx="8" cy="13" r="1.2"/><circle cx="15" cy="14" r="1.5"/></g>',
  Shimmer: '<g fill="currentColor"><rect x="3" y="5" width="3" height="10"/><rect x="9" y="5" width="3" height="10" opacity=".35"/><rect x="15" y="5" width="3" height="10"/></g>',
  Bars: '<g fill="currentColor"><rect x="3" y="4" width="18" height="3"/><rect x="3" y="9" width="18" height="3" opacity=".5"/><rect x="3" y="14" width="18" height="3"/></g>',
  SingleStrand: '<g fill="currentColor"><circle cx="4" cy="10" r="1.5" opacity=".25"/><circle cx="8" cy="10" r="1.5" opacity=".45"/><circle cx="12" cy="10" r="1.5" opacity=".7"/><circle cx="16" cy="10" r="2"/><circle cx="20" cy="10" r="1.5" opacity=".25"/></g>',
  Spirals: '<path d="M12 10m-1 0a1 1 0 1 1 2 0a3 3 0 1 1-6 0a5 5 0 1 1 10 0a7 7 0 0 1-7 7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  Butterfly: '<path d="M12 10C8 3 3 4 4 9s6 3 8 1c2 2 7 4 8-1s-4-6-8 1z" fill="currentColor"/>',
  Off: '<rect x="4" y="5" width="16" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 14 19 6" stroke="currentColor" stroke-width="1.6"/>',
};

export type EffectBarHost = {
  store: Store;
  usePreset(key: string): void;
  savePreset(key: string): void;
  pickColor(hex: string, add: boolean): void;
  pickSet(id: string): void;
  editSet(): void;
};

type Shape = { type: EffectType; params: Record<string, ParamValue>; rampIn: number; rampOut: number };

/** A short name for a brush: "Fade out", "On 60%", "Twinkle (fade in)". */
export function brushName(b: Shape): string {
  const def = effectDef(b.type)!;
  let name = def.label;
  if (b.type === 'On') {
    const a = Number(b.params.Eff_On_Start ?? 100), z = Number(b.params.Eff_On_End ?? 100);
    name = a === z ? (a === 100 ? 'On' : `On ${a}%`) : a > z ? (z === 0 ? 'Fade out' : 'Dim down') : a === 0 ? 'Fade in' : 'Brighten';
  }
  const fades = [b.rampIn ? 'fade in' : '', b.rampOut ? 'fade out' : ''].filter(Boolean).join(', ');
  return fades ? `${name} (${fades})` : name;
}

/** The brightness over an effect's length, drawn as a tiny ramp on the preset button. */
function rampShape(b: Shape): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 40 8');
  s.setAttribute('class', 'ramp');
  let a = 1, z = 1;
  if (b.type === 'On') { a = Number(b.params.Eff_On_Start ?? 100) / 100; z = Number(b.params.Eff_On_End ?? 100) / 100; }
  if (b.type === 'Off') { a = 0; z = 0; }
  const fi = b.rampIn ? 10 : 0, fo = b.rampOut ? 10 : 0;
  const y = (v: number) => 8 - v * 7.5;
  s.innerHTML = `<path d="M0 8 L0 ${fi ? 8 : y(a)} L${fi} ${y(a + (z - a) * (fi / 40))} L${40 - fo} ${y(a + (z - a) * ((40 - fo) / 40))} L40 ${fo ? 8 : y(z)} L40 8 Z" fill="currentColor"/>`;
  return s;
}

/**
 * Bottom strip: the number-key presets (click to use, Shift+click to save the brush into
 * one) and the palettes.
 */
export class EffectBar {
  constructor(private readonly el: HTMLElement, private readonly host: EffectBarHost) {}

  render() {
    const p = this.host.store.project;
    const b = p.view.brush;
    const hasSel = this.host.store.selection.size > 0;
    const tip = (base: string) => hasSel ? `${base} (also applies to the selected effects)` : base;
    const glyph = (t: EffectType) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 24 20');
      s.innerHTML = GLYPHS[t];
      return s;
    };
    const same = (pr: Preset) => pr.type === b.type && pr.rampIn === b.rampIn && pr.rampOut === b.rampOut
      && (!pr.colors || pr.colors.join() === b.colors.join())
      && JSON.stringify({ ...defaultParams(pr.type), ...pr.params }) === JSON.stringify({ ...defaultParams(b.type), ...b.params });
    const set = p.colorSets.find((x) => x.id === p.view.colorSetId) ?? p.colorSets[0];
    const presets = [...p.view.presets].sort((x, y) => (x.key === '0' ? 10 : +x.key) - (y.key === '0' ? 10 : +y.key));
    const active = presets.find(same);
    this.el.replaceChildren(
      h('div', { class: 'brush-now', title: 'The active brush: what drag, double-click and D create. Change it in the inspector (click empty space), then Shift+click a key below to keep it.' },
        h('span', { class: 'bar-label' }, 'Brush'),
        h('div', { class: 'brush-card' },
          h('div', { class: 'bc-row' }, glyph(b.type), h('strong', {}, brushName(b))),
          h('div', { class: 'bc-row' }, swatches(b.colors), rampShape(b)),
          h('span', { class: 'faint' }, active ? `Key ${active.key} · D drops it` : 'D drops it'))),
      h('div', { class: 'fx-buttons', role: 'toolbar', 'aria-label': 'Presets' }, presets.map((pr) =>
        h('button', {
          class: `fx-btn${active === pr ? ' on' : ''}`,
          title: tip(`${pr.name}${pr.colors ? ` (${pr.colors.map(colorName).join(' + ')})` : ''}. Key ${pr.key}; drops on the selected rows at the playhead. Shift+click (or Shift+${pr.key}) saves the current brush here.`),
          onclick: (e: MouseEvent) => (e.shiftKey ? this.host.savePreset(pr.key) : this.host.usePreset(pr.key)),
          'aria-pressed': String(active === pr),
        }, h('kbd', {}, pr.key), glyph(pr.type), h('span', {}, pr.name), rampShape(pr),
          pr.colors ? h('i', { class: 'pal-dot', style: { background: pr.colors[0] } }) : ''))),
      h('div', { class: 'bar-colors' },
        h('select', { class: 'set-pick', title: 'Color set: the colors effects are picked from', 'aria-label': 'Color set', onchange: (e: Event) => { const sel = e.target as HTMLSelectElement; this.host.pickSet(sel.value); sel.blur(); } },
          p.colorSets.map((cs) => h('option', { value: cs.id, selected: cs === set }, cs.name))),
        h('div', { class: 'swatch-row', role: 'toolbar', 'aria-label': `${set.name} colors` }, set.colors.map((c) => {
          const on = b.colors.includes(c);
          return h('button', {
            class: `color-btn${on ? ' on' : ''}`, style: { background: c },
            title: tip(`${colorName(c)}. Shift+click adds it (or removes it) for multi-color effects.`), 'aria-label': colorName(c), 'aria-pressed': String(on),
            onclick: (e: MouseEvent) => this.host.pickColor(c, e.shiftKey),
          });
        })),
        h('button', { class: 'mini-btn', title: `Edit the ${set.name} colors`, onclick: () => this.host.editSet() }, '✎')),
    );
  }
}
