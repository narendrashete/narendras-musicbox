import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
`);

export default db;
