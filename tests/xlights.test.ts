import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EFFECTS, effectSettings, parseEffectSettings } from '@stemlight/xlights/effects';
import { parseLayout } from '@stemlight/xlights/layout';
import { decodePalette, encodePalette } from '@stemlight/xlights/palette';
import { decodeSettings, encodeSettings, parseSettings, settingsToString } from '@stemlight/xlights/settings';
import { parseXml } from '@stemlight/xlights/xml';
import { writeXsq } from '@stemlight/xlights/xsq';
import { readXsq } from '@stemlight/xlights/xsqRead';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
/** Sequences saved by xLights 2026.17 (the others are from 2021 and use older formats). */
const MODERN = ['CaraMia.xsq', 'GrinningGhosts1.xsq', 'ThisIsHalloweenFilm.xsq'];

describe('xml', () => {
  it('parses attributes, text, entities and self-closing tags', () => {
    const n = parseXml('<?xml version="1.0"?><a x="1 &amp; 2" y=\'q\'><b>t&lt;x</b><c z="&lt;r>"/></a>');
    expect(n.attrs).toEqual({ x: '1 & 2', y: 'q' });
    expect(n.children[0].text).toBe('t<x');
    expect(n.children[1].attrs.z).toBe('<r>');
  });
  it('rejects mismatched tags', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
  });
});

describe('effect settings (golden strings from xLights 2026.17 fixtures)', () => {
  // Every EffectDB entry used by a curated effect type in the modern fixtures must decode
  // and re-encode to the identical string: key names, value formats and order all match.
  const cases: { type: string; settings: string }[] = [];
  for (const f of MODERN) {
    const seq = readXsq(fixture(f));
    for (const m of seq.models) for (const l of m.layers) for (const e of l) {
      if (EFFECTS.some((d) => d.type === e.name)) cases.push({ type: e.name, settings: e.settings });
    }
  }
  const unique = [...new Map(cases.map((c) => [`${c.type}|${c.settings}`, c])).values()];

  it('found curated effects in the fixtures', () => {
    expect(new Set(unique.map((c) => c.type))).toEqual(new Set(['On', 'Twinkle', 'Spirals', 'Butterfly']));
  });

  it.each(unique.map((c) => [c.type, c.settings]))('%s: %s', (type, settings) => {
    const d = EFFECTS.find((x) => x.type === type)!;
    const dec = decodeSettings(d.meta, settings);
    // Strings the codec wouldn't write itself (empty, partial, non-default buffer or blending)
    // must come back null so they stay opaque. Complete ones must decode and re-encode exactly.
    const complete = settings.includes('T_SLIDER_EffectLayerMix=0') && /^(E_|T_)/.test(settings) && !settings.includes('LayerMethod=Effect');
    if (complete) expect(dec).not.toBeNull();
    if (dec) expect(encodeSettings(d.meta, dec.values, dec)).toBe(settings);
  });

  it('writes Twinkle exactly as xLights does', () => {
    expect(effectSettings('Twinkle', { Twinkle_Count: 10 })).toBe(
      'E_CHECKBOX_Twinkle_ReRandom=0,E_CHECKBOX_Twinkle_Strobe=0,E_CHOICE_Twinkle_Style=New Render Method,E_SLIDER_Twinkle_Count=10,E_SLIDER_Twinkle_Steps=30,T_CHECKBOX_Canvas=0,T_CHECKBOX_LayerMorph=0,T_CHOICE_LayerMethod=Normal,T_SLIDER_EffectLayerMix=0',
    );
  });

  it('writes Spirals with a float text value and a raw slider value', () => {
    expect(effectSettings('Spirals', { Spirals_Count: 5, Spirals_Rotation: 1.5, Spirals_Movement: 0.7 })).toBe(
      'E_CHECKBOX_Spirals_3D=0,E_CHECKBOX_Spirals_Blend=0,E_CHECKBOX_Spirals_Grow=0,E_CHECKBOX_Spirals_Shrink=0,E_SLIDER_Spirals_Count=5,E_SLIDER_Spirals_Rotation=15,E_SLIDER_Spirals_Thickness=50,E_TEXTCTRL_Spirals_Movement=0.7,T_CHECKBOX_Canvas=0,T_CHECKBOX_LayerMorph=0,T_CHOICE_LayerMethod=Normal,T_SLIDER_EffectLayerMix=0',
    );
  });

  it('leaves default On intensities out and writes fades in seconds', () => {
    expect(effectSettings('On', {})).toBe('T_CHECKBOX_Canvas=0,T_CHECKBOX_LayerMorph=0,T_CHOICE_LayerMethod=Normal,T_SLIDER_EffectLayerMix=0');
    expect(effectSettings('On', { Eff_On_Start: 100, Eff_On_End: 0 }, 0, 250)).toBe(
      'E_TEXTCTRL_Eff_On_End=0,T_CHECKBOX_Canvas=0,T_CHECKBOX_LayerMorph=0,T_CHOICE_LayerMethod=Normal,T_SLIDER_EffectLayerMix=0,T_TEXTCTRL_Fadeout=0.25',
    );
  });

  it('writes the Single Strand tab and Butterfly palette colors', () => {
    expect(parseSettings(effectSettings('SingleStrand', {})).get('E_NOTEBOOK_SSEFFECT_TYPE')).toBe('Chase');
    expect(parseSettings(effectSettings('Butterfly', {})).get('E_CHOICE_Butterfly_Colors')).toBe('Palette');
  });

  it('round-trips every curated effect at defaults and with changed params', () => {
    for (const d of EFFECTS) {
      const params = Object.fromEntries(d.params.map((p) => [p.id, p.kind === 'slider' ? Math.min(p.max, p.min + p.step * 3) : p.kind === 'bool' ? true : p.options![1]]));
      for (const ps of [{}, params]) {
        const s = effectSettings(d.type, ps, 100, 500);
        const back = parseEffectSettings(d.type, s);
        expect(back, `${d.type} ${s}`).not.toBeNull();
        expect(effectSettings(d.type, back!.params, back!.fadeInMs, back!.fadeOutMs)).toBe(s);
      }
    }
  });

  it('keeps settings it cannot reproduce opaque', () => {
    expect(parseEffectSettings('Twinkle', 'E_SLIDER_Twinkle_Count=10,E_VALUECURVE_Twinkle_Count=Active=TRUE|,T_CHECKBOX_Canvas=0')).toBeNull();
    expect(parseEffectSettings('Shockwave', 'T_CHECKBOX_Canvas=0')).toBeNull();
  });

  it('sorts keys in byte order', () => {
    expect(settingsToString({ b: '1', B: '2', a_x: '3', aX: '4' })).toBe('B=2,aX=4,a_x=3,b=1');
  });
});

describe('palettes', () => {
  it('matches the 2026.17 palette layout', () => {
    const p = readXsq(fixture('CaraMia.xsq')).models.flatMap((m) => m.layers.flat()).map((e) => e.palette);
    const fromFile = p.find((x) => x.includes('C_CHECKBOX_Palette1=1'));
    const enc = encodePalette(['#ffffff']);
    if (fromFile) expect(enc).toBe(fromFile);
    expect(enc.split(',')).toHaveLength(20);
    expect(enc).toContain('C_BUTTON_Palette2=#ff0000');
  });
  it('round-trips colors', () => {
    expect(decodePalette(encodePalette(['#FF8800', '#80f']))).toEqual(['#ff8800', '#8800ff']);
  });
});

describe('layout', () => {
  const layout = parseLayout(fixture('xlights_rgbeffects.xml'));
  it('lists models and groups', () => {
    expect(layout.models.map((m) => m.name)).toContain('Pumpkin Prime');
    expect(layout.models).toHaveLength(15);
    expect(layout.groups.find((g) => g.name === 'All-RGB')?.members).toContain('RGB-Strip');
    expect(layout.models.find((m) => m.name === 'RGB-Strip')?.pixels).toBe(100);
    expect(layout.models.find((m) => m.name === 'Pumpkin Prime')?.pixels).toBe(15);
    expect(layout.xlightsVersion).toBe('2026.17');
  });
  it('reads submodels and faces', () => {
    const xml = '<xrgb><models><model name="Tree" DisplayAs="Tree 360" NumStrings="16" NodesPerString="50" WorldPosX="10" WorldPosY="20"><subModel name="Star"/><faceInfo Name="Singing"/></model></models></xrgb>';
    const m = parseLayout(xml).models[0];
    expect(m).toMatchObject({ name: 'Tree', pixels: 800, x: 10, y: 20, submodels: ['Star'], faces: ['Singing'] });
  });
});

describe('xsq writer', () => {
  it.each(MODERN)('reproduces %s from what the reader understood', (f) => {
    const src = fixture(f);
    const seq = readXsq(src);
    expect(seq.unsupported).toEqual([]);
    const out = writeXsq(seq);
    // Same document apart from per-file details xLights keeps that the composer doesn't model
    // (an older xsequence header attribute style, timing views) — compare element sections.
    const section = (s: string, tag: string) => s.slice(s.indexOf(`<${tag}`), s.indexOf(`</${tag}>`));
    for (const tag of ['ColorPalettes', 'EffectDB']) expect(section(out, tag)).toBe(section(src, tag));
    // Effect ids drift from layer order as effects are edited, and selection is UI state; neither is semantic.
    const effects = (s: string) => section(s, 'ElementEffects').replace(/ (id|selected)="\d+"/g, '');
    expect(effects(out)).toBe(effects(src));
    expect(readXsq(out).models).toEqual(seq.models);
    expect(readXsq(out).timings.map((t) => t.layers)).toEqual(seq.timings.map((t) => t.layers));
  });

  it('writes submodel layers inside the parent model', () => {
    const e = { name: 'On', startMs: 0, endMs: 500, settings: effectSettings('On', {}), palette: encodePalette(['#ff0000']) };
    const xml = writeXsq({ mediaFile: 'song.mp3', frameMs: 50, durationMs: 1000, timings: [], models: [{ name: 'Tree', layers: [[]], submodels: [{ name: 'Star', layers: [[], [e]] }] }] });
    expect(xml).toContain('<SubModelEffectLayer layer="1" name="Star">');
    expect(readXsq(xml).models[0].submodels).toEqual([{ name: 'Star', layers: [[], [e]] }]);
  });
});

describe('timing files', () => {
  it('reads every track and layer of an .xtiming, and timings from an .xsq', async () => {
    const { readTimingFile } = await import('@stemlight/xlights/timing');
    const x = readTimingFile(fixture('ThisIsHalloween.xlights.xtiming'));
    expect(x.map((t) => t.name)).toEqual(['Bars', 'Beats', 'Sections']);
    expect(x[1].layers[0].length).toBeGreaterThan(100);
    const lyric = readTimingFile('<timings><timing name="Lyrics" SourceVersion="2026.17"><EffectLayer><Effect label="hi there" starttime="0" endtime="500"/></EffectLayer><EffectLayer><Effect label="hi" starttime="0" endtime="250"/></EffectLayer></timing></timings>');
    expect(lyric[0].layers).toHaveLength(2);
    expect(readTimingFile(fixture('CaraMia.xsq')).length).toBeGreaterThan(5);
  });
});
