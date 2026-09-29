// One-off (re-runnable) import: copies every MP3 from the source folders into the library as
// <Artist>/<Title>.mp3 and indexes it. Sources are left untouched; exact duplicates are skipped.
// Usage: npm run import -- "E:\music_legacy" "C:\Users\naren\OneDrive\music"
import fs from 'node:fs';
import path from 'node:path';
import { addFile, sniffType } from '../server/library.js';
import { LIBRARY_DIR } from '../server/config.js';

const sources = process.argv.slice(2);
if (!sources.length) { console.error('Give one or more source folders'); process.exit(1); }

// Files whose tags are missing or wrong, fixed by hand (keyed by file name).
const OVERRIDES = {
  'kishore kumar': { title: 'Aa Chal Ke Tujhe', artist: 'Kishore Kumar' },
  'Hum Dil De Chuke Sanam-Sadhana Sargam-Hum Dil De Chuke Sanam [Original Soundtrack].mp3': { title: 'Hum Dil De Chuke Sanam', artist: 'Sadhana Sargam' },
  'Why does sex play such an important part in life J. Krishnamurti.mp3': { title: 'Why Does Sex Play Such an Important Part in Life', artist: 'J. Krishnamurti' },
};

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)));
sources.forEach(walk);

const stats = { added: 0, duplicate: 0, skipped: [] };
for (const f of files) {
  if (sniffType(f) !== '.mp3') { stats.skipped.push(f); continue; }
  const { song, duplicate } = await addFile(f, { overrides: OVERRIDES[path.basename(f)] || {} });
  stats[duplicate ? 'duplicate' : 'added']++;
  console.log(duplicate ? 'dup ' : 'ok  ', song.rel_path);
}
console.log(`\nLibrary: ${LIBRARY_DIR}\nadded ${stats.added}, duplicates skipped ${stats.duplicate}, non-MP3 skipped ${stats.skipped.length}:`);
stats.skipped.forEach((f) => console.log('  -', f));
