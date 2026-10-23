/**
 * ui.js — reusable UI helpers (formatting, badges, DOM builders, icons).
 */
'use strict';

/* ---------- Money helpers (centavos <-> peso display) ---------- */
function fmtMoney(c) {
  const n = (Number(c) || 0) / 100;
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseMoney(str) {
  const s = String(str ?? '').replace(/[₱,\s]/g, '');
  return /^\d+(\.\d{1,2})?$/.test(s) ? s : null;
}
const KIND_LABEL = { collection: 'Collection', expense: 'Expense' };
const STATUS_LABEL = { draft: 'Draft', posted: 'Posted', void: 'Void' };

/* ---------- Badges ---------- */
function badge(text, tone = 'gray') {
  return `<span class="badge badge-${tone}">${esc(text)}</span>`;
}
function txnBadge(kind) {
  return kind === 'collection' ? badge('Collection', 'green') : badge('Expense', 'red');
}
function statusBadge(s) {
  const tone = s === 'posted' ? 'green' : s === 'draft' ? 'amber' : 'red';
  return badge(STATUS_LABEL[s] || s, tone);
}
function sampleBadge() { return badge('SAMPLE', 'gold'); }

/* ---------- Icons (inline SVG paths, no network) ---------- */
const ICONS = {
  dashboard: '📊', barangays: '🏘️', transactions: '🔁', collections: '🧾',
  expenses: '💸', budgets: '📈', reports: '📄', tasks: '✅',
  audit: '🛡️', backup: '💾', settings: '⚙️',
};

/* ---------- DOM / escaping ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function $(sel, root = document) { return root.querySelector(sel); }
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(d) {
  try { return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return d; }
}
