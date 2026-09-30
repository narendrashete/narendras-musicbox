import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import db from './db.js';
import { PORT, HOST, APP_DIR, ALLOWED_TYPES, MAX_UPLOAD_MB, LIBRARY_DIR } from './config.js';
import { addFile, absPath, renameSong, scanLibrary } from './library.js';
import {
  requireUser, requireAdmin, setSession, clearSession, publicUser,
  hashPassword, checkPassword, randomPassword,
} from './auth.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !checkPassword(password, user.password_hash)) return res.status(401).json({ error: 'Wrong username or password' });
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
  res.sendFile(absPath(song.rel_path), {
    acceptRanges: true, dotfiles: 'allow',
    headers: { 'Content-Type': song.mime, 'Cache-Control': 'private, no-store' },
  }, (err) => { if (err && !res.headersSent) res.status(err.statusCode || 500).end(); });
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
