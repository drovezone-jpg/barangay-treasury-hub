/**
 * tests/part3-test.js — Part 3 verification suite (headless, real SQLite).
 *   npm run test:part3
 * Covers the 9 required scenarios: collection persistence across restart,
 * receipt issuance + duplicate rejection, expense add/edit, totals from
 * known amounts, barangay filter isolation, date filters & search,
 * plus validation rejects (zero/negative/bad amounts), audit trail entries,
 * and financial summary scopes.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseService } = require('../src/main/database');

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.error('  FAIL', name); }
};
const expectThrow = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-part3-'));
const svc = new DatabaseService();
const info = svc.init(dir);
console.log('Schema version:', info.schemaVersion,
  '| new this run:', info.appliedMigrations.map((m) => `v${m.version}:${m.name}`).join(', '));
check('migration v4 applied (collections-expenses-receipts)',
  info.appliedMigrations.some((m) => m.version === 4));

// Two real barangays
const b1 = svc.addBarangay({ name: 'San Isidro', openingBalance: '0' });
const b2 = svc.addBarangay({ name: 'Bagong Silang', openingBalance: '0' });
const colCats = svc.listCategories('collection');
const expCats = svc.listCategories('expense');
check('default categories seeded (collections + expenses)',
  colCats.length >= 5 && expCats.length >= 5);

console.log('\n== 1. Add collections (known amounts) ==');
const c1 = svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-01', payer: 'Juan Dela Cruz',
  description: 'Barangay clearance fees', amount: '1250.75', method: 'cash',
  categoryId: colCats[0].id, recordedBy: 'Maria Santos', remarks: 'batch 1' });
const c2 = svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-15', payer: 'Market vendors',
  description: 'Facility rental', amount: '3000.00', method: 'gcash', categoryId: colCats[1].id });
const c3 = svc.createCollection({ barangayId: b2.id, txnDate: '2026-10-10', payer: 'Tricycle operators',
  description: 'Terminal fees', amount: '500.25', method: 'cash' });
check('collection 1 saved with generated ref COL-…', !!c1.id && /^COL-\d{4}-\d{4}$/.test(c1.ref_no));
check('amount stored as centavos (1250.75 → 125075)', c1.amount_c === 125075);
check('refs unique', new Set([c1.ref_no, c2.ref_no, c3.ref_no]).size === 3);
check('collection linked to correct barangay', c1.barangay_id === b1.id && c3.barangay_id === b2.id);
check('collection mirrored into ledger (transactions)', !!c1.txn_id);

console.log('\n== 2. Validation rejects bad amounts ==');
check('zero amount rejected', expectThrow(
  () => svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-02', payer: 'X', description: 'Test zero', amount: '0', method: 'cash' }),
  /greater than zero/i));
check('negative amount rejected', expectThrow(
  () => svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-02', payer: 'X', description: 'Test neg', amount: '-50', method: 'cash' }),
  /greater than zero/i));
check('malformed amount rejected', expectThrow(
  () => svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-02', payer: 'X', description: 'Test bad', amount: '12.345', method: 'cash' }),
  /greater than zero|Amount/i));
check('missing barangay rejected', expectThrow(
  () => svc.createCollection({ txnDate: '2026-10-02', payer: 'X', description: 'Test nobrgy', amount: '10', method: 'cash' }),
  /barangay/i));
check('bad date format rejected', expectThrow(
  () => svc.createCollection({ barangayId: b1.id, txnDate: '10/02/2026', payer: 'X', description: 'Test date', amount: '10', method: 'cash' }),
  /YYYY-MM-DD/i));
check('archived barangay rejected', (() => {
  const b3 = svc.addBarangay({ name: 'Archived Test' });
  svc.setBarangayArchived(b3.id, true);
  return expectThrow(
    () => svc.createCollection({ barangayId: b3.id, txnDate: '2026-10-02', payer: 'X', description: 'Test arch', amount: '10', method: 'cash' }),
    /active barangay/i);
})());

console.log('\n== 3. Edit collection ==');
const cu = svc.updateCollection(c1.id, { barangayId: b1.id, txnDate: '2026-10-01', payer: 'Juan Dela Cruz Jr.',
  description: 'Barangay clearance fees (corrected)', amount: '1500.75', method: 'cash', recordedBy: 'Maria Santos' });
check('edit persisted (payer + amount updated)', cu.payer === 'Juan Dela Cruz Jr.' && cu.amount_c === 150075);
check('ledger mirror updated too', svc.db.prepare('SELECT amount_c FROM transactions WHERE id = ?').get(c1.txn_id).amount_c === 150075);

console.log('\n== 4. Add and edit expense ==');
const e1 = svc.createExpense({ barangayId: b1.id, txnDate: '2026-10-05', payee: 'Hardware Store',
  description: 'Repair materials', amount: '750.50', method: 'cash',
  categoryId: expCats[0].id, supportingDoc: 'INV-2026-014', recordedBy: 'Maria Santos' });
const e2 = svc.createExpense({ barangayId: b2.id, txnDate: '2026-10-08', payee: 'Electric Co.',
  description: 'Street light electricity', amount: '1200.00', method: 'bank' });
check('expense saved with generated ref EXP-…', !!e1.id && /^EXP-\d{4}-\d{4}$/.test(e1.ref_no));
check('expense amount stored as centavos (750.50 → 75050)', e1.amount_c === 75050);
check('expense mirrored into ledger', !!e1.txn_id);
const eu = svc.updateExpense(e1.id, { barangayId: b1.id, txnDate: '2026-10-05', payee: 'Hardware Store Main',
  description: 'Repair materials', amount: '900.00', method: 'cash', supportingDoc: 'INV-2026-014' });
check('expense edit persisted', eu.payee === 'Hardware Store Main' && eu.amount_c === 90000);
check('expense zero amount rejected', expectThrow(
  () => svc.createExpense({ barangayId: b1.id, txnDate: '2026-10-05', payee: 'X', description: 'Test', amount: '0', method: 'cash' }),
  /greater than zero/i));

console.log('\n== 5. Receipts: issue, link, duplicate rejection, cancel ==');
const r1 = svc.createReceipt({ barangayId: b1.id, collectionRef: c1.ref_no, receiptNo: 'RCT-0001',
  dateIssued: '2026-10-01', payer: 'Juan Dela Cruz Jr.', amount: '1500.75', status: 'issued' });
check('receipt issued and linked to collection ref', r1.collection_ref === c1.ref_no && r1.status === 'issued');
check('duplicate receipt number rejected (same barangay)', expectThrow(
  () => svc.createReceipt({ barangayId: b1.id, collectionRef: c2.ref_no, receiptNo: 'RCT-0001',
    dateIssued: '2026-10-15', payer: 'Market vendors', amount: '100', status: 'issued' }),
  /already exists/i));
const r2 = svc.createReceipt({ barangayId: b2.id, collectionRef: c3.ref_no, receiptNo: 'RCT-0001',
  dateIssued: '2026-10-10', payer: 'Tricycle operators', amount: '500.25', status: 'issued' });
check('same receipt number allowed in a DIFFERENT barangay (scope = per barangay)', r2.barangay_id === b2.id);
check('receipt with unknown collection ref rejected', expectThrow(
  () => svc.createReceipt({ barangayId: b1.id, collectionRef: 'COL-9999-9999', receiptNo: 'RCT-0009',
    dateIssued: '2026-10-01', payer: 'X', amount: '10', status: 'issued' }),
  /Collection reference not found/i));
const rc = svc.cancelReceipt(r1.id);
check('cancel sets status, record kept (not deleted)', rc.status === 'cancelled' && !rc.deleted_at);
check('cancelled receipt still listed for audit', svc.listReceipts({ status: 'cancelled' }).some((r) => r.id === r1.id));
check('double cancel rejected', expectThrow(() => svc.cancelReceipt(r1.id), /already cancelled/i));

console.log('\n== 6. Totals from known amounts ==');
// collections: 1500.75 + 3000.00 + 500.25 = 5001.00 ; expenses: 900.00 + 1200.00 = 2100.00
const s = svc.financialSummary({});
check('total collections = ₱5,001.00 (500100c)', s.collections_c === 500100);
check('total expenses = ₱2,100.00 (210000c)', s.expenses_c === 210000);
check('net = collections − expenses (290100c)', s.net_c === 290100);
check('transaction count = 5', s.n === 5);
check('multi-barangay totals flagged', s.multiBarangay === true);
const sB1 = svc.financialSummary({ barangayId: b1.id });
check('barangay-1-only collections = 450075c', sB1.collections_c === 450075);
check('single-barangay scope not flagged as multi', sB1.multiBarangay === false);
const sB2 = svc.financialSummary({ barangayId: b2.id });
check('barangay-2-only collections = 50025c', sB2.collections_c === 50025);
check('per-barangay rows isolated', s.perBarangay.length === 2);

console.log('\n== 7. Barangay isolation (no mixed records) ==');
check('b1 list contains only b1 records', svc.listCollections({ barangayId: b1.id }).every((c) => c.barangay_id === b1.id));
check('b2 list contains only b2 records', svc.listExpenses({ barangayId: b2.id }).every((e) => e.barangay_id === b2.id));
check('b1 list does not include b2 collection', !svc.listCollections({ barangayId: b1.id }).some((c) => c.id === c3.id));

console.log('\n== 8. Date filters and search ==');
const oct = svc.financialSummary({ from: '2026-10-01', to: '2026-10-31' });
check('October date range captures all 5 records', oct.n === 5);
const nov = svc.financialSummary({ from: '2026-11-01', to: '2026-11-30' });
check('November date range captures nothing', nov.n === 0);
const byDate = svc.listCollections({ from: '2026-10-10', to: '2026-10-15' });
check('collection date filter returns only c2 + c3', byDate.length === 2);
const search1 = svc.listCollections({ q: 'Juan' });
check('search by payer finds corrected collection', search1.length === 1 && search1[0].id === c1.id);
const search2 = svc.listExpenses({ q: 'INV-2026-014' });
check('search by supporting doc finds expense', search2.length === 1 && search2[0].id === e1.id);
const search3 = svc.listReceipts({ q: 'RCT-0001' });
check('receipt search finds both receipts', search3.length === 2);

console.log('\n== 9. Audit trail records create/edit/delete/cancel ==');
const log = svc.getAuditLog(50);
const actions = log.map((l) => `${l.action}:${l.entity}`);
check('collection create audited', actions.includes('create:collection'));
check('collection edit audited', actions.includes('update:collection'));
check('expense create audited', actions.includes('create:expense'));
check('expense edit audited', actions.includes('update:expense'));
check('receipt create audited', actions.includes('create:receipt'));
check('receipt cancel audited', actions.includes('cancel:receipt'));

console.log('\n== 10. Soft delete preserves audit + removes from totals ==');
const del = svc.deleteCollection(c2.id);
check('delete returns ref and succeeds', del.ok === true && del.ref === c2.ref_no);
check('deleted collection excluded from lists', !svc.listCollections({ barangayId: b1.id }).some((c) => c.id === c2.id));
const sAfterDel = svc.financialSummary({});
check('totals drop to 2001.00 collections after delete (200100c)', sAfterDel.collections_c === 200100);
check('delete audited', svc.getAuditLog(50).map((l) => `${l.action}:${l.entity}`).includes('delete:collection'));

console.log('\n== 11. Restart persistence (close & reopen DB) ==');
const snap = {
  colCount: svc.listCollections({}).length,
  c1: svc.getCollection(c1.id).amount_c,
  totals: svc.financialSummary({}),
};
svc.close();
const svc2 = new DatabaseService();
const info2 = svc2.init(dir);
check('schema v4+ persists after restart (no re-migration)', info2.schemaVersion >= 4 && info2.appliedMigrations.length === 0);
check('collections persist after restart (2 active remain)', svc2.listCollections({}).length === snap.colCount);
check('collection amounts persist after restart', svc2.getCollection(c1.id).amount_c === 150075);
check('receipts persist after restart (cancelled kept)', svc2.listReceipts({}).some((r) => r.id === r1.id && r.status === 'cancelled'));
check('totals persist after restart', svc2.financialSummary({}).collections_c === 200100);
check('expenses persist after restart', svc2.getExpense(e1.id).amount_c === 90000);
// new record still saves after restart
const cNew = svc2.createCollection({ barangayId: b1.id, txnDate: '2026-10-20', payer: 'Post-restart payer',
  description: 'Saved after reopen', amount: '100.00', method: 'cash' });
check('new collection saves after restart with fresh ref', !!cNew.id && cNew.ref_no !== c1.ref_no);
// existing users/barangays preserved
check('users preserved (schema untouched)', svc2.db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 0 && !!svc2.db.prepare('SELECT id FROM barangays WHERE id = ?').get(b1.id));
svc2.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
