import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

// App root, so the server works the same whatever folder it's started from (e.g. as a Windows task).
export const APP_DIR = path.join(import.meta.dirname, '..');
dotenv.config({ path: path.join(APP_DIR, '.env') });

export const PORT = Number(process.env.PORT || 4300);
export const HOST = process.env.HOST || '0.0.0.0'; // 127.0.0.1 behind a reverse proxy
// The music library folder. On a PC it can be the OneDrive-synced folder; on the server it's a plain
// local folder that a scheduled rclone job backs up to OneDrive. The app only ever sees a plain folder.
export const LIBRARY_DIR = process.env.LIBRARY_DIR || path.join(os.homedir(), 'OneDrive', 'Narendras musicbox');
export const DB_PATH = process.env.DB_PATH || path.join(APP_DIR, 'data', 'musicbox.db');
export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET missing - copy .env.example to .env and set it');

// Adding a format = add its extension + mime type here (and teach sniffType in library.js to spot it).
export const ALLOWED_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
export const MAX_UPLOAD_MB = 60;
