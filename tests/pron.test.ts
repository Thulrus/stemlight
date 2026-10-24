import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parsePronDict, phoneSyllables, wordPron } from '../src/align/pron';

const dict = parsePronDict(gunzipSync(readFileSync(new URL('../public/cmudict.txt.gz', import.meta.url))).toString('utf8'));
const syl = (w: string) => wordPron(w, dict).syllables.map((s) => s.text);

describe('pronunciation', () => {
  it('loads the dictionary', () => {
    expect(dict.get('CANDY')).toEqual(['K', 'AE', 'N', 'D', 'IY']);
    expect(dict.size).toBeGreaterThan(100_000);
  });
  it('splits phones by maximal onset', () => {
    expect(phoneSyllables(['K', 'AE', 'N', 'D', 'IY'])).toEqual([0, 3]);
    expect(phoneSyllables(['HH', 'AE', 'L', 'AH', 'W', 'IY', 'N'])).toEqual([0, 2, 4]);
    expect(phoneSyllables(['EH', 'K', 'S', 'T', 'R', 'AH'])).toEqual([0, 2]); // ek-stra
  });
  it('maps syllables onto letters', () => {
    expect(syl('CANDY')).toEqual(['CAN', 'DY']);
    expect(syl('HALLOWEEN')).toEqual(['HAL', 'LO', 'WEEN']);
    expect(syl('SEARCHING')).toEqual(['SEAR', 'CHING']);
    expect(syl('EVERY')).toEqual(['E', 'VER', 'Y']); // CMUdict: EH V ER IY
    expect(syl('MAKE')).toEqual(['MAKE']);
    expect(syl("THERE'S")).toEqual(["THERE'S"]);
    expect(syl('XYZZYQ')).toEqual(['XYZ', 'ZYQ']);
  });
  it('places phones on letters', () => {
    const p = wordPron('KNIGHT', dict).phones;
    expect(p.map((x) => x.phone)).toEqual(['N', 'AY', 'T']);
    // The silent K joins the N; either way the phone starts where the word does.
    expect(p.map((x) => x.letter)).toEqual([0, 2, 5]);
  });
});
