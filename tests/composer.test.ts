import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colorsForRow, exportXsq } from '../apps/composer/src/model/export';
import * as ops from '../apps/composer/src/model/ops';
import { DEFAULT_PRESETS, makeRow, newProject, normalizeProject, rowsFromLayout } from '../apps/composer/src/model/project';
import { effectSettings } from '@stemlight/xlights/effects';
import { boundaries } from '../apps/composer/src/model/snap';
import type { Effect, Project, TimingTrack } from '../apps/composer/src/model/types';
import { Store } from '../apps/composer/src/state/store';
import { parseLayout } from '@stemlight/xlights/layout';
import { readXsq } from '@stemlight/xlights/xsqRead';

const beats: TimingTrack = {
  id: 't-beats', name: 'Beats', source: 'xtiming',
  marks: Array.from({ length: 40 }, (_, i) => ({ start: i * 500, end: (i + 1) * 500, label: String((i % 4) + 1) })),
};
const sections: TimingTrack = {
  id: 't-sec', name: 'Sections', source: 'xtiming',
  marks: [{ start: 0, end: 8000, label: 'Verse 1' }, { start: 8000, end: 16000, label: 'Chorus 1' }, { start: 16000, end: 20000, label: 'Chorus 2' }],
};

function project(): Project {
  const p = newProject({ name: 'Test', audio: { fileName: 'song.mp3', hash: 'h', durationMs: 20_000 }, frameMs: 50, tracks: [beats, sections] });
  p.rows = [makeRow('Arch 1', 'model'), makeRow('Arch 2', 'model'), makeRow('Tree', 'model')];
  return p;
}

const brush: ops.Brush = { type: 'On', colors: ['#ff0000'], params: {} };

/** Invariants that must hold after any sequence of commands. */
function checkInvariants(p: Project) {
  const layers = new Map<string, Effect[]>();
  for (const e of Object.values(p.effects)) {
    expect(e.startMs % p.frameMs).toBe(0);
    expect(e.endMs % p.frameMs).toBe(0);
    expect(e.endMs).toBeGreaterThan(e.startMs);
    expect(e.startMs).toBeGreaterThanOrEqual(0);
    expect(e.endMs).toBeLessThanOrEqual(p.audio.durationMs);
    const row = p.rows.find((r) => r.id === e.rowId)!;
    expect(e.layer).toBeLessThan(row.layers);
    const k = `${e.rowId}:${e.layer}`;
    layers.set(k, [...(layers.get(k) ?? []), e]);
  }
  for (const list of layers.values()) {
    list.sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < list.length; i++) expect(list[i].startMs).toBeGreaterThanOrEqual(list[i - 1].endMs);
  }
}

/** Project content, independent of key insertion order. */
const state = (p: Project) => JSON.stringify(Object.keys(p.effects).sort().map((k) => p.effects[k])) + JSON.stringify(p.rows);

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('composer commands', () => {
  it('fills the span between marks on double-click', () => {
    const s = new Store(project());
    const row = s.project.rows[0].id;
    s.edit('fill', (tx) => [ops.fillSpan(tx, row, 1234, brush, boundaries(beats.marks))!.id]);
    const e = Object.values(s.project.effects)[0];
    expect([e.startMs, e.endMs]).toEqual([1000, 1500]);
  });

  it('overwrites what is underneath instead of adding layers', () => {
    const s = new Store(project());
    const row = s.project.rows[0].id;
    s.edit('a', (tx) => { ops.create(tx, row, 0, 2000, brush); });
    s.edit('b', (tx) => { ops.create(tx, row, 1000, 3000, brush); });
    expect(s.project.rows[0].layers).toBe(1);
    const spans = () => Object.values(s.project.effects).map((e) => [e.layer, e.startMs, e.endMs]).sort((x, y) => x[1] - y[1]);
    expect(spans()).toEqual([[0, 0, 1000], [0, 1000, 3000]]);
    // Dropped in the middle of a longer effect: it is split around the new one.
    s.edit('c', (tx) => { ops.create(tx, row, 0, 3000, brush); });
    s.edit('d', (tx) => { ops.create(tx, row, 1000, 1500, brush); });
    expect(spans()).toEqual([[0, 0, 1000], [0, 1000, 1500], [0, 1500, 3000]]);
    // Moving onto another row's effect overwrites it there.
    const other = s.project.rows[1].id;
    s.edit('e', (tx) => { ops.create(tx, other, 0, 3000, { ...brush, type: 'Twinkle' }); });
    const mid = Object.values(s.project.effects).find((e) => e.rowId === row && e.startMs === 1000)!;
    s.edit('f', (tx) => ops.move(tx, [mid.id], 0, () => other));
    expect(Object.values(s.project.effects).filter((e) => e.rowId === other).map((e) => [e.type, e.startMs, e.endMs]).sort((x, y) => (x[1] as number) - (y[1] as number)))
      .toEqual([['Twinkle', 0, 1000], ['On', 1000, 1500], ['Twinkle', 1500, 3000]]);
    expect(s.project.rows.every((r) => r.layers === 1)).toBe(true);
    // An explicitly added layer is used when asked for.
    s.edit('layer', (tx) => { tx.updateRow(other, { layers: 2 }); });
    s.edit('g', (tx) => ops.move(tx, [mid.id], 0, (r) => r, { dLayer: 1 }));
    expect(s.project.effects[mid.id].layer).toBe(1);
    expect(Object.values(s.project.effects).filter((e) => e.rowId === other && e.layer === 0)).toHaveLength(2);
    checkInvariants(s.project);
  });

  it('removes empty layers left by older versions when a project opens', () => {
    const p = project();
    p.rows[0].layers = 3;
    p.effects.x = { id: 'x', rowId: p.rows[0].id, layer: 1, startMs: 0, endMs: 500, type: 'On', params: {}, colors: ['#ff0000'], source: 'manual' };
    p.rows[1].layers = 2;
    const n = normalizeProject(p);
    expect(n.rows.map((r) => r.layers)).toEqual([2, 1, 1]);
  });

  it('skips locked rows', () => {
    const s = new Store(project());
    s.project.rows[1].locked = true;
    const c = s.edit('create', (tx) => { ops.create(tx, s.project.rows[1].id, 0, 1000, brush); });
    expect(c).toBeNull();
  });

  it('splits, merges and nudges to marks', () => {
    const s = new Store(project());
    const row = s.project.rows[0].id;
    const b = boundaries(beats.marks);
    s.edit('a', (tx) => [ops.create(tx, row, 1000, 3000, brush)!.id]);
    const id = [...s.selection][0];
    s.edit('split', (tx) => ops.splitAt(tx, [id], 2010));
    expect(Object.values(s.project.effects).map((e) => [e.startMs, e.endMs]).sort((x, y) => x[0] - y[0])).toEqual([[1000, 2000], [2000, 3000]]);
    s.edit('merge', (tx) => ops.merge(tx, Object.keys(s.project.effects)));
    expect(Object.values(s.project.effects).map((e) => [e.startMs, e.endMs])).toEqual([[1000, 3000]]);
    s.edit('nudge', (tx) => { ops.nudgeToMark(tx, Object.keys(s.project.effects), 1, b); });
    expect(Object.values(s.project.effects).map((e) => [e.startMs, e.endMs])).toEqual([[1500, 3500]]);
    s.edit('extend', (tx) => { ops.edgeToMark(tx, Object.keys(s.project.effects), 'end', 1, b); });
    expect(Object.values(s.project.effects).map((e) => [e.startMs, e.endMs])).toEqual([[1500, 4000]]);
    s.edit('split marks', (tx) => { ops.splitAtMarks(tx, Object.keys(s.project.effects), b); });
    expect(Object.keys(s.project.effects)).toHaveLength(5);
    checkInvariants(s.project);
  });

  it('keeps invariants and undoes exactly through random edit sequences', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const s = new Store(project());
      const snapshots: string[] = [state(s.project)];
      const rowIds = s.project.rows.map((x) => x.id);
      const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
      const b = boundaries(beats.marks);
      for (let step = 0; step < 60; step++) {
        const ids = Object.keys(s.project.effects);
        const some = ids.filter(() => r() < 0.3);
        const t = Math.round(r() * 21_000) - 500;
        const op = Math.floor(r() * 11);
        const c = s.edit(`op${op}`, (tx) => {
          switch (op) {
            case 0: ops.create(tx, pick(rowIds), t, t + r() * 3000 - 500, brush, Math.floor(r() * 3)); break;
            case 1: tx.place({ ...ops.brushEffect(pick(rowIds), t, t + 900, brush), layer: Math.floor(r() * 3) }, 'stack'); break;
            case 2: ops.move(tx, some, Math.round(r() * 4000 - 2000) + 7, () => pick(rowIds), { copy: r() < 0.3, dLayer: Math.floor(r() * 3) - 1 }); break;
            case 3: ops.resize(tx, some, r() < 0.5 ? 'start' : 'end', Math.round(r() * 3000 - 1500)); break;
            case 4: ops.remove(tx, some); break;
            case 5: ops.splitAt(tx, some, t); break;
            case 6: ops.merge(tx, some); break;
            case 7: ops.nudgeToMark(tx, some, r() < 0.5 ? -1 : 1, b); break;
            case 8: ops.stretch(tx, some, t, 0.5 + r()); break;
            case 9: ops.edgeToMark(tx, some, r() < 0.5 ? 'start' : 'end', r() < 0.5 ? -1 : 1, b); break;
            case 10: ops.patch(tx, some, { rampIn: 100, rampOut: 5000, type: 'Twinkle' }); break;
          }
        });
        checkInvariants(s.project);
        if (c) snapshots.push(state(s.project));
      }
      // Undo everything: each step restores the previous state exactly.
      for (let i = snapshots.length - 1; i > 0; i--) {
        expect(state(s.project)).toBe(snapshots[i]);
        s.undo();
      }
      expect(state(s.project)).toBe(snapshots[0]);
      // And redo gets back to the end.
      while (s.redo());
      expect(state(s.project)).toBe(snapshots[snapshots.length - 1]);
      // The index agrees with the effect map.
      for (const row of s.project.rows) {
        const indexed = s.index.layers(row.id).flat().map((e) => e.id).sort();
        const actual = Object.values(s.project.effects).filter((e) => e.rowId === row.id).map((e) => e.id).sort();
        expect(indexed).toEqual(actual);
      }
    }
  });
});

describe('composer export', () => {
  const layout = parseLayout(readFileSync(new URL('../fixtures/xlights_rgbeffects.xml', import.meta.url), 'utf8'));

  it('starts with groups first, then models', () => {
    const rows = rowsFromLayout(layout);
    expect(rows.slice(0, 3).map((r) => r.kind)).toEqual(['group', 'group', 'group']);
    expect(rows).toHaveLength(18);
  });

  it('writes sections, tracks and effects, and leaves out unmapped rows', () => {
    const p = newProject({ name: 'Song', audio: { fileName: 'song.mp3', hash: 'h', durationMs: 20_000 }, frameMs: 50, tracks: [beats, sections], layout });
    p.rows.push(makeRow('My virtual row', 'virtual'));
    const s = new Store(p);
    const circle = s.project.rows.find((r) => r.name === 'Circle-1')!.id;
    const virt = s.project.rows.find((r) => r.kind === 'virtual')!.id;
    s.edit('a', (tx) => {
      ops.create(tx, circle, 0, 500, brush);
      ops.create(tx, circle, 500, 1000, { type: 'Color Wash', colors: ['#ff6a00', '#8b00ff', '#39ff14'], params: {} });
      ops.create(tx, virt, 0, 500, brush);
    });
    const { xml, report } = exportXsq(s.project, { mediaFile: 'song.mp3' });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toContain('My virtual row');
    expect(report.effectCount).toBe(2);
    const back = readXsq(xml);
    expect(back.timings.map((t) => t.name)).toEqual(['Sections', 'Beats']);
    expect(back.timings[0].layers[0].map((m) => m.label)).toEqual(['Verse 1', 'Chorus 1', 'Chorus 2']);
    const c1 = back.models.find((m) => m.name === 'Circle-1')!;
    expect(c1.layers[0].map((e) => e.name)).toEqual(['On', 'Color Wash']);
    expect(c1.layers[0][1].palette).toContain('C_BUTTON_Palette2=#8b00ff');
    expect(back.models.map((m) => m.name)).not.toContain('My virtual row');
  });

  it('keeps single-color props to colors they can show, and warns about ones they cannot', () => {
    expect(layout.models.find((m) => m.name === 'Circle-1')?.singleColor).toBe('#9e00ff');
    expect(layout.models.find((m) => m.name === 'Single Line-3')?.singleColor).toBe('#ffffff');
    expect(layout.models.find((m) => m.name === 'Pumpkin1')?.singleColor).toBeUndefined();
    const p = newProject({ name: 'Song', audio: { fileName: 'song.mp3', hash: 'h', durationMs: 20_000 }, frameMs: 50, tracks: [beats], layout });
    const circle = p.rows.find((r) => r.name === 'Circle-1')!;
    const pumpkin = p.rows.find((r) => r.name === 'Pumpkin1')!;
    expect(colorsForRow(p, circle.id, ['#ff0000', '#ff6a00'])).toEqual(['#9e00ff']);
    expect(colorsForRow(p, circle.id, ['#ff0000', '#ffffff'])).toEqual(['#ffffff']);
    expect(colorsForRow(p, pumpkin.id, ['#ff0000', '#ff6a00'])).toEqual(['#ff0000', '#ff6a00']);
    const s = new Store(p);
    s.edit('a', (tx) => {
      ops.create(tx, circle.id, 0, 500, { ...brush, colors: colorsForRow(p, circle.id, ['#ff0000']) });
      ops.create(tx, circle.id, 500, 1000, { ...brush, colors: ['#ffffff'] });
    });
    expect(exportXsq(s.project, { mediaFile: 'x.mp3' }).report.warnings.join(' ')).not.toContain('single-color');
    s.edit('b', (tx) => { ops.create(tx, circle.id, 1000, 1500, { ...brush, colors: ['#ff6a00', '#8b00ff'] }); });
    expect(exportXsq(s.project, { mediaFile: 'x.mp3' }).report.warnings.join(' ')).toContain('Circle-1 (1)');
  });

  it('moves projects from palettes to colors on effects, including their undo history', async () => {
    const { migrateHistory } = await import('../apps/composer/src/model/project');
    const old = project() as Project & { palettes: { id: string; colors: string[] }[] };
    old.palettes = [{ id: 'pal-x', colors: ['#123456', '#abcdef'] }];
    delete (old as { colorSets?: unknown }).colorSets;
    const legacyEffect = { id: 'x', rowId: old.rows[0].id, layer: 0, startMs: 0, endMs: 500, type: 'On', params: {}, paletteId: 'pal-x', source: 'manual' } as unknown as Effect;
    old.effects.x = legacyEffect;
    (old.view.brush as unknown as { paletteId: string }).paletteId = 'pal-x';
    delete (old.view.brush as { colors?: unknown }).colors;
    const n = normalizeProject(old);
    expect(n.effects.x.colors).toEqual(['#123456', '#abcdef']);
    expect('paletteId' in n.effects.x).toBe(false);
    expect(n.view.brush.colors).toEqual(['#123456', '#abcdef']);
    expect(n.colorSets.length).toBeGreaterThanOrEqual(6);
    expect('palettes' in n).toBe(false);
    const h = migrateHistory({ undo: [{ label: 'a', effects: { x: [null, legacyEffect] }, fields: { palettes: [[], []] } as never }], redo: [] }, old)!;
    expect(h.undo[0].effects.x[1]!.colors).toEqual(['#123456', '#abcdef']);
    expect('palettes' in h.undo[0].fields).toBe(false);
  });

  it('has color sets of 6 to 10 colors', async () => {
    const { COLOR_SETS } = await import('../apps/composer/src/model/colors');
    for (const set of COLOR_SETS) {
      expect(set.colors.length).toBeGreaterThanOrEqual(6);
      expect(set.colors.length).toBeLessThanOrEqual(10);
      for (const c of set.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has a Fade out preset that writes what xLights writes for one', () => {
    const fade = DEFAULT_PRESETS.find((x) => x.name === 'Fade out')!;
    expect(fade.key).toBe('2');
    // From fixtures/CaraMia.xsq (hand-made in xLights 2026.17).
    expect(effectSettings(fade.type, fade.params)).toBe('E_TEXTCTRL_Eff_On_End=0,T_CHECKBOX_Canvas=0,T_CHECKBOX_LayerMorph=0,T_CHOICE_LayerMethod=Normal,T_SLIDER_EffectLayerMix=0');
  });

  it('drops a brush with its fades, and migrates older saved brushes', () => {
    const s = new Store(project());
    const row = s.project.rows[0].id;
    s.edit('d', (tx) => { ops.fillSpan(tx, row, 600, { type: 'Twinkle', colors: ['#ff0000'], params: {}, rampIn: 100, rampOut: 200 }, boundaries(beats.marks)); });
    expect(Object.values(s.project.effects)[0]).toMatchObject({ startMs: 500, endMs: 1000, ramp: { in: 100, out: 200 } });
    const old = project();
    (old.view as unknown as { brush: unknown }).brush = { type: 'Twinkle', colors: ['#ff0000'], params: { Twinkle: { Twinkle_Count: 9 }, On: {} } };
    delete (old.view as { presets?: unknown }).presets;
    const n = normalizeProject(old);
    expect(n.view.brush).toEqual({ type: 'Twinkle', colors: ['#ff0000'], params: { Twinkle_Count: 9 }, rampIn: 0, rampOut: 0 });
    expect(n.view.presets).toHaveLength(10);
  });
});
