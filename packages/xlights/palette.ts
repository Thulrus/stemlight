/**
 * xLights color palette strings: eight color buttons, each with an "in use" checkbox.
 * The layout and the unused-slot colors follow what xLights 2026.17 writes (fixtures/CaraMia.xsq).
 */
export const XL_DEFAULT_SLOTS = ['#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#000000', '#00ffff', '#ff00ff'];
export const MAX_PALETTE_COLORS = 8;

const normHex = (c: string) => {
  let h = c.trim().toLowerCase();
  if (!h.startsWith('#')) h = '#' + h;
  if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + [...h.slice(1)].map((x) => x + x).join('');
  if (!/^#[0-9a-f]{6}$/.test(h)) throw new Error(`Not a color: ${c}`);
  return h;
};

/** Encode up to 8 colors as an xLights palette string; the given colors are checked, in order. */
export function encodePalette(colors: readonly string[]): string {
  if (colors.length === 0) throw new Error('A palette needs at least one color');
  if (colors.length > MAX_PALETTE_COLORS) throw new Error(`A palette holds at most ${MAX_PALETTE_COLORS} colors`);
  const slots = XL_DEFAULT_SLOTS.map((d, i) => (i < colors.length ? normHex(colors[i]) : d));
  const parts: string[] = [];
  slots.forEach((c, i) => parts.push(`C_BUTTON_Palette${i + 1}=${c}`));
  parts.push('C_CHECKBOXBRIGHTNESSLEVEL=0', 'C_CHECKBOX_Chroma=0', 'C_CHECKBOX_MusicSparkles=0');
  slots.forEach((_, i) => parts.push(`C_CHECKBOX_Palette${i + 1}=${i < colors.length ? 1 : 0}`));
  parts.push('C_SLIDER_SparkleFrequency=0');
  return parts.join(',');
}

/** The checked colors of a palette string, in slot order. */
export function decodePalette(s: string): string[] {
  const kv = new Map(s.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)] as const; }));
  const out: string[] = [];
  for (let i = 1; i <= MAX_PALETTE_COLORS; i++) {
    const c = kv.get(`C_BUTTON_Palette${i}`);
    if (c && kv.get(`C_CHECKBOX_Palette${i}`) === '1' && /^#[0-9a-fA-F]{6}$/.test(c)) out.push(c.toLowerCase());
  }
  return out;
}
