// Create a user from the command line (used for the first admin), or reset an existing user's
// password. Prints a one-time random password; it must be changed on first sign-in.
// Usage: npm run create-user -- <username> [--admin]
import db from '../server/db.js';
import { hashPassword, randomPassword } from '../server/auth.js';

const [username, flag] = process.argv.slice(2);
if (!username) { console.error('Usage: npm run create-user -- <username> [--admin]'); process.exit(1); }

const password = randomPassword();
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), existing.id);
  console.log(`Reset password for "${username}". One-time password: ${password}`);
} else {
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), flag === '--admin' ? 1 : 0);
  console.log(`Created ${flag === '--admin' ? 'admin ' : ''}user "${username}". One-time password: ${password}`);
}
