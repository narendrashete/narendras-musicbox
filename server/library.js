import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import db from './db.js';
import { LIBRARY_DIR, ALLOWED_TYPES } from './config.js';

fs.mkdirSync(LIBRARY_DIR, { recursive: true });

// Detect the real type from the first bytes, so files with a wrong/missing extension still work.
export function sniffType(file) {
  const b = Buffer.alloc(3);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, 3, 0); } finally { fs.closeSync(fd); }
  if (b.toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return '.mp3';
  return null;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s.(-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
// ALL CAPS / all lowercase -> Title Case; mixed case is left as the tagger wrote it.
const tidy = (s) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s && (s === s.toUpperCase() || s === s.toLowerCase()) && /\p{L}/u.test(s) ? titleCase(s) : s;
};

// Misspellings found in the existing collection's tags.
const ARTIST_ALIASES = {
  'lata mangeskar': 'Lata Mangeshkar', 'lata mangeshka': 'Lata Mangeshkar',
  'mohammad rafi': 'Mohammed Rafi', 'kumar shanu': 'Kumar Sanu',
  'suhkawinder singh': 'Sukhwinder Singh', 'sukhawinder singh': 'Sukhwinder Singh',
  'a. r. rehman': 'A. R. Rahman', 'p.l.deshpande': 'P. L. Deshpande',
};

// "USHA MANGESHKAR,CHORUS" -> credits "Usha Mangeshkar", artist "Usha Mangeshkar"
export function cleanArtists(raw) {
  const names = String(raw || '')
    .split(/\s*[,;/&]\s*/)
    .map((n) => ARTIST_ALIASES[tidy(n).toLowerCase()] || tidy(n))
    .filter((n) => n && !/^(chorus|n|a|not found|various|unknown)$/i.test(n));
  return { artist: names[0] || 'Unknown Artist', credits: names.join(', ') };
}

function titleFromFilename(file) {
  let t = path.basename(file, path.extname(file))
    .replace(/^\d{1,3}[.\s_-]+/, '')      // "001. " track numbers
    .replace(/\s*\(\d+\)$/, '');         // "(1)" copy suffix
  if (!t.includes(' ')) t = t.replace(/[-_]+/g, ' ');
  return tidy(t);
}

export async function readTags(file) {
  let common = {}, format = {};
  try { ({ common, format } = await parseFile(file, { skipCovers: true })); } catch { /* untagged */ }
  return {
    title: tidy(common.title) || titleFromFilename(file),
    ...cleanArtists(common.artists?.join(', ') || common.artist),
    album: tidy(common.album) || null,
    duration: format.duration ? Math.round(format.duration) : null,
  };
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Windows/OneDrive-safe file/folder name.
export function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 90) || 'Untitled';
}

// Library layout: <Artist>/<Title>.mp3, with " (2)" etc. when a different recording has the same name.
function destPathFor(artist, title, ext, skipRel = null) {
  const dir = safeName(artist);
  const base = safeName(title);
  for (let n = 1; ; n++) {
    const rel = path.posix.join(dir, `${base}${n > 1 ? ` (${n})` : ''}${ext}`);
    if (rel === skipRel) return rel;
    if (!fs.existsSync(path.join(LIBRARY_DIR, rel)) && !db.prepare('SELECT 1 FROM songs WHERE rel_path = ?').get(rel)) return rel;
  }
}

export const absPath = (rel) => path.join(LIBRARY_DIR, ...rel.split('/'));

// Match an existing artist's spelling/casing so "kishore kumar" lands in "Kishore Kumar".
function canonicalArtist(name) {
  const row = db.prepare('SELECT artist FROM songs WHERE artist = ? COLLATE NOCASE LIMIT 1').get(name);
  return row ? row.artist : name;
}

/**
 * Put a file into the library and index it. `mode` 'copy' keeps the source, 'move' removes it
 * (used for uploads). `overrides` lets the uploader correct title/artist.
 * Returns { song, duplicate }.
 */
export async function addFile(src, { mode = 'copy', uploadedBy = null, overrides = {} } = {}) {
  const ext = sniffType(src);
  if (!ext || !ALLOWED_TYPES[ext]) throw Object.assign(new Error('Only MP3 files are allowed'), { status: 400 });

  const hash = await hashFile(src);
  const existing = db.prepare('SELECT * FROM songs WHERE hash = ?').get(hash);
  if (existing) {
    if (mode === 'move') fs.rmSync(src, { force: true });
    return { song: existing, duplicate: true };
  }

  const tags = await readTags(src);
  const title = tidy(overrides.title) || tags.title;
  const artistInfo = overrides.artist ? cleanArtists(overrides.artist) : tags;
  const artist = canonicalArtist(artistInfo.artist);
  const rel = destPathFor(artist, title, ext);
  const dest = absPath(rel);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (mode === 'move') {
    try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); }
  } else {
    fs.copyFileSync(src, dest);
  }

  const info = db.prepare(`INSERT INTO songs (title, artist, credits, album, duration, rel_path, size, hash, mime, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, artist, artistInfo.credits || artist, tags.album, tags.duration, rel, fs.statSync(dest).size, hash, ALLOWED_TYPES[ext], uploadedBy);
  return { song: db.prepare('SELECT * FROM songs WHERE id = ?').get(info.lastInsertRowid), duplicate: false };
}

// Rename title/artist: moves the file to its new <Artist>/<Title> spot too, so the folder stays organised.
export function renameSong(id, { title, artist }) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return null;
  const newTitle = tidy(title) || song.title;
  const a = artist ? cleanArtists(artist) : { artist: song.artist, credits: song.credits };
  const newArtist = canonicalArtist(a.artist);
  const rel = destPathFor(newArtist, newTitle, path.extname(song.rel_path), song.rel_path);
  if (rel !== song.rel_path) {
    fs.mkdirSync(path.dirname(absPath(rel)), { recursive: true });
    fs.renameSync(absPath(song.rel_path), absPath(rel));
    const oldDir = path.dirname(absPath(song.rel_path));
    if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
  }
  db.prepare('UPDATE songs SET title = ?, artist = ?, credits = ?, rel_path = ? WHERE id = ?')
    .run(newTitle, newArtist, artist ? a.credits : song.credits, rel, id);
  return db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
}

/**
 * Index any file sitting in the library folder that the DB doesn't know about (e.g. dropped straight
 * into OneDrive) and drop DB rows whose file is gone. Keeps the folder as the source of truth.
 */
export async function scanLibrary() {
  const known = new Set(db.prepare('SELECT rel_path FROM songs').all().map((r) => r.rel_path));
  const seen = new Set();
  let added = 0;
  const walk = async (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!ALLOWED_TYPES[path.extname(e.name).toLowerCase()]) continue;
      const rel = path.relative(LIBRARY_DIR, p).split(path.sep).join('/');
      seen.add(rel);
      if (known.has(rel)) continue;
      const hash = await hashFile(p);
      if (db.prepare('SELECT 1 FROM songs WHERE hash = ?').get(hash)) continue;
      const tags = await readTags(p);
      db.prepare(`INSERT INTO songs (title, artist, credits, album, duration, rel_path, size, hash, mime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tags.title, rel.includes('/') ? rel.split('/')[0] : tags.artist,
        tags.credits, tags.album, tags.duration, rel, fs.statSync(p).size, hash, ALLOWED_TYPES[path.extname(p).toLowerCase()]);
      added++;
    }
  };
  await walk(LIBRARY_DIR);
  const missing = [...known].filter((r) => !seen.has(r));
  // An offline/unmounted folder looks empty - never let that wipe the library and everyone's favourites.
  if (missing.length > Math.max(5, known.size / 2)) {
    console.warn(`scan: ${missing.length} files missing - library folder offline? Not removing anything.`);
    return { added, removed: 0 };
  }
  for (const r of missing) db.prepare('DELETE FROM songs WHERE rel_path = ?').run(r);
  return { added, removed: missing.length };
}
