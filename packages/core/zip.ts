import { strToU8, zipSync } from 'fflate';
import type { Track } from '@stemlight/core/types';
import { fileSafeName, toXTiming, type ExportOptions } from './xtiming';

/** One .xtiming per track, bundled into a zip. Duplicate names get a numeric suffix. */
export function tracksToZip(tracks: readonly Track[], opts: ExportOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const t of tracks) {
    const base = fileSafeName(t.name);
    let name = `${base}.xtiming`;
    for (let i = 2; name in files; i++) name = `${base} (${i}).xtiming`;
    files[name] = strToU8(toXTiming([t], opts));
  }
  return zipSync(files, { level: 6 });
}
