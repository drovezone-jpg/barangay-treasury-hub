/**
 * tests/migration-test.js — headless schema verification.
 * Runs the real migrations against a temp SQLite DB without Electron.
 *   npm run test:migrations
 * Uses better-sqlite3; if unavailable, falls back to node:sqlite
 * (node --experimental-sqlite) via a tiny API shim.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigrations } = require('../src/main/migrations');

function openDb() {
  try {
    const Database = require('better-sqlite3');
    return new Database(path.join(os.tmpdir(), `bth-test-${Date.now()}.db`));
  } catch (e) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(os.tmpdir(), `bth-test-${Date.now()}.db`));
    // minimal better-sqlite3-compatible shim
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...a) => stmt.run(...a),
          get: (...a) => stmt.get(...a),
          all: (...a) => stmt.all(...a),
        };
      },
      transaction: (fn) => (...a) => { db.exec('BEGIN'); try { fn(...a); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; } },
      pragma: (p, opts) => {
        if (opts && opts.simple) { const r = db.prepare(`PRAGMA ${p}`).get(); return Object.values(r)[0]; }
        db.exec(`PRAGMA ${p}`); return [];
      },
    };
  }
}

const db = openDb();
const { applied, current } = runMigrations(db);

const expected = ['settings', 'barangays', 'users', 'categories', 'transactions',
  'budgets', 'tasks', 'audit_log', 'collections', 'expenses', 'collection_receipts', 'schema_migrations'];
const missing = expected.filter((t) => {
  try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all(); return false; }
  catch { return true; }
});

// Smoke: insert + money invariant check
db.prepare(`INSERT INTO barangays (name) VALUES ('Test Brgy')`).run();
db.prepare(`INSERT INTO transactions (barangay_id, txn_date, kind, description, amount_c)
            VALUES (1, '2026-01-01', 'collection', 'Test OR', 123456)`).run();
const row = db.prepare('SELECT amount_c FROM transactions WHERE id = 1').get();

console.log('Applied migrations :', applied.map((m) => `v${m.version}:${m.name}`).join(', ') || '(none)');
console.log('Schema version     :', current);
console.log('Tables present     :', expected.length - missing.length, '/', expected.length, missing.length ? `MISSING: ${missing}` : '');
console.log('Money round-trip   :', row.amount_c === 123456 ? 'OK (centavos intact)' : `FAIL (${row.amount_c})`);

if (missing.length || row.amount_c !== 123456 || current < 2) {
  console.error('MIGRATION TEST FAILED');
  process.exit(1);
}
console.log('MIGRATION TEST PASSED');
