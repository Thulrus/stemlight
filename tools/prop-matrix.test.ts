// Dev tool: for every prop (model) in the hand-made sequences, which of our tracks follow it?
// Prints the best tracks per prop by span match (start and end within 100 ms) and by start only.
// Takes the benchmark's configuration (VOCALS, LEAD, SYL; see tests/bench.test.ts).
// Run: STEMLIGHT_TOOLS=1 npx vitest run tools/prop-matrix.test.ts --disableConsoleIntercept
import { existsSync, readFileSync } from 'node:fs';
import { it } from 'vitest';
import { BENCH_CASES } from '../src/eval/bench';
import { eventF, spanF, within } from '../src/eval/metrics';
import { parseModelEffects } from '../src/eval/xsq';
import { STEMS_DIR } from '../tests/audio';
import { analyzeCachedSong } from '../tests/bench.test';

it.skipIf(!process.env.STEMLIGHT_TOOLS)('prop matrix', async () => {
  for (const c of BENCH_CASES) {
    if (!existsSync(`${STEMS_DIR}${c.song}/drums.wav`)) continue;
    const tracks = await analyzeCachedSong(c.song);
    const xsq = readFileSync(new URL(`../fixtures/${c.xsq}.xsq`, import.meta.url), 'utf8');
    console.log(`\n=== ${c.xsq}`);
    for (const [prop, effects] of parseModelEffects(xsq)) {
      if (effects.length < 6) continue;
      const lo = effects[0].start - 0.5, hi = Math.max(...effects.map((e) => e.end)) + 0.5;
      const rows = tracks.map((t) => {
        const est = within(t.marks, lo, hi);
        return { name: t.name, n: est.length, span: spanF(est, effects, 0.1), start: eventF(est.map((m) => m.start), effects.map((e) => e.start), 0.1) };
      });
      const top = (k: 'span' | 'start') => [...rows].sort((a, b) => b[k].f - a[k].f).slice(0, 3).map((r) => `${r.name}(${r[k].f.toFixed(2)},n=${r.n})`).join('  ');
      console.log(`${prop.padEnd(14)} n=${String(effects.length).padStart(3)}\n   span : ${top('span')}\n   start: ${top('start')}`);
    }
  }
}, 3_600_000);
