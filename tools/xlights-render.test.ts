// Dev tool (not part of `npm test`): renders sequences written by the composer's .xsq writer
// with a real xLights, headless, and checks what it lit. This is milestone C0's go/no-go check.
//
//   XLIGHTS=/path/to/xLights.AppImage npm run tool:xlights
//
// xLights runs fully sandboxed: HOME and XDG dirs point into a temporary folder, and the show
// folder is a temporary copy, so the user's own xLights settings and show folder are never
// read or written. Generated files are kept in $OUT (default: a temp dir, printed at the end)
// so they can also be opened in xLights by hand.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseTimingTracks } from '@stemlight/core/parseXTiming';
import { quantizeMarks } from '@stemlight/core/quantize';
import { EFFECTS, effectSettings, type EffectType } from '@stemlight/xlights/effects';
import { encodePalette } from '@stemlight/xlights/palette';
import { writeXsq, type XsqDocument, type XsqEffect } from '@stemlight/xlights/xsq';
import { colorsForRow, exportXsq } from '../apps/composer/src/model/export';
import * as ops from '../apps/composer/src/model/ops';
import { newProject, uid } from '../apps/composer/src/model/project';
import { activeBoundaries } from '../apps/composer/src/model/snap';
import { Store } from '../apps/composer/src/state/store';
import { parseLayout } from '@stemlight/xlights/layout';
import { readTimingFile } from '@stemlight/xlights/timing';
import { wavBytes } from '../tests/audio';
import { readFseq, type Fseq } from '../tests/fseq';

const XLIGHTS = process.env.XLIGHTS;
const root = mkdtempSync(join(tmpdir(), 'stemlight-xlights-'));
const OUT = process.env.OUT ?? join(root, 'out');
const fixture = (n: string) => new URL(`../fixtures/${n}`, import.meta.url).pathname;

/** Render one sequence in a fresh sandboxed show folder; returns the decoded fseq. */
function render(name: string, xsq: string, layoutXml: string, durationMs: number): Fseq {
  const show = join(root, `show-${name}`);
  const home = join(root, `home-${name}`);
  mkdirSync(show, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(show, 'xlights_rgbeffects.xml'), layoutXml);
  writeFileSync(join(show, 'silence.wav'), wavBytes(new Float32Array(Math.ceil((durationMs / 1000 + 1) * 8000)), 8000));
  writeFileSync(join(show, `${name}.xsq`), xsq);
  copyFileSync(join(show, `${name}.xsq`), join(OUT, `${name}.xsq`));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.state'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.data') };
  const log = execFileSync(XLIGHTS!, ['--headless', '-s', show, '-od', OUT, join(show, `${name}.xsq`)], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  if (!/Updated in|wrote/.test(log)) console.log(log);
  // xLights must load the sequence without complaint. The sandbox has no controllers
  // (xlights_networks.xml), so warnings about those are expected and ignored.
  const xlLog = readFileSync(join(home, '.state/xLights/xLights_spdlog.log'), 'utf8');
  const warnings = xlLog.split('\n').filter((l) => /\[xLights (warning|error|critical)\]/.test(l) && !/networks|start channels/i.test(l));
  expect(warnings, warnings.join('\n')).toEqual([]);
  return readFseq(readFileSync(join(OUT, `${name}.fseq`)));
}

/** A test layout with absolute start channels (the fixture's RGB props need its controllers). */
function testLayout(): string {
  const line = (name: string, ch: number, y: number, extra = '') =>
    `    <model name="${name}" DisplayAs="Single Line" Antialias="1" Dir="L" LayoutGroup="Default" LightsPerNode="1" NodesPerString="50" NumStrings="1" PixelSize="2" SourceVersion="2026.17" StartChannel="${ch}" StartSide="B" StringType="RGB Nodes" Transparency="0" versionNumber="8" WorldPosX="0" WorldPosY="${y}" WorldPosZ="0" X2="500" Y2="0" Z2="0">${extra}</model>`;
  const models = EFFECTS.map((e, i) => line(`Line ${e.type}`, 1 + i * 150, i * 20));
  models.push(line('Line Sub', 1 + EFFECTS.length * 150, -40, '<subModel name="Left" layout="horizontal" type="ranges" bufferstyle="Default" line0="1-10"/>'));
  models.push(line('Line G1', 1 + (EFFECTS.length + 1) * 150, -60), line('Line G2', 1 + (EFFECTS.length + 2) * 150, -80));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xrgb>',
    '  <models type="rgb_effects">',
    ...models,
    '  </models>',
    '  <modelGroups type="rgb_effects">',
    '    <modelGroup name="Both Lines" DisplayAs="ModelGroup" DefaultCamera="2D" GridSize="400" layout="minimalGrid" LayoutGroup="Default" models="Line G1,Line G2"/>',
    '  </modelGroups>',
    '</xrgb>',
    '',
  ].join('\n');
}

const red = encodePalette(['#ff0000']);
const fx = (type: EffectType, startMs: number, endMs: number, palette = red, fadeOutMs = 0): XsqEffect =>
  ({ name: type, startMs, endMs, settings: effectSettings(type, {}, 0, fadeOutMs), palette });
const doc = (durationMs: number, rest: Partial<XsqDocument>): XsqDocument =>
  ({ mediaFile: 'silence.wav', frameMs: 50, durationMs, timings: [], models: [], song: 'Stemlight test', ...rest });
/** Sum of a model's channels at a frame. */
const level = (f: Fseq, frame: number, ch0: number, n: number) => {
  let s = 0;
  for (let c = 0; c < n; c++) s += f.at(frame, ch0 + c);
  return s;
};

it.skipIf(!XLIGHTS)('C0 spike: one On effect per beat on a fixture model renders on exactly those frames', () => {
  const beats = parseTimingTracks(readFileSync(fixture('ThisIsHalloween.xlights.xtiming'), 'utf8')).find((t) => t.name === 'Beats')!;
  const marks = quantizeMarks(beats.marks, 50).filter((m) => m.start < 30_000);
  const durationMs = 32_000;
  const xsq = writeXsq(doc(durationMs, {
    timings: [{ name: 'Beats', layers: [marks.map((m) => ({ startMs: m.start, endMs: m.end, label: m.label }))] }],
    models: [{ name: 'Circle-1', layers: [marks.map((m) => fx('On', m.start, m.end, encodePalette(['#ffffff'])))] }],
  }));
  const f = render('spike-beats', xsq, readFileSync(fixture('xlights_rgbeffects.xml'), 'utf8'), durationMs);
  // Circle-1 is a single-color model on channel 1 (index 0).
  let wrong = 0;
  for (let frame = 0; frame < Math.min(f.frames, durationMs / 50); frame++) {
    const t = frame * 50;
    const on = marks.some((m) => t >= m.start && t < m.end);
    if ((f.at(frame, 0) > 0) !== on) wrong++;
  }
  expect(marks.length).toBeGreaterThan(40);
  expect(wrong).toBe(0);
});

it.skipIf(!XLIGHTS)('every curated effect, fades, submodels and groups render', () => {
  const durationMs = 6_000;
  const models = EFFECTS.map((e) => ({ name: `Line ${e.type}`, layers: [[fx(e.type, 1000, 4000, encodePalette(['#ff0000', '#00ff00', '#0000ff']))]] }));
  // A fade-out on the On line's second layer, after the first effect.
  models[0].layers.push([fx('On', 4500, 5500, red, 1000)]);
  models.push({ name: 'Line Sub', layers: [[]], submodels: [{ name: 'Left', layers: [[fx('On', 1000, 2000)]] }] } as never);
  models.push({ name: 'Both Lines', layers: [[fx('On', 1000, 2000)]] });
  const f = render('effects', writeXsq(doc(durationMs, { models })), testLayout(), durationMs);

  const report: string[] = [];
  EFFECTS.forEach((e, i) => {
    const ch0 = i * 150;
    const before = level(f, 10, ch0, 150);
    let during = 0;
    for (let fr = 22; fr < 78; fr += 4) during += level(f, fr, ch0, 150);
    report.push(`${e.type}: before=${before} during=${during}`);
    expect(before, e.type).toBe(0);
    if (e.type === 'Off') expect(during, e.type).toBe(0);
    else expect(during, e.type).toBeGreaterThan(0);
  });
  // Fade-out: bright early in the effect, dim near its end.
  const early = level(f, 91, 0, 150), late = level(f, 108, 0, 150);
  report.push(`On fade-out: early=${early} late=${late}`);
  expect(late).toBeLessThan(early * 0.5);
  // Submodel "Left" = pixels 1-10 of Line Sub: lit, the rest dark.
  const sub = EFFECTS.length * 150;
  report.push(`Submodel: left=${level(f, 30, sub, 30)} rest=${level(f, 30, sub + 30, 120)}`);
  expect(level(f, 30, sub, 30)).toBeGreaterThan(0);
  expect(level(f, 30, sub + 30, 120)).toBe(0);
  // Group: both members lit.
  const g1 = (EFFECTS.length + 1) * 150, g2 = (EFFECTS.length + 2) * 150;
  expect(level(f, 30, g1, 150)).toBeGreaterThan(0);
  expect(level(f, 30, g2, 150)).toBeGreaterThan(0);
  console.log(report.join('\n') + `\n\nGenerated sequences and renders: ${OUT}`);
});

it.skipIf(!XLIGHTS)('a project built with composer edits exports a sequence xLights renders as composed', () => {
  const layoutXml = readFileSync(fixture('xlights_rgbeffects.xml'), 'utf8');
  const timing = readTimingFile(readFileSync(fixture('ThisIsHalloween.xlights.xtiming'), 'utf8'));
  const durationMs = 30_000;
  const p = newProject({
    name: 'Composer e2e', audio: { fileName: 'silence.wav', hash: 'h', durationMs }, frameMs: 50, layout: parseLayout(layoutXml),
    tracks: timing.map((t) => ({ id: uid('t'), name: t.name, source: 'xtiming' as const, marks: t.layers[0].filter((m) => m.endMs <= durationMs).map((m) => ({ start: m.startMs, end: m.endMs, label: m.label })) })),
  });
  const s = new Store(p);
  const circle = (n: number) => s.project.rows.find((r) => r.name === `Circle-${n}`)!;
  const bounds = activeBoundaries(s.project);
  // Fill every beat interval on Circle-1 between 5 and 15 s with the row's own color, then a
  // chase (one beat later per circle) across Circle-2..5, then split, merge and move a few.
  s.edit('fill', (tx) => {
    for (let i = 0; i + 1 < bounds.length; i++) if (bounds[i] >= 5000 && bounds[i + 1] <= 15000) ops.fillSpan(tx, circle(1).id, bounds[i] + 1, { type: 'On', colors: colorsForRow(s.project, circle(1).id, ['#ff6a00']), params: {} }, bounds);
  });
  const beatsFrom = bounds.filter((b) => b >= 16000);
  s.edit('chase', (tx) => {
    for (let k = 0; k < 4; k++) ops.create(tx, circle(k + 2).id, beatsFrom[k], beatsFrom[k + 1], { type: 'On', colors: colorsForRow(s.project, circle(k + 2).id, ['#ff6a00']), params: {} });
  });
  const { xml, report } = exportXsq(s.project, { mediaFile: 'silence.wav' });
  expect(report.errors).toEqual([]);
  const f = render('composer-e2e', xml, layoutXml, durationMs);
  const expectLit = (ch: number, row: string) => {
    let wrong = 0;
    for (let fr = 0; fr < durationMs / 50; fr++) {
      const t = fr * 50;
      const on = Object.values(s.project.effects).some((e) => e.rowId === s.project.rows.find((r) => r.name === row)!.id && t >= e.startMs && t < e.endMs);
      if ((f.at(fr, ch) > 0) !== on) wrong++;
    }
    return wrong;
  };
  for (let n = 1; n <= 5; n++) expect(expectLit(n - 1, `Circle-${n}`), `Circle-${n}`).toBe(0);
  expect(Object.keys(s.project.effects).length).toBeGreaterThan(15);
});
