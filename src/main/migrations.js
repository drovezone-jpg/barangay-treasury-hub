/**
 * migrations.js — Versioned schema migrations for Barangay Treasury Hub.
 *
 * IMPORTANT DESIGN NOTES
 * - All monetary values are stored as INTEGER CENTAVOS (1 peso = 100 centavos).
 *   Never store money as floating point. Convert at the UI boundary.
 * - Every data table carries `is_sample` (0/1) so demonstration data can be
 *   identified and excluded from real reports, and `deleted_at` for soft deletes.
 * - Every data table that records financial or administrative facts carries
 *   `barangay_id` FK so the app supports 2–5 configured barangays.
 * - Migrations run inside a transaction and are tracked in `schema_migrations`.
 *
 * This module is intentionally free of Electron imports so it can be unit
 * tested headlessly with plain Node (`npm run test:migrations`).
 */
'use strict';

const MIGRATIONS = [
  {
    version: 1,
    name: 'core-foundation',
    up: (db) => {
      db.exec(`
        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE barangays (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          municipality  TEXT NOT NULL DEFAULT '',
          province      TEXT NOT NULL DEFAULT '',
          tint_color    TEXT NOT NULL DEFAULT '#1B5E20',
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Single authorized treasurer login (Part 1: local credential only,
        -- stored as a salted hash, never plaintext).
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'treasurer',
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          last_login_at TEXT
        );

        -- Chart of accounts style categories for collections and expenses.
        CREATE TABLE categories (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          kind        TEXT NOT NULL CHECK (kind IN ('collection','expense')),
          name        TEXT NOT NULL,
          barangay_id INTEGER REFERENCES barangays(id),
          is_sample   INTEGER NOT NULL DEFAULT 0,
          deleted_at  TEXT
        );

        CREATE TABLE transactions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id   INTEGER NOT NULL REFERENCES barangays(id),
          txn_date      TEXT NOT NULL,
          kind          TEXT NOT NULL CHECK (kind IN ('collection','expense')),
          category_id   INTEGER REFERENCES categories(id),
          description   TEXT NOT NULL,
          amount_c      INTEGER NOT NULL CHECK (amount_c >= 0),
          or_number     TEXT,
          payee         TEXT,
          method        TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','check','gcash','bank')),
          status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','void')),
          notes         TEXT,
          is_sample     INTEGER NOT NULL DEFAULT 0,
          created_by    INTEGER REFERENCES users(id),
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at    TEXT
        );

        CREATE TABLE budgets (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id   INTEGER NOT NULL REFERENCES barangays(id),
          category_id   INTEGER REFERENCES categories(id),
          fiscal_year   INTEGER NOT NULL,
          period        TEXT NOT NULL DEFAULT 'annual' CHECK (period IN ('annual','quarterly','monthly')),
          period_label  TEXT NOT NULL DEFAULT 'FY',
          amount_c      INTEGER NOT NULL CHECK (amount_c >= 0),
          is_sample     INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at    TEXT
        );

        CREATE TABLE tasks (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id   INTEGER REFERENCES barangays(id),
          title         TEXT NOT NULL,
          due_date      TEXT,
          priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
          status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
          notes         TEXT,
          is_sample     INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at  TEXT,
          deleted_at    TEXT
        );

        CREATE TABLE audit_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER REFERENCES users(id),
          action        TEXT NOT NULL,
          entity        TEXT NOT NULL,
          entity_id     INTEGER,
          barangay_id   INTEGER,
          details       TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_txn_brgy_date   ON transactions(barangay_id, txn_date);
        CREATE INDEX idx_txn_kind        ON transactions(kind, status);
        CREATE INDEX idx_budget_lookup   ON budgets(barangay_id, fiscal_year);
        CREATE INDEX idx_audit_time      ON audit_log(created_at);
        CREATE INDEX idx_tasks_due       ON tasks(due_date, status);
      `);
    },
  },
  {
    // Part 2 — Barangay Management: archive flag (history preserved),
    // opening balance, sample flag, and unique barangay names.
    version: 3,
    name: 'barangay-management',
    up: (db) => {
      db.exec(`
        ALTER TABLE barangays ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE barangays ADD COLUMN opening_balance_c INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE barangays ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE barangays ADD COLUMN deleted_at TEXT;
        CREATE UNIQUE INDEX idx_brgy_name_unique ON barangays(lower(name));
      `);
    },
  },
  {
    // Part 3 — Income/Collections, Expenses, Receipts, financial summaries.
    // Amounts are INTEGER centavos; every table carries barangay_id;
    // receipt numbers are unique per barangay (among non-deleted rows);
    // deletes are soft so cancelled receipts keep their audit history.
    version: 4,
    name: 'collections-expenses-receipts',
    up: (db) => {
      db.exec(`
        -- v2 left an unused 'receipts' extension table; superseded by
        -- collection_receipts below. It was never written to (always empty).
        DROP TABLE IF EXISTS receipts;

        CREATE TABLE collections (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id   INTEGER NOT NULL REFERENCES barangays(id),
          txn_date      TEXT NOT NULL,
          category_id   INTEGER REFERENCES categories(id),
          payer         TEXT NOT NULL,
          description   TEXT NOT NULL,
          amount_c      INTEGER NOT NULL CHECK (amount_c > 0),
          method        TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','check','gcash','bank')),
          ref_no        TEXT NOT NULL,
          recorded_by   TEXT,
          remarks       TEXT,
          txn_id        INTEGER REFERENCES transactions(id),
          is_sample     INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at    TEXT
        );
        CREATE INDEX idx_col_brgy_date ON collections(barangay_id, txn_date);
        CREATE UNIQUE INDEX idx_col_ref ON collections(ref_no);

        CREATE TABLE expenses (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id    INTEGER NOT NULL REFERENCES barangays(id),
          txn_date       TEXT NOT NULL,
          category_id    INTEGER REFERENCES categories(id),
          payee          TEXT NOT NULL,
          description    TEXT NOT NULL,
          amount_c       INTEGER NOT NULL CHECK (amount_c > 0),
          method         TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','check','gcash','bank')),
          ref_no         TEXT NOT NULL,
          supporting_doc TEXT,
          recorded_by    TEXT,
          remarks        TEXT,
          txn_id         INTEGER REFERENCES transactions(id),
          is_sample      INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at     TEXT
        );
        CREATE INDEX idx_exp_brgy_date ON expenses(barangay_id, txn_date);
        CREATE UNIQUE INDEX idx_exp_ref ON expenses(ref_no);

        CREATE TABLE collection_receipts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id    INTEGER NOT NULL REFERENCES barangays(id),
          collection_id  INTEGER REFERENCES collections(id),
          collection_ref TEXT,
          receipt_no     TEXT NOT NULL,
          date_issued    TEXT NOT NULL,
          payer          TEXT NOT NULL,
          amount_c       INTEGER NOT NULL CHECK (amount_c > 0),
          purpose        TEXT,
          status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled','pending')),
          is_sample      INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at     TEXT
        );
        -- Duplicate receipt numbers are prevented per barangay among
        -- non-deleted records; cancelled receipts keep their number reserved.
        CREATE UNIQUE INDEX idx_rcpt_no ON collection_receipts(barangay_id, receipt_no) WHERE deleted_at IS NULL;

        -- Default working categories (real data, is_sample = 0).
        INSERT INTO categories (kind, name, is_sample) VALUES
          ('collection','Community Tax',0),
          ('collection','Clearance & Certifications',0),
          ('collection','Permits & Licenses',0),
          ('collection','Facility Rentals',0),
          ('collection','Other Collections',0),
          ('expense','Supplies & Materials',0),
          ('expense','Utilities',0),
          ('expense','Maintenance & Repairs',0),
          ('expense','Honoraria',0),
          ('expense','Other Expenses',0);
      `);
    },
  },
  {
    // Part 4 — Budget Monitoring + expense-to-budget linking.
    // Adds a nullable budget_id FK on expenses (existing rows kept, never
    // backfilled: unlinked expenses are what the 'unassigned' flag shows),
    // budget record fields (description, remarks, ref_no, updated_at), and a
    // duplicate guard on barangay+year+category+description among non-deleted
    // rows (distinct descriptions remain legitimate separate allocations).
    version: 5,
    name: 'budget-monitoring',
    up: (db) => {
      db.exec(`
        ALTER TABLE expenses ADD COLUMN budget_id INTEGER REFERENCES budgets(id);
        ALTER TABLE budgets ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE budgets ADD COLUMN remarks TEXT;
        ALTER TABLE budgets ADD COLUMN ref_no TEXT;
        ALTER TABLE budgets ADD COLUMN updated_at TEXT;
        UPDATE budgets SET ref_no = 'BGT-' || printf('%04d', id) WHERE ref_no IS NULL;
        CREATE UNIQUE INDEX idx_budget_dup ON budgets(barangay_id, fiscal_year, COALESCE(category_id, 0), lower(description)) WHERE deleted_at IS NULL;
        CREATE INDEX idx_exp_budget ON expenses(budget_id);
      `);
    },
  },
  {
    // Part 5 — Tasks & Deadlines, Audit viewer support, Settings defaults.
    // Tasks table is rebuilt (rows preserved) to add description/updated_at
    // and an 'in_progress' status; the v1 CHECK only allowed open/done/cancelled.
    // Settings defaults are seeded with INSERT OR IGNORE (existing values kept).
    version: 6,
    name: 'tasks-audit-settings',
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          barangay_id   INTEGER REFERENCES barangays(id),
          title         TEXT NOT NULL,
          description   TEXT,
          due_date      TEXT,
          priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
          status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
          notes         TEXT,
          is_sample     INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT,
          completed_at  TEXT,
          deleted_at    TEXT
        );
        INSERT INTO tasks_new (id, barangay_id, title, due_date, priority, status, notes, is_sample, created_at, completed_at, deleted_at)
          SELECT id, barangay_id, title, due_date, priority, status, notes, is_sample, created_at, completed_at, deleted_at FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX idx_tasks_due ON tasks(due_date, status);

        INSERT OR IGNORE INTO settings (key, value) VALUES
          ('org_name', ''),
          ('default_barangay_id', ''),
          ('default_fiscal_year', ''),
          ('date_format', 'en-PH'),
          ('report_footer', 'Prepared by the Barangay Treasurer. Management-information output only.'),
          ('backup_reminder', 'off'),
          ('last_backup_at', '');
      `);
    },
  },
  {
    version: 2,
    name: 'collection-receipts-link',
    up: (db) => {
      // Extension point used by later parts: receipts tied to a collection txn.
      db.exec(`
        CREATE TABLE receipts (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id INTEGER NOT NULL REFERENCES transactions(id),
          receipt_no    TEXT NOT NULL,
          issued_at     TEXT NOT NULL DEFAULT (datetime('now')),
          is_sample     INTEGER NOT NULL DEFAULT 0,
          deleted_at    TEXT
        );
        CREATE INDEX idx_receipts_txn ON receipts(transaction_id);
      `);
    },
  },
];

/**
 * Run all pending migrations inside transactions.
 * @param {import('better-sqlite3').Database} db
 * @returns {{applied: Array<{version:number,name:string}>, current:number}}
 */
function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const current = db.pragma('user_version', { simple: true });
  const applied = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)'
  );
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
      insert.run(m.version, m.name);
    })();
    applied.push({ version: m.version, name: m.name });
  }
  return { applied, current: db.pragma('user_version', { simple: true }) };
}

/** Whitelisted table->column registry used by the safe generic query API. */
const TABLE_REGISTRY = {
  barangays: ['id', 'name', 'municipality', 'province', 'tint_color', 'is_active', 'created_at'],
  transactions: ['id', 'barangay_id', 'txn_date', 'kind', 'category_id', 'description',
    'amount_c', 'or_number', 'payee', 'method', 'status', 'notes', 'is_sample', 'created_at', 'updated_at'],
  budgets: ['id', 'barangay_id', 'category_id', 'fiscal_year', 'period', 'period_label',
    'amount_c', 'is_sample', 'created_at'],
  tasks: ['id', 'barangay_id', 'title', 'due_date', 'priority', 'status', 'notes',
    'is_sample', 'created_at', 'completed_at'],
  audit_log: ['id', 'user_id', 'action', 'entity', 'entity_id', 'barangay_id', 'details', 'created_at'],
  categories: ['id', 'kind', 'name', 'barangay_id', 'is_sample'],
};

module.exports = { runMigrations, MIGRATIONS, TABLE_REGISTRY };
