/**
 * security.js — password hashing (scrypt, no external dependencies).
 * Runs only in the main process; headless-testable with plain Node.
 */
'use strict';

const crypto = require('crypto');
const KEYLEN = 64;

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, saltHex) {
  const salt = saltHex || makeSalt();
  const hash = crypto.scryptSync(String(password), salt, KEYLEN).toString('hex');
  return { salt, hash };
}

function verifyPassword(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!user) {
    // Run a dummy hash anyway so timing does not trivially reveal user existence.
    crypto.scryptSync('x', 'y', KEYLEN);
    return null;
  }
  const attempt = crypto.scryptSync(String(password), user.password_salt, KEYLEN);
  const stored = Buffer.from(user.password_hash, 'hex');
  if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) return null;
  return user;
}

module.exports = { makeSalt, hashPassword, verifyPassword };
