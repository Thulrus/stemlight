/**
 * Effect settings strings ("E_SLIDER_Twinkle_Count=10,T_CHECKBOX_Canvas=0,…"), driven by
 * xLights' own effect metadata (resources/effectmetadata/*.json) so key names, value
 * formats and defaults come from xLights rather than from memory. The key rules mirror
 * src-ui-wx/effectpanels/JsonEffectPanel.cpp (2026.17):
 *
 * - int slider: E_SLIDER_<id> (E_TEXTCTRL_<id> when settingPrefix is TEXTCTRL)
 * - float slider (divisor > 1): E_TEXTCTRL_<id> as a decimal, or E_SLIDER_<id> holding
 *   value × divisor when settingPrefix is SLIDER
 * - checkbox: E_CHECKBOX_<id> = 0/1; choice: E_CHOICE_<id>; spin: E_SPINCTRL_<id>; text: E_TEXTCTRL_<id>
 * - properties with suppressIfDefault are left out while at their default
 *
 * Keys are written in byte order, as xLights' std::map does.
 */

export type PropMeta = {
  id: string;
  label: string;
  type: 'int' | 'float' | 'bool' | 'enum' | 'string' | 'color' | 'file' | 'font';
  controlType: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  divisor?: number;
  settingPrefix?: string;
  suppressIfDefault?: boolean;
  options?: string[];
  platform?: 'ipad' | 'desktop';
  description?: string;
};

export type TabGroupMeta = { type: 'tabs'; tabs: { label: string; properties: string[] }[]; settingKey?: string; persistSelection?: boolean };
export type EffectMeta = { effectName: string; properties: PropMeta[]; groups?: ({ type: string } | TabGroupMeta)[] };

/**
 * Tab groups whose selected page is stored in the settings (e.g. Single Strand's
 * E_NOTEBOOK_SSEFFECT_TYPE=Chase). Value is the selected tab's label; xLights writes the
 * first tab unless the user picked another.
 */
function notebooks(meta: EffectMeta): { key: string; tabs: string[] }[] {
  const out: { key: string; tabs: string[] }[] = [];
  for (const g of meta.groups ?? []) {
    if (g.type !== 'tabs') continue;
    const t = g as TabGroupMeta;
    if (t.settingKey && t.persistSelection !== false && t.tabs.length) out.push({ key: t.settingKey, tabs: t.tabs.map((x) => x.label) });
  }
  return out;
}

export type ParamValue = number | string | boolean;

/** The layer-blending settings xLights writes on every effect (fixture, 2026.17). */
const BLEND_DEFAULTS: Record<string, string> = {
  T_CHECKBOX_Canvas: '0',
  T_CHECKBOX_LayerMorph: '0',
  T_CHOICE_LayerMethod: 'Normal',
  T_SLIDER_EffectLayerMix: '0',
};
const FADE_IN = 'T_TEXTCTRL_Fadein';
const FADE_OUT = 'T_TEXTCTRL_Fadeout';

/** The settings key for a property, or undefined when it isn't stored in the settings string. */
export function settingKey(p: PropMeta): string | undefined {
  if (p.platform === 'ipad') return undefined;
  const div = p.divisor ?? 1;
  switch (p.controlType) {
    case 'slider':
      if (div > 1) return p.settingPrefix === 'SLIDER' ? `E_SLIDER_${p.id}` : `E_TEXTCTRL_${p.id}`;
      return p.settingPrefix === 'TEXTCTRL' ? `E_TEXTCTRL_${p.id}` : `E_SLIDER_${p.id}`;
    case 'checkbox': return `E_CHECKBOX_${p.id}`;
    case 'choice': return `E_CHOICE_${p.id}`;
    case 'spin': return `E_SPINCTRL_${p.id}`;
    case 'text': return `E_TEXTCTRL_${p.id}`;
    default: return undefined;
  }
}

/** Decimal places xLights shows for a float divisor (10 → 1, 100 → 2). */
const decimals = (div: number) => Math.max(0, Math.round(Math.log10(div)));

/** Format a value (in natural units, e.g. 0.7 for a float slider) as xLights stores it. */
export function formatValue(p: PropMeta, v: ParamValue): string {
  const div = p.divisor ?? 1;
  if (p.type === 'bool') return v === true || v === 1 || v === '1' ? '1' : '0';
  if (p.type === 'int') return String(Math.round(Number(v)));
  if (p.type === 'float') {
    if (div > 1 && p.settingPrefix === 'SLIDER') return String(Math.round(Number(v) * div));
    if (div > 1) return Number(v).toFixed(decimals(div));
    return String(Number(v));
  }
  return String(v);
}

/** Parse a stored value back to natural units. */
export function parseValue(p: PropMeta, s: string): ParamValue {
  const div = p.divisor ?? 1;
  if (p.type === 'bool') return s === '1' || s.toLowerCase() === 'true';
  if (p.type === 'int') return Math.round(Number(s));
  if (p.type === 'float') return div > 1 && p.settingPrefix === 'SLIDER' ? Number(s) / div : Number(s);
  return s;
}

export function defaultValue(p: PropMeta): ParamValue {
  if (p.default !== undefined) return p.default;
  if (p.type === 'bool') return false;
  if (p.type === 'int' || p.type === 'float') return p.min ?? 0;
  return p.options?.[0] ?? '';
}

const sameValue = (p: PropMeta, a: ParamValue, b: ParamValue) => formatValue(p, a) === formatValue(p, b);

export type EncodeOptions = { fadeInMs?: number; fadeOutMs?: number; tabs?: Record<string, string> };

/** Build the settings map for an effect: every stored property, with `values` over the defaults. */
export function encodeSettingsMap(meta: EffectMeta, values: Record<string, ParamValue>, opts: EncodeOptions = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of meta.properties) {
    const key = settingKey(p);
    if (!key) continue;
    const def = defaultValue(p);
    const v = values[p.id] ?? def;
    if (p.suppressIfDefault && sameValue(p, v, def)) continue;
    out.set(key, formatValue(p, v));
  }
  for (const nb of notebooks(meta)) {
    const picked = opts.tabs?.[nb.key];
    out.set(nb.key, picked && nb.tabs.includes(picked) ? picked : nb.tabs[0]);
  }
  for (const [k, v] of Object.entries(BLEND_DEFAULTS)) out.set(k, v);
  if (opts.fadeInMs && opts.fadeInMs > 0) out.set(FADE_IN, (opts.fadeInMs / 1000).toFixed(2));
  if (opts.fadeOutMs && opts.fadeOutMs > 0) out.set(FADE_OUT, (opts.fadeOutMs / 1000).toFixed(2));
  return out;
}

export function settingsToString(map: Map<string, string> | Record<string, string>): string {
  const entries = map instanceof Map ? [...map] : Object.entries(map);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

export function encodeSettings(meta: EffectMeta, values: Record<string, ParamValue>, opts: EncodeOptions = {}): string {
  return settingsToString(encodeSettingsMap(meta, values, opts));
}

/** Split a settings string into key/value pairs (xLights escapes commas in values as &comma;). */
export function parseSettings(s: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!s) return out;
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out.set(part.slice(0, eq), part.slice(eq + 1).replace(/&comma;/g, ','));
  }
  return out;
}

export type DecodedSettings = {
  values: Record<string, ParamValue>;
  fadeInMs: number;
  fadeOutMs: number;
  tabs: Record<string, string>;
};

/**
 * Decode a settings string written for `meta`. Returns null when it holds anything the
 * codec wouldn't reproduce (unknown keys, value curves, non-default blending), so the
 * caller can keep the original string untouched instead.
 */
export function decodeSettings(meta: EffectMeta, s: string): DecodedSettings | null {
  const map = parseSettings(s);
  const values: Record<string, ParamValue> = {};
  const byKey = new Map<string, PropMeta>();
  for (const p of meta.properties) {
    const k = settingKey(p);
    if (k) byKey.set(k, p);
  }
  let fadeInMs = 0, fadeOutMs = 0;
  const tabs: Record<string, string> = {};
  const nbKeys = new Set(notebooks(meta).map((n) => n.key));
  for (const [k, v] of map) {
    const p = byKey.get(k);
    if (p) { values[p.id] = parseValue(p, v); continue; }
    if (nbKeys.has(k)) { tabs[k] = v; continue; }
    if (k === FADE_IN) { fadeInMs = Math.round(Number(v) * 1000); continue; }
    if (k === FADE_OUT) { fadeOutMs = Math.round(Number(v) * 1000); continue; }
    if (BLEND_DEFAULTS[k] === v) continue;
    return null;
  }
  const decoded = { values, fadeInMs, fadeOutMs, tabs };
  // Only accept it if encoding gives back exactly the same string.
  return encodeSettings(meta, values, { fadeInMs, fadeOutMs, tabs }) === settingsToString(map) ? decoded : null;
}
