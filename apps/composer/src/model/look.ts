import type { Effect } from './types';

/**
 * How effects look in the composer's preview: recognizable, not pixel-accurate. Each
 * curated effect gets a few lines that say "a color, this bright, now"; xLights renders
 * the real thing. Colors are [r, g, b] in 0..255.
 */
export type RGB = [number, number, number];

const hexCache = new Map<string, RGB>();
export function hexToRgb(hex: string): RGB {
  let c = hexCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    hexCache.set(hex, c);
  }
  return c;
}

const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

/** Palette color at a position 0..1 across the palette, blended between neighbors. */
function blendAt(colors: RGB[], pos: number, circular: boolean): RGB {
  if (colors.length === 1) return colors[0];
  const n = circular ? colors.length : colors.length - 1;
  const x = (((pos % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  return mix(colors[i % colors.length], colors[(i + 1) % colors.length], x - i);
}

/** Cheap deterministic noise in 0..1 for a time bucket and seed. */
function noise(bucket: number, seed: number): number {
  let x = (bucket * 374761393 + seed * 668265263) | 0;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Color and brightness of an effect at time t (ms), or null when it's dark. */
export function effectLook(e: Effect, t: number, seed = 0): { rgb: RGB; level: number } | null {
  if (t < e.startMs || t >= e.endMs) return null;
  const colors = (e.colors?.length ? e.colors : ['#ffffff']).map(hexToRgb);
  const len = e.endMs - e.startMs;
  const p = (t - e.startMs) / len;
  const sec = (t - e.startMs) / 1000;
  let rgb = colors[0];
  let level = 1;
  switch (e.type) {
    case 'Off':
      return { rgb: [0, 0, 0], level: 0 };
    case 'On': {
      const a = num(e.params.Eff_On_Start, 100) / 100;
      const b = num(e.params.Eff_On_End, 100) / 100;
      level = a + (b - a) * p;
      break;
    }
    case 'Color Wash':
      rgb = blendAt(colors, p * num(e.params.ColorWash_Cycles, 1), !!e.params.ColorWash_CircularPalette);
      break;
    case 'Twinkle': {
      const steps = Math.max(2, num(e.params.Twinkle_Steps, 30));
      const bucket = Math.floor(t / (steps * 25));
      level = 0.25 + 0.75 * noise(bucket, seed) * Math.min(1, num(e.params.Twinkle_Count, 3) / 10 + 0.3);
      rgb = colors[Math.floor(noise(bucket, seed + 7) * colors.length)];
      break;
    }
    case 'Shimmer': {
      const cycles = Math.max(0.1, num(e.params.Shimmer_Cycles, 1));
      const period = Math.max(50, len / (cycles * 10));
      const duty = num(e.params.Shimmer_Duty_Factor, 50) / 100;
      level = ((t - e.startMs) % period) / period < duty ? 1 : 0;
      break;
    }
    case 'Bars':
    case 'SingleStrand':
    case 'Spirals':
    case 'Butterfly': {
      // Motion effects: cycle through the palette at the effect's speed, with a gentle pulse.
      const speed = e.type === 'Bars' ? num(e.params.Bars_Cycles, 1) : e.type === 'SingleStrand' ? num(e.params.Chase_Rotations, 1) : e.type === 'Spirals' ? Math.abs(num(e.params.Spirals_Movement, 1)) : num(e.params.Butterfly_Speed, 10) / 10;
      const phase = sec * Math.max(0.2, speed);
      rgb = blendAt(colors, phase, true);
      level = 0.7 + 0.3 * Math.abs(Math.sin(phase * Math.PI * 2));
      break;
    }
    default:
      // Opaque (unknown) effects: a flat palette fill.
      level = 0.8;
  }
  if (e.ramp) {
    const tin = t - e.startMs, tout = e.endMs - t;
    if (e.ramp.in > 0 && tin < e.ramp.in) level *= tin / e.ramp.in;
    if (e.ramp.out > 0 && tout < e.ramp.out) level *= tout / e.ramp.out;
  }
  return { rgb, level: Math.max(0, Math.min(1, level)) };
}
