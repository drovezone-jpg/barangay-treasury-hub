/**
 * auth.js — account creation and login logic (Part 2 fix).
 * Extracted from main.js so it is headless-testable and so the IPC layer
 * stays a thin wrapper. Passwords are NEVER stored in plaintext: they are
 * hashed with scrypt + a random salt (see security.js).
 */
'use strict';

const { makeSalt, hashPassword, verifyPassword } = require('./security');

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,60}$/;

/**
 * Create the ONE authorized treasurer account. Rejects if any account
 * already exists (first-run setup only — no additional registrations).
 */
function registerInitialUser(db, { username, displayName, password }) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0)
    throw new Error('An account already exists. Please sign in with your credentials.');

  const uname = String(username || '').trim();
  const dname = String(displayName || '').trim() || uname;
  if (!USERNAME_RE.test(uname))
    throw new Error('Username must be 3–60 characters (letters, numbers, dots, dashes, underscores).');
  if (typeof password !== 'string' || password.length < 8)
    throw new Error('Password must be at least 8 characters.');

  const { salt, hash } = hashPassword(password, makeSalt());
  try {
    const info = db.prepare(
      'INSERT INTO users (username, display_name, password_salt, password_hash) VALUES (?, ?, ?, ?)'
    ).run(uname, dname.slice(0, 120), salt, hash);
    return { id: info.lastInsertRowid, username: uname, displayName: dname };
  } catch (e) {
    // Friendly message only — never leak SQLite internals to the UI.
    if (/UNIQUE/i.test(String(e.message))) throw new Error('Username already exists.');
    throw new Error('Could not create the account. Please try again.');
  }
}

/** Verify credentials. Returns {id, displayName} or throws a generic error. */
function loginUser(db, { username, password }) {
  const user = verifyPassword(db, String(username || ''), String(password || ''));
  if (!user) throw new Error('Invalid username or password.');
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return { id: user.id, displayName: user.display_name };
}

/** True when at least one account exists (drives setup-vs-login form). */
function hasAnyUser(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

module.exports = { registerInitialUser, loginUser, hasAnyUser, USERNAME_RE };
