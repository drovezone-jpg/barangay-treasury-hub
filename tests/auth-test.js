/**
 * tests/auth-test.js — login / registration verification suite (headless).
 *   npm run test:auth
 * Covers: first-time account creation, successful login, wrong-password
 * rejection, reopen-DB-and-login-again, no plaintext storage, second
 * registration blocked, schema/column consistency.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseService } = require('../src/main/database');
const { registerInitialUser, loginUser, hasAnyUser } = require('../src/main/auth');

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.error('  FAIL', name); }
};
const expectThrow = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-auth-'));
const svc = new DatabaseService();
const info = svc.init(dir);
const db = svc.db;

console.log('Schema version:', info.schemaVersion);
check('users table exists with expected columns', (() => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  return ['id', 'username', 'display_name', 'password_salt', 'password_hash', 'role', 'created_at', 'last_login_at']
    .every((c) => cols.includes(c));
})());

console.log('\n== 1. First-time account creation ==');
check('no account exists on fresh DB', hasAnyUser(db) === false);
const u = registerInitialUser(db, { username: 'maria.santos', displayName: 'Maria Santos', password: 'S3cure!pass' });
check('registration succeeds on empty DB', !!u && u.username === 'maria.santos');
check('exactly one account now exists', db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 1);

console.log('\n== 2. Existing-account protection ==');
check('second registration rejected', expectThrow(
  () => registerInitialUser(db, { username: 'intruder', displayName: 'X', password: '12345678' }),
  /already exists/i));
check('duplicate username rejected with friendly message', expectThrow(() => {
  db.prepare('DELETE FROM users').run();
  registerInitialUser(db, { username: 'maria.santos', displayName: 'M', password: 'S3cure!pass' });
  registerInitialUser(db, { username: 'maria.santos', displayName: 'M', password: 'Other!pass1' });
}, /already exists/i));
check('short password (<8) rejected', expectThrow(() => {
  db.prepare('DELETE FROM users').run();
  registerInitialUser(db, { username: 'maria.santos', displayName: 'M', password: 'short' });
}, /at least 8/i));
// recreate the canonical account for later steps
db.prepare('DELETE FROM users').run();
registerInitialUser(db, { username: 'maria.santos', displayName: 'Maria Santos', password: 'S3cure!pass' });

console.log('\n== 3. Stored credentials are not plaintext ==');
const row = db.prepare('SELECT username, display_name, password_salt, password_hash FROM users').get();
check('password_salt is a 32-char hex salt', /^[0-9a-f]{32}$/.test(row.password_salt));
check('password_hash is 128-char hex (scrypt, 64 bytes)', /^[0-9a-f]{128}$/.test(row.password_hash));
check('password hash ≠ plaintext', row.password_hash !== 'S3cure!pass');
check('salt ≠ plaintext password', row.password_salt !== 'S3cure!pass');

console.log('\n== 4. Login verification ==');
const ok = loginUser(db, { username: 'maria.santos', password: 'S3cure!pass' });
check('correct credentials accepted', !!ok && ok.displayName === 'Maria Santos');
check('wrong password rejected with generic message', expectThrow(
  () => loginUser(db, { username: 'maria.santos', password: 'wrongpass99' }),
  /^Invalid username or password\.$/));
check('unknown username rejected with same generic message', expectThrow(
  () => loginUser(db, { username: 'nobody', password: 'whatever123' }),
  /^Invalid username or password\.$/));
check('last_login_at updated on success',
  !!db.prepare('SELECT last_login_at FROM users WHERE username = ?').get('maria.santos').last_login_at);

console.log('\n== 5. Persistence: close & reopen DB, sign in again ==');
const snap = db.prepare('SELECT username, display_name, password_salt, password_hash FROM users').get();
svc.close();
const svc2 = new DatabaseService();
svc2.init(dir);
const ok2 = loginUser(svc2.db, { username: 'maria.santos', password: 'S3cure!pass' });
check('login works after app restart (credentials persisted)', !!ok2 && ok2.displayName === 'Maria Santos');
const row2 = svc2.db.prepare('SELECT password_salt, password_hash FROM users').get();
check('stored hash/salt unchanged across restart', row2.password_hash === snap.password_hash && row2.password_salt === snap.password_salt);
check('wrong password still rejected after restart', expectThrow(
  () => loginUser(svc2.db, { username: 'maria.santos', password: 'wrongpass99' }),
  /^Invalid username or password\.$/));
check('registration still blocked after restart', expectThrow(
  () => registerInitialUser(svc2.db, { username: 'newbie', displayName: 'N', password: '12345678' }),
  /already exists/i));
// barangay data also still persists (regression of Part 2)
const b = svc2.addBarangay({ name: 'Persistence Check', openingBalance: '1000' });
check('barangay creation still works post-restart (DB intact)', !!b.id && b.balance_c === 100000);
svc2.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
