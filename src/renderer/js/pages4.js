/**
 * pages4.js — Part 4 pages: Budget Monitoring, Budget Utilization,
 * Financial Reports (with CSV export and print-friendly layout).
 * Uses the existing green/gold theme and treasuryAPI preload bridge.
 * Charts use actual database values only.
 */
'use strict';

/* ============================================================
   1. BUDGET MONITORING
   ============================================================ */
async function pageBudgets() {
  const years = [];
  for (let y = 2024; y <= 2030; y++) years.push(y);
  const yearOpts = years.map((y) => `<option value="${y}" ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`).join('');

  return `
    <div class="card" id="bud-totals-card"></div>
    <div class="card">
      <h2>Budget Monitoring</h2>
      <p class="card-sub">Budget allocations per barangay and year. Reference numbers are generated automatically (BGT-YYYY-NNNN).
      Figures are recorded amounts — not official certified balances.</p>
      <div class="form-row" id="bud-filters" style="margin-bottom:12px">
        <label>Barangay<select id="bud-brgy"><option value="">All barangays</option></select></label>
        <label>Budget year<select id="bud-year"><option value="">All years</option>${yearOpts}</select></label>
        <label>Search<input type="search" id="bud-q" placeholder="Description, category, ref no, remarks…" /></label>
      </div>
      <div class="table-wrap"><table id="bud-table">
        <thead><tr><th>Ref No.</th><th>Barangay</th><th>Year</th><th>Category</th><th>Description</th>
        <th>Allocated</th><th>Spent</th><th>Remaining</th><th>Utilized</th><th>Actions</th></tr></thead>
        <tbody><tr><td colspan="10" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2 id="bud-form-title">Create Budget Record</h2>
      <form id="form-budget" data-id="">
        <div class="form-row">
          <label>Barangay *<select name="barangayId" required></select></label>
          <label>Budget year *<select name="fiscalYear" required>${yearOpts}</select></label>
          <label>Budget category<select name="categoryId"></select></label>
          <label>Allocated amount (₱) *<input name="amount" required placeholder="50000.00" inputmode="decimal" /></label>
        </div>
        <div class="form-row">
          <label>Description *<input name="description" required minlength="3" placeholder="e.g. Supplies allocation for FY 2026" /></label>
          <label>Remarks<input name="remarks" /></label>
        </div>
        <button class="btn btn-primary" id="bud-submit">Create budget</button>
        <button type="button" class="btn btn-outline hidden" id="bud-cancel">Cancel edit</button>
        <p class="form-ok" id="bud-ok" hidden></p>
        <p class="form-error" id="bud-err" hidden></p>
      </form>
    </div>
    <div class="card hidden" id="bud-details"></div>`;
}

async function refreshBudTotals(filters) {
  const rows = await window.treasuryAPI.budTotals(filters || {});
  const card = $('#bud-totals-card');
  if (!card) return;
  const scope = filters?.barangayId ? 'Selected barangay'
    : (rows.length > 1 ? '<span class="badge badge-amber">Multiple barangays combined</span>' : 'All barangays');
  const trs = rows.map((r) => `
    <tr><td>${esc(r.name)}</td><td>${r.fiscalYear}</td>
    <td>${fmtMoney(r.allocated_c)}</td>
    <td class="stat-red">${fmtMoney(r.spent_c)}</td>
    <td>${fmtMoney(r.allocated_c - r.spent_c)}</td>
    <td>${r.allocated_c > 0 ? (r.spent_c / r.allocated_c * 100).toFixed(2) + '%' : '—'}</td></tr>`).join('');
  const totalAlloc = rows.reduce((a, r) => a + r.allocated_c, 0);
  const totalSpent = rows.reduce((a, r) => a + r.spent_c, 0);
  card.innerHTML = `
    <h2>Total Budget Allocated</h2>
    <p class="card-sub">Scope: ${scope} · recorded amounts, not certified balances</p>
    <div class="grid-3" style="margin-bottom:12px">
      <div><div class="stat-label">Total allocated</div>
        <div class="stat-value">${fmtMoney(totalAlloc)}</div></div>
      <div><div class="stat-label">Total spent (charged to budgets)</div>
        <div class="stat-value stat-red">${fmtMoney(totalSpent)}</div></div>
      <div><div class="stat-label">Total remaining</div>
        <div class="stat-value stat-green">${fmtMoney(totalAlloc - totalSpent)}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Barangay</th><th>Year</th><th>Allocated</th><th>Spent</th><th>Remaining</th><th>Utilized</th></tr></thead>
      <tbody>${trs || '<tr><td colspan="6" class="muted">No budget records yet — create one below.</td></tr>'}</tbody>
    </table></div>`;
}

async function refreshBudTable(filters) {
  const rows = await window.treasuryAPI.budList(filters || {});
  const tbody = $('#bud-table tbody');
  tbody.innerHTML = rows.length ? rows.map((b) => {
    const pct = b.amount_c > 0 ? (b.spent_c / b.amount_c * 100) : null;
    const tone = pct === null ? 'gray' : pct > 100 ? 'red' : pct >= 90 ? 'amber' : 'green';
    return `
    <tr>
      <td>${esc(b.ref_no)}</td>
      <td>${esc(b.barangay_name)}</td>
      <td>${b.fiscal_year}</td>
      <td>${esc(b.category_name || '—')}</td>
      <td>${esc(b.description)} ${b.is_sample ? sampleBadge() : ''}</td>
      <td>${fmtMoney(b.amount_c)}</td>
      <td class="stat-red">${fmtMoney(b.spent_c)}</td>
      <td>${fmtMoney(b.amount_c - b.spent_c)}</td>
      <td>${pct === null ? '—' : `<span class="badge badge-${tone}">${pct.toFixed(2)}%</span>`}</td>
      <td>
        <button class="btn btn-outline" data-bud-edit="${b.id}">Edit</button>
        <button class="btn btn-danger" data-bud-del="${b.id}">Delete</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="muted">No budget records found for this filter.</td></tr>';

  tbody.querySelectorAll('[data-bud-edit]').forEach((btn) =>
    btn.addEventListener('click', () => loadBudgetForEdit(Number(btn.dataset.budEdit))));
  tbody.querySelectorAll('[data-bud-del]').forEach((btn) =>
    btn.addEventListener('click', () => deleteWithConfirm(
      () => window.treasuryAPI.budDelete(Number(btn.dataset.budDel)),
      'Delete this budget record? Budgets with expenses charged to them cannot be deleted.',
      () => renderRoute('budgets'))));
}

async function loadBudgetForEdit(id) {
  try {
    const b = await window.treasuryAPI.budGet(id);
    const form = $('#form-budget');
    form.dataset.id = b.id;
    form.elements.barangayId.value = b.barangay_id;
    form.elements.fiscalYear.value = b.fiscal_year;
    form.elements.categoryId.value = b.category_id || '';
    form.elements.amount.value = (b.amount_c / 100).toFixed(2);
    form.elements.description.value = b.description;
    form.elements.remarks.value = b.remarks || '';
    $('#bud-form-title').textContent = `Edit Budget ${b.ref_no}`;
    $('#bud-submit').textContent = 'Save changes';
    $('#bud-cancel').classList.remove('hidden');
    $('#form-budget').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { alert(err.message); }
}

async function postRenderBudgets() {
  const [brgys, cats] = await Promise.all([window.treasuryAPI.listB(), window.treasuryAPI.cats()]);
  const f = $('#form-budget');
  for (const b of brgys) f.elements.barangayId.appendChild(new Option(b.name, b.id));
  f.elements.categoryId.appendChild(new Option('— none —', ''));
  for (const c of cats) f.elements.categoryId.appendChild(new Option(`${c.name} (${c.kind})`, c.id));

  $('#bud-filters').addEventListener('input', () => {
    const fl = { barangayId: $('#bud-brgy').value || undefined,
                 fiscalYear: $('#bud-year').value || undefined,
                 q: $('#bud-q').value.trim() || undefined };
    refreshBudTable(fl); refreshBudTotals(fl);
  });

  const okMsg = $('#bud-ok'), errMsg = $('#bud-err'), submit = $('#bud-submit');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    if (submit.disabled) return;
    const fd = new FormData(f);
    submit.disabled = true; submit.textContent = 'Saving…';
    try {
      const payload = {
        barangayId: fd.get('barangayId'), fiscalYear: fd.get('fiscalYear'),
        categoryId: fd.get('categoryId') || null, amount: fd.get('amount'),
        description: fd.get('description'), remarks: fd.get('remarks'),
      };
      const id = f.dataset.id;
      if (id) {
        await window.treasuryAPI.budUpdate(Number(id), payload);
        okMsg.textContent = 'Budget updated.';
      } else {
        const saved = await window.treasuryAPI.budCreate(payload);
        okMsg.textContent = `Budget saved with reference ${saved.ref_no}.`;
      }
      okMsg.hidden = false;
      f.reset(); f.dataset.id = '';
      $('#bud-form-title').textContent = 'Create Budget Record';
      $('#bud-submit').textContent = 'Create budget';
      $('#bud-cancel').classList.add('hidden');
      const fl = { barangayId: $('#bud-brgy').value || undefined,
                   fiscalYear: $('#bud-year').value || undefined, q: undefined };
      await Promise.all([refreshBudTable(fl), refreshBudTotals(fl)]);
    } catch (err) {
      errMsg.textContent = err.message; errMsg.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = f.dataset.id ? 'Save changes' : 'Create budget';
    }
  });
  $('#bud-cancel').addEventListener('click', () => {
    f.reset(); f.dataset.id = '';
    $('#bud-form-title').textContent = 'Create Budget Record';
    $('#bud-submit').textContent = 'Create budget';
    $('#bud-cancel').classList.add('hidden');
  });

  await Promise.all([refreshBudTable({}), refreshBudTotals({})]);
}

/* ============================================================
   2. BUDGET UTILIZATION (per barangay)
   ============================================================ */
async function pageBudgetUtilizationPanel(containerSel = '#reports-body', filters = {}) {
  const box = $(containerSel);
  if (!box) return '';
  let util = null, err = null;
  try { util = await window.treasuryAPI.budUtil(filters); }
  catch (e) { err = e.message; }
  const uHtml = !util ? `<p class="muted">${esc(err || '')}</p>` : `
    <div class="card">
      <h2>Budget Utilization</h2>
      <p class="card-sub">Per budget record. Remaining = allocated − recorded expenses charged to the budget.
      Figures are recorded amounts, not official certified balances.</p>
      ${util.unassigned.count ? `<p class="card-sub"><span class="badge badge-amber">UNASSIGNED EXPENSES</span>
        ${util.unassigned.count} expense record(s) totalling ${fmtMoney(util.unassigned.amount_c)} are not assigned
        to any budget — review and assign them from the Expenses page.</p>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Ref</th><th>Year</th><th>Category</th><th>Description</th><th>Allocated</th>
        <th>Spent</th><th>Remaining</th><th>Utilized</th><th>Expenses</th></tr></thead>
        <tbody>${util.rows.length ? util.rows.map((r) => `
          <tr><td>${esc(r.ref_no)}</td><td>${r.fiscalYear}</td>
          <td>${esc(r.category_name || '—')}</td><td>${esc(r.description)}</td>
          <td>${fmtMoney(r.allocated_c)}</td>
          <td class="stat-red">${fmtMoney(r.spent_c)}</td>
          <td class="${r.remaining_c < 0 ? 'stat-red' : ''}">${fmtMoney(r.remaining_c)}</td>
          <td>${r.utilization_pct === null ? '<span class="muted">no allocation</span>'
            : `<span class="badge badge-${r.utilization_pct > 100 ? 'red' : r.utilization_pct >= 90 ? 'amber' : 'green'}">${r.utilization_pct.toFixed(2)}%</span>`}</td>
          <td>${r.expense_count}</td></tr>`).join('')
          : '<tr><td colspan="9" class="muted">No budget records for this barangay/year yet.</td></tr>'}</tbody>
      </table></div>
      ${util.rows.some((r) => r.allocated_c === 0) ? '<p class="card-sub">Records with zero allocation show "no allocation" utilization and are handled safely (no division).</p>' : ''}
    </div>`;
  box.insertAdjacentHTML('beforeend', uHtml);
}

/* ============================================================
   3. FINANCIAL REPORTS
   ============================================================ */
const REPORT_TYPES = [
  ['collections', 'Collection Report'],
  ['expenses', 'Expense Report'],
  ['summary', 'Income and Expense Summary'],
  ['budget_alloc', 'Budget Allocation Report'],
  ['budget_util', 'Budget Utilization Report'],
  ['brgy_summary', 'Barangay Financial Summary'],
  ['txn_history', 'Transaction History Report'],
];

let __currentReport = null; // cached for CSV export / printing

async function pageReports() {
  const yearOpts = [];
  for (let y = 2024; y <= 2030; y++) yearOpts.push(`<option value="${y}">${y}</option>`);
  return `
    <div class="card no-print">
      <h2>Financial Reports</h2>
      <p class="card-sub">Generate reports from actual database records. Export to CSV or print.
      Reports are management-information outputs — <strong>not officially certified government financial statements</strong>.</p>
      <div class="form-row">
        <label>Report type<select id="rep-type">
          ${REPORT_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select></label>
        <label>Barangay<select id="rep-brgy"><option value="">All barangays</option></select></label>
        <label>From date<input type="date" id="rep-from" /></label>
        <label>To date<input type="date" id="rep-to" /></label>
      </div>
      <div class="form-row">
        <label>Budget year<select id="rep-year"><option value="">All years</option>${yearOpts.join('')}</select></label>
        <label>Category<select id="rep-cat"><option value="">All categories</option></select></label>
        <label>Search<input type="search" id="rep-q" placeholder="Keyword…" /></label>
      </div>
      <button class="btn btn-primary" id="rep-generate">Generate report</button>
      <button class="btn btn-outline" id="rep-csv" disabled>Export CSV</button>
      <button class="btn btn-outline" id="rep-print" disabled>Print</button>
      <p class="form-error" id="rep-err" hidden></p>
    </div>
    <div id="reports-body"></div>`;
}

function reportTitle(type) {
  return (REPORT_TYPES.find(([v]) => v === type) || [null, type])[1];
}

async function generateReport() {
  const type = $('#rep-type').value;
  const barangayId = $('#rep-brgy').value || undefined;
  const from = $('#rep-from').value || undefined;
  const to = $('#rep-to').value || undefined;
  const fiscalYear = $('#rep-year').value || undefined;
  const categoryId = $('#rep-cat').value || undefined;
  const q = $('#rep-q').value.trim() || undefined;
  const err = $('#rep-err');
  err.hidden = true;
  if (from && to && from > to) {
    err.textContent = 'Start date must not be after the end date.';
    err.hidden = false;
    return;
  }
  const filters = { barangayId, from, to, fiscalYear, categoryId, q };
  const brgys = await window.treasuryAPI.listB({ includeArchived: true });
  const brgyName = barangayId ? (brgys.find((b) => b.id === Number(barangayId))?.name || `#${barangayId}`) : 'All barangays';
  const period = [from, to].filter(Boolean).join(' to ') || (fiscalYear ? `Budget year ${fiscalYear}` : 'All recorded dates');

  const body = $('#reports-body');
  body.innerHTML = '<div class="card muted">Generating…</div>';
  const cats = await window.treasuryAPI.cats();
  const catName = (id) => cats.find((c) => c.id === id)?.name || '—';
  const meta = `
    <div class="print-header">
      <h2>${esc(reportTitle(type))}</h2>
      <p>Barangay Treasury Hub — Multi-Barangay Financial Management System</p>
      <p><strong>Barangay:</strong> ${esc(brgyName)}${Number(barangayId) ? '' : ' <span class="badge badge-amber">Multiple barangays combined</span>'}
       &nbsp;·&nbsp; <strong>Period:</strong> ${esc(period)}<br>
      <strong>Generated:</strong> ${new Date().toLocaleString('en-PH')}</p>
      <p><em>Management-information output only — not an officially certified government financial statement.</em></p>
    </div>`;
  let html = '';

  try {
    if (type === 'collections') {
      const rows = await window.treasuryAPI.colList({ ...filters, limit: 2000 });
      const total = rows.reduce((a, r) => a + r.amount_c, 0);
      html = meta + reportTable('Collection Report', [
        ['Ref No.', r => esc(r.ref_no)], ['Date', r => esc(r.txn_date)],
        ['Barangay', r => esc(r.barangay_name)], ['Payer', r => esc(r.payer)],
        ['Category', r => esc(r.category_name || '—')], ['Description', r => esc(r.description)],
        ['Amount', r => fmtMoney(r.amount_c)], ['Method', r => esc(METHOD_LABEL[r.method] || r.method)],
      ], rows, [['TOTAL COLLECTIONS', fmtMoney(total)]]);

    } else if (type === 'expenses') {
      const rows = await window.treasuryAPI.expList({ ...filters, limit: 2000 });
      const total = rows.reduce((a, r) => a + r.amount_c, 0);
      html = meta + reportTable('Expense Report', [
        ['Ref No.', r => esc(r.ref_no)], ['Date', r => esc(r.txn_date)],
        ['Barangay', r => esc(r.barangay_name)], ['Payee', r => esc(r.payee)],
        ['Category', r => esc(r.category_name || '—')], ['Description', r => esc(r.description)],
        ['Amount', r => fmtMoney(r.amount_c)], ['Method', r => esc(METHOD_LABEL[r.method] || r.method)],
        ['Budget link', r => r.budget_id ? `Budget #${r.budget_id}` : 'UNASSIGNED'],
      ], rows, [['TOTAL EXPENSES', fmtMoney(total)]]);

    } else if (type === 'summary' || type === 'brgy_summary') {
      const s = await window.treasuryAPI.finSummary(filters);
      const trends = await window.treasuryAPI.trends(filters);
      const multi = !barangayId && s.perBarangay.length > 1;
      html = meta + `
        <div class="card">
          <h2>${esc(reportTitle(type))}</h2>
          <p class="card-sub">Barangay: ${esc(brgyName)}${multi ? ' <span class="badge badge-amber">Multiple barangays combined</span>' : ''} · Period: ${esc(period)}</p>
          <div class="grid-3" style="margin-bottom:12px">
            <div><div class="stat-label">Total collections (recorded)</div>
              <div class="stat-value stat-green">${fmtMoney(s.collections_c)}</div></div>
            <div><div class="stat-label">Total expenses (recorded)</div>
              <div class="stat-value stat-red">${fmtMoney(s.expenses_c)}</div></div>
            <div><div class="stat-label">Net (collections − expenses)</div>
              <div class="stat-value">${fmtMoney(s.net_c)}</div></div>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Barangay</th><th>Collections</th><th>Expenses</th><th>Net</th><th>Transactions</th></tr></thead>
            <tbody>${s.perBarangay.length ? s.perBarangay.map((p) => `
              <tr><td>${esc(p.name)}</td><td class="stat-green">${fmtMoney(p.collections_c)}</td>
              <td class="stat-red">${fmtMoney(p.expenses_c)}</td>
              <td>${fmtMoney(p.collections_c - p.expenses_c)}</td><td>${p.n}</td></tr>`).join('')
              : '<tr><td colspan="5" class="muted">No records in this scope.</td></tr>'}</tbody>
          </table></div>
          ${trends.length ? '<div class="chart-box" style="margin-top:16px"><canvas id="rep-chart"></canvas></div>' : ''}
        </div>`;
      __currentReport = { type, brgyName, period, rows: s.perBarangay.map((p) => ({
        barangay: p.name, collections: fmtMoney(p.collections_c), expenses: fmtMoney(p.expenses_c),
        net: fmtMoney(p.collections_c - p.expenses_c), transactions: p.n })), grand: ['TOTAL', fmtMoney(s.collections_c), fmtMoney(s.expenses_c), fmtMoney(s.net_c), s.n] };
      body.innerHTML = html;
      drawTrendChart(trends);
      enableExport();
      return;

    } else if (type === 'budget_alloc') {
      const rows = await window.treasuryAPI.budList({ barangayId, fiscalYear, q });
      const total = rows.reduce((a, r) => a + r.amount_c, 0);
      html = meta + reportTable('Budget Allocation Report', [
        ['Ref No.', r => esc(r.ref_no)], ['Barangay', r => esc(r.barangay_name)],
        ['Year', r => r.fiscal_year], ['Category', r => esc(r.category_name || '—')],
        ['Description', r => esc(r.description)], ['Allocated', r => fmtMoney(r.amount_c)],
        ['Remarks', r => esc(r.remarks || '—')],
      ], rows, [['TOTAL ALLOCATED', fmtMoney(total)]]);

    } else if (type === 'budget_util') {
      if (!barangayId) {
        $('#rep-err').textContent = 'Budget Utilization Report requires selecting a specific barangay.';
        $('#rep-err').hidden = false;
        $('#reports-body').innerHTML = '';
        return;
      }
      body.innerHTML = meta;
      await pageBudgetUtilizationPanel('#reports-body', { barangayId, fiscalYear });
      const util = await window.treasuryAPI.budUtil({ barangayId, fiscalYear });
      __currentReport = { type, brgyName, period, rows: util.rows.map((r) => ({
        ref: r.ref_no, year: r.fiscalYear, category: r.category_name || '—', description: r.description,
        allocated: fmtMoney(r.allocated_c), spent: fmtMoney(r.spent_c),
        remaining: fmtMoney(r.remaining_c), utilization: r.utilization_pct === null ? 'n/a' : r.utilization_pct.toFixed(2) + '%' })),
        unassigned: util.unassigned };
      enableExport();
      return;

    } else if (type === 'txn_history') {
      const rows = await window.treasuryAPI.list({ ...filters, limit: 2000 });
      const totC = rows.filter((r) => r.kind === 'collection').reduce((a, r) => a + r.amount_c, 0);
      const totE = rows.filter((r) => r.kind === 'expense').reduce((a, r) => a + r.amount_c, 0);
      html = meta + reportTable('Transaction History Report', [
        ['Date', r => esc(r.txn_date)], ['Barangay', r => esc(r.barangay_name)],
        ['Type', r => esc(KIND_LABEL[r.kind] || r.kind)], ['Description', r => esc(r.description) + (r.is_sample ? ' (SAMPLE)' : '')],
        ['Party', r => esc(r.payee || '—')], ['Category', r => esc(r.category_name || '—')],
        ['Ref / OR No.', r => esc(r.or_number || '—')], ['Amount', r => fmtMoney(r.amount_c)],
      ], rows, [['TOTAL COLLECTIONS', fmtMoney(totC)], ['TOTAL EXPENSES', fmtMoney(totE)], ['NET', fmtMoney(totC - totE)]]);
    }

    body.innerHTML = html;
    enableExport();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
    body.innerHTML = '';
  }
}

/** Build a standard report table with footer totals. */
function reportTable(title, cols, rows, footers) {
  const thead = cols.map(([h]) => `<th>${h}</th>`).join('');
  const trs = rows.length ? rows.map((r) => `<tr>${cols.map(([, fn]) => `<td>${fn(r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" class="muted">No records for this report scope.</td></tr>`;
  const tfoot = footers ? footers.map(([l, v]) =>
    `<tr><th colspan="${cols.length - 1}" style="text-align:right">${l}</th><th>${v}</th></tr>`).join('') : '';
  return `<div class="card"><h2>${esc(title)}</h2>
    <div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${trs}</tbody>
    <tfoot>${tfoot}</tfoot></table></div></div>`;
}

function drawTrendChart(trends) {
  const canvas = $('#rep-chart');
  if (!canvas || typeof Chart === 'undefined' || !trends.length) return;
  new Chart(canvas, {
    type: 'line',
    data: {
      labels: trends.map((t) => t.month),
      datasets: [
        { label: 'Collections (₱)', data: trends.map((t) => t.collections_c / 100), borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,.15)', fill: true, tension: .25 },
        { label: 'Expenses (₱)', data: trends.map((t) => t.expenses_c / 100), borderColor: '#C9A227', backgroundColor: 'rgba(201,162,39,.15)', fill: true, tension: .25 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: (v) => '₱' + Number(v).toLocaleString() } } } },
  });
}

function enableExport() {
  $('#rep-csv').disabled = false;
  $('#rep-print').disabled = false;
}

/* ---------------- CSV export (UTF-8 BOM so ₱ opens correctly) ---------------- */
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportCsv() {
  const r = __currentReport;
  if (!r) return;
  const lines = [];
  lines.push(csvEscape(reportTitle(r.type)));
  lines.push(csvEscape(`Barangay: ${r.brgyName}`));
  lines.push(csvEscape(`Period: ${r.period}`));
  lines.push(csvEscape('Generated: ' + new Date().toLocaleString('en-PH')));
  lines.push(csvEscape('Management-information output only - not an officially certified government financial statement'));
  lines.push('');
  if (r.rows.length) {
    lines.push(Object.keys(r.rows[0]).map(csvEscape).join(','));
    for (const row of r.rows) lines.push(Object.values(row).map(csvEscape).join(','));
  }
  if (r.grand) lines.push(r.grand.map(csvEscape).join(','));
  if (r.unassigned) lines.push('', csvEscape(`UNASSIGNED EXPENSES: ${r.unassigned.count} record(s), ${fmtMoney(r.unassigned.amount_c)}`));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${r.type}-report-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function postRenderReports() {
  const [brgys, cats] = await Promise.all([window.treasuryAPI.listB({ includeArchived: true }), window.treasuryAPI.cats()]);
  for (const b of brgys) $('#rep-brgy').appendChild(new Option(b.name, b.id));
  for (const c of cats) $('#rep-cat').appendChild(new Option(`${c.name} (${c.kind})`, c.id));
  $('#rep-generate').addEventListener('click', generateReport);
  $('#rep-csv').addEventListener('click', exportCsv);
  // Print via the existing Electron renderer (window.print works in Electron
  // and uses the @media print layout in styles.css).
  $('#rep-print').addEventListener('click', () => window.print());
}
