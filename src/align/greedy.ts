import { frameTime, type Emissions } from './ctc';
import { syllabify } from './text';

/**
 * Syllable onsets without lyrics: greedy CTC decoding of the character model gives letters at
 * the frames they're emitted, even when the words come out misspelled. Each decoded word is
 * split into spelled syllables, and a syllable starts at its first letter. Singing the model
 * can't read at all (vocalises, other languages) yields fewer letters, not false ones.
 * `minProb` drops letter spikes the model isn't sure of.
 */
export function greedySyllables(em: Emissions, vocab: Record<string, number>, minProb = 0.1): { start: number; text: string }[] {
  const id2ch: string[] = [];
  for (const [ch, id] of Object.entries(vocab)) id2ch[id] = ch;
  const blank = vocab['<pad>'] ?? 0;
  const sep = vocab['|'];
  const words: { letters: string; frames: number[] }[] = [];
  let cur = { letters: '', frames: [] as number[] };
  let prev = -1;
  const V = em.vocab;
  for (let t = 0; t < em.frames; t++) {
    let best = 0;
    for (let k = 1; k < V; k++) if (em.logp[t * V + k] > em.logp[t * V + best]) best = k;
    if (best !== prev && best !== blank) {
      const ch = id2ch[best];
      if (best === sep || !ch || !/^[A-Z']$/.test(ch)) {
        if (cur.letters) words.push(cur);
        cur = { letters: '', frames: [] };
      } else if (Math.exp(em.logp[t * V + best]) >= minProb) {
        cur.letters += ch;
        cur.frames.push(t);
      }
    }
    prev = best;
  }
  if (cur.letters) words.push(cur);
  const out: { start: number; text: string }[] = [];
  for (const w of words) {
    let i = 0;
    for (const s of syllabify(w.letters)) {
      out.push({ start: frameTime(em, w.frames[i]), text: s });
      i += s.length;
    }
  }
  return out;
}

