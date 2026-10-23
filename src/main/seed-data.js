/**
 * seed-data.js — clearly-labeled SAMPLE demonstration data.
 * Every seeded row is flagged is_sample = 1 and is displayed in the UI with
 * a "SAMPLE DATA" badge. Sample rows are excluded from real reports.
 */
'use strict';

function loadSampleData(dbService) {
  const db = dbService.db;
  const existing = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE is_sample = 1").get().n;
  if (existing > 0) return { ok: false, message: 'Sample data already loaded.' };

  const brgyNames = ['San Isidro (SAMPLE)', 'Bagong Silang (SAMPLE)', 'Mabini (SAMPLE)'];
  const ids = [];
  const insB = db.prepare('INSERT INTO barangays (name, municipality, province, tint_color, is_sample) VALUES (?, ?, ?, ?, 1)');
  for (const n of brgyNames) {
    const r = insB.run(n, 'Sample Municipality', 'Sample Province', '#1B5E20');
    ids.push(r.lastInsertRowid);
  }

  const insT = db.prepare(`INSERT INTO transactions
    (barangay_id, txn_date, kind, description, amount_c, or_number, payee, method, is_sample)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const today = new Date();
  const d = (offset) => {
    const t = new Date(today); t.setDate(t.getDate() - offset);
    return t.toISOString().slice(0, 10);
  };
  const sampleTxns = [
    [0, d(1), 'collection', 'Community tax certificates (SAMPLE)', 1245000, 'OR-1001', 'Various residents', 'cash'],
    [0, d(2), 'collection', 'Barangay clearance fees (SAMPLE)', 860000, 'OR-1002', 'Various residents', 'cash'],
    [0, d(3), 'expense', 'Barangay hall supplies (SAMPLE)', 150000, null, 'Office Depot Store', 'cash'],
    [1, d(1), 'collection', 'Basketball court rental fees (SAMPLE)', 420000, 'OR-2001', 'Sports committee', 'cash'],
    [1, d(2), 'expense', 'Street light electricity (SAMPLE)', 380000, null, 'Sample Electric Co.', 'bank'],
    [2, d(1), 'collection', 'Tricycle terminal fees (SAMPLE)', 960000, 'OR-3001', 'Tricycle operators', 'cash'],
    [2, d(4), 'expense', 'Health center medicine restock (SAMPLE)', 725000, null, 'Sample Pharma', 'check'],
  ];
  for (const [i, date, kind, desc, centavos, or, payee, method] of sampleTxns) {
    insT.run(ids[i], date, kind, desc, centavos, or, payee, method);
  }

  const insTask = db.prepare(`INSERT INTO tasks (barangay_id, title, due_date, priority, is_sample)
                              VALUES (?, ?, ?, ?, 1)`);
  insTask.run(ids[0], 'Submit sample monthly report (SAMPLE)', d(-5), 'high');
  insTask.run(ids[1], 'Reconcile sample cashbook (SAMPLE)', d(-2), 'normal');

  dbService.audit(null, 'seed', 'sample-data', null, null, { transactions: sampleTxns.length });
  return { ok: true, message: 'Sample data loaded (all rows labeled is_sample=1).' };
}

module.exports = { loadSampleData };
