import Bars from './metadata/Bars.json';
import Butterfly from './metadata/Butterfly.json';
import ColorWash from './metadata/ColorWash.json';
import Off from './metadata/Off.json';
import On from './metadata/On.json';
import Shimmer from './metadata/Shimmer.json';
import SingleStrand from './metadata/SingleStrand.json';
import Spirals from './metadata/Spirals.json';
import Twinkle from './metadata/Twinkle.json';
import { decodeSettings, encodeSettings, type EffectMeta, type ParamValue, type PropMeta } from './settings';

/**
 * The curated effects the composer creates. Each one exposes a handful of xLights'
 * parameters; everything else is written at xLights' defaults and tuned in xLights.
 * Adding an effect = vendoring its metadata JSON and adding an entry here.
 */
/** xLights' own effect names, as written in .xsq files. */
export type EffectType = 'On' | 'Color Wash' | 'Twinkle' | 'Shimmer' | 'Bars' | 'SingleStrand' | 'Spirals' | 'Butterfly' | 'Off';

export type ParamDef = {
  /** xLights property id, e.g. "Twinkle_Count". */
  id: string;
  label: string;
  kind: 'slider' | 'enum' | 'bool';
  min: number;
  max: number;
  step: number;
  default: ParamValue;
  options?: string[];
  unit?: string;
  meta: PropMeta;
};

export type EffectDef = {
  type: EffectType;
  /** Name shown in the composer. */
  label: string;
  /** Shortcut key in the effect bar (1-9, 0). */
  key: string;
  /** One-line hint for the effect bar tooltip. */
  hint: string;
  meta: EffectMeta;
  params: ParamDef[];
  /** Values the composer writes instead of xLights' defaults (e.g. Butterfly uses the palette). */
  fixed: Record<string, ParamValue>;
};

type Curated = { id: string; label?: string; default?: ParamValue; unit?: string };

function def(label: string, key: string, hint: string, metaJson: unknown, curated: Curated[], fixed: Record<string, ParamValue> = {}): EffectDef {
  const meta = metaJson as EffectMeta;
  const type = meta.effectName as EffectType;
  const params = curated.map((c): ParamDef => {
    const p = meta.properties.find((x) => x.id === c.id);
    if (!p) throw new Error(`${label} has no property ${c.id}`);
    const kind = p.type === 'bool' ? 'bool' : p.type === 'enum' ? 'enum' : 'slider';
    const div = p.divisor ?? 1;
    return {
      id: p.id,
      label: c.label ?? p.label,
      kind,
      min: p.min !== undefined ? p.min / div : 0,
      max: p.max !== undefined ? p.max / div : 1,
      step: p.type === 'float' ? 1 / div : 1,
      default: c.default ?? fixed[p.id] ?? p.default ?? (kind === 'bool' ? false : 0),
      options: p.options,
      unit: c.unit,
      meta: p,
    };
  });
  return { type, label, key, hint, meta, params, fixed };
}

export const EFFECTS: EffectDef[] = [
  def('On', '1', 'Solid color: pulses, accents, base fills', On, [
    { id: 'Eff_On_Start', label: 'Start brightness', unit: '%' },
    { id: 'Eff_On_End', label: 'End brightness', unit: '%' },
  ]),
  def('Color Wash', '2', 'Blends through the palette: section backgrounds', ColorWash, [
    { id: 'ColorWash_Cycles', label: 'Palette cycles' },
    { id: 'ColorWash_CircularPalette', label: 'Loop palette' },
  ]),
  def('Twinkle', '3', 'Random twinkling pixels: calm passages', Twinkle, [
    { id: 'Twinkle_Count', label: 'Density', unit: '%' },
    { id: 'Twinkle_Steps', label: 'Twinkle length' },
  ]),
  def('Shimmer', '4', 'Flickers on and off: cymbals, hats, tension', Shimmer, [
    { id: 'Shimmer_Cycles', label: 'Speed' },
    { id: 'Shimmer_Duty_Factor', label: 'Duty', unit: '%' },
  ]),
  def('Bars', '5', 'Moving color bars: builds, sweeps', Bars, [
    { id: 'Bars_Direction', label: 'Direction' },
    { id: 'Bars_BarCount', label: 'Bars' },
    { id: 'Bars_Cycles', label: 'Speed' },
  ]),
  def('Single Strand', '6', 'Chase along the string: running lights', SingleStrand, [
    { id: 'Chase_Type1', label: 'Direction' },
    { id: 'Color_Mix1', label: 'Chase size', unit: '%' },
    { id: 'Chase_Rotations', label: 'Speed' },
  ]),
  def('Spirals', '7', 'Rotating spirals: mega-tree motion', Spirals, [
    { id: 'Spirals_Count', label: 'Spirals' },
    { id: 'Spirals_Movement', label: 'Rotation speed' },
    { id: 'Spirals_Rotation', label: 'Twist' },
  ]),
  def('Butterfly', '8', 'Busy, colorful patterns: energetic choruses', Butterfly, [
    { id: 'Butterfly_Style', label: 'Style' },
    { id: 'Butterfly_Speed', label: 'Speed' },
  ], { Butterfly_Colors: 'Palette' }),
  def('Off', '0', 'Explicit blackout', Off, []),
];

export const EFFECT_BY_TYPE = new Map(EFFECTS.map((e) => [e.type, e]));

export function effectDef(type: string): EffectDef | undefined {
  return EFFECT_BY_TYPE.get(type as EffectType);
}

export function defaultParams(type: EffectType): Record<string, ParamValue> {
  const d = EFFECT_BY_TYPE.get(type)!;
  return Object.fromEntries(d.params.map((p) => [p.id, p.default]));
}

/** The xLights settings string for an effect with the given composer parameters and fades. */
export function effectSettings(type: EffectType, params: Record<string, ParamValue>, fadeInMs = 0, fadeOutMs = 0): string {
  const d = EFFECT_BY_TYPE.get(type);
  if (!d) throw new Error(`Unknown effect ${type}`);
  const values: Record<string, ParamValue> = { ...d.fixed };
  for (const p of d.params) if (params[p.id] !== undefined) values[p.id] = params[p.id];
  return encodeSettings(d.meta, values, { fadeInMs, fadeOutMs });
}

/**
 * Read an imported settings string into composer parameters. Null when the string uses
 * anything beyond the curated parameters (then the effect stays opaque, settings untouched).
 */
export function parseEffectSettings(type: string, settings: string): { params: Record<string, ParamValue>; fadeInMs: number; fadeOutMs: number } | null {
  const d = effectDef(type);
  if (!d) return null;
  const dec = decodeSettings(d.meta, settings);
  if (!dec) return null;
  const curated = new Set(d.params.map((p) => p.id));
  for (const [k, v] of Object.entries(dec.values)) {
    if (curated.has(k)) continue;
    const p = d.meta.properties.find((x) => x.id === k)!;
    const expected = d.fixed[k] ?? p.default;
    if (expected !== undefined && String(v) !== String(expected)) return null;
  }
  const params = Object.fromEntries(d.params.map((p) => [p.id, dec.values[p.id] ?? p.default]));
  // Must reproduce the original exactly, or keep it opaque.
  if (effectSettings(d.type, params, dec.fadeInMs, dec.fadeOutMs) !== settings) return null;
  return { params, fadeInMs: dec.fadeInMs, fadeOutMs: dec.fadeOutMs };
}
