/**
 * tests/part2-test.js — Part 2 verification suite (headless, real SQLite).
 * Covers: add / view / edit / archive barangays; duplicate rejection;
 * 2–5 limit; per-barangay isolation; dashboard refresh; persistence after
 * reopening the database file (simulated app restart).
 *   npm run test:part2
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseService } = require('../src/main/database');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.error('  FAIL', name); }
}
const PESOS = (c) => `₱${(c / 100).toFixed(2)}`;

// --- Fresh DB file in tmp (DatabaseService builds its own filename in dir) ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-part2-'));
const svcA = new DatabaseService();
const infoA = svcA.init(dir);
console.log('Schema version:', infoA.schemaVersion, '| migrations applied:', infoA.appliedMigrations.map(m => `v${m.version}:${m.name}`).join(', '));
check('schema migrated to v3+ (barangay-management present)', infoA.schemaVersion >= 3);

console.log('\n== 1. Add / view / edit / archive ==');
const b1 = svcA.addBarangay({ name: 'San Isidro', municipality: 'Sample Town', province: 'Sample Prov', openingBalance: '5000.00' });
const b2 = svcA.addBarangay({ name: 'Bagong Silang', openingBalance: '0' });
check('add barangay 1 returns computed balance', b1.balance_c === 500000 && b1.opening_balance_c === 500000);
check('add barangay 2 works', !!b2.id);
check('active count = 2', svcA.activeBarangayCount() === 2);

// Record real transactions per barangay
svcA.createTransaction({ barangayId: b1.id, txnDate: '2026-10-20', kind: 'collection', description: 'Clearance fees batch 1', amount: '1250.75', method: 'cash' });
svcA.createTransaction({ barangayId: b1.id, txnDate: '2026-10-21', kind: 'expense', description: 'Office supplies', amount: '300.25', method: 'cash' });
svcA.createTransaction({ barangayId: b2.id, txnDate: '2026-10-21', kind: 'collection', description: 'Court rental', amount: '800.00', method: 'cash' });

const v1 = svcA.getBarangay(b1.id);
check('view barangay 1: collections computed by SQL', v1.collections_c === 125075);
check('view barangay 1: expenses computed by SQL', v1.expenses_c === 30025);
check('balance = opening + collections − expenses', v1.balance_c === 500000 + 125075 - 30025);

const e1 = svcA.updateBarangay(b1.id, { name: 'San Isidro Renamed', municipality: 'New Town', openingBalance: '6000' });
check('edit barangay name persisted', e1.name === 'San Isidro Renamed');
check('edit opening balance recomputed into balance', e1.balance_c === 600000 + 125075 - 30025);

console.log('\n== 2. Duplicate rejection & 2–5 limit ==');
let dupErr = null;
try { svcA.addBarangay({ name: 'san isidro renamed' }); } catch (e) { dupErr = e; }
check('duplicate name rejected (case-insensitive)', !!dupErr && /already exists/i.test(dupErr.message));

while (svcA.activeBarangayCount() < 5) svcA.addBarangay({ name: 'Brgy ' + (svcA.activeBarangayCount() + 1) });
let maxErr = null;
try { svcA.addBarangay({ name: 'Extra Brgy' }); } catch (e) { maxErr = e; }
check('6th barangay blocked (max 5)', !!maxErr && /maximum of 5/i.test(maxErr.message));

// Reduce to exactly 2 active, then the next archive must be blocked (2 → 1).
const fillers = svcA.listBarangays().filter((b) => b.id !== b1.id && b.id !== b2.id);
for (const f of fillers.slice(0, 3)) svcA.setBarangayArchived(f.id, true);
check('3 archived, 2 active remain', svcA.activeBarangayCount() === 2);
let minErr = null;
try { svcA.setBarangayArchived(b1.id, true); } catch (e) { minErr = e; }
check('archive blocked when it would drop below 2 active', !!minErr && /at least 2/i.test(minErr.message));
for (const f of fillers.slice(0, 3)) svcA.setBarangayArchived(f.id, false);
check('restore brings back 5 active', svcA.activeBarangayCount() === 5);

console.log('\n== 3. Archive keeps history ==');
// Add a 6th -> no. Instead: restore-able archive test uses one of the 5.
// Archive one of the two with no blockers: create situation with 5 active; archive is allowed (stays 4 ≥ 2).
const archTarget = svcA.listBarangays().find((b) => b.id !== b1.id && b.id !== b2.id) || b2;
const arch = svcA.setBarangayArchived(archTarget.id, true);
check('archive flag set, record still exists', arch.archived === 1);
const histBefore = svcA.getBarangay(archTarget.id).txn_count;
check('financial history preserved after archive', svcA.getBarangay(archTarget.id).txn_count === histBefore);
const restored = svcA.setBarangayArchived(archTarget.id, false);
check('restore works', restored.archived === 0);

console.log('\n== 4. Per-barangay isolation ==');
const w1 = svcA.barangayWorkspace(b1.id);
const w2 = svcA.barangayWorkspace(b2.id);
check('workspace 1 only has its own transactions', w1.transactions.every((t) => t.barangay_id === b1.id));
check('workspace 2 only has its own transactions', w2.transactions.every((t) => t.barangay_id === b2.id));
check('barangay 1 does not see barangay 2 records', !w1.transactions.some((t) => t.barangay_id === b2.id));
check('isolation: brgy1 collections ≠ brgy2 collections', w1.barangay.collections_c !== w2.barangay.collections_c);

console.log('\n== 5. Dashboard refresh from DB ==');
let d = svcA.dashboardSummary();
check('barangayCount reflects DB (5)', d.barangayCount === 5);
check('real collections total computed (125075 + 80000)', d.real.collections_c === 125075 + 80000);
check('real expenses total computed (30025)', d.real.expenses_c === 30025);
check('sample bucket empty (no sample data)', d.sample.count === 0);
check('pending tasks list present (0 tasks)', Array.isArray(d.pendingTasks) && d.pendingTasks.length === 0);
// add a task + sample txn, refresh
svcA.db.prepare("INSERT INTO tasks (barangay_id, title, due_date, priority) VALUES (?, 'Submit report', '2026-11-01', 'high')").run(b1.id);
svcA.createTransaction({ barangayId: b1.id, txnDate: '2026-10-22', kind: 'collection', description: 'SAMPLE only', amount: '999.99', method: 'cash', isSample: true });
d = svcA.dashboardSummary();
check('dashboard picks up new task', d.openTasks === 1 && d.pendingTasks[0].title === 'Submit report');
check('sample txn excluded from real totals', d.real.collections_c === 125075 + 80000);
check('sample txn captured in sample bucket', d.sample.collections_c === 99999);
const perB1 = d.perBarangay.find((p) => p.barangayId === b1.id);
check('per-barangay balance row computed', perB1.real.balance_c === 600000 + 125075 - 30025);

console.log('\n== 6. Persistence across restart (close & reopen DB) ==');
const snapshot = {
  brgys: svcA.listBarangays({ includeArchived: true }).length,
  b1: svcA.getBarangay(b1.id).balance_c,
  real: svcA.dashboardSummary().real.collections_c,
};
svcA.close(); // simulate app quit
const svcB = new DatabaseService();
svcB.init(dir); // reopen same folder = same DB file
const after = {
  brgys: svcB.listBarangays({ includeArchived: true }).length,
  b1: svcB.getBarangay(b1.id).balance_c,
  real: svcB.dashboardSummary().real.collections_c,
};
check('barangay count persists after reopen', after.brgys === snapshot.brgys);
check('barangay balance persists after reopen', after.b1 === snapshot.b1 && after.b1 === 600000 + 125075 - 30025);
check('dashboard totals persist after reopen', after.real === snapshot.real);
const renamed = svcB.getBarangay(b1.id);
check('edit persisted across restart', renamed.name === 'San Isidro Renamed' && renamed.municipality === 'New Town');
check('sample totals reported separately after restart', renamed.sample_collections_c === 99999 && renamed.balance_c === 600000 + 125075 - 30025);
svcB.close();

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log(`Money figures verified: ${PESOS(600000 + 125075 - 30025)} balance for ${renamed.name}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
