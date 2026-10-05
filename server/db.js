import fs from 'node:fs';
import path from 'node:path';
// Node's built-in SQLite: no native npm module to compile (the Windows server has no build tools).
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,          -- primary artist: folder name + grouping
  credits TEXT,                  -- all credited singers, for display
  album TEXT,
  duration REAL,
  rel_path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS song_categories (
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (song_id, category_id)
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, song_id)
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE,
  seconds INTEGER NOT NULL DEFAULT 0,   -- how long they actually listened
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS plays_song ON plays(song_id);
CREATE INDEX IF NOT EXISTS plays_user ON plays(user_id);
-- Things going wrong for people: failed sign-ins, songs that won't play, stalls, failed uploads, JS crashes.
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,                         -- kept for failed sign-ins, where there may be no user
  kind TEXT NOT NULL,
  song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  detail TEXT,
  device TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS problems_created ON problems(created_at);
-- Small key/value store for admin-set options (e.g. the buddies' invite code).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Existing databases predate these columns.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen TEXT');
if (!userCols.includes('last_login')) db.exec('ALTER TABLE users ADD COLUMN last_login TEXT');
// Buddies: one row per phone that came in through the invite link, no password of their own.
if (!userCols.includes('is_guest')) db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('name')) db.exec('ALTER TABLE users ADD COLUMN name TEXT');
// Community mentors approve or delete uploads; the admin is always one too.
if (!userCols.includes('is_mentor')) db.exec('ALTER TABLE users ADD COLUMN is_mentor INTEGER NOT NULL DEFAULT 0');
// Uploads from non-mentors wait here (approved = 0) and stay hidden until a mentor approves them.
const songCols = db.prepare('PRAGMA table_info(songs)').all().map((c) => c.name);
if (!songCols.includes('approved')) db.exec('ALTER TABLE songs ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
export const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

export default db;
