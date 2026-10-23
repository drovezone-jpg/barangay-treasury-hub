/**
 * tests/part5-test.js — Part 5 verification suite (headless, real SQLite).
 *   npm run test:part5
 * Covers: task lifecycle, overdue/upcoming math, persistence; audit records
 * + read-only design; backup creation + validity; restore of a valid backup;
 * rejection of corrupt/foreign files; failed-restore rollback; settings
 * persistence and defaults reset.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseService } = require('../src/main/database');
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-part5-'));
const svc = new DatabaseService();
const info = svc.init(dir);
console.log('Schema version:', info.schemaVersion,
  '| new:', info.appliedMigrations.map((m) => `v${m.version}:${m.name}`).join(', '));
check('migration v6 applied (tasks-audit-settings)', info.appliedMigrations.some((m) => m.version === 6));
check('tasks has new columns', (() => {
  const cols = svc.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  return ['description', 'updated_at'].every((c) => cols.includes(c));
})());
check('tasks CHECK now allows in_progress', (() => {
  svc.db.prepare("INSERT INTO tasks (title, status) VALUES ('tmp status probe', 'in_progress')").run();
  const ok = !!svc.db.prepare("SELECT id FROM tasks WHERE title = 'tmp status probe' AND status = 'in_progress'").get();
  svc.db.prepare("DELETE FROM tasks WHERE title = 'tmp status probe'").run();
  return ok;
})());
check('settings defaults seeded', (() => {
  const s = svc.getSettings();
  return s.date_format === 'en-PH' && typeof s.report_footer === 'string' && s.report_footer.length > 0;
})());

const b1 = svc.addBarangay({ name: 'San Isidro', openingBalance: '0' });
const today = new Date();
const iso = (offsetDays) => {
  const t = new Date(today); t.setDate(t.getDate() + offsetDays);
  return t.toISOString().slice(0, 10);
};

console.log('\n== 1. Task lifecycle ==');
const t1 = svc.createTask({ title: 'Submit monthly report', barangayId: b1.id, dueDate: iso(-3), priority: 'high' });
const t2 = svc.createTask({ title: 'Reconcile cashbook', dueDate: iso(0), priority: 'medium' });
const t3 = svc.createTask({ title: 'Prepare Q4 budget review', dueDate: iso(10), priority: 'low', description: 'Q4 review' });
check('tasks created (pending by default)', t1.status === 'open' && t2.status === 'open' && t3.status === 'open');
check('invalid priority rejected', expectThrow(
  () => svc.createTask({ title: 'Bad priority task', priority: 'critical' }), /Priority/i));
check('short title rejected', expectThrow(() => svc.createTask({ title: 'ab', priority: 'low' }), /3-200|3–200/i));
check('bad due date rejected', expectThrow(
  () => svc.createTask({ title: 'Bad date task', priority: 'low', dueDate: '10/12/2026' }), /YYYY-MM-DD/i));
const t1e = svc.updateTask(t1.id, { title: 'Submit monthly report (amended)', priority: 'urgent', status: 'in_progress' });
check('task edit persisted (status + priority)', t1e.status === 'in_progress' && t1e.priority === 'urgent' && !!t1e.updated_at);
const t1d = svc.setTaskCompleted(t1.id, true);
check('task completed (status + completed_at set)', t1d.status === 'done' && !!t1d.completed_at);
check('double completion rejected', expectThrow(() => svc.setTaskCompleted(t1.id, true), /already completed/i));
const t1r = svc.setTaskCompleted(t1.id, false);
check('task reopened (completed_at cleared)', t1r.status === 'open' && !t1r.completed_at);
check('reopen of non-completed task rejected', expectThrow(() => svc.setTaskCompleted(t1.id, false), /Only completed/i));

console.log('\n== 2. Overdue / upcoming / due-today math (local dates) ==');
let st = svc.taskStats();
check('overdue count = 1 (t1 due 3 days ago, open)', st.overdue === 1);
check('due today = 1 (t2)', st.dueToday === 1);
check('upcoming = 1 (t3)', st.upcoming === 1);
check('pending = 3', st.pending === 3);
check('completed = 0 after reopen', st.completed === 0);
svc.setTaskCompleted(t2.id, true);
st = svc.taskStats();
check('completed = 1 after completing t2', st.completed === 1 && st.pending === 2);
check('listTasks overdue filter returns only t1', svc.listTasks({ due: 'overdue' }).every((x) => x.is_overdue === 1) && svc.listTasks({ due: 'overdue' }).some((x) => x.id === t1.id));
check('listTasks completed filter returns t2', svc.listTasks({ due: 'completed' }).some((x) => x.id === t2.id));
check('listTasks upcoming filter returns t3', svc.listTasks({ due: 'upcoming' }).some((x) => x.id === t3.id));
check('listTasks barangay filter isolates b1', svc.listTasks({ barangayId: b1.id }).every((x) => x.barangay_id === b1.id));
check('listTasks search finds amended title', svc.listTasks({ q: 'amended' }).some((x) => x.id === t1.id));
const tdel = svc.deleteTask(t3.id);
check('task delete ok + audit', tdel.ok === true && !svc.listTasks({}).some((x) => x.id === t3.id));

console.log('\n== 3. Audit records + read-only design ==');
const audit1 = svc.listAudit({});
const actions = new Set(audit1.rows.map((r) => r.action));
check('task create/update/complete/reopen/delete all audited',
  ['create', 'update', 'complete', 'reopen', 'delete'].every((a) => actions.has(a)));
check('barangay create audited', actions.has('create') && audit1.rows.some((r) => r.entity === 'barangay'));
check('audit rows include actor or legacy marker',
  audit1.rows.every((r) => r.actor === 'not recorded (legacy entry)' || typeof r.actor === 'string'));
check('audit filters work (action=delete)', svc.listAudit({ action: 'delete' }).rows.every((r) => r.action === 'delete'));
check('audit entity filter works', svc.listAudit({ entity: 'task' }).rows.every((r) => r.entity === 'task'));
check('no update/delete API exists for audit', typeof svc.updateAudit === 'undefined' && typeof svc.deleteAudit === 'undefined');
{
  // Deterministic pagination probe: 25 extra entries, page size 10.
  const before = svc.listAudit({ page: 1, pageSize: 10 }).total;
  for (let i = 0; i < 25; i++) svc.audit(null, 'probe_bulk', 'user', null, null, { i });
  const p1 = svc.listAudit({ page: 1, pageSize: 10 });
  const p2 = svc.listAudit({ page: 2, pageSize: 10 });
  check('audit pagination math (bulk-probed)', p1.rows.length === 10 && p2.rows.length === 10
    && p1.total === before + 25 && p2.total === before + 25
    && p1.rows[0].id !== p2.rows[0].id
    && p1.pages === Math.ceil((before + 25) / 10));
}
svc.audit(null, 'test_probe', 'user', null, null, { password: 'hunter2', name: 'ok' });
{
  const row = svc.db.prepare("SELECT details FROM audit_log WHERE entity='user' AND action='test_probe'").get();
  check('secret fields stripped from audit details', !!row && (!row.details || !row.details.includes('hunter2')));
}

console.log('\n== 4. Backup creation produces valid, restorable DB ==');
const seedCollection = svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-01', payer: 'Backup test payer',
  description: 'Record before backup', amount: '777.77', method: 'cash' });
const backupFile = path.join(dir, 'backup.sqlite');
const backupInfo = await br.createBackup(svc, backupFile); // online backup API
check('backup file exists and is non-empty', fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0);
check('backup reported size matches file', backupInfo.bytes === fs.statSync(backupFile).size);
check('backup audit recorded', svc.listAudit({ action: 'backup' }).rows.length >= 1);
const v = br.validateBackupFile(backupFile);
check('backup validates (integrity + required tables)', typeof v.schemaVersion === 'number');
check('settings last_backup_at updated', !!svc.getSettings().last_backup_at);

console.log('\n== 5. Corrupt / foreign files rejected safely ==');
const corrupt = path.join(dir, 'corrupt.sqlite');
fs.writeFileSync(corrupt, Buffer.from('this is not a database at all, just text padding padding padding', 'utf8'));
check('non-SQLite file rejected', expectThrow(() => br.validateBackupFile(corrupt), /not a valid database backup/i));
const foreign = path.join(dir, 'foreign.sqlite');
{ const Database = require('better-sqlite3'); const f = new Database(foreign); f.exec('CREATE TABLE x (a)'); f.close(); }
check('unrelated SQLite file rejected', expectThrow(() => br.validateBackupFile(foreign), /not a Barangay Treasury Hub backup/i));
const truncated = path.join(dir, 'truncated.sqlite');
{ const buf = fs.readFileSync(backupFile); fs.writeFileSync(truncated, buf.subarray(0, Math.floor(buf.length / 2))); }
check('truncated/corrupted backup rejected or flagged', (() => {
  try { br.validateBackupFile(truncated); return false; } catch (e) { return true; }
})());

console.log('\n== 6. Restore valid backup restores expected records ==');
// change data after backup, then restore to prove replacement
svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-02', payer: 'After-backup payer',
  description: 'Record after backup', amount: '100.00', method: 'cash' });
const countAfterChange = svc.listCollections({}).length;
check('data changed after backup (2 collections)', countAfterChange === 2);
const rr = await br.restoreBackup(svc, backupFile);
check('restore succeeded', rr.ok === true && typeof rr.schemaVersion === 'number');
check('restored DB has only the pre-backup collection (1)',
  svc.listCollections({}).length === 1 && svc.listCollections({})[0].id === seedCollection.id);
check('restored DB lacks the after-backup record', !svc.listCollections({}).some((c) => c.payer === 'After-backup payer'));
check('restored DB passes migrations/verification (barangays readable)', svc.listBarangays().length >= 1);
check('restore audit recorded', svc.listAudit({ action: 'restore' }).rows.length >= 1);
check('safety backup file kept on disk', fs.existsSync(rr.safetyBackup));

console.log('\n== 7. Failed restore preserves original data ==');
// Simulate: create a marker, attempt restore from a corrupt file
svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-03', payer: 'Pre-failed-restore',
  description: 'Marker record', amount: '55.00', method: 'cash' });
const before = svc.listCollections({}).map((c) => c.id);
let restoreErr = null;
try { await br.restoreBackup(svc, corrupt); } catch (e) { restoreErr = e; }
check('restore from corrupt file throws with clear message', !!restoreErr && /not a valid database backup/i.test(restoreErr.message));
check('original data intact after failed restore', JSON.stringify(svc.listCollections({}).map((c) => c.id)) === JSON.stringify(before));
check('database still usable after failed restore',
  !!svc.createCollection({ barangayId: b1.id, txnDate: '2026-10-04', payer: 'Post-failed-restore',
    description: 'Still works', amount: '5.00', method: 'cash' }).id);

console.log('\n== 8. Settings persistence + defaults ==');
svc.updateSettings({ org_name: 'Office of the Treasurer', default_fiscal_year: '2026', backup_reminder: 'weekly' });
const s1 = svc.getSettings();
check('settings saved', s1.org_name === 'Office of the Treasurer' && s1.backup_reminder === 'weekly');
check('invalid fiscal year rejected', expectThrow(
  () => svc.updateSettings({ default_fiscal_year: '1899' }), /2000 and 2100/i));
check('invalid reminder rejected', expectThrow(
  () => svc.updateSettings({ backup_reminder: 'daily' }), /off, weekly, or monthly/i));
check('nonexistent default barangay rejected', expectThrow(
  () => svc.updateSettings({ default_barangay_id: '99999' }), /does not exist/i));
const rs = svc.resetSettings();
check('restore defaults works', rs.org_name === '' && rs.backup_reminder === 'off' && rs.date_format === 'en-PH');

console.log('\n== 9. Restart persistence ==');
const snap = { tasks: svc.listTasks({}).length, settings: svc.getSettings(), audit: svc.listAudit({ pageSize: 10 }).total };
svc.close();
const svc2 = new DatabaseService();
svc2.init(dir);
check('tasks persist after restart', svc2.listTasks({}).length === snap.tasks);
check('settings persist after restart', JSON.stringify(svc2.getSettings()) === JSON.stringify(snap.settings));
check('audit persists after restart', svc2.listAudit({ pageSize: 10 }).total === snap.audit);
check('backup file still on disk after restart', fs.existsSync(backupFile));
const finOk = svc2.financialSummary({});
check('financial data intact after restart (Part 3 regression)', finOk.collections_c >= 77777);
svc2.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
