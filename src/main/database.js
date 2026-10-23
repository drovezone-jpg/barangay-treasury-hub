/**
 * database.js — SQLite connection + safe prepared-statement data access layer.
 * Runs ONLY in the Electron main process. The renderer never sees SQL.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { runMigrations, TABLE_REGISTRY } = require('./migrations');

let Database = null; // required lazily so headless tests can also use it

/** Settings defaults (seeded by migration v6; user-editable in Settings). */
const DEFAULT_SETTINGS = {
  org_name: '',
  default_barangay_id: '',
  default_fiscal_year: '',
  date_format: 'en-PH',
  report_footer: 'Prepared by the Barangay Treasurer. Management-information output only.',
  backup_reminder: 'off',
  last_backup_at: '',
};

class DatabaseService {
  constructor() {
    this.db = null;
    this.dbPath = null;
    this.userDataPath = null;
    this.sessionUserId = null; // set by main.js on successful login
    this._busy = false;        // set during backup/restore operations
  }

  /**
   * Open (and create if needed) the database at userData/barangay-hub.db.
   * @param {string} userDataPath - Electron app.getPath('userData')
   */
  init(userDataPath) {
    if (!Database) Database = require('better-sqlite3');
    fs.mkdirSync(userDataPath, { recursive: true });
    this.userDataPath = userDataPath; // remembered for safe reopen (restore)
    this.dbPath = path.join(userDataPath, 'barangay-treasury-hub.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const { applied, current } = runMigrations(this.db);
    return { dbPath: this.dbPath, appliedMigrations: applied, schemaVersion: current };
  }

  /** Insert an audit trail row. Never throws into the caller's flow.
   *  Written by trusted main-process code only; secret-looking fields are
   *  stripped; the session user is attributed when none is passed. */
  audit(userId, action, entity, entityId, barangayId, details) {
    try {
      let d = details ?? null;
      if (d && typeof d === 'object') {
        const clean = {};
        for (const [k, v] of Object.entries(d)) {
          if (/password|hash|salt|secret/i.test(k)) continue;
          clean[k] = v;
        }
        d = Object.keys(clean).length ? clean : null;
      }
      this.db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, barangay_id, details)
                       VALUES (?, ?, ?, ?, ?, ?)`)
        .run(userId ?? this.sessionUserId ?? null, action, entity, entityId ?? null,
             barangayId ?? null, d ? JSON.stringify(d) : null);
    } catch (e) {
      console.error('audit_log write failed:', e.message);
    }
  }

  // ------------------------------------------------------------------
  // Validation helpers
  // ------------------------------------------------------------------
  /** Parse a money string like "1,234.56" into integer centavos. */
  static toCentavos(input) {
    const s = String(input ?? '').replace(/[₱,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  /** Parse a signed money string like "-250.50" into integer centavos. */
  static toCentavosSigned(input) {
    const s = String(input ?? '').trim().replace(/[₱,\s]/g, '');
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  /** Validate a transaction payload; returns {ok, errors, values} */
  validateTransaction(p) {
    const errors = [];
    const barangayId = Number.parseInt(p.barangayId, 10);
    if (!Number.isInteger(barangayId) || barangayId <= 0) errors.push('Select a valid barangay.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.txnDate || ''))) errors.push('Date must be YYYY-MM-DD.');
    if (!['collection', 'expense'].includes(p.kind)) errors.push('Type must be collection or expense.');
    const amountC = DatabaseService.toCentavos(p.amount);
    if (amountC === null || amountC <= 0) errors.push('Amount must be a positive number.');
    if (!p.description || String(p.description).trim().length < 3) errors.push('Description is required (min 3 characters).');
    if (!['cash', 'check', 'gcash', 'bank'].includes(p.method)) errors.push('Invalid payment method.');
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      errors,
      values: {
        barangay_id: barangayId,
        txn_date: p.txnDate,
        kind: p.kind,
        description: String(p.description).trim().slice(0, 500),
        amount_c: amountC,
        or_number: p.orNumber ? String(p.orNumber).trim().slice(0, 50) : null,
        payee: p.payee ? String(p.payee).trim().slice(0, 200) : null,
        method: p.method,
        notes: p.notes ? String(p.notes).trim().slice(0, 2000) : null,
        is_sample: p.isSample ? 1 : 0,
      },
    };
  }

  // ------------------------------------------------------------------
  // Barangay Management (Part 2)
  // ------------------------------------------------------------------
  listBarangays({ includeArchived = false } = {}) {
    return this.db.prepare(
      `SELECT id, name, municipality, province, tint_color, is_active, archived,
              opening_balance_c, is_sample, created_at
       FROM barangays
       ${includeArchived ? '' : 'WHERE archived = 0 AND deleted_at IS NULL'}
       ORDER BY name`
    ).all();
  }

  activeBarangayCount() {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM barangays WHERE archived = 0 AND deleted_at IS NULL'
    ).get().n;
  }

  /** Full barangay record + computed balance (opening + collections − expenses). */
  getBarangay(id) {
    const b = this.db.prepare(
      `SELECT id, name, municipality, province, tint_color, is_active, archived,
              opening_balance_c, is_sample, created_at
       FROM barangays WHERE id = ?`
    ).get(Number(id));
    if (!b) throw new Error('Barangay not found.');
    const totals = this.db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'collection' AND is_sample = 0 THEN amount_c END), 0) AS collections_c,
         COALESCE(SUM(CASE WHEN kind = 'expense'    AND is_sample = 0 THEN amount_c END), 0) AS expenses_c,
         COALESCE(SUM(CASE WHEN kind = 'collection' AND is_sample = 1 THEN amount_c END), 0) AS sample_collections_c,
         COALESCE(SUM(CASE WHEN kind = 'expense'    AND is_sample = 1 THEN amount_c END), 0) AS sample_expenses_c,
         COUNT(*) AS txn_count
       FROM transactions
       WHERE barangay_id = ? AND deleted_at IS NULL AND status = 'posted'`
    ).get(Number(id));
    return {
      ...b, ...totals,
      // Real balance excludes sample rows; sample figures are reported separately.
      balance_c: b.opening_balance_c + totals.collections_c - totals.expenses_c,
      sample_balance_c: totals.sample_collections_c - totals.sample_expenses_c,
    };
  }

  /** Validate barangay payload; rejects duplicates (case-insensitive). */
  validateBarangay(p, excludeId = null) {
    const errors = [];
    const name = String(p.name || '').trim();
    if (name.length < 2 || name.length > 120) errors.push('Barangay name must be 2–120 characters.');
    const openC = DatabaseService.toCentavosSigned(p.openingBalance ?? p.opening_balance ?? 0);
    if (openC === null) errors.push('Opening balance must be a number like 0, 1500 or -250.50.');
    const tint = /^#[0-9a-fA-F]{6}$/.test(p.tintColor || '') ? p.tintColor : '#1B5E20';
    const dup = excludeId
      ? this.db.prepare('SELECT id FROM barangays WHERE lower(name) = lower(?) AND id != ?').get(name, Number(excludeId))
      : this.db.prepare('SELECT id FROM barangays WHERE lower(name) = lower(?)').get(name);
    if (dup) errors.push('A barangay with this name already exists.');
    if (errors.length) { const e = new Error(errors.join(' ')); e.validationErrors = errors; throw e; }
    return {
      name,
      municipality: String(p.municipality || '').trim().slice(0, 120),
      province: String(p.province || '').trim().slice(0, 120),
      opening_balance_c: openC,
      tint_color: tint,
    };
  }

  addBarangay(p) {
    const v = this.validateBarangay(p || {});
    if (this.activeBarangayCount() >= 5)
      throw new Error('This system supports 2 to 5 barangays (maximum of 5 reached).');
    const info = this.db.prepare(
      `INSERT INTO barangays (name, municipality, province, tint_color, opening_balance_c)
       VALUES (?, ?, ?, ?, ?)`
    ).run(v.name, v.municipality, v.province, v.tint_color, v.opening_balance_c);
    this.audit(null, 'create', 'barangay', info.lastInsertRowid, info.lastInsertRowid, { name: v.name });
    return this.getBarangay(info.lastInsertRowid);
  }

  updateBarangay(id, p) {
    const bid = Number(id);
    const v = this.validateBarangay(p || {}, bid);
    this.db.prepare(
      `UPDATE barangays SET name = ?, municipality = ?, province = ?, tint_color = ?, opening_balance_c = ?
       WHERE id = ?`
    ).run(v.name, v.municipality, v.province, v.tint_color, v.opening_balance_c, bid);
    this.audit(null, 'update', 'barangay', bid, bid, { name: v.name });
    return this.getBarangay(bid);
  }

  /** Archive / restore (soft flag). Financial history is never deleted.
   *  Enforces the 2–5 rule: at least 2 barangays must stay active. */
  setBarangayArchived(id, archived) {
    const bid = Number(id);
    const b = this.getBarangay(bid);
    if (archived && this.activeBarangayCount() - 1 < 2)
      throw new Error('At least 2 barangays must remain active (system supports 2–5).');
    this.db.prepare('UPDATE barangays SET archived = ? WHERE id = ?').run(archived ? 1 : 0, bid);
    this.audit(null, archived ? 'archive' : 'restore', 'barangay', bid, bid, { name: b.name });
    return this.getBarangay(bid);
  }

  /** Per-barangay financial workspace: details, txns, monthly totals, tasks. */
  barangayWorkspace(id) {
    const bid = Number(id);
    const barangay = this.getBarangay(bid);
    const transactions = this.listTransactions({ barangayId: bid, limit: 100 });
    const monthly = this.db.prepare(
      `SELECT substr(txn_date, 1, 7) AS month, kind, SUM(amount_c) AS total_c, is_sample
       FROM transactions
       WHERE barangay_id = ? AND deleted_at IS NULL AND status = 'posted'
       GROUP BY month, kind, is_sample ORDER BY month`
    ).all(bid);
    const openTasks = this.db.prepare(
      `SELECT id, title, due_date, priority FROM tasks
       WHERE barangay_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY due_date`
    ).all(bid);
    return { barangay, transactions, monthly, openTasks };
  }

  // ------------------------------------------------------------------
  // Transactions
  // ------------------------------------------------------------------
  listTransactions({ barangayId, kind, categoryId, from, to, q, limit = 200 } = {}) {
    const clauses = ['t.deleted_at IS NULL'];
    const params = [];
    if (barangayId) { clauses.push('t.barangay_id = ?'); params.push(Number(barangayId)); }
    if (kind && ['collection', 'expense'].includes(kind)) { clauses.push('t.kind = ?'); params.push(kind); }
    if (categoryId) { clauses.push('t.category_id = ?'); params.push(Number(categoryId)); }
    if (from) { clauses.push('t.txn_date >= ?'); params.push(String(from)); }
    if (to) { clauses.push('t.txn_date <= ?'); params.push(String(to)); }
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(t.description LIKE ? OR t.payee LIKE ? OR t.or_number LIKE ?)');
      params.push(like, like, like);
    }
    params.push(Number(limit) || 200);
    return this.db.prepare(
      `SELECT t.*, b.name AS barangay_name, c.name AS category_name
       FROM transactions t
       JOIN barangays b ON b.id = t.barangay_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`
    ).all(...params);
  }

  createTransaction(payload) {
    const v = this.validateTransaction(payload);
    if (!v.ok) { const e = new Error(v.errors.join(' ')); e.validationErrors = v.errors; throw e; }
    const x = v.values;
    const info = this.db.prepare(
      `INSERT INTO transactions (barangay_id, txn_date, kind, description, amount_c, or_number, payee, method, notes, is_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(x.barangay_id, x.txn_date, x.kind, x.description, x.amount_c, x.or_number, x.payee, x.method, x.notes, x.is_sample);
    this.audit(null, 'create', 'transaction', info.lastInsertRowid, x.barangay_id, { kind: x.kind, amount_c: x.amount_c });
    return this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  }

  // ------------------------------------------------------------------
  // Dashboard (Part 2) — all totals computed by SQL aggregates,
  // sample data kept in a separate bucket from real records.
  // ------------------------------------------------------------------
  dashboardSummary() {
    const rows = this.db.prepare(
      `SELECT t.barangay_id, t.kind, SUM(t.amount_c) AS total_c, COUNT(*) AS n, t.is_sample
       FROM transactions t
       JOIN barangays b ON b.id = t.barangay_id
       WHERE t.deleted_at IS NULL AND t.status = 'posted' AND b.archived = 0
       GROUP BY t.barangay_id, t.kind, t.is_sample`
    ).all();
    const brgys = this.db.prepare(
      'SELECT id, name, opening_balance_c, is_sample FROM barangays WHERE archived = 0 AND deleted_at IS NULL'
    ).all();
    const openTasks = this.db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL AND status = 'open'"
    ).get().n;
    const pendingTasks = this.db.prepare(
      `SELECT id, title, due_date, priority FROM tasks
       WHERE deleted_at IS NULL AND status = 'open' ORDER BY due_date LIMIT 5`
    ).all();

    const mkBucket = () => ({ collections_c: 0, expenses_c: 0, count: 0, perBarangay: new Map() });
    const buckets = { real: mkBucket(), sample: mkBucket() };
    for (const r of rows) {
      const bucket = buckets[r.is_sample ? 'sample' : 'real'];
      if (r.kind === 'collection') bucket.collections_c += r.total_c; else bucket.expenses_c += r.total_c;
      bucket.count += r.n;
      if (!bucket.perBarangay.has(r.barangay_id))
        bucket.perBarangay.set(r.barangay_id, { collections_c: 0, expenses_c: 0, count: 0 });
      const o = bucket.perBarangay.get(r.barangay_id);
      if (r.kind === 'collection') o.collections_c += r.total_c; else o.expenses_c += r.total_c;
      o.count += r.n;
    }
    const serialize = (x) => ({
      collections_c: x.collections_c, expenses_c: x.expenses_c, count: x.count,
      perBarangay: [...x.perBarangay.entries()].map(([id, v]) => ({ barangayId: id, ...v })),
    });

    // Balance = opening_balance + collections − expenses (computed, never hardcoded).
    const perBarangay = brgys.map((b) => {
      const real = buckets.real.perBarangay.get(b.id) || { collections_c: 0, expenses_c: 0, count: 0 };
      const sample = buckets.sample.perBarangay.get(b.id) || { collections_c: 0, expenses_c: 0, count: 0 };
      return {
        barangayId: b.id, name: b.name, isSampleBarangay: !!b.is_sample,
        opening_c: b.opening_balance_c,
        real: { ...real, balance_c: b.opening_balance_c + real.collections_c - real.expenses_c },
        sample: { ...sample, balance_c: sample.collections_c - sample.expenses_c },
      };
    });
    return {
      barangayCount: brgys.length, openTasks, pendingTasks,
      taskStats: this.taskStats(),
      real: serialize(buckets.real), sample: serialize(buckets.sample), perBarangay,
    };
  }

  // ------------------------------------------------------------------
  // Part 3 — Categories, Collections, Expenses, Receipts, Summaries
  // ------------------------------------------------------------------
  listCategories(kind) {
    return this.db.prepare(
      'SELECT id, kind, name FROM categories WHERE deleted_at IS NULL AND (? IS NULL OR kind = ?) ORDER BY name'
    ).all(kind || null, kind || null);
  }

  /** Amount string -> positive integer centavos, or null when invalid.
   *  Rejects zero, negatives, NaN, malformed and >2-decimal values. */
  static toPositiveCentavos(input) {
    const s = String(input ?? '').trim().replace(/[₱,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const c = Math.round(parseFloat(s) * 100);
    return c > 0 ? c : null;
  }

  _validatePartyRecord(p, { kind }) {
    const errors = [];
    const barangayId = Number.parseInt(p.barangayId, 10);
    const brgy = Number.isInteger(barangayId)
      ? this.db.prepare('SELECT id FROM barangays WHERE id = ? AND archived = 0 AND deleted_at IS NULL').get(barangayId)
      : null;
    if (!brgy) errors.push('Select a valid, active barangay.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.txnDate || '')))
      errors.push('Date must be YYYY-MM-DD.');
    const party = String(p.payer || p.payee || '').trim();
    if (party.length < 2) errors.push(kind === 'collection' ? 'Payer or source of income is required.' : 'Payee or supplier is required.');
    const description = String(p.description || '').trim();
    if (description.length < 3) errors.push('Description / purpose is required (min 3 characters).');
    const amountC = DatabaseService.toPositiveCentavos(p.amount);
    if (amountC === null) errors.push('Amount must be greater than zero, e.g. 250.00 (max 2 decimal places).');
    const method = ['cash', 'check', 'gcash', 'bank'].includes(p.method) ? p.method : null;
    if (!method) errors.push('Invalid payment method.');
    let categoryId = null;
    if (p.categoryId) {
      categoryId = Number.parseInt(p.categoryId, 10) || null;
      if (categoryId && !this.db.prepare('SELECT id FROM categories WHERE id = ? AND kind = ?').get(categoryId, kind))
        errors.push('Invalid category.');
    }
    if (errors.length) { const e = new Error(errors.join(' ')); e.validationErrors = errors; throw e; }
    return {
      barangay_id: barangayId, txn_date: p.txnDate, category_id: categoryId,
      party: party.slice(0, 200), description: description.slice(0, 500),
      amount_c: amountC, method,
      recorded_by: String(p.recordedBy || '').trim().slice(0, 120) || null,
      remarks: String(p.remarks || '').trim().slice(0, 500) || null,
      supporting_doc: String(p.supportingDoc || '').trim().slice(0, 120) || null,
    };
  }

  // ---------------- Collections ----------------
  getCollection(id) {
    return this.db.prepare(
      `SELECT c.*, b.name AS barangay_name, cat.name AS category_name
       FROM collections c
       JOIN barangays b ON b.id = c.barangay_id
       LEFT JOIN categories cat ON cat.id = c.category_id
       WHERE c.id = ? AND c.deleted_at IS NULL`).get(Number(id));
  }

  listCollections({ barangayId, categoryId, from, to, q, limit = 500 } = {}) {
    const clauses = ['c.deleted_at IS NULL'];
    const params = [];
    if (barangayId) { clauses.push('c.barangay_id = ?'); params.push(Number(barangayId)); }
    if (categoryId) { clauses.push('c.category_id = ?'); params.push(Number(categoryId)); }
    if (from) { clauses.push('c.txn_date >= ?'); params.push(String(from)); }
    if (to) { clauses.push('c.txn_date <= ?'); params.push(String(to)); }
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(c.payer LIKE ? OR c.description LIKE ? OR c.ref_no LIKE ?)');
      params.push(like, like, like);
    }
    params.push(Number(limit) || 500);
    return this.db.prepare(
      `SELECT c.*, b.name AS barangay_name, cat.name AS category_name
       FROM collections c
       JOIN barangays b ON b.id = c.barangay_id
       LEFT JOIN categories cat ON cat.id = c.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.txn_date DESC, c.id DESC LIMIT ?`).all(...params);
  }

  createCollection(p) {
    const v = this._validatePartyRecord(p, { kind: 'collection' });
    const result = this.db.transaction(() => {
      // Unique reference: derived from the AUTOINCREMENT next id — never overwrites.
      const nextId = this.db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM collections').get().n;
      const ref = `COL-${v.txn_date.slice(0, 4)}-${String(nextId).padStart(4, '0')}`;
      const info = this.db.prepare(
        `INSERT INTO collections (barangay_id, txn_date, category_id, payer, description, amount_c, method, ref_no, recorded_by, remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.barangay_id, v.txn_date, v.category_id, v.party, v.description, v.amount_c, v.method, ref, v.recorded_by, v.remarks);
      // Mirror into the ledger so dashboard/workspace/summaries stay in sync.
      const t = this.db.prepare(
        `INSERT INTO transactions (barangay_id, txn_date, kind, category_id, description, amount_c, or_number, payee, method, status)
         VALUES (?, ?, 'collection', ?, ?, ?, ?, ?, ?, 'posted')`)
        .run(v.barangay_id, v.txn_date, v.category_id, v.description, v.amount_c, ref, v.party, v.method);
      this.db.prepare('UPDATE collections SET txn_id = ? WHERE id = ?').run(t.lastInsertRowid, info.lastInsertRowid);
      return { id: info.lastInsertRowid, ref };
    })();
    this.audit(null, 'create', 'collection', result.id, v.barangay_id, { ref: result.ref, amount_c: v.amount_c });
    return this.getCollection(result.id);
  }

  updateCollection(id, p) {
    const cid = Number(id);
    const existing = this.getCollection(cid);
    if (!existing) throw new Error('Collection record not found.');
    const v = this._validatePartyRecord(p, { kind: 'collection' });
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE collections SET barangay_id = ?, txn_date = ?, category_id = ?, payer = ?, description = ?,
         amount_c = ?, method = ?, recorded_by = ?, remarks = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(v.barangay_id, v.txn_date, v.category_id, v.party, v.description, v.amount_c, v.method,
             v.recorded_by, v.remarks, cid);
      if (existing.txn_id) {
        this.db.prepare(
          `UPDATE transactions SET barangay_id = ?, txn_date = ?, category_id = ?, description = ?,
           amount_c = ?, or_number = ?, payee = ?, method = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(v.barangay_id, v.txn_date, v.category_id, v.description, v.amount_c, existing.ref_no,
               v.party, v.method, existing.txn_id);
      }
    })();
    this.audit(null, 'update', 'collection', cid, v.barangay_id, { ref: existing.ref_no });
    return this.getCollection(cid);
  }

  deleteCollection(id) {
    const cid = Number(id);
    const existing = this.getCollection(cid);
    if (!existing) throw new Error('Collection record not found.');
    this.db.transaction(() => {
      this.db.prepare("UPDATE collections SET deleted_at = datetime('now') WHERE id = ?").run(cid);
      if (existing.txn_id)
        this.db.prepare("UPDATE transactions SET deleted_at = datetime('now') WHERE id = ?").run(existing.txn_id);
    })();
    this.audit(null, 'delete', 'collection', cid, existing.barangay_id, { ref: existing.ref_no });
    return { ok: true, ref: existing.ref_no };
  }

  // ---------------- Expenses ----------------
  getExpense(id) {
    return this.db.prepare(
      `SELECT e.*, b.name AS barangay_name, cat.name AS category_name
       FROM expenses e
       JOIN barangays b ON b.id = e.barangay_id
       LEFT JOIN categories cat ON cat.id = e.category_id
       WHERE e.id = ? AND e.deleted_at IS NULL`).get(Number(id));
  }

  listExpenses({ barangayId, categoryId, from, to, q, unassigned, limit = 500 } = {}) {
    const clauses = ['e.deleted_at IS NULL'];
    const params = [];
    if (unassigned) { clauses.push('e.budget_id IS NULL'); }
    if (barangayId) { clauses.push('e.barangay_id = ?'); params.push(Number(barangayId)); }
    if (categoryId) { clauses.push('e.category_id = ?'); params.push(Number(categoryId)); }
    if (from) { clauses.push('e.txn_date >= ?'); params.push(String(from)); }
    if (to) { clauses.push('e.txn_date <= ?'); params.push(String(to)); }
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(e.payee LIKE ? OR e.description LIKE ? OR e.ref_no LIKE ? OR e.supporting_doc LIKE ?)');
      params.push(like, like, like, like);
    }
    params.push(Number(limit) || 500);
    return this.db.prepare(
      `SELECT e.*, b.name AS barangay_name, cat.name AS category_name
       FROM expenses e
       JOIN barangays b ON b.id = e.barangay_id
       LEFT JOIN categories cat ON cat.id = e.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY e.txn_date DESC, e.id DESC LIMIT ?`).all(...params);
  }

  /** Resolve an expense-to-budget link: the budget must exist, be active,
   *  and belong to the SAME barangay as the expense (prevents cross-barangay
   *  charging). Returns null when no budget was supplied. */
  _resolveBudget(budgetId, barangayId) {
    if (!budgetId) return null;
    const bid = Number.parseInt(budgetId, 10);
    if (!Number.isInteger(bid)) throw new Error('Invalid budget selection.');
    const b = this.db.prepare('SELECT id, barangay_id FROM budgets WHERE id = ? AND deleted_at IS NULL').get(bid);
    if (!b) throw new Error('Selected budget not found.');
    if (b.barangay_id !== barangayId)
      throw new Error('The selected budget belongs to a different barangay.');
    return bid;
  }

  createExpense(p) {
    const v = this._validatePartyRecord(p, { kind: 'expense' });
    const budgetId = this._resolveBudget(p.budgetId, v.barangay_id);
    const result = this.db.transaction(() => {
      const nextId = this.db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM expenses').get().n;
      const ref = `EXP-${v.txn_date.slice(0, 4)}-${String(nextId).padStart(4, '0')}`;
      const info = this.db.prepare(
        `INSERT INTO expenses (barangay_id, txn_date, category_id, payee, description, amount_c, method, ref_no, supporting_doc, recorded_by, remarks, budget_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.barangay_id, v.txn_date, v.category_id, v.party, v.description, v.amount_c, v.method,
             ref, v.supporting_doc, v.recorded_by, v.remarks, budgetId);
      const t = this.db.prepare(
        `INSERT INTO transactions (barangay_id, txn_date, kind, category_id, description, amount_c, or_number, payee, method, status)
         VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, 'posted')`)
        .run(v.barangay_id, v.txn_date, v.category_id, v.description, v.amount_c, ref, v.party, v.method);
      this.db.prepare('UPDATE expenses SET txn_id = ? WHERE id = ?').run(t.lastInsertRowid, info.lastInsertRowid);
      return { id: info.lastInsertRowid, ref };
    })();
    this.audit(null, 'create', 'expense', result.id, v.barangay_id, { ref: result.ref, amount_c: v.amount_c });
    return this.getExpense(result.id);
  }

  updateExpense(id, p) {
    const eid = Number(id);
    const existing = this.getExpense(eid);
    if (!existing) throw new Error('Expense record not found.');
    const v = this._validatePartyRecord(p, { kind: 'expense' });
    const budgetId = this._resolveBudget(p.budgetId, v.barangay_id);
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE expenses SET barangay_id = ?, txn_date = ?, category_id = ?, payee = ?, description = ?,
         amount_c = ?, method = ?, supporting_doc = ?, recorded_by = ?, remarks = ?, budget_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(v.barangay_id, v.txn_date, v.category_id, v.party, v.description, v.amount_c, v.method,
             v.supporting_doc, v.recorded_by, v.remarks, budgetId, eid);
      if (existing.txn_id) {
        this.db.prepare(
          `UPDATE transactions SET barangay_id = ?, txn_date = ?, category_id = ?, description = ?,
           amount_c = ?, or_number = ?, payee = ?, method = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(v.barangay_id, v.txn_date, v.category_id, v.description, v.amount_c, existing.ref_no,
               v.party, v.method, existing.txn_id);
      }
    })();
    this.audit(null, 'update', 'expense', eid, v.barangay_id, { ref: existing.ref_no });
    return this.getExpense(eid);
  }

  deleteExpense(id) {
    const eid = Number(id);
    const existing = this.getExpense(eid);
    if (!existing) throw new Error('Expense record not found.');
    this.db.transaction(() => {
      this.db.prepare("UPDATE expenses SET deleted_at = datetime('now') WHERE id = ?").run(eid);
      if (existing.txn_id)
        this.db.prepare("UPDATE transactions SET deleted_at = datetime('now') WHERE id = ?").run(existing.txn_id);
    })();
    this.audit(null, 'delete', 'expense', eid, existing.barangay_id, { ref: existing.ref_no });
    return { ok: true, ref: existing.ref_no };
  }

  // ---------------- Receipts ----------------
  getReceipt(id) {
    return this.db.prepare(
      `SELECT r.*, b.name AS barangay_name
       FROM collection_receipts r
       JOIN barangays b ON b.id = r.barangay_id
       WHERE r.id = ? AND r.deleted_at IS NULL`).get(Number(id));
  }

  listReceipts({ barangayId, status, q, limit = 500 } = {}) {
    const clauses = ['r.deleted_at IS NULL'];
    const params = [];
    if (barangayId) { clauses.push('r.barangay_id = ?'); params.push(Number(barangayId)); }
    if (status && ['issued', 'cancelled', 'pending'].includes(status)) {
      clauses.push('r.status = ?'); params.push(status);
    }
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(r.payer LIKE ? OR r.receipt_no LIKE ? OR r.collection_ref LIKE ?)');
      params.push(like, like, like);
    }
    params.push(Number(limit) || 500);
    return this.db.prepare(
      `SELECT r.*, b.name AS barangay_name
       FROM collection_receipts r
       JOIN barangays b ON b.id = r.barangay_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.date_issued DESC, r.id DESC LIMIT ?`).all(...params);
  }

  createReceipt(p) {
    const errors = [];
    const barangayId = Number.parseInt(p.barangayId, 10);
    if (!Number.isInteger(barangayId)) errors.push('Select a valid barangay.');
    const receiptNo = String(p.receiptNo || '').trim();
    if (!receiptNo || receiptNo.length > 50) errors.push('Receipt number is required (max 50 characters).');
    const col = p.collectionRef
      ? this.db.prepare('SELECT id, ref_no, payer, amount_c FROM collections WHERE ref_no = ? AND barangay_id = ? AND deleted_at IS NULL')
          .get(String(p.collectionRef).trim(), barangayId)
      : null;
    if (!col) errors.push('Collection reference not found for this barangay.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.dateIssued || ''))) errors.push('Date issued must be YYYY-MM-DD.');
    const payer = String(p.payer || '').trim();
    if (payer.length < 2) errors.push('Payer is required.');
    const amountC = DatabaseService.toPositiveCentavos(p.amount);
    if (amountC === null) errors.push('Amount must be greater than zero (max 2 decimal places).');
    const status = ['issued', 'cancelled', 'pending'].includes(p.status) ? p.status : 'issued';
    if (errors.length) { const e = new Error(errors.join(' ')); e.validationErrors = errors; throw e; }
    try {
      const info = this.db.prepare(
        `INSERT INTO collection_receipts (barangay_id, collection_id, collection_ref, receipt_no, date_issued, payer, amount_c, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(barangayId, col.id, col.ref_no, receiptNo, p.dateIssued, payer.slice(0, 200), amountC,
             String(p.purpose || '').trim().slice(0, 500) || null, status);
      this.audit(null, 'create', 'receipt', info.lastInsertRowid, barangayId,
                 { receipt_no: receiptNo, collection_ref: col.ref_no });
      return this.getReceipt(info.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message)))
        throw new Error(`Receipt number "${receiptNo}" already exists for this barangay.`);
      throw new Error('Could not save the receipt.');
    }
  }

  /** Cancel a receipt. The record is KEPT (status change only) for auditing. */
  cancelReceipt(id) {
    const rid = Number(id);
    const r = this.getReceipt(rid);
    if (!r) throw new Error('Receipt not found.');
    if (r.status === 'cancelled') throw new Error('Receipt is already cancelled.');
    this.db.prepare("UPDATE collection_receipts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(rid);
    this.audit(null, 'cancel', 'receipt', rid, r.barangay_id, { receipt_no: r.receipt_no });
    return this.getReceipt(rid);
  }

  // ---------------- Financial summary ----------------
  financialSummary(f = {}) {
    const clauses = ["t.deleted_at IS NULL", "t.status = 'posted'", 't.is_sample = 0'];
    const params = [];
    if (f.barangayId) { clauses.push('t.barangay_id = ?'); params.push(Number(f.barangayId)); }
    if (f.categoryId) { clauses.push('t.category_id = ?'); params.push(Number(f.categoryId)); }
    if (f.kind && ['collection', 'expense'].includes(f.kind)) { clauses.push('t.kind = ?'); params.push(f.kind); }
    if (f.from) { clauses.push('t.txn_date >= ?'); params.push(String(f.from)); }
    if (f.to) { clauses.push('t.txn_date <= ?'); params.push(String(f.to)); }
    const where = clauses.join(' AND ');
    const totals = this.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'collection' THEN amount_c END), 0) AS collections_c,
              COALESCE(SUM(CASE WHEN kind = 'expense'    THEN amount_c END), 0) AS expenses_c,
              COUNT(*) AS n
       FROM transactions t WHERE ${where}`).get(...params);
    const perBarangay = this.db.prepare(
      `SELECT t.barangay_id AS barangayId, b.name,
              COALESCE(SUM(CASE WHEN t.kind = 'collection' THEN t.amount_c END), 0) AS collections_c,
              COALESCE(SUM(CASE WHEN t.kind = 'expense'    THEN t.amount_c END), 0) AS expenses_c,
              COUNT(*) AS n
       FROM transactions t JOIN barangays b ON b.id = t.barangay_id
       WHERE ${where}
       GROUP BY t.barangay_id ORDER BY b.name`).all(...params);
    return {
      collections_c: totals.collections_c, expenses_c: totals.expenses_c,
      net_c: totals.collections_c - totals.expenses_c, n: totals.n,
      perBarangay,
      multiBarangay: !f.barangayId && perBarangay.length > 1,
    };
  }

  // ------------------------------------------------------------------
  // Part 4 — Budget Monitoring, Utilization, Reports
  // ------------------------------------------------------------------
  listBudgets({ barangayId, fiscalYear, q, limit = 500 } = {}) {
    const clauses = ['bt.deleted_at IS NULL'];
    const params = [];
    if (barangayId) { clauses.push('bt.barangay_id = ?'); params.push(Number(barangayId)); }
    if (fiscalYear) { clauses.push('bt.fiscal_year = ?'); params.push(Number(fiscalYear)); }
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(bt.description LIKE ? OR bt.ref_no LIKE ? OR c.name LIKE ? OR bt.remarks LIKE ?)');
      params.push(like, like, like, like);
    }
    params.push(Number(limit) || 500);
    return this.db.prepare(
      `SELECT bt.*, b.name AS barangay_name, c.name AS category_name,
              COALESCE((SELECT SUM(e.amount_c) FROM expenses e
                        WHERE e.budget_id = bt.id AND e.deleted_at IS NULL), 0) AS spent_c
       FROM budgets bt
       JOIN barangays b ON b.id = bt.barangay_id
       LEFT JOIN categories c ON c.id = bt.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY bt.fiscal_year DESC, b.name, bt.id DESC LIMIT ?`).all(...params);
  }

  getBudget(id) {
    const b = this.db.prepare(
      `SELECT bt.*, b.name AS barangay_name, c.name AS category_name
       FROM budgets bt
       JOIN barangays b ON b.id = bt.barangay_id
       LEFT JOIN categories c ON c.id = bt.category_id
       WHERE bt.id = ? AND bt.deleted_at IS NULL`).get(Number(id));
    if (!b) throw new Error('Budget record not found.');
    const spent = this.db.prepare(
      'SELECT COALESCE(SUM(amount_c),0) AS s FROM expenses WHERE budget_id = ? AND deleted_at IS NULL'
    ).get(Number(id)).s;
    return { ...b, spent_c: spent, remaining_c: b.amount_c - spent,
             utilization_pct: b.amount_c > 0 ? Math.round(spent / b.amount_c * 10000) / 100 : null };
  }

  validateBudget(p, excludeId = null) {
    const errors = [];
    const barangayId = Number.parseInt(p.barangayId, 10);
    if (!Number.isInteger(barangayId) ||
        !this.db.prepare('SELECT id FROM barangays WHERE id = ? AND archived = 0 AND deleted_at IS NULL').get(barangayId))
      errors.push('Select a valid, active barangay.');
    const year = Number.parseInt(p.fiscalYear, 10);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push('Budget year must be between 2000 and 2100.');
    const amountC = DatabaseService.toPositiveCentavos(p.amount);
    if (amountC === null) errors.push('Allocated amount must be greater than zero (max 2 decimal places).');
    const description = String(p.description || '').trim();
    if (description.length < 3) errors.push('Description is required (min 3 characters).');
    let categoryId = null;
    if (p.categoryId) {
      categoryId = Number.parseInt(p.categoryId, 10) || null;
      if (categoryId && !this.db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId))
        errors.push('Invalid category.');
    }
    // Duplicate guard: same barangay + year + category + description.
    const dup = excludeId
      ? this.db.prepare(`SELECT id FROM budgets WHERE barangay_id = ? AND fiscal_year = ?
          AND COALESCE(category_id,0) = COALESCE(?,0) AND lower(description) = lower(?) AND id != ? AND deleted_at IS NULL`)
          .get(barangayId, year, categoryId, description, Number(excludeId))
      : this.db.prepare(`SELECT id FROM budgets WHERE barangay_id = ? AND fiscal_year = ?
          AND COALESCE(category_id,0) = COALESCE(?,0) AND lower(description) = lower(?) AND deleted_at IS NULL`)
          .get(barangayId, year, categoryId, description);
    if (dup) errors.push('A budget with the same barangay, year, category, and description already exists.');
    if (errors.length) { const e = new Error(errors.join(' ')); e.validationErrors = errors; throw e; }
    return {
      barangay_id: barangayId, fiscal_year: year, category_id: categoryId,
      description: description.slice(0, 300),
      amount_c: amountC,
      remarks: String(p.remarks || '').trim().slice(0, 500) || null,
      period: 'annual', period_label: String(p.fiscalYear || year),
    };
  }

  createBudget(p) {
    const v = this.validateBudget(p || {});
    const result = this.db.transaction(() => {
      const nextId = this.db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM budgets').get().n;
      const ref = `BGT-${v.fiscal_year}-${String(nextId).padStart(4, '0')}`;
      const info = this.db.prepare(
        `INSERT INTO budgets (barangay_id, category_id, fiscal_year, period, period_label, amount_c, description, remarks, ref_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.barangay_id, v.category_id, v.fiscal_year, v.period, v.period_label, v.amount_c, v.description, v.remarks, ref);
      return { id: info.lastInsertRowid, ref };
    })();
    this.audit(null, 'create', 'budget', result.id, v.barangay_id, { ref: result.ref, amount_c: v.amount_c });
    return this.getBudget(result.id);
  }

  updateBudget(id, p) {
    const bid = Number(id);
    const existing = this.getBudget(bid);
    const v = this.validateBudget(p || {}, bid);
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE budgets SET barangay_id = ?, category_id = ?, fiscal_year = ?, period_label = ?,
         amount_c = ?, description = ?, remarks = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(v.barangay_id, v.category_id, v.fiscal_year, v.period_label, v.amount_c, v.description, v.remarks, bid);
    })();
    this.audit(null, 'update', 'budget', bid, v.barangay_id, { ref: existing.ref_no });
    return this.getBudget(bid);
  }

  deleteBudget(id) {
    const bid = Number(id);
    const existing = this.getBudget(bid);
    if (existing.spent_c > 0)
      throw new Error('This budget has recorded expenses charged to it. Remove or reassign those expenses first.');
    this.db.prepare("UPDATE budgets SET deleted_at = datetime('now') WHERE id = ?").run(bid);
    this.audit(null, 'delete', 'budget', bid, existing.barangay_id, { ref: existing.ref_no });
    return { ok: true, ref: existing.ref_no };
  }

  /** Budget-year totals per barangay (all non-deleted budgets in scope). */
  budgetTotals({ barangayId, fiscalYear } = {}) {
    const clauses = ['bt.deleted_at IS NULL'];
    const params = [];
    if (barangayId) { clauses.push('bt.barangay_id = ?'); params.push(Number(barangayId)); }
    if (fiscalYear) { clauses.push('bt.fiscal_year = ?'); params.push(Number(fiscalYear)); }
    return this.db.prepare(
      `SELECT bt.barangay_id AS barangayId, b.name, bt.fiscal_year AS fiscalYear,
              SUM(bt.amount_c) AS allocated_c,
              COALESCE((SELECT SUM(e.amount_c) FROM expenses e
                        JOIN budgets b2 ON b2.id = e.budget_id
                        WHERE b2.barangay_id = bt.barangay_id AND b2.fiscal_year = bt.fiscal_year
                          AND e.deleted_at IS NULL AND b2.deleted_at IS NULL), 0) AS spent_c
       FROM budgets bt JOIN barangays b ON b.id = bt.barangay_id
       WHERE ${clauses.join(' AND ')}
       GROUP BY bt.barangay_id, bt.fiscal_year ORDER BY b.name, bt.fiscal_year`).all(...params);
  }

  /** Utilization per budget record for a barangay (+ unassigned expense total). */
  budgetUtilization({ barangayId, fiscalYear } = {}) {
    if (!barangayId) throw new Error('Select a barangay to view budget utilization.');
    const bid = Number(barangayId);
    const clauses = ['bt.deleted_at IS NULL', 'bt.barangay_id = ?'];
    const params = [bid];
    if (fiscalYear) { clauses.push('bt.fiscal_year = ?'); params.push(Number(fiscalYear)); }
    const rows = this.db.prepare(
      `SELECT bt.id, bt.ref_no, bt.fiscal_year AS fiscalYear, bt.description, bt.remarks,
              c.name AS category_name, bt.amount_c AS allocated_c,
              COALESCE((SELECT SUM(e.amount_c) FROM expenses e
                        WHERE e.budget_id = bt.id AND e.deleted_at IS NULL), 0) AS spent_c,
              (SELECT COUNT(*) FROM expenses e WHERE e.budget_id = bt.id AND e.deleted_at IS NULL) AS expense_count
       FROM budgets bt
       LEFT JOIN categories c ON c.id = bt.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY bt.fiscal_year DESC, c.name`).all(...params);
    const withCalc = rows.map((r) => ({
      ...r,
      remaining_c: r.allocated_c - r.spent_c,
      utilization_pct: r.allocated_c > 0 ? Math.round(r.spent_c / r.allocated_c * 10000) / 100 : null,
    }));
    const unassigned = this.db.prepare(
      `SELECT COALESCE(SUM(amount_c),0) AS s, COUNT(*) AS n FROM expenses
       WHERE barangay_id = ? AND budget_id IS NULL AND deleted_at IS NULL`).get(bid);
    return { rows: withCalc, unassigned: { amount_c: unassigned.s, count: unassigned.n } };
  }

  /** Monthly trends (collections vs expenses) for charts. */
  monthlyTrends({ barangayId, from, to, fiscalYear } = {}) {
    const clauses = ["t.deleted_at IS NULL", "t.status = 'posted'", 't.is_sample = 0'];
    const params = [];
    if (barangayId) { clauses.push('t.barangay_id = ?'); params.push(Number(barangayId)); }
    if (from) { clauses.push('t.txn_date >= ?'); params.push(String(from)); }
    if (to) { clauses.push('t.txn_date <= ?'); params.push(String(to)); }
    if (fiscalYear) { clauses.push('substr(t.txn_date, 1, 4) = ?'); params.push(String(fiscalYear)); }
    return this.db.prepare(
      `SELECT substr(t.txn_date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN t.kind = 'collection' THEN t.amount_c END), 0) AS collections_c,
              COALESCE(SUM(CASE WHEN t.kind = 'expense'    THEN t.amount_c END), 0) AS expenses_c
       FROM transactions t WHERE ${clauses.join(' AND ')}
       GROUP BY month ORDER BY month`).all(...params);
  }

  // ------------------------------------------------------------------
  // Part 5 — Tasks, Audit viewer, Settings
  // ------------------------------------------------------------------
  validateTask(p) {
    const errors = [];
    const title = String(p.title || '').trim();
    if (title.length < 3 || title.length > 200) errors.push('Task title is required (3-200 characters).');
    let barangayId = null;
    if (p.barangayId) {
      barangayId = Number.parseInt(p.barangayId, 10) || null;
      if (barangayId && !this.db.prepare('SELECT id FROM barangays WHERE id = ?').get(barangayId))
        errors.push('Invalid barangay.');
    }
    let dueDate = null;
    if (p.dueDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.dueDate))) errors.push('Due date must be YYYY-MM-DD.');
      else dueDate = p.dueDate;
    }
    const PRIORITY = { low: 'low', medium: 'normal', normal: 'normal', high: 'high', urgent: 'urgent' };
    const priority = PRIORITY[p.priority];
    if (!priority) errors.push('Priority must be Low, Medium, or High.');
    const STATUS = ['open', 'in_progress', 'done', 'cancelled'];
    const status = STATUS.includes(p.status) ? p.status : null;
    if (p.status && !status) errors.push('Invalid status.');
    if (errors.length) { const e = new Error(errors.join(' ')); e.validationErrors = errors; throw e; }
    return {
      title,
      description: String(p.description || '').trim().slice(0, 1000) || null,
      barangay_id: barangayId, due_date: dueDate, priority, status,
      notes: String(p.remarks ?? p.notes ?? '').trim().slice(0, 1000) || null,
    };
  }

  createTask(p) {
    const v = this.validateTask(p || {});
    const info = this.db.prepare(
      `INSERT INTO tasks (barangay_id, title, description, due_date, priority, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(v.barangay_id, v.title, v.description, v.due_date, v.priority, v.status || 'open', v.notes);
    this.audit(null, 'create', 'task', info.lastInsertRowid, v.barangay_id, { title: v.title });
    return this.getTask(info.lastInsertRowid);
  }

  getTask(id) {
    const t = this.db.prepare(
      `SELECT t.id, t.barangay_id, t.title, t.description, t.due_date, t.priority, t.status,
              t.notes, t.is_sample, t.created_at, t.updated_at, t.completed_at, b.name AS barangay_name
       FROM tasks t LEFT JOIN barangays b ON b.id = t.barangay_id
       WHERE t.id = ? AND t.deleted_at IS NULL`).get(Number(id));
    if (!t) throw new Error('Task not found.');
    return t;
  }

  updateTask(id, p) {
    const idn = Number(id);
    const existing = this.getTask(idn);
    // Fields left undefined keep their current value ('' explicitly clears).
    const merged = { ...p };
    if (merged.barangayId === undefined) merged.barangayId = existing.barangay_id;
    if (merged.dueDate === undefined) merged.dueDate = existing.due_date;
    if (merged.description === undefined) merged.description = existing.description;
    if (merged.remarks === undefined && merged.notes === undefined) merged.remarks = existing.notes;
    const v = this.validateTask({ ...merged, status: merged.status || existing.status });
    this.db.prepare(
      `UPDATE tasks SET barangay_id = ?, title = ?, description = ?, due_date = ?, priority = ?,
       status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(v.barangay_id, v.title, v.description, v.due_date, v.priority, v.status, v.notes, idn);
    this.audit(null, 'update', 'task', idn, v.barangay_id, { title: v.title, was: existing.title });
    return this.getTask(idn);
  }

  /** Mark a task completed (done=true) or reopen it (done=false). */
  setTaskCompleted(id, done) {
    const idn = Number(id);
    const t = this.getTask(idn);
    if (done && t.status === 'done') throw new Error('Task is already completed.');
    if (!done && t.status !== 'done') throw new Error('Only completed tasks can be reopened.');
    this.db.prepare(
      done
        ? `UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        : `UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(idn);
    this.audit(null, done ? 'complete' : 'reopen', 'task', idn, t.barangay_id, { title: t.title });
    return this.getTask(idn);
  }

  deleteTask(id) {
    const idn = Number(id);
    const t = this.getTask(idn);
    this.db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run(idn);
    this.audit(null, 'delete', 'task', idn, t.barangay_id, { title: t.title });
    return { ok: true, title: t.title };
  }

  listTasks({ barangayId, status, priority, due, q, limit = 500 } = {}) {
    const clauses = ['t.deleted_at IS NULL'];
    const params = [];
    if (barangayId) { clauses.push('t.barangay_id = ?'); params.push(Number(barangayId)); }
    if (status === 'active') clauses.push("t.status IN ('open','in_progress')");
    else if (status && ['open', 'in_progress', 'done', 'cancelled'].includes(status)) {
      clauses.push('t.status = ?'); params.push(status);
    }
    if (priority && ['low', 'normal', 'high', 'urgent'].includes(priority)) {
      clauses.push('t.priority = ?'); params.push(priority);
    }
    if (due === 'overdue') clauses.push("t.status IN ('open','in_progress') AND t.due_date IS NOT NULL AND t.due_date < date('now','localtime')");
    else if (due === 'today') clauses.push("t.status IN ('open','in_progress') AND t.due_date = date('now','localtime')");
    else if (due === 'week') clauses.push("t.status IN ('open','in_progress') AND t.due_date BETWEEN date('now','localtime') AND date('now','localtime','+7 day')");
    else if (due === 'upcoming') clauses.push("t.status IN ('open','in_progress') AND t.due_date > date('now','localtime')");
    else if (due === 'completed') clauses.push("t.status = 'done'");
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(t.title LIKE ? OR t.description LIKE ? OR t.notes LIKE ?)');
      params.push(like, like, like);
    }
    params.push(Number(limit) || 500);
    return this.db.prepare(
      `SELECT t.id, t.barangay_id, t.title, t.description, t.due_date, t.priority, t.status,
              t.notes, t.is_sample, t.created_at, t.updated_at, t.completed_at, b.name AS barangay_name,
              (t.status IN ('open','in_progress') AND t.due_date IS NOT NULL
               AND t.due_date < date('now','localtime')) AS is_overdue
       FROM tasks t LEFT JOIN barangays b ON b.id = t.barangay_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY (t.status = 'done') ASC, t.due_date IS NULL, t.due_date, t.id DESC LIMIT ?`).all(...params);
  }

  /** Dashboard/tasks summary counts (local dates). */
  taskStats() {
    return this.db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('open','in_progress') THEN 1 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status IN ('open','in_progress') AND due_date = date('now','localtime') THEN 1 END), 0) AS dueToday,
         COALESCE(SUM(CASE WHEN status IN ('open','in_progress') AND due_date > date('now','localtime') THEN 1 END), 0) AS upcoming,
         COALESCE(SUM(CASE WHEN status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date < date('now','localtime') THEN 1 END), 0) AS overdue,
         COALESCE(SUM(CASE WHEN status = 'done' THEN 1 END), 0) AS completed
       FROM tasks WHERE deleted_at IS NULL`).get();
  }

  /** Read-only audit viewer with filters and LIMIT/OFFSET pagination.
   *  There is intentionally NO update/delete audit API on this service. */
  listAudit({ action, entity, barangayId, from, to, q, page = 1, pageSize = 50 } = {}) {
    const clauses = ['1 = 1'];
    const params = [];
    if (action && /^[a-z_]{2,30}$/.test(action)) { clauses.push('a.action = ?'); params.push(action); }
    if (entity && /^[a-z_]{2,30}$/.test(entity)) { clauses.push('a.entity = ?'); params.push(entity); }
    if (barangayId) { clauses.push('a.barangay_id = ?'); params.push(Number(barangayId)); }
    if (from) { clauses.push('date(a.created_at) >= ?'); params.push(String(from)); }
    if (to) { clauses.push('date(a.created_at) <= ?'); params.push(String(to)); }
    if (q) {
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      clauses.push('(a.details LIKE ? OR u.username LIKE ? OR a.action LIKE ? OR a.entity LIKE ?)');
      params.push(like, like, like, like);
    }
    const where = clauses.join(' AND ');
    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where}`
    ).get(...params).n;
    const pageNum = Math.max(1, Number(page) || 1);
    const size = Math.min(200, Math.max(10, Number(pageSize) || 50));
    const rows = this.db.prepare(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.barangay_id, a.details, a.created_at,
              u.username, b.name AS barangay_name,
              CASE WHEN u.username IS NULL THEN 'not recorded (legacy entry)' ELSE u.username END AS actor
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN barangays b ON b.id = a.barangay_id
       WHERE ${where}
       ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, size, (pageNum - 1) * size);
    return { rows, total, page: pageNum, pageSize: size, pages: Math.max(1, Math.ceil(total / size)) };
  }

  // ---------------- Settings ----------------
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const o = {};
    for (const r of rows) o[r.key] = r.value;
    return { ...DEFAULT_SETTINGS, ...o };
  }

  updateSettings(p) {
    const errors = [];
    const clean = {};
    const str = (v) => String(v ?? '').trim();
    if ('org_name' in p) clean.org_name = str(p.org_name).slice(0, 120);
    if ('default_barangay_id' in p) {
      const v = str(p.default_barangay_id);
      if (v && !this.db.prepare('SELECT id FROM barangays WHERE id = ?').get(Number(v)))
        errors.push('Default barangay does not exist.');
      else clean.default_barangay_id = v;
    }
    if ('default_fiscal_year' in p) {
      const v = str(p.default_fiscal_year);
      if (v && (!/^\d{4}$/.test(v) || +v < 2000 || +v > 2100)) errors.push('Default fiscal year must be between 2000 and 2100.');
      else clean.default_fiscal_year = v;
    }
    if ('date_format' in p) {
      if (!['en-PH', 'ISO'].includes(p.date_format)) errors.push('Date format must be en-PH or ISO.');
      else clean.date_format = p.date_format;
    }
    if ('report_footer' in p) clean.report_footer = str(p.report_footer).slice(0, 300);
    if ('backup_reminder' in p) {
      if (!['off', 'weekly', 'monthly'].includes(p.backup_reminder)) errors.push('Backup reminder must be off, weekly, or monthly.');
      else clean.backup_reminder = p.backup_reminder;
    }
    if (errors.length) { const e = new Error(errors.join(' ')); e.validationErrors = errors; throw e; }
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(clean)) upsert.run(k, v);
    })();
    this.audit(null, 'update', 'settings', null, null, { keys: Object.keys(clean) });
    return this.getSettings();
  }

  resetSettings() {
    this.updateSettings(DEFAULT_SETTINGS);
    this.audit(null, 'restore', 'settings', null, null, { defaults: true });
    return this.getSettings();
  }

  getAuditLog(limit = 300) {
    return this.db.prepare(
      'SELECT id, action, entity, entity_id, barangay_id, details, created_at FROM audit_log ORDER BY id DESC LIMIT ?'
    ).all(Number(limit) || 300);
  }

  /** Safe generic listing restricted to the TABLE_REGISTRY whitelist. */
  safeList(table, { limit = 100 } = {}) {
    const cols = TABLE_REGISTRY[table];
    if (!cols) throw new Error(`Table not permitted: ${table}`);
    return this.db.prepare(`SELECT ${cols.join(', ')} FROM ${table} LIMIT ?`).all(Number(limit) || 100);
  }

  close() {
    if (this.db) { try { this.db.close(); } catch { /* ignore */ } this.db = null; }
  }
}

module.exports = {
  DatabaseService,
  toCentavos: DatabaseService.toCentavos,
  toCentavosSigned: DatabaseService.toCentavosSigned,
  toPositiveCentavos: DatabaseService.toPositiveCentavos,
  DEFAULT_SETTINGS,
};
