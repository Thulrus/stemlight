/**
 * Color sets: a handful of themed sets of 6-10 colors. A project uses one at a time, and
 * effects take their colors from it (one color, or several for washes and chases). Exact
 * colors are usually fine-tuned in xLights; these are for laying the show out.
 */
export type ColorSet = { id: string; name: string; colors: string[] };

export const COLOR_SETS: ColorSet[] = [
  { id: 'basics', name: 'Basics', colors: ['#ffffff', '#ffd8a0', '#ff0000', '#ff7a00', '#ffd000', '#00ff00', '#00e5ff', '#0040ff', '#8b00ff', '#ff00c8'] },
  { id: 'christmas', name: 'Christmas', colors: ['#ff0000', '#00c000', '#ffffff', '#ffd8a0', '#ffb300', '#0040ff', '#a0e8ff', '#ff3070'] },
  { id: 'halloween', name: 'Halloween', colors: ['#ff6a00', '#8b00ff', '#39ff14', '#ff0000', '#ffb000', '#ffffff', '#00b4ff', '#ff00c8'] },
  { id: 'patriotic', name: 'Patriotic', colors: ['#ff0000', '#ffffff', '#0030ff', '#ffd8a0', '#ffb300', '#00b4ff'] },
  { id: 'valentine', name: 'Valentine', colors: ['#ff0000', '#ff3070', '#ff80b0', '#c000ff', '#ffffff', '#ffd8a0'] },
  { id: 'spring', name: 'Spring pastels', colors: ['#ff9ec8', '#c8a0ff', '#90ffc0', '#a0d8ff', '#fff08a', '#ffc090', '#ffffff'] },
];

export const DEFAULT_COLOR_SET = 'basics';

/** Common names for the built-in colors, for tooltips and labels. */
const NAMES: Record<string, string> = {
  '#ffffff': 'White', '#ffd8a0': 'Warm white', '#ff0000': 'Red', '#ff7a00': 'Orange', '#ff6a00': 'Orange', '#ffd000': 'Yellow',
  '#00ff00': 'Green', '#00c000': 'Green', '#39ff14': 'Slime green', '#00e5ff': 'Cyan', '#0040ff': 'Blue', '#0030ff': 'Blue',
  '#8b00ff': 'Purple', '#ff00c8': 'Magenta', '#ffb300': 'Gold', '#ffb000': 'Amber', '#a0e8ff': 'Ice blue', '#00b4ff': 'Sky blue',
  '#ff3070': 'Pink', '#ff80b0': 'Light pink', '#c000ff': 'Violet', '#ff9ec8': 'Pastel pink', '#c8a0ff': 'Lavender',
  '#90ffc0': 'Mint', '#a0d8ff': 'Baby blue', '#fff08a': 'Butter', '#ffc090': 'Peach',
};
export const colorName = (hex: string) => NAMES[hex.toLowerCase()] ?? hex.toUpperCase();

export const copySets = (): ColorSet[] => COLOR_SETS.map((s) => ({ ...s, colors: [...s.colors] }));
