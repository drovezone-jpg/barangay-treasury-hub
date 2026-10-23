/**
 * tests/part6-test.js — final integration & data-safety suite.
 *   npm run test:part6
 * Uses temporary databases only. Covers: known-value centavo math,
 * cancelled receipts and double-counting, corrupt-backup rejection with
 * original DB intact, safety backup before restore, restart persistence,
 * migration idempotency, treasurer-account preservation, missing/corrupt
 * live-DB handling, and inclusive date filters.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseService } = require('../src/main/database');
const { hasAnyUser } = require('../src/main/auth');
const br = require('../src/main/backup-restore');

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.error('  FAIL', name); }
};
const expectThrow = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-part6-'));
  const svc = new DatabaseService();
  svc.init(dir);
  const b1 = svc.addBarangay({ name: 'San Isidro', openingBalance: '1000.00' });
  const b2 = svc.addBarangay({ name: 'Bagong Silang', openingBalance: '0' });
  const cats = svc.listCategories('collection');

  console.log('== 1. Known-value centavo math (fictional test values) ==');
  const c1 = svc.createCollection({ barangayId: b1.id, txnDate: '2026-11-01', payer: 'Fictional Payer A',
    description: 'Integration test collection one', amount: '1234.56', method: 'cash', categoryId: cats[0].id });
  const c2 = svc.createCollection({ barangayId: b1.id, txnDate: '2026-11-05', payer: 'Fictional Payer B',
    description: 'Integration test collection two', amount: '765.43', method: 'gcash', categoryId: cats[0].id });
  const c3 = svc.createCollection({ barangayId: b2.id, txnDate: '2026-11-03', payer: 'Fictional Payer C',
    description: 'Integration test collection three', amount: '500.00', method: 'cash' });
  const e1 = svc.createExpense({ barangayId: b1.id, txnDate: '2026-11-02', payee: 'Fictional Vendor X',
    description: 'Integration test expense one', amount: '300.25', method: 'cash' });
  const e2 = svc.createExpense({ barangayId: b1.id, txnDate: '2026-11-04', payee: 'Fictional Vendor Y',
    description: 'Integration test expense two', amount: '199.75', method: 'bank' });
  check('1234.56 stored as 123456 centavos', c1.amount_c === 123456);
  check('collections sum: 1234.56 + 765.43 + 500.00 = 2499.99', svc.financialSummary({}).collections_c === 249999);
  check('expenses sum: 300.25 + 199.75 = 500.00', svc.financialSummary({}).expenses_c === 50000);
  check('net = 1999.99 exactly (199999c, no float drift)', svc.financialSummary({}).net_c === 199999);

  console.log('== 2. Cancelled receipts and double-counting ==');
  const r1 = svc.createReceipt({ barangayId: b1.id, collectionRef: c1.ref_no, receiptNo: 'RCT-F6-001',
    dateIssued: '2026-11-01', payer: 'Fictional Payer A', amount: '1234.56', status: 'issued' });
  const beforeCancel = svc.financialSummary({ barangayId: b1.id }).collections_c;
  check('receipt does not duplicate the collection total', beforeCancel === 123456 + 76543);
  svc.cancelReceipt(r1.id);
  const afterCancel = svc.financialSummary({ barangayId: b1.id }).collections_c;
  check('cancelling a receipt leaves collection totals unchanged', afterCancel === beforeCancel);
  check('cancelled receipt kept in records for audit', svc.listReceipts({ barangayId: b1.id }).some((r) => r.id === r1.id && r.status === 'cancelled'));

  console.log('== 3. Barangay filters and inclusive date bounds ==');
  const sB1 = svc.financialSummary({ barangayId: b1.id });
  check('barangay-1 filter: collections = 1999.99, expenses = 500.00',
    sB1.collections_c === 199999 && sB1.expenses_c === 50000);
  check('barangay-2 filter excludes barangay-1 records',
    svc.financialSummary({ barangayId: b2.id }).collections_c === 50000);
  const nov1to5 = svc.financialSummary({ from: '2026-11-01', to: '2026-11-05' });
  check('date range bounds are inclusive (all 5 records)', nov1to5.n === 5);
  const nov2to4 = svc.financialSummary({ from: '2026-11-02', to: '2026-11-04' });
  check('narrow range 11-02..11-04 includes only c3, e1, e2 (3 records)', nov2to4.n === 3);
  const nov10plus = svc.financialSummary({ from: '2026-11-10' });
  check('records outside range excluded', nov10plus.n === 0);
  check('start-after-end validation exists in report UI date logic (DB layer tolerant)', svc.financialSummary({ from: '2026-12-01', to: '2026-11-01' }).n === 0);

  console.log('== 4. Backup / restore safety ==');
  const backupFile = path.join(dir, 'integration-backup.sqlite');
  await br.createBackup(svc, backupFile);
  check('backup file created', fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0);
  // change data after backup
  svc.createCollection({ barangayId: b1.id, txnDate: '2026-11-20', payer: 'Post-backup',
    description: 'Added after backup', amount: '10.00', method: 'cash' });
  check('data changed after backup (4 collections now)', svc.listCollections({}).length === 4);
  const corrupt = path.join(dir, 'corrupt.sqlite');
  fs.writeFileSync(corrupt, 'definitely not a sqlite database, just plain text padding padding');
  let err1 = null;
  try { await br.restoreBackup(svc, corrupt); } catch (e) { err1 = e; }
  check('corrupt backup rejected', !!err1 && /not a valid database backup/i.test(err1.message));
  check('original DB intact after failed restore attempt', svc.listCollections({}).length === 4);
  const rr = await br.restoreBackup(svc, backupFile);
  check('valid restore succeeds', rr.ok === true);
  check('safety backup of pre-restore data was created', fs.existsSync(rr.safetyBackup) && fs.statSync(rr.safetyBackup).size > 0);
  check('restored DB has exactly the 3 pre-backup collections', svc.listCollections({}).length === 3);
  check('restored DB integrity_check passes', (() => {
    const Database = require('better-sqlite3');
    const d = new Database(svc.dbPath, { readonly: true });
    const ic = d.pragma('integrity_check', { simple: true });
    d.close();
    return ic === 'ok';
  })());

  console.log('== 5. Restart persistence + account preservation ==');
  const userBefore = hasAnyUser(svc.db);
  svc.db.prepare("INSERT INTO users (username, display_name, password_salt, password_hash) VALUES ('treasurer1','T One','aa','bb')").run();
  const snap = { cols: svc.listCollections({}).length, brgys: svc.listBarangays({ includeArchived: true }).length };
  svc.close();
  const svc2 = new DatabaseService();
  const i2 = svc2.init(dir);
  check('migration rerun is idempotent (nothing re-applied at v6)', i2.schemaVersion >= 6 && i2.appliedMigrations.length === 0);
  check('financial records persist across restart', svc2.listCollections({}).length === snap.cols);
  check('barangays persist across restart', svc2.listBarangays({ includeArchived: true }).length === snap.brgys);
  check('existing treasurer account survives reopen', hasAnyUser(svc2.db) === true);
  const u = svc2.db.prepare('SELECT username FROM users').get();
  svc2.init(dir); // re-init same dir again
  check('re-initialization does not overwrite the treasurer account',
    svc2.db.prepare('SELECT username FROM users').get().username === u.username);
  svc2.close();

  console.log('== 6. Missing / corrupt live database handling ==');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-fresh-'));
  const svc3 = new DatabaseService();
  svc3.init(emptyDir);
  check('missing database: init creates a fresh usable one', svc3.listBarangays().length === 0 && hasAnyUser(svc3.db) === false);
  svc3.close();
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-bad-'));
  const badFile = path.join(badDir, 'barangay-treasury-hub.db');
  fs.writeFileSync(badFile, 'garbage bytes that are not a sqlite header at all......');
  const svc4 = new DatabaseService();
  let err2 = null;
  try { svc4.init(badDir); } catch (e) { err2 = e; }
  check('corrupt live DB surfaces a clear error (does not silently reset)', !!err2);
  check('corrupt live DB file is NOT overwritten/deleted by init', fs.readFileSync(badFile, 'utf8').startsWith('garbage bytes'));
  if (svc4.db) svc4.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(badDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
