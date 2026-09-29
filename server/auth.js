import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { JWT_SECRET } from './config.js';

const COOKIE = 'mb_session';
const MAX_AGE_DAYS = 90; // it's a music app on your own phone - stay signed in

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
  return { id: u.id, username: u.username, isAdmin: !!u.is_admin, mustChangePassword: !!u.must_change_password };
}

export function requireUser(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies[COOKIE] || '', JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) throw new Error('gone');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}
