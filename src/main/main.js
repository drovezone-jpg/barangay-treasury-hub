/**
 * main.js — Electron main process for Barangay Treasury Hub.
 *
 * SECURITY POSTURE
 * - contextIsolation: true, nodeIntegration: false, sandbox: true for the renderer.
 * - A restricted preload API (contextBridge) is the ONLY bridge to SQLite.
 * - All IPC channels are whitelisted in preload.js; handlers live here.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { DatabaseService } = require('./database');
const { registerInitialUser, loginUser, hasAnyUser } = require('./auth');
const seed = require('./seed-data');
const br = require('./backup-restore');

const dbService = new DatabaseService();
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#F3F4F6',
    title: 'Barangay Treasury Hub',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,   // renderer cannot reach Node directly
      nodeIntegration: false,   // no require() in the renderer
      sandbox: true,            // renderer runs in a Chromium sandbox
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Block unexpected navigation / new windows (offline app).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url); // only for explicit external links
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

/* ------------------------------------------------------------------ */
/* IPC API — every handler validates inputs and uses prepared          */
/* statements inside DatabaseService. No raw SQL crosses IPC.          */
/* ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('app:getInfo', () => ({
    appName: 'Barangay Treasury Hub',
    version: app.getVersion(),
    dbPath: dbService.dbPath,
    currentDate: new Date().toISOString().slice(0, 10),
  }));

  ipcMain.handle('auth:status', () => ({ hasUser: hasAnyUser(dbService.db) }));

  // First-run setup ONLY. auth.js rejects any further registration once an
  // account exists; passwords are scrypt-hashed with a random salt.
  ipcMain.handle('auth:register', (_e, payload) => {
    const user = registerInitialUser(dbService.db, payload || {});
    dbService.audit(user.id, 'create', 'user', user.id, null, { username: user.username });
    return { ok: true, displayName: user.displayName };
  });

  ipcMain.handle('auth:login', (_e, payload) => {
    try {
      const user = loginUser(dbService.db, payload || {});
      dbService.sessionUserId = user.id;
      dbService.audit(user.id, 'login', 'user', user.id, null, null);
      return { ok: true, displayName: user.displayName };
    } catch (err) {
      dbService.audit(null, 'login_failed', 'user', null, null,
        { username: String(payload?.username || '').slice(0, 60) });
      throw err;
    }
  });

  ipcMain.handle('barangay:list', (_e, opts) => dbService.listBarangays(opts || {}));
  ipcMain.handle('barangay:add', (_e, payload) => dbService.addBarangay(payload || {}));
  ipcMain.handle('barangay:get', (_e, id) => dbService.getBarangay(id));
  ipcMain.handle('barangay:update', (_e, id, payload) => dbService.updateBarangay(id, payload || {}));
  ipcMain.handle('barangay:archive', (_e, id, archived) => dbService.setBarangayArchived(id, archived));
  ipcMain.handle('barangay:workspace', (_e, id) => dbService.barangayWorkspace(id));

  ipcMain.handle('txn:list', (_e, filter) => dbService.listTransactions(filter || {}));
  ipcMain.handle('txn:create', (_e, payload) => dbService.createTransaction(payload || {}));

  // Part 3 — categories, collections, expenses, receipts, financial summary
  ipcMain.handle('cat:list', (_e, kind) => dbService.listCategories(kind));

  ipcMain.handle('col:list', (_e, f) => dbService.listCollections(f || {}));
  ipcMain.handle('col:get', (_e, id) => dbService.getCollection(id));
  ipcMain.handle('col:create', (_e, p) => dbService.createCollection(p || {}));
  ipcMain.handle('col:update', (_e, id, p) => dbService.updateCollection(id, p || {}));
  ipcMain.handle('col:delete', (_e, id) => dbService.deleteCollection(id));

  ipcMain.handle('exp:list', (_e, f) => dbService.listExpenses(f || {}));
  ipcMain.handle('exp:get', (_e, id) => dbService.getExpense(id));
  ipcMain.handle('exp:create', (_e, p) => dbService.createExpense(p || {}));
  ipcMain.handle('exp:update', (_e, id, p) => dbService.updateExpense(id, p || {}));
  ipcMain.handle('exp:delete', (_e, id) => dbService.deleteExpense(id));

  ipcMain.handle('rcpt:list', (_e, f) => dbService.listReceipts(f || {}));
  ipcMain.handle('rcpt:create', (_e, p) => dbService.createReceipt(p || {}));
  ipcMain.handle('rcpt:cancel', (_e, id) => dbService.cancelReceipt(id));

  ipcMain.handle('fin:summary', (_e, f) => dbService.financialSummary(f || {}));

  // Part 4 — budgets, utilization, report data
  ipcMain.handle('bud:list', (_e, f) => dbService.listBudgets(f || {}));
  ipcMain.handle('bud:get', (_e, id) => dbService.getBudget(id));
  ipcMain.handle('bud:create', (_e, p) => dbService.createBudget(p || {}));
  ipcMain.handle('bud:update', (_e, id, p) => dbService.updateBudget(id, p || {}));
  ipcMain.handle('bud:delete', (_e, id) => dbService.deleteBudget(id));
  ipcMain.handle('bud:totals', (_e, f) => dbService.budgetTotals(f || {}));
  ipcMain.handle('bud:utilization', (_e, f) => dbService.budgetUtilization(f || {}));
  ipcMain.handle('fin:trends', (_e, f) => dbService.monthlyTrends(f || {}));

  // Part 5 — tasks, audit viewer, settings, backup/restore
  ipcMain.handle('task:list', (_e, f) => dbService.listTasks(f || {}));
  ipcMain.handle('task:create', (_e, p) => dbService.createTask(p || {}));
  ipcMain.handle('task:update', (_e, id, p) => dbService.updateTask(id, p || {}));
  ipcMain.handle('task:complete', (_e, id, done) => dbService.setTaskCompleted(id, done));
  ipcMain.handle('task:delete', (_e, id) => dbService.deleteTask(id));
  ipcMain.handle('audit:view', (_e, f) => dbService.listAudit(f || {}));
  ipcMain.handle('settings:get', () => dbService.getSettings());
  ipcMain.handle('settings:update', (_e, p) => dbService.updateSettings(p || {}));
  ipcMain.handle('settings:reset', () => dbService.resetSettings());
  ipcMain.handle('backup:status', () => ({
    lastBackupAt: dbService.getSettings().last_backup_at,
    settings: dbService.getSettings(),
  }));

  // Backup: save path chosen via Electron's native dialog (main process).
  // Never overwrites an existing file without a hard error.
  ipcMain.handle('backup:save', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save database backup',
      defaultPath: 'barangay-treasury-hub-backup-' + new Date().toISOString().slice(0, 10) + '.sqlite',
      filters: [{ name: 'Barangay Treasury Hub backup (SQLite)', extensions: ['sqlite'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    if (fs.existsSync(filePath))
      throw new Error('A file with that name already exists. Choose a different name or delete the old backup first.');
    return br.createBackup(dbService, filePath);
  });

  // Restore: file chosen via dialog; explicit in-dialog confirmation;
  // validation + safety backup handled inside backup-restore.js.
  ipcMain.handle('backup:restore', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a backup file to restore',
      properties: ['openFile'],
      filters: [{ name: 'Barangay Treasury Hub backup (SQLite)', extensions: ['sqlite', 'db', 'bak'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, canceled: true };
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Restore backup'],
      defaultId: 0,
      title: 'Confirm restore',
      message: 'Restoring will REPLACE all current application data with the selected backup.',
      detail: 'A safety backup of the current data is created first. The application will reload after restoring.',
    });
    if (r.response !== 1) return { ok: false, canceled: true };
    const result = await br.restoreBackup(dbService, filePaths[0]);
    dbService.sessionUserId = null; // credentials must be re-verified against restored data
    return result;
  });

  // Report export/print audit (renderer can only trigger, not author entries:
  // action and entity are fixed here; only a short label is taken).
  ipcMain.handle('audit:reportExport', (_e, type) => {
    dbService.audit(null, 'export', 'report', null, null, { report: String(type || '').slice(0, 60) });
    return { ok: true };
  });

  ipcMain.handle('dashboard:summary', () => dbService.dashboardSummary());
  ipcMain.handle('audit:list', (_e, limit) => dbService.getAuditLog(limit));
  ipcMain.handle('data:safeList', (_e, table, opts) => dbService.safeList(table, opts || {}));
  ipcMain.handle('seed:loadSample', () => seed.loadSampleData(dbService));
}

app.whenReady().then(() => {
  let initInfo;
  try {
    initInfo = dbService.init(app.getPath('userData'));
  } catch (err) {
    // Corrupt or incompatible database: surface a clear error, never delete
    // or reset the user's data at startup.
    dialog.showErrorBox('Database error',
      'The application database could not be opened.\n\n' + err.message +
      '\n\nYour database file was NOT modified. It is located at:\n' +
      (dbService.dbPath || path.join(app.getPath('userData'), 'barangay-treasury-hub.db')) +
      '\n\nRestore a backup over this file, or move it aside to start fresh. The application will now exit.');
    app.exit(1);
    return;
  }
  console.log('[db] ready:', initInfo.dbPath, 'schema v' + initInfo.schemaVersion);
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  dbService.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => dbService.close());
