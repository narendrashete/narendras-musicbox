import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { JWT_SECRET } from './config.js';

const COOKIE = 'mb_session';
// It's a music app on your own phone: stay signed in until you sign out. The cookie is renewed
// as the app is used (see requireUser), so only a year of not opening it signs you out.
const MAX_AGE_DAYS = 365;

export const hashPassword = (p) => bcrypt.hashSync(p, 10);
export const checkPassword = (p, h) => bcrypt.compareSync(p, h);

// Readable one-time password: 12 chars, no look-alike characters.
export function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => chars[b % chars.length]).join('');
}

export function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: `${MAX_AGE_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: res.req.secure, maxAge: MAX_AGE_DAYS * 864e5,
  });
}

export const clearSession = (res) => res.clearCookie(COOKIE);

export function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name || null, isAdmin: !!u.is_admin,
    isGuest: !!u.is_guest, mustChangePassword: !!u.must_change_password,
  };
}

// The signed-in user for this request, or null.
export function sessionUser(req) {
  try {
    const { uid, iat } = jwt.verify(req.cookies[COOKIE] || '', JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    return user ? { user, iat } : null;
  } catch { return null; }
}

export function requireUser(req, res, next) {
  try {
    const s = sessionUser(req);
    if (!s) throw new Error('gone');
    const { user } = s;
    req.user = user;
    if (Date.now() / 1000 - s.iat > 86400) setSession(res, user); // slide the expiry forward, once a day
    // "Last seen" for the admin dashboard; throttled so streaming doesn't write on every request.
    if (!user.last_seen || Date.now() - Date.parse(`${user.last_seen}Z`) > 60e3) {
      db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);
    }
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}
