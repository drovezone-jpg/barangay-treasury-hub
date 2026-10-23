/**
 * pages5.js — Part 5 pages: Tasks and Deadlines, Audit Trail viewer,
 * Backup and Restore, Settings. Existing theme and preload bridge only.
 */
'use strict';

const PRIORITY_LABEL = { low: 'Low', normal: 'Medium', high: 'High', urgent: 'Urgent' };
const TASK_STATUS_LABEL = { open: 'Pending', in_progress: 'In Progress', done: 'Completed', cancelled: 'Cancelled' };
const ACTION_LABEL = { create: 'Created', update: 'Updated', delete: 'Deleted', cancel: 'Cancelled',
  complete: 'Completed', reopen: 'Reopened', archive: 'Archived', restore: 'Restored',
  login: 'Login', login_failed: 'Login failed', backup: 'Backup', export: 'Exported', seed: 'Seeded' };

function priorityBadge(p) {
  const tone = p === 'urgent' || p === 'high' ? 'red' : p === 'normal' ? 'amber' : 'gray';
  return badge(PRIORITY_LABEL[p] || p, tone);
}
function taskStatusBadge(s) {
  const tone = s === 'done' ? 'green' : s === 'cancelled' ? 'red' : 'amber';
  return badge(TASK_STATUS_LABEL[s] || s, tone);
}
function fmtDateTime(sqlite) {
  try { return new Date(sqlite.replace(' ', 'T') + 'Z').toLocaleString('en-PH'); } catch { return sqlite; }
}

/* ============================================================
   1. TASKS AND DEADLINES
   ============================================================ */
async function pageTasks() {
  return `
    <div class="card" id="task-stats-card"></div>
    <div class="card">
      <h2>Tasks and Deadlines</h2>
      <p class="card-sub">Overdue tasks are highlighted in red. All dates use this computer's local date — no internet needed.</p>
      <div class="form-row" id="task-filters" style="margin-bottom:12px">
        <label>Barangay<select id="task-brgy"><option value="">All barangays</option></select></label>
        <label>Status<select id="task-status">
          <option value="">All</option><option value="active">Pending + In Progress</option>
          <option value="open">Pending</option><option value="in_progress">In Progress</option>
          <option value="done">Completed</option></select></label>
        <label>Priority<select id="task-priority">
          <option value="">All</option><option value="low">Low</option>
          <option value="normal">Medium</option><option value="high">High</option></select></label>
        <label>Deadline<select id="task-due">
          <option value="">Any</option><option value="overdue">Overdue</option>
          <option value="today">Due today</option><option value="week">Next 7 days</option>
          <option value="upcoming">Upcoming</option><option value="completed">Completed</option></select></label>
        <label>Search<input type="search" id="task-q" placeholder="Title, description, remarks…" /></label>
      </div>
      <div class="table-wrap"><table id="task-table">
        <thead><tr><th>Task</th><th>Barangay</th><th>Due date</th><th>Priority</th><th>Status</th>
        <th>Created</th><th>Modified</th><th>Actions</th></tr></thead>
        <tbody><tr><td colspan="8" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2 id="task-form-title">Create Task</h2>
      <form id="form-task" data-id="">
        <div class="form-row">
          <label>Task title *<input name="title" required minlength="3" placeholder="e.g. Submit monthly report" /></label>
          <label>Barangay (optional)<select name="barangayId"></select></label>
          <label>Due date<input type="date" name="dueDate" /></label>
          <label>Priority *<select name="priority">
            <option value="low">Low</option><option value="normal" selected>Medium</option>
            <option value="high">High</option></select></label>
        </div>
        <div class="form-row">
          <label>Status<select name="status">
            <option value="open">Pending</option><option value="in_progress">In Progress</option>
            <option value="done">Completed</option></select></label>
          <label>Description<input name="description" placeholder="Optional details" /></label>
          <label>Remarks<input name="remarks" placeholder="Optional" /></label>
        </div>
        <button class="btn btn-primary" id="task-submit">Create task</button>
        <button type="button" class="btn btn-outline hidden" id="task-cancel">Cancel edit</button>
        <p class="form-ok" id="task-ok" hidden></p>
        <p class="form-error" id="task-err" hidden></p>
      </form>
    </div>`;
}

async function refreshTaskStats() {
  const s = await window.treasuryAPI.summary();
  const t = s.taskStats || { pending: 0, dueToday: 0, upcoming: 0, overdue: 0, completed: 0 };
  const card = $('#task-stats-card');
  if (!card) return;
  card.innerHTML = `
    <h2>Task Summary</h2>
    <div class="grid-3" style="margin-top:10px">
      <div><div class="stat-label">Pending tasks</div>
        <div class="stat-value">${t.pending}</div></div>
      <div><div class="stat-label">Due today</div>
        <div class="stat-value ${t.dueToday ? '' : 'muted'}">${t.dueToday}</div></div>
      <div><div class="stat-label">Upcoming deadlines</div>
        <div class="stat-value">${t.upcoming}</div></div>
      <div><div class="stat-label">Overdue</div>
        <div class="stat-value ${t.overdue ? 'stat-red' : 'muted'}">${t.overdue}</div></div>
      <div><div class="stat-label">Completed</div>
        <div class="stat-value stat-green">${t.completed}</div></div>
    </div>`;
}

async function refreshTaskTable(filters) {
  const rows = await window.treasuryAPI.taskList(filters || {});
  const tbody = $('#task-table tbody');
  tbody.innerHTML = rows.length ? rows.map((t) => `
    <tr ${t.is_overdue ? 'style="background:var(--red-soft)"' : ''}>
      <td>${esc(t.title)} ${t.is_sample ? sampleBadge() : ''}${t.is_overdue ? ' ' + badge('OVERDUE', 'red') : ''}</td>
      <td>${esc(t.barangay_name || '—')}</td>
      <td>${esc(t.due_date || '—')}</td>
      <td>${priorityBadge(t.priority)}</td>
      <td>${taskStatusBadge(t.status)}</td>
      <td class="muted">${esc((t.created_at || '').slice(0, 10))}</td>
      <td class="muted">${esc((t.updated_at || t.created_at || '').slice(0, 10))}</td>
      <td>
        <button class="btn btn-outline" data-task-edit="${t.id}">Edit</button>
        ${t.status === 'done'
          ? `<button class="btn btn-outline" data-task-reopen="${t.id}">Reopen</button>`
          : `<button class="btn btn-outline" data-task-done="${t.id}">Complete</button>`}
        <button class="btn btn-danger" data-task-del="${t.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted">No tasks found for this filter.</td></tr>';

  const refresh = () => { refreshTaskTable(readTaskFilters()); refreshTaskStats(); };
  tbody.querySelectorAll('[data-task-edit]').forEach((b) =>
    b.addEventListener('click', () => loadTaskForEdit(Number(b.dataset.taskEdit))));
  tbody.querySelectorAll('[data-task-done]').forEach((b) =>
    b.addEventListener('click', () => window.treasuryAPI.taskComplete(Number(b.dataset.taskDone), true).then(refresh).catch((e) => alert(e.message))));
  tbody.querySelectorAll('[data-task-reopen]').forEach((b) =>
    b.addEventListener('click', () => window.treasuryAPI.taskComplete(Number(b.dataset.taskReopen), false).then(refresh).catch((e) => alert(e.message))));
  tbody.querySelectorAll('[data-task-del]').forEach((b) =>
    b.addEventListener('click', () => deleteWithConfirm(
      () => window.treasuryAPI.taskDelete(Number(b.dataset.taskDel)),
      'Delete this task? The deletion is recorded in the audit trail.',
      refresh)));
}

function readTaskFilters() {
  return {
    barangayId: $('#task-brgy').value || undefined,
    status: $('#task-status').value || undefined,
    priority: $('#task-priority').value || undefined,
    due: $('#task-due').value || undefined,
    q: $('#task-q').value.trim() || undefined,
  };
}

async function loadTaskForEdit(id) {
  try {
    const rows = await window.treasuryAPI.taskList({});
    const task = rows.find((r) => r.id === id);
    if (!task) throw new Error('Task not found.');
    const f = $('#form-task');
    f.dataset.id = task.id;
    f.elements.title.value = task.title;
    f.elements.barangayId.value = task.barangay_id || '';
    f.elements.dueDate.value = task.due_date || '';
    f.elements.priority.value = task.priority;
    f.elements.status.value = task.status;
    f.elements.description.value = task.description || '';
    f.elements.remarks.value = task.notes || '';
    $('#task-form-title').textContent = 'Edit Task';
    $('#task-submit').textContent = 'Save changes';
    $('#task-cancel').classList.remove('hidden');
    f.scrollIntoView({ behavior: 'smooth' });
  } catch (err) { alert(err.message); }
}

async function postRenderTasks() {
  const brgys = await window.treasuryAPI.listB();
  const f = $('#form-task');
  for (const b of brgys) f.elements.barangayId.appendChild(new Option(b.name, b.id));

  $('#task-filters').addEventListener('input', () => refreshTaskTable(readTaskFilters()));

  const okMsg = $('#task-ok'), errMsg = $('#task-err'), submit = $('#task-submit');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    if (submit.disabled) return;
    const fd = new FormData(f);
    submit.disabled = true; submit.textContent = 'Saving…';
    try {
      const payload = {
        title: fd.get('title'), barangayId: fd.get('barangayId') || null,
        dueDate: fd.get('dueDate') || null, priority: fd.get('priority'),
        status: fd.get('status'), description: fd.get('description'), remarks: fd.get('remarks'),
      };
      const id = f.dataset.id;
      if (id) { await window.treasuryAPI.taskUpdate(Number(id), payload); okMsg.textContent = 'Task updated.'; }
      else { await window.treasuryAPI.taskCreate(payload); okMsg.textContent = 'Task created.'; }
      okMsg.hidden = false;
      f.reset(); f.dataset.id = '';
      $('#task-form-title').textContent = 'Create Task';
      $('#task-submit').textContent = 'Create task';
      $('#task-cancel').classList.add('hidden');
      await Promise.all([refreshTaskTable(readTaskFilters()), refreshTaskStats()]);
    } catch (err) {
      errMsg.textContent = err.message; errMsg.hidden = false;
    } finally {
      submit.disabled = false; submit.textContent = f.dataset.id ? 'Save changes' : 'Create task';
    }
  });
  $('#task-cancel').addEventListener('click', () => {
    f.reset(); f.dataset.id = '';
    $('#task-form-title').textContent = 'Create Task';
    $('#task-submit').textContent = 'Create task';
    $('#task-cancel').classList.add('hidden');
  });
  await Promise.all([refreshTaskTable({}), refreshTaskStats()]);
}

/* ============================================================
   2. AUDIT TRAIL VIEWER (read-only)
   ============================================================ */
async function pageAudit() {
  return `
    <div class="card">
      <h2>Audit Trail</h2>
      <p class="card-sub">Read-only record of application activities. Entries cannot be edited or deleted from this interface.
      Older entries (pre-Part 5) may show "not recorded" for the responsible account — such history cannot be reconstructed.</p>
      <div class="form-row" id="audit-filters" style="margin-bottom:12px">
        <label>Action<select id="audit-action"><option value="">All actions</option>
          ${Object.entries(ACTION_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select></label>
        <label>Module<select id="audit-entity"><option value="">All modules</option>
          <option value="barangay">Barangays</option><option value="collection">Collections</option>
          <option value="receipt">Receipts</option><option value="expense">Expenses</option>
          <option value="budget">Budgets</option><option value="task">Tasks</option>
          <option value="user">Users / login</option><option value="settings">Settings</option>
          <option value="database">Backup / restore</option><option value="report">Reports</option>
        </select></label>
        <label>Barangay<select id="audit-brgy"><option value="">All barangays</option></select></label>
        <label>From date<input type="date" id="audit-from" /></label>
        <label>To date<input type="date" id="audit-to" /></label>
        <label>Search<input type="search" id="audit-q" placeholder="Details, username…" /></label>
      </div>
      <div class="table-wrap"><table id="audit-table">
        <thead><tr><th>Date &amp; time</th><th>Account</th><th>Action</th><th>Module</th>
        <th>Record</th><th>Barangay</th><th>Details</th></tr></thead>
        <tbody><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
      </table></div>
      <p class="card-sub" id="audit-paging" style="margin-top:10px"></p>
    </div>`;
}

async function refreshAuditTable(page = 1) {
  const filters = {
    action: $('#audit-action').value || undefined,
    entity: $('#audit-entity').value || undefined,
    barangayId: $('#audit-brgy').value || undefined,
    from: $('#audit-from').value || undefined,
    to: $('#audit-to').value || undefined,
    q: $('#audit-q').value.trim() || undefined,
    page, pageSize: 50,
  };
  const res = await window.treasuryAPI.auditView(filters);
  const tbody = $('#audit-table tbody');
  tbody.innerHTML = res.rows.length ? res.rows.map((a) => `
    <tr>
      <td class="muted">${esc(fmtDateTime(a.created_at))}</td>
      <td>${esc(a.actor)}</td>
      <td>${badge(ACTION_LABEL[a.action] || a.action, a.action === 'login_failed' || a.action === 'delete' ? 'red' : 'green')}</td>
      <td>${esc(a.entity)}</td>
      <td>${a.entity_id ? esc(`${a.entity} #${a.entity_id}`) : '—'}</td>
      <td>${esc(a.barangay_name || '—')}</td>
      <td class="muted">${esc(a.details ? a.details.slice(0, 120) : '—')}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">No audit entries found for this filter.</td></tr>';
  $('#audit-paging').innerHTML = `
    ${res.total} entr${res.total === 1 ? 'y' : 'ies'} · page ${res.page} of ${res.pages}
    ${res.page > 1 ? '<button class="btn btn-outline" id="audit-prev">← Previous</button>' : ''}
    ${res.page < res.pages ? '<button class="btn btn-outline" id="audit-next">Next →</button>' : ''}`;
  $('#audit-prev')?.addEventListener('click', () => refreshAuditTable(res.page - 1));
  $('#audit-next')?.addEventListener('click', () => refreshAuditTable(res.page + 1));
}

async function postRenderAudit() {
  const brgys = await window.treasuryAPI.listB({ includeArchived: true });
  for (const b of brgys) $('#audit-brgy').appendChild(new Option(b.name, b.id));
  $('#audit-filters').addEventListener('input', () => refreshAuditTable(1));
  await refreshAuditTable(1);
}

/* ============================================================
   3. BACKUP AND RESTORE
   ============================================================ */
async function pageBackup() {
  return `
    <div class="card">
      <h2>Database Backup</h2>
      <p class="card-sub">Backups are consistent SQLite copies (.sqlite) created with the database's built-in backup API — safe even while the app is in use.
      The backup contains all records, including login data and audit history.</p>
      <div class="grid-2">
        <div>
          <p><strong>Last backup:</strong> <span id="bk-last" class="muted">…</span></p>
          <button class="btn btn-primary" id="bk-save">Create backup…</button>
        </div>
      </div>
      <p class="form-ok" id="bk-ok" hidden></p>
      <p class="form-error" id="bk-err" hidden></p>
    </div>
    <div class="card">
      <h2>Restore from Backup</h2>
      <p class="card-sub"><span class="badge badge-red">WARNING</span> Restoring replaces <strong>all current data</strong> with the selected backup.
      A safety backup of the current data is created automatically first. Corrupted or unrelated files are rejected.</p>
      <button class="btn btn-danger" id="bk-restore">Restore from backup file…</button>
      <p class="form-ok" id="rs-ok" hidden></p>
      <p class="form-error" id="rs-err" hidden></p>
    </div>`;
}

async function postRenderBackup() {
  const st = await window.treasuryAPI.backupStatus();
  $('#bk-last').textContent = st.lastBackupAt ? fmtDateTime(st.lastBackupAt.replace('Z', '')) : 'No backup created yet.';
  $('#bk-save').addEventListener('click', async () => {
    const ok = $('#bk-ok'), err = $('#bk-err');
    ok.hidden = err.hidden = true;
    try {
      const r = await window.treasuryAPI.backupSave();
      if (r.canceled) return;
      ok.textContent = `Backup saved: ${r.path} (${(r.bytes / 1024).toFixed(1)} KB).`;
      ok.hidden = false;
      $('#bk-last').textContent = fmtDateTime(new Date().toISOString().replace('Z', ''));
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  $('#bk-restore').addEventListener('click', async () => {
    const ok = $('#rs-ok'), err = $('#rs-err');
    ok.hidden = err.hidden = true;
    try {
      const r = await window.treasuryAPI.backupRestore();
      if (r.canceled) return;
      ok.textContent = `Restore complete (schema v${r.schemaVersion}). The application data has been replaced. Safety backup kept at: ${r.safetyBackup}`;
      ok.hidden = false;
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}

/* ============================================================
   4. SETTINGS
   ============================================================ */
async function pageSettings() {
  const s = await window.treasuryAPI.getSettings();
  const brgys = await window.treasuryAPI.listB();
  return `
    <div class="card">
      <h2>Application Settings</h2>
      <p class="card-sub">Display and workflow preferences. Changing these never alters historical financial values.
      Footer text is your own label — it is not an official government certification.</p>
      <form id="form-settings">
        <div class="form-row">
          <label>Organization / office name<input name="org_name" value="${esc(s.org_name)}" placeholder="e.g. Office of the Barangay Treasurer" /></label>
          <label>Default barangay<select name="default_barangay_id">
            <option value="">None</option>
            ${brgys.map((b) => `<option value="${b.id}" ${String(b.id) === s.default_barangay_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          </select></label>
          <label>Default fiscal year<input name="default_fiscal_year" value="${esc(s.default_fiscal_year)}" placeholder="e.g. 2026" /></label>
          <label>Date format<select name="date_format">
            <option value="en-PH" ${s.date_format === 'en-PH' ? 'selected' : ''}>Philippine (e.g. October 23, 2026)</option>
            <option value="ISO" ${s.date_format === 'ISO' ? 'selected' : ''}>ISO (2026-10-23)</option>
          </select></label>
        </div>
        <div class="form-row">
          <label>Backup reminder<select name="backup_reminder">
            <option value="off" ${s.backup_reminder === 'off' ? 'selected' : ''}>Off</option>
            <option value="weekly" ${s.backup_reminder === 'weekly' ? 'selected' : ''}>Weekly</option>
            <option value="monthly" ${s.backup_reminder === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select></label>
        </div>
        <label>Report / receipt footer<textarea name="report_footer" rows="2">${esc(s.report_footer)}</textarea></label>
        <button class="btn btn-primary" id="set-save">Save settings</button>
        <button type="button" class="btn btn-outline" id="set-cancel">Cancel</button>
        <button type="button" class="btn btn-danger" id="set-reset">Restore defaults</button>
        <p class="form-ok" id="set-ok" hidden></p>
        <p class="form-error" id="set-err" hidden></p>
      </form>
    </div>
    <div class="card">
      <h2>Application Information</h2>
      <div class="table-wrap"><table>
        <tr><th>Application</th><td>Barangay Treasury Hub — Multi-Barangay Financial Management System</td></tr>
        <tr><th>Version</th><td>${esc((await window.treasuryAPI.info()).version)}</td></tr>
        <tr><th>Storage</th><td>Local SQLite database (offline)</td></tr>
        <tr><th>Reports</th><td>Management-information outputs only — not officially certified government financial statements.</td></tr>
      </table></div>
    </div>`;
}

async function postRenderSettings() {
  const f = $('#form-settings');
  const okMsg = $('#set-ok'), errMsg = $('#set-err');
  const original = Object.fromEntries(new FormData(f).entries());
  $('#set-save').addEventListener('click', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    try {
      const fd = new FormData(f);
      await window.treasuryAPI.updateSettings({
        org_name: fd.get('org_name'), default_barangay_id: fd.get('default_barangay_id'),
        default_fiscal_year: fd.get('default_fiscal_year'), date_format: fd.get('date_format'),
        report_footer: fd.get('report_footer'), backup_reminder: fd.get('backup_reminder'),
      });
      okMsg.textContent = 'Settings saved.'; okMsg.hidden = false;
    } catch (err) { errMsg.textContent = err.message; errMsg.hidden = false; }
  });
  $('#set-cancel').addEventListener('click', () => {
    for (const [k, v] of Object.entries(original)) f.elements[k].value = v;
    okMsg.hidden = errMsg.hidden = true;
  });
  $('#set-reset').addEventListener('click', async () => {
    if (!window.confirm('Restore all settings to their defaults?')) return;
    try {
      await window.treasuryAPI.resetSettings();
      okMsg.textContent = 'Settings restored to defaults.'; okMsg.hidden = false;
      renderRoute('settings');
    } catch (err) { errMsg.textContent = err.message; errMsg.hidden = false; }
  });
}
