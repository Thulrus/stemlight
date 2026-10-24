// Builds public/cmudict.txt.gz from the CMU Pronouncing Dictionary (BSD-style license, see
// THIRD_PARTY_LICENSES): one line per word, "word PH ON EMES", first pronunciation only, stress
// marks removed. Run: node tools/build-pron-dict.mjs <path to cmudict.dict>
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const seen = new Set();
const out = [];
for (const raw of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const line = raw.split('#')[0].trim();
  if (!line) continue;
  const [word, ...phones] = line.split(/\s+/);
  if (!/^[a-z']+$/.test(word) || seen.has(word)) continue;
  seen.add(word);
  out.push(`${word} ${phones.map((p) => p.replace(/\d/g, '')).join(' ')}`);
}
writeFileSync(new URL('../public/cmudict.txt.gz', import.meta.url), gzipSync(out.join('\n') + '\n', { level: 9 }));
console.log(`${out.length} words`);
