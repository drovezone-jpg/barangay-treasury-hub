/**
 * app.js — application bootstrap: auth flow, navigation, routing.
 */
'use strict';

let SAMPLE_MODE = false;

/* ---------------- Routing ---------------- */
const POST_RENDER = { dashboard: postRenderDashboard, barangays: postRenderBarangays,
  transactions: postRenderTransactions, collections: postRenderCollections, expenses: postRenderExpenses,
  budgets: postRenderBudgets, reports: postRenderReports,
  tasks: postRenderTasks, audit: postRenderAudit, backup: postRenderBackup, settings: postRenderSettings };

async function renderRoute(key) {
  const content = $('#content');
  content.innerHTML = '<div class="card muted">Loading…</div>';
  try {
    let html;
    if (key === 'dashboard') html = await pageDashboard();
    else if (key === 'barangays') html = await pageBarangays();
    else if (PLACEHOLDER_PAGES[key]) html = await PLACEHOLDER_PAGES[key]();
    else html = '<div class="card"><h2>Module coming soon</h2></div>';
    content.innerHTML = html;
    if (POST_RENDER[key]) POST_RENDER[key]();
  } catch (err) {
    content.innerHTML = `<div class="card"><p class="form-error">${esc(err.message)}</p></div>`;
  }
}

function buildNav() {
  const nav = $('#sidebar-nav');
  nav.innerHTML = NAV_ITEMS.map(([key, label]) => `
    <button class="nav-item" data-route="${key}">
      <span class="nav-icon">${ICONS[key]}</span>${esc(label)}
    </button>`).join('');
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    btn.classList.add('active');
    renderRoute(btn.dataset.route);
  });
  nav.querySelector('.nav-item')?.classList.add('active');
  return 'dashboard';
}

/* ---------------- Auth ---------------- */
async function initAuth() {
  const { hasUser } = await window.treasuryAPI.status();
  const submit = $('#auth-submit');
  const err = $('#auth-error');
  $('#auth-displayname').parentElement.hidden = hasUser;
  submit.textContent = hasUser ? 'Sign in' : 'Create treasurer account';

  const show = (msg) => { err.textContent = msg; err.hidden = false; };

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    if (!username) return show('Please enter your username.');
    if (!hasUser && password.length < 8)
      return show('Password must be at least 8 characters.');
    try {
      if (hasUser) {
        const res = await window.treasuryAPI.login({ username, password });
        enterApp(res.displayName || username);
      } else {
        const reg = await window.treasuryAPI.register({
          username, password, displayName: $('#auth-displayname').value.trim() || username,
        });
        // Registration signs the user straight in (requirement 4).
        enterApp(reg.displayName || username);
      }
    } catch (ex) {
      // IPC errors from auth.js are already user-friendly and never expose
      // internals; fall back to a generic message just in case.
      show(typeof ex.message === 'string' && ex.message && !/SQLITE|Error:/i.test(ex.message)
        ? ex.message
        : 'Sign in failed. Please check your credentials and try again.');
    }
  });
}

async function enterApp(username) {
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#user-name').textContent = username;
  $('#user-initial').textContent = (username[0] || 'T').toUpperCase();
  const first = buildNav();
  renderRoute(first);
}

/* ---------------- Boot ---------------- */
window.addEventListener('DOMContentLoaded', async () => {
  const info = await window.treasuryAPI.info();
  $('#header-date').textContent = fmtDate(info.currentDate);
  initAuth();

  $('#btn-load-sample').addEventListener('click', async () => {
    const res = await window.treasuryAPI.loadSample();
    SAMPLE_MODE = true;
    $('#sample-mode-badge').hidden = false;
    alert(res.message + ' All sample rows are clearly labeled and excluded from real reports.');
    const active = document.querySelector('.nav-item.active');
    renderRoute(active ? active.dataset.route : 'dashboard');
  });
});
