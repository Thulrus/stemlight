import { describe, expect, it } from 'vitest';
import { stemFromFileName } from '../src/audio/decode';

describe('stemFromFileName', () => {
  it.each([
    ['drums.wav', 'drums'],
    ['My Song - Drums.flac', 'drums'],
    ['song_bass.mp3', 'bass'],
    ['vocals.wav', 'vocals'],
    ['Lead Vox.wav', 'vocals'],
    ['other.wav', 'other'],
    ['song (Instrumental).wav', 'other'],
    ['03 This Is Halloween.mp3', undefined],
    ['Bassline Boogie.mp3', undefined],
  ] as const)('%s -> %s', (name, stem) => {
    expect(stemFromFileName(name)).toBe(stem);
  });
});
