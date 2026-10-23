/**
 * pages.js — page renderers for the navigation modules.
 * Part 2: functional Dashboard (DB-driven, sample data separated) and
 * Barangay Management (add / view / edit / archive / search) + per-barangay
 * financial workspace. Other modules keep their foundation shells.
 */
'use strict';

const NAV_ITEMS = [
  ['dashboard', 'Dashboard'],
  ['barangays', 'Barangay Management'],
  ['transactions', 'Transactions'],
  ['collections', 'Collections and Receipts'],
  ['expenses', 'Expenses'],
  ['budgets', 'Budget Monitoring'],
  ['reports', 'Reports'],
  ['tasks', 'Tasks and Deadlines'],
  ['audit', 'Audit Trail'],
  ['backup', 'Backup and Restore'],
  ['settings', 'Settings'],
];

/* ================= DASHBOARD ================= */
async function pageDashboard() {
  const [s, txns] = await Promise.all([
    window.treasuryAPI.summary(),
    window.treasuryAPI.list({ limit: 8 }),
  ]);
  window.__dashSummary = s; // cached for post-render chart

  const tot = s.real, samp = s.sample;
  const statCards = `
    <div class="grid-3">
      <div class="card"><div class="stat-label">Configured barangays</div>
        <div class="stat-value">${s.barangayCount}</div>
        <div class="stat-label">System supports 2–5</div></div>
      <div class="card"><div class="stat-label">Total collections (actual)</div>
        <div class="stat-value stat-green">${fmtMoney(tot.collections_c)}</div>
        <div class="stat-label">${tot.count} recorded transaction${tot.count === 1 ? '' : 's'}</div></div>
      <div class="card"><div class="stat-label">Total expenses (actual)</div>
        <div class="stat-value stat-red">${fmtMoney(tot.expenses_c)}</div>
        <div class="stat-label">Net: ${fmtMoney(tot.collections_c - tot.expenses_c)}</div></div>
    </div>`;

  const hasReal = tot.count > 0 || samp.count > 0;
  const rows = s.perBarangay.map((p) => `
    <tr>
      <td><a href="#" class="brgy-link" data-id="${p.barangayId}">${esc(p.name)}</a>
          ${p.isSampleBarangay ? sampleBadge() : ''}</td>
      <td class="stat-green">${fmtMoney(p.real.collections_c)}</td>
      <td class="stat-red">${fmtMoney(p.real.expenses_c)}</td>
      <td>${fmtMoney(p.real.balance_c)}
        ${samp.count ? `<span class="muted">(+${fmtMoney(p.sample.balance_c)} sample)</span>` : ''}</td>
      <td>${p.real.count}</td>
    </tr>`).join('');

  const sampleNote = samp.count
    ? `<p class="card-sub"><span class="badge badge-amber">SAMPLE DATA MODE</span>
       ${samp.count} sample transaction(s) exist. Sample figures are shown separately and are
       <strong>excluded from all actual totals above</strong>.</p>`
    : '';

  const taskRows = s.pendingTasks.map((t) => `
    <tr><td>${esc(t.title)}</td><td>${esc(t.due_date || '—')}</td>
    <td>${badge(t.priority, t.priority === 'urgent' || t.priority === 'high' ? 'red' : 'gray')}</td></tr>`).join('');

  const txnRows = txns.map((t) => `
    <tr>
      <td>${esc(t.txn_date)}</td>
      <td>${esc(t.barangay_name)}</td>
      <td>${txnBadge(t.kind)}</td>
      <td>${esc(t.description)} ${t.is_sample ? sampleBadge() : ''}</td>
      <td class="${t.kind === 'collection' ? 'stat-green' : 'stat-red'}">${fmtMoney(t.amount_c)}</td>
      <td>${statusBadge(t.status)}</td>
    </tr>`).join('');

  return `
    ${statCards}
    <div class="card">
      <h2>Collections vs Expenses by Barangay</h2>
      <p class="card-sub">Actual (non-sample) posted totals only, computed from the database.</p>
      <div class="chart-box"><canvas id="dash-chart"></canvas></div>
    </div>
    <div class="card">
      <h2>Per-Barangay Balances</h2>
      <p class="card-sub">Balance = opening balance + collections − expenses (actual records).</p>
      ${sampleNote}
      <div class="table-wrap"><table>
        <thead><tr><th>Barangay</th><th>Collections</th><th>Expenses</th><th>Balance</th><th>Records</th></tr></thead>
        <tbody>${hasReal || s.perBarangay.length ? rows : '<tr><td colspan="5" class="muted">No barangays configured yet — go to Barangay Management.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Recent Transactions</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Barangay</th><th>Type</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>${txnRows || '<tr><td colspan="6" class="muted">No transactions yet.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h2>Pending Tasks</h2>
        <p class="card-sub">${s.openTasks} open task${s.openTasks === 1 ? '' : 's'}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Task</th><th>Due</th><th>Priority</th></tr></thead>
          <tbody>${taskRows || '<tr><td colspan="3" class="muted">No pending tasks.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>
    <div class="card">
      <h2>Report Disclaimer</h2>
      <p class="card-sub">Figures shown are management-information outputs of this application only. They are <strong>not</strong>
      certified as compliant with official government accounting rules (e.g., COA regulations) and must be validated by the proper authorities before any official use.</p>
    </div>`;
}

async function postRenderDashboard() {
  const canvas = $('#dash-chart');
  const s = window.__dashSummary;
  if (!canvas || typeof Chart === 'undefined' || !s) return;
  const nonSample = s.perBarangay.filter((p) => !p.isSampleBarangay);
  const shown = nonSample.length ? nonSample : s.perBarangay;
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: shown.map((p) => p.name.replace(' (SAMPLE)', '')),
      datasets: [
        { label: 'Collections (₱)', data: shown.map((p) => (p.real.collections_c + (shown === s.perBarangay ? p.sample.collections_c : 0)) / 100), backgroundColor: '#2E7D32' },
        { label: 'Expenses (₱)', data: shown.map((p) => (p.real.expenses_c + (shown === s.perBarangay ? p.sample.expenses_c : 0)) / 100), backgroundColor: '#C9A227' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: (v) => '₱' + Number(v).toLocaleString() } } },
    },
  });
  // Barangay name links open the workspace
  document.querySelectorAll('.brgy-link').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); openBarangayWorkspace(a.dataset.id); }));
}

/* ================= BARANGAY MANAGEMENT ================= */
async function pageBarangays() {
  const brgys = await window.treasuryAPI.listB({ includeArchived: true });
  window.__brgys = brgys;
  const rows = brgys.map((b) => `
    <tr data-name="${esc(b.name.toLowerCase())}">
      <td>${esc(b.name)} ${b.is_sample ? sampleBadge() : ''}</td>
      <td>${esc(b.municipality)}</td>
      <td>${esc(b.province)}</td>
      <td>${b.archived ? badge('Archived', 'amber') : badge('Active', 'green')}</td>
      <td>
        <button class="btn btn-outline" data-view="${b.id}">View / Edit</button>
        ${b.archived
          ? `<button class="btn btn-outline" data-restore="${b.id}">Restore</button>`
          : `<button class="btn btn-danger" data-archive="${b.id}">Archive</button>`}
      </td>
    </tr>`).join('');

  return `
    <div class="card">
      <h2>Barangay Management</h2>
      <p class="card-sub">${brgys.filter((b) => !b.archived).length} active of a supported 2–5.
      Archiving keeps all financial history; records stay separate per barangay.</p>
      <input type="search" id="brgy-search" placeholder="Search barangay…" style="max-width:320px" />
      <div class="table-wrap" style="margin-top:12px"><table id="brgy-table">
        <thead><tr><th>Barangay</th><th>Municipality</th><th>Province</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No barangays yet. Add at least 2 below.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card" id="brgy-form-card">
      <h2 id="brgy-form-title">Add Barangay</h2>
      <p class="card-sub">Required: barangay name. Opening balance may be negative (e.g., -250.50).</p>
      <form id="form-barangay" data-id="">
        <div class="form-row">
          <label>Barangay name *<input name="name" required placeholder="e.g. San Isidro" /></label>
          <label>Municipality<input name="municipality" /></label>
          <label>Province<input name="province" /></label>
          <label>Opening balance (₱)<input name="openingBalance" placeholder="0.00" /></label>
        </div>
        <button class="btn btn-primary" id="brgy-submit">Add barangay</button>
        <button type="button" class="btn btn-outline hidden" id="brgy-cancel">Cancel edit</button>
        <p class="form-ok" id="brgy-ok" hidden></p>
        <p class="form-error" id="brgy-err" hidden></p>
      </form>
    </div>

    <div class="card hidden" id="brgy-details"></div>`;
}

async function postRenderBarangays() {
  const form = $('#form-barangay');
  const okMsg = $('#brgy-ok'), errMsg = $('#brgy-err');

  // Search filter
  $('#brgy-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#brgy-table tbody tr').forEach((tr) => {
      tr.style.display = tr.dataset.name.includes(q) ? '' : 'none';
    });
  });

  // Add / edit submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    const fd = new FormData(form);
    const payload = {
      name: fd.get('name'), municipality: fd.get('municipality'),
      province: fd.get('province'), openingBalance: fd.get('openingBalance') || '0',
    };
    try {
      const id = form.dataset.id;
      if (id) {
        await window.treasuryAPI.updateB(Number(id), payload);
        okMsg.textContent = 'Barangay updated.';
      } else {
        await window.treasuryAPI.addB(payload);
        okMsg.textContent = 'Barangay added.';
      }
      okMsg.hidden = false;
      renderRoute('barangays');
    } catch (err) {
      errMsg.textContent = err.message; errMsg.hidden = false;
    }
  });

  $('#brgy-cancel')?.addEventListener('click', () => {
    form.reset(); form.dataset.id = '';
    $('#brgy-form-title').textContent = 'Add Barangay';
    $('#brgy-submit').textContent = 'Add barangay';
    $('#brgy-cancel').classList.add('hidden');
  });

  // View / Edit
  document.querySelectorAll('[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => loadBarangayDetails(Number(btn.dataset.view))));

  // Archive / Restore
  document.querySelectorAll('[data-archive]').forEach((btn) =>
    btn.addEventListener('click', () => archiveAction(Number(btn.dataset.archive), true)));
  document.querySelectorAll('[data-restore]').forEach((btn) =>
    btn.addEventListener('click', () => archiveAction(Number(btn.dataset.restore), false)));

  if (window.__brgys?.length) await loadBarangayDetails(window.__brgys[0].id);
}

async function loadBarangayDetails(id) {
  try {
    const b = await window.treasuryAPI.getB(id);
    const box = $('#brgy-details');
    box.classList.remove('hidden');
    box.innerHTML = `
      <h2>Details — ${esc(b.name)} ${b.is_sample ? sampleBadge() : ''}</h2>
      <div class="grid-3" style="margin:12px 0">
        <div><div class="stat-label">Computed balance</div>
          <div class="stat-value">${fmtMoney(b.balance_c)}</div></div>
        <div><div class="stat-label">Collections</div>
          <div class="stat-value stat-green">${fmtMoney(b.collections_c)}</div></div>
        <div><div class="stat-label">Expenses</div>
          <div class="stat-value stat-red">${fmtMoney(b.expenses_c)}</div></div>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Opening balance</th><td>${fmtMoney(b.opening_balance_c)}</td></tr>
        <tr><th>Municipality</th><td>${esc(b.municipality) || '—'}</td></tr>
        <tr><th>Province</th><td>${esc(b.province) || '—'}</td></tr>
        <tr><th>Recorded transactions</th><td>${b.txn_count}</td></tr>
        ${b.sample_collections_c || b.sample_expenses_c ? `<tr><th>Sample figures (excluded from balance)</th><td class="muted">+${fmtMoney(b.sample_collections_c)} / −${fmtMoney(b.sample_expenses_c)} ${sampleBadge()}</td></tr>` : ''}
        <tr><th>Status</th><td>${b.archived ? badge('Archived', 'amber') : badge('Active', 'green')}</td></tr>
        <tr><th>Created</th><td>${esc(b.created_at)}</td></tr>
      </table></div>
      <p><button class="btn btn-outline" id="brgy-edit-btn" style="margin-top:12px">Edit this barangay</button>
      <button class="btn btn-outline" id="brgy-workspace-btn" style="margin-top:12px">Open financial workspace</button></p>`;
    $('#brgy-edit-btn').addEventListener('click', () => {
      const form = $('#form-barangay');
      form.dataset.id = b.id;
      form.elements.name.value = b.name.replace(' (SAMPLE)', '');
      form.elements.municipality.value = b.municipality;
      form.elements.province.value = b.province;
      form.elements.openingBalance.value = (b.opening_balance_c / 100).toFixed(2);
      $('#brgy-form-title').textContent = `Edit Barangay #${b.id}`;
      $('#brgy-submit').textContent = 'Save changes';
      $('#brgy-cancel').classList.remove('hidden');
      $('#brgy-form-card').scrollIntoView({ behavior: 'smooth' });
    });
    $('#brgy-workspace-btn').addEventListener('click', () => openBarangayWorkspace(b.id));
  } catch (err) {
    alert(err.message);
  }
}

async function archiveAction(id, archived) {
  try {
    const b = await window.treasuryAPI.archiveB(id, archived);
    alert(archived
      ? `${b.name} archived. All its financial history is preserved and can be restored.`
      : `${b.name} restored to active.`);
    renderRoute('barangays');
  } catch (err) { alert(err.message); }
}

/* ================= BARANGAY WORKSPACE (per-barangay view) ================= */
async function pageBarangayWorkspace(brgyId) {
  const w = await window.treasuryAPI.workspace(brgyId);
  const b = w.barangay;
  const rows = w.transactions.map((t) => `
    <tr>
      <td>${esc(t.txn_date)}</td>
      <td>${txnBadge(t.kind)}</td>
      <td>${esc(t.description)} ${t.is_sample ? sampleBadge() : ''}</td>
      <td class="${t.kind === 'collection' ? 'stat-green' : 'stat-red'}">${fmtMoney(t.amount_c)}</td>
      <td>${statusBadge(t.status)}</td>
    </tr>`).join('');
  const taskRows = w.openTasks.map((t) => `
    <tr><td>${esc(t.title)}</td><td>${esc(t.due_date || '—')}</td>
    <td>${badge(t.priority, t.priority === 'urgent' || t.priority === 'high' ? 'red' : 'gray')}</td></tr>`).join('');

  return `
    <div class="card">
      <h2>${esc(b.name)} — Financial Workspace ${b.is_sample ? sampleBadge() : ''}</h2>
      <p class="card-sub">${esc(b.municipality)}, ${esc(b.province)} ·
        ${b.archived ? badge('Archived', 'amber') : badge('Active', 'green')}</p>
      <div class="grid-3" style="margin:12px 0">
        <div><div class="stat-label">Balance</div>
          <div class="stat-value">${fmtMoney(b.balance_c)}</div></div>
        <div><div class="stat-label">Collections</div>
          <div class="stat-value stat-green">${fmtMoney(b.collections_c)}</div></div>
        <div><div class="stat-label">Expenses</div>
          <div class="stat-value stat-red">${fmtMoney(b.expenses_c)}</div></div>
      </div>
      <button class="btn btn-outline" id="ws-back">← Back to Barangay Management</button>
    </div>
    <div class="card">
      <h2>Transactions (this barangay only)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No transactions for this barangay yet.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Pending Tasks</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Task</th><th>Due</th><th>Priority</th></tr></thead>
        <tbody>${taskRows || '<tr><td colspan="3" class="muted">No pending tasks.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

function postRenderWorkspace() {
  $('#ws-back')?.addEventListener('click', () => renderRoute('barangays'));
}

function openBarangayWorkspace(id) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelector('.nav-item[data-route="barangays"]')?.classList.add('active');
  const content = $('#content');
  content.innerHTML = '<div class="card muted">Loading…</div>';
  pageBarangayWorkspace(id).then((html) => {
    content.innerHTML = html;
    postRenderWorkspace();
  }).catch((err) => {
    content.innerHTML = `<div class="card"><p class="form-error">${esc(err.message)}</p></div>`;
  });
}

/* ================= FOUNDATION PAGES (extensible shells) ================= */
const ROADMAPS = {
  transactions: ['Full transaction entry forms (validated, parameterized)', 'Edit / void with soft-delete', 'Filtering and search'],
  collections: ['Official receipt issuance', 'Receipt printing preview', 'Collections ledger per barangay'],
  expenses: ['Expense vouchers', 'Supporting-document tracking', 'Expense categories and summaries'],
  budgets: ['Annual / quarterly budget setting', 'Burn-down vs actuals charts', 'Variance alerts'],
  reports: ['Collection & expense summaries (clearly labeled as management reports)', 'Export to PDF / CSV', 'Per-barangay and consolidated views'],
  tasks: ['Deadline calendar', 'Priority and completion tracking', 'Recurring compliance reminders'],
  audit: ['Filterable audit log viewer', 'Login and data-change history'],
  backup: ['One-click SQLite backup file export', 'Restore from backup with validation'],
  settings: ['Treasurer profile', 'Fiscal year defaults', 'Data management tools'],
};

function foundationPage(key, title, extra = '') {
  const items = (ROADMAPS[key] || []).map((i) => `<li>${i}</li>`).join('');
  return `
    <div class="card">
      <h2>${esc(title)}</h2>
      <p class="card-sub">Module foundation — database tables and navigation are in place; this module is completed in a later build stage.</p>
      ${extra}
      <h2 style="margin-top:14px">Planned capabilities</h2>
      <ul class="muted" style="margin:8px 0 0 20px; line-height:1.8">${items}</ul>
    </div>`;
}

const PLACEHOLDER_PAGES = {
  transactions: () => pageTransactions(),
  collections: () => pageCollections(),
  expenses: () => pageExpenses(),
  budgets: () => pageBudgets(),
  reports: () => pageReports(),
  tasks: () => pageTasks(),
  audit: () => pageAudit(),
  backup: () => pageBackup(),
  settings: () => pageSettings(),
};
