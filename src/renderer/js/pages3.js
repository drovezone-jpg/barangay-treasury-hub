/**
 * pages3.js — Part 3 pages: Collections, Receipts, Expenses.
 * Uses the existing green/gold theme (styles.css) and treasuryAPI preload
 * bridge. Submit buttons disable while a save is in flight (prevents
 * double submission); all errors from the main process are shown.
 */
'use strict';

const METHOD_LABEL = { cash: 'Cash', check: 'Check', gcash: 'GCash', bank: 'Bank transfer' };
const RCPT_STATUS_LABEL = { issued: 'Issued', cancelled: 'Cancelled', pending: 'Pending' };

function methodBadge(m) { return badge(METHOD_LABEL[m] || m, 'gray'); }
function rcptStatusBadge(s) {
  const tone = s === 'issued' ? 'green' : s === 'pending' ? 'amber' : 'red';
  return badge(RCPT_STATUS_LABEL[s] || s, tone);
}
function partyBadge(name) { return badge('SYSTEM-GENERATED RECORD — not an official government receipt', 'gold'); }

/** Build a barangay + date filter bar. */
function filterBarHtml(prefix) {
  return `
    <div class="form-row" id="${prefix}-filters" style="margin-bottom:12px">
      <label>Barangay
        <select id="${prefix}-brgy"><option value="">All barangays</option></select></label>
      <label>Category
        <select id="${prefix}-cat"><option value="">All categories</option></select></label>
      <label>From date<input type="date" id="${prefix}-from" /></label>
      <label>To date<input type="date" id="${prefix}-to" /></label>
      <label>Search
        <input type="search" id="${prefix}-q" placeholder="Payer, description, ref no…" /></label>
    </div>`;
}

async function populateFilterOptions(prefix, { withCategory = true } = {}) {
  const [brgys, cats] = await Promise.all([
    window.treasuryAPI.listB(), withCategory ? window.treasuryAPI.cats() : Promise.resolve([]),
  ]);
  const sel = $(`#${prefix}-brgy`);
  for (const b of brgys) {
    const o = document.createElement('option');
    o.value = b.id; o.textContent = b.name;
    sel.appendChild(o);
  }
  if (withCategory) {
    const csel = $(`#${prefix}-cat`);
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = `${c.name} (${c.kind})`;
      csel.appendChild(o);
    }
  }
}

function readFilters(prefix) {
  return {
    barangayId: $(`#${prefix}-brgy`).value || undefined,
    categoryId: $(`#${prefix}-cat`)?.value || undefined,
    from: $(`#${prefix}-from`).value || undefined,
    to: $(`#${prefix}-to`).value || undefined,
    q: $(`#${prefix}-q`).value.trim() || undefined,
  };
}

/* ============================================================
   1. COLLECTIONS PAGE
   ============================================================ */
async function pageCollections() {
  return `
    <div class="card" id="col-summary-card"></div>
    <div class="card">
      <h2>Collections</h2>
      <p class="card-sub">Money collected per barangay. Reference numbers are generated automatically (COL-YYYY-NNNN).</p>
      ${filterBarHtml('col')}
      <div class="table-wrap"><table id="col-table">
        <thead><tr><th>Ref No.</th><th>Date</th><th>Barangay</th><th>Payer / Source</th><th>Category</th>
        <th>Description</th><th>Amount</th><th>Method</th><th>Recorded by</th><th>Actions</th></tr></thead>
        <tbody><tr><td colspan="10" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2 id="col-form-title">Add Collection</h2>
      <form id="form-collection" data-id="">
        <div class="form-row">
          <label>Barangay *<select name="barangayId" required></select></label>
          <label>Collection date *<input type="date" name="txnDate" required /></label>
          <label>Category<select name="categoryId"></select></label>
          <label>Payer / source of income *<input name="payer" required placeholder="e.g. Juan Dela Cruz / Market vendors" /></label>
        </div>
        <div class="form-row">
          <label>Description / purpose *<input name="description" required minlength="3" placeholder="e.g. Barangay clearance fees" /></label>
          <label>Amount (₱) *<input name="amount" required placeholder="1500.00" inputmode="decimal" /></label>
          <label>Payment method *<select name="method">
            <option value="cash">Cash</option><option value="check">Check</option>
            <option value="gcash">GCash</option><option value="bank">Bank transfer</option></select></label>
          <label>Recorded by<input name="recordedBy" placeholder="Treasurer name" /></label>
        </div>
        <label>Remarks<textarea name="remarks" rows="2" placeholder="Optional notes"></textarea></label>
        <button class="btn btn-primary" id="col-submit">Save collection</button>
        <button type="button" class="btn btn-outline hidden" id="col-cancel">Cancel edit</button>
        <p class="form-ok" id="col-ok" hidden></p>
        <p class="form-error" id="col-err" hidden></p>
      </form>
    </div>`;
}

async function refreshColSummary(filters) {
  const [s, sAll] = await Promise.all([
    window.treasuryAPI.finSummary(filters || {}),
    window.treasuryAPI.finSummary({}),
  ]);
  const card = $('#col-summary-card');
  if (!card) return;
  const scope = filters?.barangayId
    ? 'Selected barangay'
    : (s.multiBarangay ? '<span class="badge badge-amber">Multiple barangays combined</span>' : 'All barangays');
  const list = filters?.barangayId ? s.perBarangay : s.perBarangay;
  const rows = list.map((p) => `
    <tr><td>${esc(p.name)}</td>
    <td class="stat-green">${fmtMoney(p.collections_c)}</td>
    <td class="stat-red">${fmtMoney(p.expenses_c)}</td>
    <td>${fmtMoney(p.collections_c - p.expenses_c)}</td>
    <td>${p.n}</td></tr>`).join('');
  card.innerHTML = `
    <h2>Financial Summary</h2>
    <p class="card-sub">Scope: ${scope} · actual records only (sample data excluded)</p>
    <div class="grid-3" style="margin-bottom:12px">
      <div><div class="stat-label">Total collections</div>
        <div class="stat-value stat-green">${fmtMoney(s.collections_c)}</div></div>
      <div><div class="stat-label">Total expenses</div>
        <div class="stat-value stat-red">${fmtMoney(s.expenses_c)}</div></div>
      <div><div class="stat-label">Net recorded amount</div>
        <div class="stat-value">${fmtMoney(s.net_c)}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Barangay</th><th>Collections</th><th>Expenses</th><th>Net</th><th>Transactions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No records in this scope yet.</td></tr>'}</tbody>
    </table></div>
    <p class="card-sub" style="margin-top:8px">Transaction count in scope: <strong>${s.n}</strong>
    ${s.multiBarangay ? ' · totals cover <strong>multiple barangays</strong>, not a single barangay.' : ''}</p>`;
}

async function refreshColTable(filters) {
  const rows = await window.treasuryAPI.colList(filters || {});
  const tbody = $('#col-table tbody');
  tbody.innerHTML = rows.length ? rows.map((c) => `
    <tr>
      <td>${esc(c.ref_no)}</td>
      <td>${esc(c.txn_date)}</td>
      <td>${esc(c.barangay_name)}</td>
      <td>${esc(c.payer)}</td>
      <td>${esc(c.category_name || '—')}</td>
      <td>${esc(c.description)}</td>
      <td class="stat-green">${fmtMoney(c.amount_c)}</td>
      <td>${methodBadge(c.method)}</td>
      <td>${esc(c.recorded_by || '—')}</td>
      <td>
        <button class="btn btn-outline" data-col-edit="${c.id}">Edit</button>
        <button class="btn btn-danger" data-col-del="${c.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="10" class="muted">No collection records found for this filter.</td></tr>';

  tbody.querySelectorAll('[data-col-edit]').forEach((b) =>
    b.addEventListener('click', () => loadCollectionForEdit(Number(b.dataset.colEdit))));
  tbody.querySelectorAll('[data-col-del]').forEach((b) =>
    b.addEventListener('click', () => deleteWithConfirm(
      () => window.treasuryAPI.colDelete(Number(b.dataset.colDel)),
      'Delete this collection record? Its linked ledger entry is removed and the action is recorded in the audit trail.',
      () => { renderRoute('collections'); })));
}

async function loadCollectionForEdit(id) {
  try {
    const c = await window.treasuryAPI.colGet(id);
    const form = $('#form-collection');
    form.dataset.id = c.id;
    form.elements.barangayId.value = c.barangay_id;
    form.elements.txnDate.value = c.txn_date;
    form.elements.categoryId.value = c.category_id || '';
    form.elements.payer.value = c.payer;
    form.elements.description.value = c.description;
    form.elements.amount.value = (c.amount_c / 100).toFixed(2);
    form.elements.method.value = c.method;
    form.elements.recordedBy.value = c.recorded_by || '';
    form.elements.remarks.value = c.remarks || '';
    $('#col-form-title').textContent = `Edit Collection ${c.ref_no}`;
    $('#col-submit').textContent = 'Save changes';
    $('#col-cancel').classList.remove('hidden');
    $('#col-form-card') || $('#form-collection').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { alert(err.message); }
}

async function postRenderCollections() {
  await populateFilterOptions('col');
  // form barangay + category options
  const f = $('#form-collection');
  const [brgys, cats] = await Promise.all([window.treasuryAPI.listB(), window.treasuryAPI.cats('collection')]);
  for (const b of brgys) f.elements.barangayId.appendChild(new Option(b.name, b.id));
  f.elements.categoryId.appendChild(new Option('— none —', ''));
  for (const c of cats) f.elements.categoryId.appendChild(new Option(c.name, c.id));
  f.elements.txnDate.value = todayISO();

  $('#col-filters').addEventListener('input', () => {
    refreshColTable(readFilters('col'));
    refreshColSummary(readFilters('col'));
  });

  // Submit with double-submission guard
  const okMsg = $('#col-ok'), errMsg = $('#col-err'), submit = $('#col-submit');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    if (submit.disabled) return; // in-flight guard
    const fd = new FormData(f);
    const payload = {
      barangayId: fd.get('barangayId'), txnDate: fd.get('txnDate'),
      categoryId: fd.get('categoryId') || null, payer: fd.get('payer'),
      description: fd.get('description'), amount: fd.get('amount'),
      method: fd.get('method'), recordedBy: fd.get('recordedBy'), remarks: fd.get('remarks'),
    };
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      const id = f.dataset.id;
      if (id) {
        await window.treasuryAPI.colUpdate(Number(id), payload);
        okMsg.textContent = 'Collection updated.';
      } else {
        const saved = await window.treasuryAPI.colCreate(payload);
        okMsg.textContent = `Collection saved with reference ${saved.ref_no}.`;
      }
      okMsg.hidden = false;
      f.reset(); f.dataset.id = ''; f.elements.txnDate.value = todayISO();
      $('#col-form-title').textContent = 'Add Collection';
      $('#col-submit').textContent = 'Save collection';
      $('#col-cancel').classList.add('hidden');
      await Promise.all([refreshColTable(readFilters('col')), refreshColSummary(readFilters('col'))]);
    } catch (err) {
      errMsg.textContent = err.message; errMsg.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = f.dataset.id ? 'Save changes' : 'Save collection';
    }
  });

  $('#col-cancel').addEventListener('click', () => {
    f.reset(); f.dataset.id = ''; f.elements.txnDate.value = todayISO();
    $('#col-form-title').textContent = 'Add Collection';
    $('#col-submit').textContent = 'Save collection';
    $('#col-cancel').classList.add('hidden');
  });

  await Promise.all([refreshColTable({}), refreshColSummary({})]);
}

/* ============================================================
   2. RECEIPTS PAGE
   ============================================================ */
async function pageReceipts() {
  return `
    <div class="card">
      <h2>Receipt Management</h2>
      <p class="card-sub">Receipts are linked to collection records. Receipt numbers must be unique per barangay.
      Cancelled receipts are kept in the records for auditing. ${partyBadge()}</p>
      <div class="form-row" id="rcpt-filters" style="margin-bottom:12px">
        <label>Barangay<select id="rcpt-brgy"><option value="">All barangays</option></select></label>
        <label>Status<select id="rcpt-status">
          <option value="">All statuses</option>
          <option value="issued">Issued</option>
          <option value="pending">Pending</option>
          <option value="cancelled">Cancelled</option></select></label>
        <label>Search<input type="search" id="rcpt-q" placeholder="Receipt no, payer, collection ref…" /></label>
      </div>
      <div class="table-wrap"><table id="rcpt-table">
        <thead><tr><th>Receipt No.</th><th>Collection Ref</th><th>Barangay</th><th>Date issued</th>
        <th>Payer</th><th>Amount</th><th>Purpose</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Record a Receipt</h2>
      <form id="form-receipt">
        <div class="form-row">
          <label>Barangay *<select name="barangayId" required></select></label>
          <label>Collection reference *<select name="collectionRef" required></select></label>
          <label>Receipt number *<input name="receiptNo" required placeholder="e.g. RCT-0001" /></label>
          <label>Date issued *<input type="date" name="dateIssued" required /></label>
        </div>
        <div class="form-row">
          <label>Payer *<input name="payer" required /></label>
          <label>Amount (₱) *<input name="amount" required placeholder="1500.00" inputmode="decimal" /></label>
          <label>Status<select name="status">
            <option value="issued">Issued</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option></select></label>
        </div>
        <label>Purpose<input name="purpose" placeholder="Optional" /></label>
        <button class="btn btn-primary" id="rcpt-submit">Save receipt</button>
        <p class="form-ok" id="rcpt-ok" hidden></p>
        <p class="form-error" id="rcpt-err" hidden></p>
      </form>
    </div>`;
}

async function refreshRcptTable(filters) {
  const rows = await window.treasuryAPI.rcptList(filters || {});
  const tbody = $('#rcpt-table tbody');
  tbody.innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${esc(r.receipt_no)}</td>
      <td>${esc(r.collection_ref || '—')}</td>
      <td>${esc(r.barangay_name)}</td>
      <td>${esc(r.date_issued)}</td>
      <td>${esc(r.payer)}</td>
      <td class="stat-green">${fmtMoney(r.amount_c)}</td>
      <td>${esc(r.purpose || '—')}</td>
      <td>${rcptStatusBadge(r.status)}</td>
      <td>${r.status !== 'cancelled'
        ? `<button class="btn btn-danger" data-rcpt-cancel="${r.id}">Cancel receipt</button>`
        : '<span class="muted">kept for audit</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="9" class="muted">No receipts found for this filter.</td></tr>';

  tbody.querySelectorAll('[data-rcpt-cancel]').forEach((b) =>
    b.addEventListener('click', () => deleteWithConfirm(
      () => window.treasuryAPI.rcptCancel(Number(b.dataset.rcptCancel)),
      'Cancel this receipt? The record is KEPT with status Cancelled for auditing.',
      () => refreshRcptTable(readRcptFilters()))));
}

function readRcptFilters() {
  return {
    barangayId: $('#rcpt-brgy').value || undefined,
    status: $('#rcpt-status').value || undefined,
    q: $('#rcpt-q').value.trim() || undefined,
  };
}

async function postRenderReceipts() {
  const [brgys] = await Promise.all([window.treasuryAPI.listB(), populateFilterOptions('rcpt', { withCategory: false })]);
  const f = $('#form-receipt');
  const brgySel = f.elements.barangayId;
  for (const b of brgys) brgySel.appendChild(new Option(b.name, b.id));
  f.elements.dateIssued.value = todayISO();

  const loadColRefs = async () => {
    const colSel = f.elements.collectionRef;
    colSel.innerHTML = '<option value="">— select a collection —</option>';
    if (!brgySel.value) return;
    const cols = await window.treasuryAPI.colList({ barangayId: brgySel.value, limit: 100 });
    for (const c of cols) colSel.appendChild(new Option(`${c.ref_no} — ${c.payer} — ${fmtMoney(c.amount_c)}`, c.ref_no));
  };
  brgySel.addEventListener('change', loadColRefs);
  await loadColRefs();

  $('#rcpt-filters').addEventListener('input', () => refreshRcptTable(readRcptFilters()));

  const okMsg = $('#rcpt-ok'), errMsg = $('#rcpt-err'), submit = $('#rcpt-submit');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    if (submit.disabled) return;
    const fd = new FormData(f);
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      const saved = await window.treasuryAPI.rcptCreate({
        barangayId: fd.get('barangayId'), collectionRef: fd.get('collectionRef'),
        receiptNo: fd.get('receiptNo'), dateIssued: fd.get('dateIssued'),
        payer: fd.get('payer'), amount: fd.get('amount'),
        purpose: fd.get('purpose'), status: fd.get('status'),
      });
      okMsg.textContent = `Receipt ${saved.receipt_no} saved. This is a system-generated record, not an official government receipt.`;
      okMsg.hidden = false;
      f.reset(); f.elements.dateIssued.value = todayISO();
      await loadColRefs();
      await refreshRcptTable(readRcptFilters());
    } catch (err) {
      errMsg.textContent = err.message; errMsg.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Save receipt';
    }
  });

  await refreshRcptTable({});
}

/* ============================================================
   3. EXPENSES PAGE
   ============================================================ */
async function pageExpenses() {
  return `
    <div class="card" id="exp-summary-card"></div>
    <div class="card">
      <h2>Expenses</h2>
      <p class="card-sub">Barangay expenses. Reference numbers are generated automatically (EXP-YYYY-NNNN).</p>
      ${filterBarHtml('exp')}
      <div class="table-wrap"><table id="exp-table">
        <thead><tr><th>Ref No.</th><th>Date</th><th>Barangay</th><th>Payee / Supplier</th><th>Category</th>
        <th>Description</th><th>Amount</th><th>Method</th><th>Supporting doc</th><th>Recorded by</th><th>Actions</th></tr></thead>
        <tbody><tr><td colspan="11" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2 id="exp-form-title">Add Expense</h2>
      <form id="form-expense" data-id="">
        <div class="form-row">
          <label>Barangay *<select name="barangayId" required></select></label>
          <label>Transaction date *<input type="date" name="txnDate" required /></label>
          <label>Category<select name="categoryId"></select></label>
          <label>Payee / supplier *<input name="payee" required placeholder="e.g. Hardware Store" /></label>
        </div>
        <div class="form-row">
          <label>Description / purpose *<input name="description" required minlength="3" /></label>
          <label>Amount (₱) *<input name="amount" required placeholder="750.00" inputmode="decimal" /></label>
          <label>Payment method *<select name="method">
            <option value="cash">Cash</option><option value="check">Check</option>
            <option value="gcash">GCash</option><option value="bank">Bank transfer</option></select></label>
          <label>Supporting document / ref<input name="supportingDoc" placeholder="e.g. INV-2026-014" /></label>
        </div>
        <div class="form-row">
          <label>Recorded by<input name="recordedBy" /></label>
          <label>Remarks<input name="remarks" /></label>
        </div>
        <button class="btn btn-primary" id="exp-submit">Save expense</button>
        <button type="button" class="btn btn-outline hidden" id="exp-cancel">Cancel edit</button>
        <p class="form-ok" id="exp-ok" hidden></p>
        <p class="form-error" id="exp-err" hidden></p>
      </form>
    </div>`;
}

async function refreshExpSummary(filters) {
  const s = await window.treasuryAPI.finSummary(filters || {});
  const card = $('#exp-summary-card');
  if (!card) return;
  const scope = filters?.barangayId
    ? 'Selected barangay'
    : (s.multiBarangay ? '<span class="badge badge-amber">Multiple barangays combined</span>' : 'All barangays');
  const rows = s.perBarangay.map((p) => `
    <tr><td>${esc(p.name)}</td>
    <td class="stat-green">${fmtMoney(p.collections_c)}</td>
    <td class="stat-red">${fmtMoney(p.expenses_c)}</td>
    <td>${fmtMoney(p.collections_c - p.expenses_c)}</td>
    <td>${p.n}</td></tr>`).join('');
  card.innerHTML = `
    <h2>Expense Summary</h2>
    <p class="card-sub">Scope: ${scope} · actual records only (sample data excluded)</p>
    <div class="grid-3" style="margin-bottom:12px">
      <div><div class="stat-label">Total collections</div>
        <div class="stat-value stat-green">${fmtMoney(s.collections_c)}</div></div>
      <div><div class="stat-label">Total expenses</div>
        <div class="stat-value stat-red">${fmtMoney(s.expenses_c)}</div></div>
      <div><div class="stat-label">Net recorded amount</div>
        <div class="stat-value">${fmtMoney(s.net_c)}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Barangay</th><th>Collections</th><th>Expenses</th><th>Net</th><th>Transactions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No records in this scope yet.</td></tr>'}</tbody>
    </table></div>`;
}

async function refreshExpTable(filters) {
  const rows = await window.treasuryAPI.expList(filters || {});
  const tbody = $('#exp-table tbody');
  tbody.innerHTML = rows.length ? rows.map((e2) => `
    <tr>
      <td>${esc(e2.ref_no)}</td>
      <td>${esc(e2.txn_date)}</td>
      <td>${esc(e2.barangay_name)}</td>
      <td>${esc(e2.payee)}</td>
      <td>${esc(e2.category_name || '—')}</td>
      <td>${esc(e2.description)}</td>
      <td class="stat-red">${fmtMoney(e2.amount_c)}</td>
      <td>${methodBadge(e2.method)}</td>
      <td>${esc(e2.supporting_doc || '—')}</td>
      <td>${esc(e2.recorded_by || '—')}</td>
      <td>
        <button class="btn btn-outline" data-exp-edit="${e2.id}">Edit</button>
        <button class="btn btn-danger" data-exp-del="${e2.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="11" class="muted">No expense records found for this filter.</td></tr>';

  tbody.querySelectorAll('[data-exp-edit]').forEach((b) =>
    b.addEventListener('click', () => loadExpenseForEdit(Number(b.dataset.expEdit))));
  tbody.querySelectorAll('[data-exp-del]').forEach((b) =>
    b.addEventListener('click', () => deleteWithConfirm(
      () => window.treasuryAPI.expDelete(Number(b.dataset.expDel)),
      'Delete this expense record? Its linked ledger entry is removed and the action is recorded in the audit trail.',
      () => { renderRoute('expenses'); })));
}

async function loadExpenseForEdit(id) {
  try {
    const e2 = await window.treasuryAPI.expGet(id);
    const form = $('#form-expense');
    form.dataset.id = e2.id;
    form.elements.barangayId.value = e2.barangay_id;
    form.elements.txnDate.value = e2.txn_date;
    form.elements.categoryId.value = e2.category_id || '';
    form.elements.payee.value = e2.payee;
    form.elements.description.value = e2.description;
    form.elements.amount.value = (e2.amount_c / 100).toFixed(2);
    form.elements.method.value = e2.method;
    form.elements.supportingDoc.value = e2.supporting_doc || '';
    form.elements.recordedBy.value = e2.recorded_by || '';
    form.elements.remarks.value = e2.remarks || '';
    $('#exp-form-title').textContent = `Edit Expense ${e2.ref_no}`;
    $('#exp-submit').textContent = 'Save changes';
    $('#exp-cancel').classList.remove('hidden');
    $('#form-expense').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { alert(err.message); }
}

async function postRenderExpenses() {
  await populateFilterOptions('exp');
  const f = $('#form-expense');
  const [brgys, cats] = await Promise.all([window.treasuryAPI.listB(), window.treasuryAPI.cats('expense')]);
  for (const b of brgys) f.elements.barangayId.appendChild(new Option(b.name, b.id));
  f.elements.categoryId.appendChild(new Option('— none —', ''));
  for (const c of cats) f.elements.categoryId.appendChild(new Option(c.name, c.id));
  f.elements.txnDate.value = todayISO();

  $('#exp-filters').addEventListener('input', () => {
    refreshExpTable(readFilters('exp'));
    refreshExpSummary(readFilters('exp'));
  });

  const okMsg = $('#exp-ok'), errMsg = $('#exp-err'), submit = $('#exp-submit');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    okMsg.hidden = errMsg.hidden = true;
    if (submit.disabled) return;
    const fd = new FormData(f);
    const payload = {
      barangayId: fd.get('barangayId'), txnDate: fd.get('txnDate'),
      categoryId: fd.get('categoryId') || null, payee: fd.get('payee'),
      description: fd.get('description'), amount: fd.get('amount'),
      method: fd.get('method'), supportingDoc: fd.get('supportingDoc'),
      recordedBy: fd.get('recordedBy'), remarks: fd.get('remarks'),
    };
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      const id = f.dataset.id;
      if (id) {
        await window.treasuryAPI.expUpdate(Number(id), payload);
        okMsg.textContent = 'Expense updated.';
      } else {
        const saved = await window.treasuryAPI.expCreate(payload);
        okMsg.textContent = `Expense saved with reference ${saved.ref_no}.`;
      }
      okMsg.hidden = false;
      f.reset(); f.dataset.id = ''; f.elements.txnDate.value = todayISO();
      $('#exp-form-title').textContent = 'Add Expense';
      $('#exp-submit').textContent = 'Save expense';
      $('#exp-cancel').classList.add('hidden');
      await Promise.all([refreshExpTable(readFilters('exp')), refreshExpSummary(readFilters('exp'))]);
    } catch (err) {
      errMsg.textContent = err.message; errMsg.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = f.dataset.id ? 'Save changes' : 'Save expense';
    }
  });

  $('#exp-cancel').addEventListener('click', () => {
    f.reset(); f.dataset.id = ''; f.elements.txnDate.value = todayISO();
    $('#exp-form-title').textContent = 'Add Expense';
    $('#exp-submit').textContent = 'Save expense';
    $('#exp-cancel').classList.add('hidden');
  });

  await Promise.all([refreshExpTable({}), refreshExpSummary({})]);
}

/* ============================================================
   TRANSACTIONS (unified ledger)
   ============================================================ */
async function pageTransactions() {
  return `
    <div class="card" id="txn-summary-card"></div>
    <div class="card">
      <h2>Transactions — Unified Ledger</h2>
      <p class="card-sub">All recorded collections and expenses. Actual records only (sample data excluded from summaries).</p>
      ${filterBarHtml('txn')}
      <div class="table-wrap"><table id="txn-table">
        <thead><tr><th>Date</th><th>Barangay</th><th>Type</th><th>Description</th><th>Party</th>
        <th>Category</th><th>Ref / OR No.</th><th>Amount</th><th>Method</th></tr></thead>
        <tbody><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>`;
}

async function refreshTxnTable(filters) {
  const rows = await window.treasuryAPI.list(filters || {});
  const tbody = $('#txn-table tbody');
  tbody.innerHTML = rows.length ? rows.map((t) => `
    <tr>
      <td>${esc(t.txn_date)}</td>
      <td>${esc(t.barangay_name)}</td>
      <td>${txnBadge(t.kind)}</td>
      <td>${esc(t.description)} ${t.is_sample ? sampleBadge() : ''}</td>
      <td>${esc(t.payee || '—')}</td>
      <td>${esc(t.category_name || '—')}</td>
      <td>${esc(t.or_number || '—')}</td>
      <td class="${t.kind === 'collection' ? 'stat-green' : 'stat-red'}">${fmtMoney(t.amount_c)}</td>
      <td>${methodBadge(t.method)}</td>
    </tr>`).join('') : '<tr><td colspan="9" class="muted">No transactions found for this filter.</td></tr>';
}

async function refreshTxnSummary(filters) {
  const s = await window.treasuryAPI.finSummary(filters || {});
  const card = $('#txn-summary-card');
  if (!card) return;
  const scope = filters?.barangayId
    ? 'Selected barangay'
    : (s.multiBarangay ? '<span class="badge badge-amber">Multiple barangays combined</span>' : 'All barangays');
  const rows = s.perBarangay.map((p) => `
    <tr><td>${esc(p.name)}</td>
    <td class="stat-green">${fmtMoney(p.collections_c)}</td>
    <td class="stat-red">${fmtMoney(p.expenses_c)}</td>
    <td>${fmtMoney(p.collections_c - p.expenses_c)}</td>
    <td>${p.n}</td></tr>`).join('');
  card.innerHTML = `
    <h2>Financial Summary</h2>
    <p class="card-sub">Scope: ${scope}</p>
    <div class="grid-3" style="margin-bottom:12px">
      <div><div class="stat-label">Total collections</div>
        <div class="stat-value stat-green">${fmtMoney(s.collections_c)}</div></div>
      <div><div class="stat-label">Total expenses</div>
        <div class="stat-value stat-red">${fmtMoney(s.expenses_c)}</div></div>
      <div><div class="stat-label">Net recorded amount</div>
        <div class="stat-value">${fmtMoney(s.net_c)}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Barangay</th><th>Collections</th><th>Expenses</th><th>Net</th><th>Transactions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No records in this scope yet.</td></tr>'}</tbody>
    </table></div>
    <p class="card-sub" style="margin-top:8px">Transactions in scope: <strong>${s.n}</strong>
    ${s.multiBarangay ? ' · totals cover <strong>multiple barangays</strong>, not a single barangay.' : ''}</p>`;
}

async function postRenderTransactions() {
  await populateFilterOptions('txn');
  $('#txn-filters').addEventListener('input', () => {
    refreshTxnTable(readFilters('txn'));
    refreshTxnSummary(readFilters('txn'));
  });
  await Promise.all([refreshTxnTable({}), refreshTxnSummary({})]);
}

/* ---------------- shared delete confirmation ---------------- */
function deleteWithConfirm(actionFn, message, after) {
  // Custom modal is avoided; native confirm is sufficient for a desktop app
  // and guarantees the user must act before deletion proceeds.
  if (window.confirm(message)) {
    Promise.resolve(actionFn()).then((res) => {
      if (res && res.ref) alert(`Deleted ${res.ref}. This action was recorded in the audit trail.`);
      after && after(res);
    }).catch((err) => alert(err.message));
  }
}

/* ============================================================
   ROUTE WIRING
   - "Transactions" nav item → unified ledger page.
   - "Collections and Receipts" nav item → collections page followed by
     the receipt management page (both modules on one screen).
   ============================================================ */
const _rawPageCollections = pageCollections;
const _rawPostRenderCollections = postRenderCollections;

async function pageCollectionsAndReceipts() {
  return (await _rawPageCollections()) + '\n' + (await pageReceipts());
}

async function postRenderCollectionsAndReceipts() {
  await _rawPostRenderCollections();
  await postRenderReceipts();
}

PLACEHOLDER_PAGES.collections = pageCollectionsAndReceipts;
POST_RENDER.collections = postRenderCollectionsAndReceipts;
