/**
 * backup-restore.js — safe SQLite backup & restore (Part 5).
 *
 * Backups use better-sqlite3's online backup API (db.backup), which handles
 * WAL journal mode and in-flight transactions safely — never a blind file
 * copy of a live database. Restore validates a temp copy first, takes a
 * safety backup of the current data, and rolls back on any failure so the
 * original database is never left partially replaced.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_TABLES = ['barangays', 'users', 'transactions', 'collections',
  'expenses', 'budgets', 'tasks', 'audit_log', 'settings', 'schema_migrations'];

/**
 * Create a consistent backup of the current database at targetPath.
 * Uses SQLite's online backup API. Audits the operation.
 */
async function createBackup(dbService, targetPath) {
  if (dbService._busy) throw new Error('A backup or restore operation is already in progress.');
  dbService._busy = true;
  try {
    await dbService.db.backup(targetPath);
    const stat = fs.statSync(targetPath);
    dbService.db.prepare(
      "INSERT INTO settings (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(new Date().toISOString());
    dbService.audit(null, 'backup', 'database', null, null,
      { file: path.basename(targetPath), bytes: stat.size });
    return { ok: true, path: targetPath, bytes: stat.size };
  } finally {
    dbService._busy = false;
  }
}

/**
 * Validate a candidate backup file WITHOUT touching the live database:
 * SQLite header, integrity_check, and required application tables.
 * Works on a temp copy so the original backup file is never modified.
 */
function validateBackupFile(file) {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (!header.toString('utf8').startsWith('SQLite format 3'))
    throw new Error('The selected file is not a valid database backup file.');
  const Database = require('better-sqlite3');
  const tmp = file + '.validate-' + Date.now();
  fs.copyFileSync(file, tmp);
  try {
    const db = new Database(tmp);
    try {
      const ic = db.pragma('integrity_check', { simple: true });
      if (ic !== 'ok') throw new Error('The backup file is corrupted (integrity check failed).');
      const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !names.has(t));
      if (missing.length)
        throw new Error('This file is not a Barangay Treasury Hub backup (missing tables: ' + missing.join(', ') + ').');
      return { schemaVersion: db.pragma('user_version', { simple: true }) };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Restore a validated backup. Order of operations:
 * 1. validate the backup file (temp copy)
 * 2. safety-backup the CURRENT database (kept on disk even on success)
 * 3. close the live connection, swap files, reopen, run migrations, verify
 * 4. on ANY failure: roll back to the safety backup and re-open it
 */
async function restoreBackup(dbService, backupFile) {
  if (dbService._busy) throw new Error('A backup or restore operation is already in progress.');
  const { schemaVersion } = validateBackupFile(backupFile);

  // Safety backup of current data (kept for manual recovery too).
  const safety = dbService.dbPath + '.pre-restore-' + Date.now() + '.bak';
  await dbService.db.backup(safety);

  dbService._busy = true;
  try {
    dbService.close();
    const oldFile = dbService.dbPath + '.old-' + Date.now();
    fs.renameSync(dbService.dbPath, oldFile);
    try {
      fs.copyFileSync(backupFile, dbService.dbPath);
      for (const sfx of ['-wal', '-shm']) fs.rmSync(dbService.dbPath + sfx, { force: true });
      dbService.init(dbService.userDataPath); // reopen + run pending migrations
      dbService.db.prepare('SELECT COUNT(*) AS n FROM barangays').get(); // verify readable
      fs.rmSync(oldFile, { force: true });
      dbService.audit(null, 'restore', 'database', null, null,
        { from: path.basename(backupFile), schemaVersion });
      return { ok: true, schemaVersion, safetyBackup: safety };
    } catch (err) {
      // Roll back: original data preserved, app left in a working state.
      try { dbService.close(); } catch { /* already closed */ }
      fs.rmSync(dbService.dbPath, { force: true });
      for (const sfx of ['-wal', '-shm']) fs.rmSync(dbService.dbPath + sfx, { force: true });
      fs.copyFileSync(safety, dbService.dbPath);
      dbService.init(dbService.userDataPath);
      dbService.db.prepare('SELECT COUNT(*) AS n FROM barangays').get();
      throw new Error('Restore failed — your original data was preserved. (' + err.message + ')');
    }
  } finally {
    dbService._busy = false;
  }
}

module.exports = { createBackup, restoreBackup, validateBackupFile, REQUIRED_TABLES };
