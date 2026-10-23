/**
 * preload.js — the ONLY bridge between the sandboxed renderer and Node.
 * Exposes a narrow, explicitly whitelisted API on window.treasuryAPI.
 * No raw SQL, no fs, no ipcRenderer leak to the renderer.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// channel -> renderer method name (explicit map, no dynamic guessing)
const CHANNELS = {
  'app:getInfo': 'info',
  'auth:status': 'status',
  'auth:register': 'register',
  'auth:login': 'login',
  'barangay:list': 'listB',
  'barangay:add': 'addB',
  'barangay:get': 'getB',
  'barangay:update': 'updateB',
  'barangay:archive': 'archiveB',
  'barangay:workspace': 'workspace',
  'txn:list': 'list',
  'txn:create': 'create',
  'dashboard:summary': 'summary',
  'audit:list': 'auditLog',
  'seed:loadSample': 'loadSample',
  'data:safeList': 'safeList',
  'cat:list': 'cats',
  'col:list': 'colList',
  'col:get': 'colGet',
  'col:create': 'colCreate',
  'col:update': 'colUpdate',
  'col:delete': 'colDelete',
  'exp:list': 'expList',
  'exp:get': 'expGet',
  'exp:create': 'expCreate',
  'exp:update': 'expUpdate',
  'exp:delete': 'expDelete',
  'rcpt:list': 'rcptList',
  'rcpt:create': 'rcptCreate',
  'rcpt:cancel': 'rcptCancel',
  'fin:summary': 'finSummary',
  'bud:list': 'budList',
  'bud:get': 'budGet',
  'bud:create': 'budCreate',
  'bud:update': 'budUpdate',
  'bud:delete': 'budDelete',
  'bud:totals': 'budTotals',
  'bud:utilization': 'budUtil',
  'fin:trends': 'trends',
  'task:list': 'taskList',
  'task:create': 'taskCreate',
  'task:update': 'taskUpdate',
  'task:complete': 'taskComplete',
  'task:delete': 'taskDelete',
  'audit:view': 'auditView',
  'settings:get': 'getSettings',
  'settings:update': 'updateSettings',
  'settings:reset': 'resetSettings',
  'backup:status': 'backupStatus',
  'backup:save': 'backupSave',
  'backup:restore': 'backupRestore',
  'audit:reportExport': 'reportExport',
};

const api = {};
for (const [ch, method] of Object.entries(CHANNELS)) {
  api[method] = (...args) => ipcRenderer.invoke(ch, ...args);
}

contextBridge.exposeInMainWorld('treasuryAPI', api);
