import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import db from './db.js';
import { PORT, HOST, APP_DIR, ALLOWED_TYPES, MAX_UPLOAD_MB, LIBRARY_DIR, DB_PATH } from './config.js';
import { addFile, absPath, renameSong, scanLibrary, sniffType } from './library.js';
import {
  requireUser, requireAdmin, setSession, clearSession, publicUser,
  hashPassword, checkPassword, randomPassword,
} from './auth.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

const logProblem = ({ userId = null, username = null, kind, songId = null, detail = null, req }) => {
  const device = String(req.get('user-agent') || '').slice(0, 200);
  db.prepare('INSERT INTO problems (user_id, username, kind, song_id, detail, device) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, username, kind, songId, detail && String(detail).slice(0, 300), device);
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !checkPassword(password, user.password_hash)) {
    logProblem({ userId: user?.id, username: username.trim().slice(0, 40), kind: user ? 'login_wrong_password' : 'login_unknown_user', req });
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  db.prepare("UPDATE users SET last_login = datetime('now'), last_seen = datetime('now') WHERE id = ?").run(user.id);
  setSession(res, user);
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

app.use('/api', requireUser);

app.get('/api/me', (req, res) => res.json(publicUser(req.user)));

app.post('/api/me/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(current || '', req.user.password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

// ---------- library ----------
const songSelect = `
  SELECT s.id, s.title, s.artist, s.credits, s.album, s.duration, s.created_at,
         u.username AS uploaded_by,
         EXISTS (SELECT 1 FROM favorites f WHERE f.song_id = s.id AND f.user_id = @uid) AS fav,
         (SELECT group_concat(sc.category_id) FROM song_categories sc WHERE sc.song_id = s.id) AS cats
  FROM songs s LEFT JOIN users u ON u.id = s.uploaded_by`;
const shapeSong = (r) => ({ ...r, fav: !!r.fav, cats: r.cats ? r.cats.split(',').map(Number) : [] });
const getSong = (id, uid) => {
  const r = db.prepare(`${songSelect} WHERE s.id = @id`).get({ id, uid });
  return r && shapeSong(r);
};

// The whole library in one go - a few thousand rows is still small, and it lets the phone
// search/filter instantly without round trips.
app.get('/api/library', (req, res) => {
  const songs = db.prepare(`${songSelect} ORDER BY s.title COLLATE NOCASE`).all({ uid: req.user.id }).map(shapeSong);
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE').all();
  res.json({ songs, categories });
});

// Streams with HTTP Range support: the player fetches only the bytes it's about to play,
// and nothing is stored on the phone beyond the browser's normal playback buffer.
app.get('/api/songs/:id/stream', (req, res) => {
  const song = db.prepare('SELECT rel_path, mime FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).end();
  const file = absPath(song.rel_path);
  // Trust the file's bytes over its name: an AAC/M4A file named .mp3 served as audio/mpeg won't play on iPhone/Safari.
  let mime = song.mime;
  try { mime = ALLOWED_TYPES[sniffType(file)] || mime; } catch {}
  res.sendFile(file, {
    acceptRanges: true, dotfiles: 'allow',
    headers: { 'Content-Type': mime, 'Cache-Control': 'private, no-store' },
  }, (err) => { if (err && !res.headersSent) res.status(err.statusCode || 500).end(); });
});

// One row per song someone actually listened to (the app reports it after ~20s of playback).
app.post('/api/plays', (req, res) => {
  const songId = Number(req.body?.songId);
  if (!db.prepare('SELECT 1 FROM songs WHERE id = ?').get(songId)) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT INTO plays (user_id, song_id, seconds) VALUES (?, ?, ?)')
    .run(req.user.id, songId, Math.min(Math.max(Math.round(Number(req.body?.seconds) || 0), 0), 86400));
  res.json({ ok: true });
});

// Trouble reported by the app itself (song won't play, buffering for ages, upload failed, crash).
const PROBLEM_KINDS = new Set(['play_error', 'stall', 'upload_failed', 'js_error']);
app.post('/api/problems', (req, res) => {
  const { kind, songId, detail } = req.body || {};
  if (!PROBLEM_KINDS.has(kind)) return res.status(400).json({ error: 'Unknown kind' });
  const sid = db.prepare('SELECT id FROM songs WHERE id = ?').get(Number(songId))?.id ?? null;
  logProblem({ userId: req.user.id, kind, songId: sid, detail, req });
  res.json({ ok: true });
});

app.put('/api/songs/:id/favorite', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, song_id) VALUES (?, ?)').run(req.user.id, req.params.id);
  res.json({ fav: true });
});
app.delete('/api/songs/:id/favorite', (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND song_id = ?').run(req.user.id, req.params.id);
  res.json({ fav: false });
});

// ---------- upload (any signed-in user) ----------
const upload = multer({
  dest: path.join(os.tmpdir(), 'musicbox-uploads'),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED_TYPES[path.extname(file.originalname).toLowerCase()]),
});

app.post('/api/songs', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Only MP3 or M4A files are allowed' });
  try {
    const { song, duplicate } = await addFile(req.file.path, {
      mode: 'move', uploadedBy: req.user.id, originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), overrides: { title: req.body.title, artist: req.body.artist },
    });
    res.status(duplicate ? 200 : 201).json({ song: getSong(song.id, req.user.id), duplicate });
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
}));

// ---------- admin: song details + categories ----------
app.patch('/api/songs/:id', requireAdmin, (req, res) => {
  const { title, artist, cats } = req.body || {};
  if (title !== undefined || artist !== undefined) {
    if (!renameSong(req.params.id, { title, artist })) return res.status(404).json({ error: 'Not found' });
  }
  if (Array.isArray(cats)) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM song_categories WHERE song_id = ?').run(req.params.id);
      const ins = db.prepare('INSERT OR IGNORE INTO song_categories (song_id, category_id) VALUES (?, ?)');
      cats.forEach((c) => ins.run(req.params.id, c));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  res.json(getSong(req.params.id, req.user.id));
});

app.post('/api/categories', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
  res.json(db.prepare('SELECT id, name FROM categories WHERE name = ?').get(name));
});
app.patch('/api/categories/:id', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ id: Number(req.params.id), name });
});
app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: users ----------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username').all());
});
app.post('/api/users', requireAdmin, (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!/^[\w.-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username: 3-30 letters, numbers, . _ -' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'Username taken' });
  const password = randomPassword();
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hashPassword(password), req.body.isAdmin ? 1 : 0);
  res.json({ username, password }); // shown once to the admin to pass on
});
app.post('/api/users/:id/reset', requireAdmin, (req, res) => {
  const password = randomPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), req.params.id);
  res.json({ password });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: health check (is the OneDrive folder readable? which song files are missing?) ----------
app.get('/api/admin/health', requireAdmin, wrap(async (req, res) => {
  const out = {
    time: new Date().toISOString(), node: process.version, uptimeMin: Math.round(process.uptime() / 60),
    libraryDir: LIBRARY_DIR, folder: { ok: false }, songs: { total: 0, ok: 0, missing: 0, failures: [] }, readTest: null,
  };
  try {
    out.folder = { ok: true, entries: fs.readdirSync(LIBRARY_DIR).length };
  } catch (e) { out.folder = { ok: false, error: `${e.code || ''} ${e.message}`.trim() }; }

  try {
    const st = fs.statfsSync(LIBRARY_DIR);
    out.disk = { freeGB: +(st.bavail * st.bsize / 1e9).toFixed(1), totalGB: +(st.blocks * st.bsize / 1e9).toFixed(1) };
  } catch {}

  // The OneDrive backup job (Musicbox-Sync) writes this file after every run.
  const syncFile = process.env.SYNC_STATUS_FILE || path.join(path.dirname(DB_PATH), '..', 'logs', 'sync-status.json');
  try {
    const b = JSON.parse(fs.readFileSync(syncFile, 'utf8').replace(/^\uFEFF/, ''));
    out.backup = { ok: !!b.ok, time: b.time, ageMin: Math.round((Date.now() - Date.parse(b.time)) / 60000), error: b.error || '' };
  } catch { out.backup = null; }

  const rows = db.prepare('SELECT id, title, rel_path FROM songs').all();
  out.songs.total = rows.length;
  for (let i = 0; i < rows.length; i += 20) { // small batches so a slow network drive isn't hit all at once
    await Promise.all(rows.slice(i, i + 20).map(async (r) => {
      try { await fs.promises.access(absPath(r.rel_path), fs.constants.R_OK); out.songs.ok++; }
      catch (e) {
        out.songs.missing++;
        if (out.songs.failures.length < 15) out.songs.failures.push({ id: r.id, title: r.title, path: r.rel_path, error: e.code || e.message });
      }
    }));
  }

  // Actually read bytes from one song, the way a play would.
  const first = rows.find((r) => fs.existsSync(absPath(r.rel_path)));
  if (first) {
    const t0 = Date.now();
    try {
      const fd = await fs.promises.open(absPath(first.rel_path), 'r');
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      out.readTest = { ok: true, title: first.title, bytes: bytesRead, ms: Date.now() - t0, type: sniffType(absPath(first.rel_path)) };
    } catch (e) { out.readTest = { ok: false, title: first.title, error: `${e.code || ''} ${e.message}`.trim() }; }
  }
  res.json(out);
}));

// ---------- admin: usage dashboard ----------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = `-${days} days`;
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const users = all(`
    SELECT u.id, u.username, u.is_admin, u.must_change_password, u.created_at, u.last_login, u.last_seen,
      (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id AND p.created_at >= datetime('now', ?)) AS plays,
      (SELECT COALESCE(SUM(seconds), 0) FROM plays p WHERE p.user_id = u.id AND p.created_at >= datetime('now', ?)) AS seconds,
      (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id) AS plays_ever,
      (SELECT s.title FROM plays p JOIN songs s ON s.id = p.song_id WHERE p.user_id = u.id ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS last_song,
      (SELECT COUNT(*) FROM songs s WHERE s.uploaded_by = u.id) AS uploads,
      (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS favourites,
      (SELECT COUNT(*) FROM problems x WHERE x.user_id = u.id AND x.created_at >= datetime('now', ?)) AS problems,
      (SELECT COUNT(*) FROM problems x WHERE x.user_id = u.id AND x.kind LIKE 'login_%' AND x.created_at >= datetime('now', ?)) AS failed_logins
    FROM users u ORDER BY u.last_seen DESC, u.username`, since, since, since, since);

  const topSongs = all(`
    SELECT s.id, s.title, s.artist, COUNT(*) AS plays, COUNT(DISTINCT p.user_id) AS listeners,
           SUM(p.seconds) AS seconds, MAX(p.created_at) AS last_played
    FROM plays p JOIN songs s ON s.id = p.song_id
    WHERE p.created_at >= datetime('now', ?) GROUP BY s.id ORDER BY plays DESC, seconds DESC LIMIT 15`, since);

  const topArtists = all(`
    SELECT s.artist, COUNT(*) AS plays, COUNT(DISTINCT p.user_id) AS listeners
    FROM plays p JOIN songs s ON s.id = p.song_id
    WHERE p.created_at >= datetime('now', ?) GROUP BY s.artist ORDER BY plays DESC LIMIT 8`, since);

  const daily = all(`
    SELECT date(created_at) AS day, COUNT(*) AS plays, COUNT(DISTINCT user_id) AS listeners
    FROM plays WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`, since);

  const uploads = all(`
    SELECT s.id, s.title, s.artist, s.created_at, u.username AS uploaded_by
    FROM songs s LEFT JOIN users u ON u.id = s.uploaded_by
    WHERE s.uploaded_by IS NOT NULL ORDER BY s.created_at DESC LIMIT 20`);

  const problems = all(`
    SELECT x.id, x.kind, x.detail, x.device, x.created_at, COALESCE(u.username, x.username) AS username, s.title AS song
    FROM problems x LEFT JOIN users u ON u.id = x.user_id LEFT JOIN songs s ON s.id = x.song_id
    WHERE x.created_at >= datetime('now', ?) ORDER BY x.created_at DESC, x.id DESC LIMIT 60`, since);

  const brokenSongs = all(`
    SELECT s.id, s.title, s.artist, COUNT(*) AS errors, COUNT(DISTINCT x.user_id) AS people
    FROM problems x JOIN songs s ON s.id = x.song_id
    WHERE x.kind = 'play_error' AND x.created_at >= datetime('now', ?) GROUP BY s.id ORDER BY errors DESC LIMIT 10`, since);

  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM songs) AS songs, (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM plays WHERE created_at >= datetime('now', ?)) AS plays,
           (SELECT COALESCE(SUM(seconds), 0) FROM plays WHERE created_at >= datetime('now', ?)) AS seconds,
           (SELECT COUNT(*) FROM songs WHERE uploaded_by IS NOT NULL AND created_at >= datetime('now', ?)) AS uploads`).get(since, since, since);

  res.json({ days, totals, users, topSongs, topArtists, daily, uploads, problems, brokenSongs });
});

app.post('/api/rescan', requireAdmin, wrap(async (req, res) => res.json(await scanLibrary())));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File is bigger than ${MAX_UPLOAD_MB} MB` });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
});

// ---------- app shell ----------
app.use(express.static(path.join(APP_DIR, 'public'), { index: 'index.html' }));

app.listen(PORT, HOST, () => {
  console.log(`${new Date().toISOString()} Narendra's Musicbox on http://${HOST}:${PORT}  (library: ${LIBRARY_DIR})`);
  scanLibrary().then((r) => (r.added || r.removed) && console.log('scan:', r)).catch((e) => console.error('scan failed', e));
});
