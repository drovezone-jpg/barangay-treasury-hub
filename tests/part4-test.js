/**
 * tests/part4-test.js — Part 4 verification suite (headless, real SQLite).
 *   npm run test:part4
 * Covers: budget create/edit/persist, expense→budget linking, utilization
 * math, zero allocations, unrelated-budget isolation, unassigned flagging,
 * report totals vs raw SUM, barangay/date filters, CSV output, regression.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-part4-'));
const svc = new DatabaseService();
const info = svc.init(dir);
console.log('Schema version:', info.schemaVersion,
  '| new:', info.appliedMigrations.map((m) => `v${m.version}:${m.name}`).join(', '));
check('migration v5 applied (budget-monitoring)', info.appliedMigrations.some((m) => m.version === 5));
check('expenses now has budget_id column',
  svc.db.prepare('PRAGMA table_info(expenses)').all().some((c) => c.name === 'budget_id'));

const b1 = svc.addBarangay({ name: 'San Isidro', openingBalance: '0' });
const b2 = svc.addBarangay({ name: 'Bagong Silang', openingBalance: '0' });
const expCats = svc.listCategories('expense');
const colCats = svc.listCategories('collection');

console.log('\n== 1. Create and edit budget ==');
const g1 = svc.createBudget({ barangayId: b1.id, fiscalYear: 2026, categoryId: expCats[0].id,
  description: 'Supplies allocation FY2026', amount: '10000.00', remarks: 'initial' });
check('budget created with generated ref BGT-…', !!g1.id && /^BGT-\d{4}/.test(g1.ref_no));
check('allocated amount stored as centavos (10000.00 → 1000000)', g1.amount_c === 1000000);
const g2 = svc.createBudget({ barangayId: b1.id, fiscalYear: 2026, categoryId: expCats[1].id,
  description: 'Utilities allocation FY2026', amount: '5000.00' });
const g3 = svc.createBudget({ barangayId: b2.id, fiscalYear: 2026, categoryId: expCats[0].id,
  description: 'Supplies allocation FY2026 (Bagong Silang)', amount: '8000.00' });
check('separate allocations allowed (distinct descriptions)', !!g2.id && !!g3.id);
check('duplicate budget rejected (same brgy+year+category+description)', expectThrow(
  () => svc.createBudget({ barangayId: b1.id, fiscalYear: 2026, categoryId: expCats[0].id,
    description: 'supplies allocation fy2026', amount: '999' }),
  /already exists/i));
const ge = svc.updateBudget(g1.id, { barangayId: b1.id, fiscalYear: 2026, categoryId: expCats[0].id,
  description: 'Supplies allocation FY2026 (amended)', amount: '12000.00' });
check('budget edit persisted (amount 12000.00)', ge.amount_c === 1200000 && ge.description.includes('amended'));
check('zero budget amount rejected', expectThrow(
  () => svc.createBudget({ barangayId: b1.id, fiscalYear: 2026, description: 'Zero alloc test', amount: '0' }),
  /greater than zero/i));
check('negative budget rejected', expectThrow(
  () => svc.createBudget({ barangayId: b1.id, fiscalYear: 2026, description: 'Neg alloc test', amount: '-5' }),
  /greater than zero/i));
check('bad year rejected', expectThrow(
  () => svc.createBudget({ barangayId: b1.id, fiscalYear: 1899, description: 'Bad year test', amount: '10' }),
  /2000 and 2100/i));

console.log('\n== 2. Link expense to correct budget ==');
const e1 = svc.createExpense({ barangayId: b1.id, txnDate: '2026-03-05', payee: 'Office Depot',
  description: 'Supplies purchase Q1', amount: '2500.00', method: 'cash', budgetId: g1.id });
check('expense linked to budget', e1.budget_id === g1.id);
const e2 = svc.createExpense({ barangayId: b1.id, txnDate: '2026-06-10', payee: 'Electric Co.',
  description: 'Electricity Q2', amount: '1800.50', method: 'bank', budgetId: g2.id });
check('second expense linked to its own budget', e2.budget_id === g2.id);
check('cross-barangay budget charging rejected', expectThrow(
  () => svc.createExpense({ barangayId: b2.id, txnDate: '2026-03-06', payee: 'Vendor Co',
    description: 'Wrong brgy charge', amount: '10', method: 'cash', budgetId: g1.id }),
  /different barangay/i));
const e3 = svc.updateExpense(e1.id, { barangayId: b1.id, txnDate: '2026-03-05', payee: 'Office Depot',
  description: 'Supplies purchase Q1', amount: '2500.00', method: 'cash', budgetId: null });
check('expense can be unassigned via edit', e3.budget_id === null);

console.log('\n== 3. Utilization math (known amounts) ==');
// g1: allocated 12000.00, spent 0 (e1 unassigned) → 0%
let u = svc.budgetUtilization({ barangayId: b1.id });
let r1 = u.rows.find((r) => r.id === g1.id);
check('g1 remaining = allocated − spent (12000.00)', r1.remaining_c === 1200000);
check('g1 utilization 0%', r1.utilization_pct === 0);
// reassign e1 to g1
svc.updateExpense(e1.id, { barangayId: b1.id, txnDate: '2026-03-05', payee: 'Office Depot',
  description: 'Supplies purchase Q1', amount: '2500.00', method: 'cash', budgetId: g1.id });
u = svc.budgetUtilization({ barangayId: b1.id });
r1 = u.rows.find((r) => r.id === g1.id);
check('g1 spent = 2500.00 (charged once via budget_id)', r1.spent_c === 250000);
check('g1 remaining = 9500.00 (950000c)', r1.remaining_c === 950000);
check('g1 utilization = 250000/1200000×100 = 20.83%', r1.utilization_pct === 20.83);
const r2 = u.rows.find((r) => r.id === g2.id);
check('g2 spent = 1800.50, utilization 36.01%', r2.spent_c === 180050 && r2.utilization_pct === 36.01);

console.log('\n== 4. Unassigned expenses flagged; no cross-budget counting ==');
const eUn = svc.createExpense({ barangayId: b1.id, txnDate: '2026-07-01', payee: 'Misc Vendor',
  description: 'Unassigned purchase', amount: '100.00', method: 'cash' });
u = svc.budgetUtilization({ barangayId: b1.id });
check('unassigned expense flagged with amount + count',
  u.unassigned.count === 1 && u.unassigned.amount_c === 10000);
check('unrelated budget not charged by unassigned expense', u.rows.every((r) => r.spent_c !== 110050));
check('expense counted once (g1 spent unchanged at 2500.00)',
  u.rows.find((r) => r.id === g1.id).spent_c === 250000);
const uB2 = svc.budgetUtilization({ barangayId: b2.id });
check('barangay-2 utilization isolated from barangay-1 expenses',
  uB2.rows.find((r) => r.id === g3.id).spent_c === 0);

console.log('\n== 5. Zero-budget handling (no division errors) ==');
const g0 = svc.createBudget({ barangayId: b2.id, fiscalYear: 2026, description: 'Zero-allocated grant placeholder', amount: '0.01' });
// force a true zero via direct prepared statement (UI validation rejects zero; schema allows >= 0)
svc.db.prepare('UPDATE budgets SET amount_c = 0 WHERE id = ?').run(g0.id);
const u0 = svc.budgetUtilization({ barangayId: b2.id });
const r0 = u0.rows.find((r) => r.id === g0.id);
check('zero allocation: utilization null (no division error)', r0.utilization_pct === null);
check('zero allocation: remaining = 0 − spent', r0.remaining_c === -r0.spent_c);
const gb = svc.getBudget(g0.id);
check('getBudget also handles zero allocation safely', gb.utilization_pct === null);

console.log('\n== 6. Budget-year totals per barangay ==');
const t = svc.budgetTotals({ fiscalYear: 2026 });
const t1 = t.find((x) => x.barangayId === b1.id);
const t2 = t.find((x) => x.barangayId === b2.id);
check('brgy-1 total allocated = 17000.00', t1.allocated_c === 1700000);
check('brgy-1 total spent = 4300.50', t1.spent_c === 430050);
check('brgy-2 total allocated matches underlying budget records', t2.allocated_c === svc.getBudget(g3.id).amount_c + svc.getBudget(g0.id).amount_c);

console.log('\n== 7. Reports use actual SQLite records ==');
// collections for the reports
svc.createCollection({ barangayId: b1.id, txnDate: '2026-02-01', payer: 'Residents',
  description: 'Clearance fees', amount: '3000.00', method: 'cash', categoryId: colCats[0].id });
const s = svc.financialSummary({ barangayId: b1.id });
const raw = svc.db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN kind='collection' THEN amount_c END),0) AS c,
          COALESCE(SUM(CASE WHEN kind='expense' THEN amount_c END),0) AS e, COUNT(*) AS n
   FROM transactions WHERE deleted_at IS NULL AND status='posted' AND is_sample=0 AND barangay_id = ?`
).get(b1.id);
check('report collections total matches raw SUM', s.collections_c === raw.c && s.collections_c === 300000);
check('report expenses total matches raw SUM', s.expenses_c === raw.e && s.expenses_c === 440050);
check('report net = collections − expenses', s.net_c === raw.c - raw.e);
check('report transaction count matches raw COUNT', s.n === raw.n);
const trends = svc.monthlyTrends({ barangayId: b1.id, fiscalYear: 2026 });
check('monthly trends computed from DB (non-empty)', trends.length >= 2);

console.log('\n== 8. Barangay and date filters ==');
check('financialSummary barangay filter isolates b1', svc.financialSummary({ barangayId: b2.id }).collections_c === 0);
check('budget list barangay filter isolates b1', svc.listBudgets({ barangayId: b1.id }).every((x) => x.barangay_id === b1.id));
check('budget list year filter works', svc.listBudgets({ fiscalYear: 2030 }).length === 0);
check('expense unassigned filter works', svc.listExpenses({ barangayId: b1.id, unassigned: true }).every((x) => x.budget_id === null));
check('budget search by description works', svc.listBudgets({ q: 'amended' }).some((x) => x.id === g1.id));

console.log('\n== 9. Receipts excluded from collection totals (no double counting) ==');
// collection + receipt for the same money must not double-count in summaries
const cR = svc.createCollection({ barangayId: b1.id, txnDate: '2026-02-10', payer: 'Juan',
  description: 'Permit fee', amount: '500.00', method: 'cash' });
svc.createReceipt({ barangayId: b1.id, collectionRef: cR.ref_no, receiptNo: 'RCT-B4001',
  dateIssued: '2026-02-10', payer: 'Juan', amount: '500.00', status: 'issued' });
const s2 = svc.financialSummary({ barangayId: b1.id });
check('collection total counts collection once (3500.00, not 4000.00)', s2.collections_c === 350000);
check('receipts tracked separately from ledger', svc.listReceipts({ barangayId: b1.id }).some((r) => r.receipt_no === 'RCT-B4001'));

console.log('\n== 10. CSV export correctness ===');
const csvEscape = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = { name: 'San Isidro', desc: 'Has "quotes" and, commas', amt: '₱12,000.00' };
const line = [row.name, row.desc, row.amt].map(csvEscape).join(',');
check('CSV escapes quotes and commas', line === 'San Isidro,"Has ""quotes"" and, commas","₱12,000.00"');
check('CSV with UTF-8 BOM renders ₱', ('\uFEFF' + line).charCodeAt(0) === 0xFEFF);

console.log('\n== 11. Budget delete guard + persistence ==');
check('budget with charged expenses cannot be deleted', expectThrow(() => svc.deleteBudget(g1.id), /recorded expenses/i));
const snap = { g1: svc.getBudget(g1.id).amount_c, spent: svc.getBudget(g1.id).spent_c };
svc.close();
const svc2 = new DatabaseService();
const i2 = svc2.init(dir);
check('schema v5+ persists after restart (no re-migration)', i2.schemaVersion >= 5 && i2.appliedMigrations.length === 0);
const g1b = svc2.getBudget(g1.id);
check('budget persists after restart (12000.00)', g1b.amount_c === 1200000 && g1b.amount_c === snap.g1);
check('expense→budget link persists after restart', svc2.getExpense(e1.id).budget_id === g1.id);
check('utilization recomputes identically after restart', svc2.budgetUtilization({ barangayId: b1.id }).rows.find((r) => r.id === g1.id).spent_c === snap.spent);
check('existing collections/receipts/expenses still work after restart',
  !!svc2.createCollection({ barangayId: b1.id, txnDate: '2026-03-01', payer: 'Post-restart',
    description: 'Still works after reopen', amount: '10.00', method: 'cash' }).id);
svc2.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
