import * as F from './db.js';
import * as L from './logic.js';
import { t, getLang, setLang } from './i18n.js';
import { APP_NAME, ADMIN_USERNAME } from './config.js';
import { KERALA_HOLIDAYS } from './holidays.js';

// ---------- state ----------
const DEFAULT_SCRAP_TYPES = ['Aluminium', 'Steel', 'Ottu', 'Copper', 'Others'];
const S = {
  user: null, profile: null, sid: null,
  users: {}, settings: { defaultMarginPct: 100, legacyMarginPct: 85 },
  customers: {}, accounts: {}, complaints: {}, catalog: {}, events: {}, routeChanges: {}, phoneIdx: {}, meals: {}, itemNames: [], itemPrices: {},
  subs: [], sellerSubs: [], refresh: null,
};
const scrapTypes = () => (S.settings.scrapTypes?.length ? S.settings.scrapTypes : DEFAULT_SCRAP_TYPES);

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const rmoney = (n) => money(Math.round(Number(n) || 0));
const pdfMoney = (n) => 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const num = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const today = () => L.todayStr();
const fmtDate = (d) => (d && d !== '0000-00-00' ? d.split('-').reverse().join('-') : '');
const isAdmin = () => S.profile?.role === 'admin';
const userName = (uid) => S.users[uid]?.name || '—';
// Seller data is stored under a sellerKey, so a replacement login can take over the same customers.
const keyOf = (uid, u = S.users[uid]) => u?.sellerKey || uid;
const sellers = () => Object.entries(S.users).filter(([, u]) => u.role === 'seller' && u.active !== false).map(([id, u]) => ({ ...u, uid: id, id: keyOf(id, u) }));
const sellerName = (key) => sellers().find((s) => s.id === key)?.name || userName(key);
const FREQ = ['daily', 'weekly', 'monthly'];
// Route days: JS getDay() numbers (Sun=0). Thursday and Friday have no route.
const ROUTE_DAYS = [1, 2, 3, 6, 0];
const DAY_KEYS = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 6: 'sat' };
const dayLabel = (d) => t({ 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 6: 'Sat' }[d]);
const todayDay = () => new Date().getDay();
const daysOf = (c) => (Array.isArray(c?.days) ? c.days : []);
const dayPicker = (sel = []) => `<div class="daypick">${ROUTE_DAYS.map((d) =>
  `<label><input type="checkbox" name="day" value="${d}" ${sel.includes(d) ? 'checked' : ''}><span>${dayLabel(d)}</span></label>`).join('')}</div>`;
// Phones: [{label, number, primary}]; c.phone always mirrors the default number.
const phonesOf = (c) => (Array.isArray(c?.phones) && c.phones.length ? c.phones : c?.phone ? [{ label: '', number: c.phone, primary: true }] : []);
const PHONE_LABELS = ['Self', 'Husband', 'Wife', 'Son', 'Daughter', 'Home phone', 'Neighbour'];
const placeOf = (c) => [c?.house, c?.lane].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
const placeBadge = (c, big = false) => (placeOf(c) ? `<span class="place ${big ? 'big' : ''}">📍 ${esc(placeOf(c))}</span>` : '');
const houseCmp = (a, b) => String(a.house || '').localeCompare(String(b.house || ''), 'en', { numeric: true, sensitivity: 'base' });
const searchHit = (c, q) => !q || [c.name, c.lane, c.house, ...phonesOf(c).map((p) => p.number)].some((x) => String(x || '').toLowerCase().includes(q));
const phoneRowHtml = (p = {}, i = 0) => `<div class="phonerow">
  <input name="pl" list="plabels" placeholder="${t('Label')}" value="${esc(p.label || '')}">
  <input name="pn" type="tel" inputmode="tel" placeholder="${t('Number')}" value="${esc(p.number || '')}">
  <label class="star" title="${t('Default')}"><input type="radio" name="pdef" value="${i}" ${p.primary ? 'checked' : ''}><span>★</span></label>
  <button type="button" class="x" data-prm>×</button></div>`;
// Contact Picker (Chrome on Android): the person picks one contact; the app never reads the whole list.
const canPickContact = () => 'contacts' in navigator && typeof navigator.contacts?.select === 'function';
/** Indian mobile numbers as 10 digits (drops +91 / 91 / 0, spaces and dashes); other numbers kept as typed digits. */
function cleanPhone(raw) {
  const s = String(raw || '').trim(), d = s.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  if (d.length === 10) return d;
  return (s.startsWith('+') ? '+' : '') + d;
}
async function pickContact() {
  try {
    const [c] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
    if (!c) return null;
    const numbers = [...new Set((c.tel || []).map(cleanPhone).filter((n) => n.replace(/\D/g, '').length >= 6))];
    return { name: String((c.name || [])[0] || '').trim(), numbers };
  } catch (e) { if (e?.name !== 'AbortError' && e?.name !== 'InvalidStateError') toast(t('Could not open contacts'), true); return null; }
}
/** Small in-page chooser (no browser popup). Resolves to the index picked, or null on cancel. */
function askChoice(title, options) {
  return new Promise((done) => {
    const ov = document.createElement('div');
    ov.className = 'qrov';
    ov.innerHTML = `<div class="card choice" role="dialog"><b>${esc(title)}</b>
      ${options.map((o, i) => `<button type="button" class="btn" data-ch="${i}">📞 ${esc(o)}</button>`).join('')}
      <button type="button" class="btn ghost" data-ch="x">${t('Cancel')}</button></div>`;
    document.body.appendChild(ov);
    const end = (v) => { ov.remove(); done(v); };
    $$('[data-ch]', ov).forEach((b) => (b.onclick = () => end(b.dataset.ch === 'x' ? null : Number(b.dataset.ch))));
    ov.onclick = (e) => { if (e.target === ov) end(null); };
  });
}
/** Small in-page number prompt. Resolves to a whole number between 1 and max, or null on cancel. */
function askNumber(title, value, max) {
  return new Promise((done) => {
    const ov = document.createElement('div');
    ov.className = 'qrov';
    ov.innerHTML = `<form class="card choice" role="dialog"><b>${esc(title)}</b>
      <input type="number" name="n" min="1" max="${max}" step="1" inputmode="numeric" value="${value}">
      <button class="btn primary" type="submit">${t('Save')}</button><button type="button" class="btn ghost" data-x>${t('Cancel')}</button></form>`;
    document.body.appendChild(ov);
    const f = $('form', ov), end = (v) => { ov.remove(); done(v); };
    f.n.focus(); f.n.select();
    f.onsubmit = (e) => { e.preventDefault(); const v = Math.round(num(f.n.value)); if (!(v >= 1)) return; end(Math.min(v, max)); };
    $('[data-x]', ov).onclick = () => end(null);
    ov.onclick = (e) => { if (e.target === ov) end(null); };
  });
}
const modeLabel = (m) => (m === 'upi' ? 'UPI' : m === 'scrap' ? t('Scrap') : t('Cash'));
const MODE_ICON = { cash: '💵', upi: '📱', scrap: '♻️' };
const MODE_EN = { cash: 'Cash', upi: 'UPI', scrap: 'Scrap' };
const payPicker = (name, sel, modes = ['cash', 'upi']) => `<div class="seg" role="radiogroup">${modes.map((m) =>
  `<label><input type="radio" name="${name}" value="${m}" ${m === sel ? 'checked' : ''}><span>${MODE_ICON[m]} ${modeLabel(m)}</span></label>`).join('')}</div>`;
const pickedMode = (name, root = document) => root.querySelector(`input[name=${name}]:checked`)?.value || 'cash';
const splitLine = (cash, upi, scrap = 0) => `${t('Cash')} ${money(cash)} · UPI ${money(upi)}${scrap ? ` · ${t('Scrap')} ${money(scrap)}` : ''}`;
// Collections taken as scrap list what was taken: [{type, value}]
const scrapDetail = (x) => (x?.scrapItems || []).map((i) => `${t(i.type)} ${money(i.value)}`).join(', ');
const ymd = (d) => L.todayStr(d);
const shortDate = (d) => (d ? d.slice(8, 10) + '-' + d.slice(5, 7) : '');
const holidayName = (h) => (getLang() === 'ml' && h.ml ? h.ml : h.en || h.name);
/** All general-calendar entries: built-in Kerala holidays + events the admin added. */
const allEvents = () => [...KERALA_HOLIDAYS.map((h) => ({ ...h, name: holidayName(h) })),
  ...Object.values(S.events).map((e) => ({ ...e, name: e.name, holiday: !!e.holiday }))];
/** What to visit today after holiday decisions: { days: [{day, moved}], change }. */
const todayPlan = () => L.dayPlan(today(), S.routeChanges, ROUTE_DAYS);
const onTodayRoute = (c, plan = todayPlan()) => plan.days.some((d) => daysOf(c).includes(d.day));
const freqLabel = (f) => t({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[f] || f || '');

function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = 'toast'), 2600);
}
const onWriteError = (e) => toast(t('Could not save') + ': ' + (e.code || e.message), true);
const go = (h) => { location.hash = h; };

function setTitle(title, back, sub = '') {
  $('#title').textContent = title;
  $('#hsub').textContent = sub;
  $('#hlogo').hidden = !!back || title !== APP_NAME;
  const b = $('#back');
  b.hidden = !back;
  b.onclick = () => (typeof back === 'string' ? go(back) : history.back());
}

function sellerBar() {
  if (!isAdmin()) return '';
  const opts = sellers().map((s) => `<option value="${s.id}" ${s.id === S.sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `<div class="sellerbar"><label>${t('Viewing seller')}</label><select id="sellerPick"><option value="">—</option>${opts}</select></div>`;
}
function bindSellerBar() {
  const sel = $('#sellerPick');
  if (sel) sel.onchange = () => { selectSeller(sel.value); route(); };
}
function needSeller() {
  if (S.sid) return false;
  view.innerHTML = sellerBar() + `<div class="empty">${t('Choose a seller above to see their customers.')}</div>`;
  bindSellerBar();
  return true;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if ($(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ---------- subscriptions ----------
function subscribeGlobal() {
  S.subs.forEach((u) => u()); S.subs = [];
  S.subs.push(F.onSnapshot(F.doc(F.db, 'settings', 'main'), (d) => {
    if (d.exists()) Object.assign(S.settings, d.data());
  }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'users'), (qs) => {
    S.users = {}; qs.forEach((d) => (S.users[d.id] = d.data()));
    if (isAdmin() && !S.sid) { const saved = localStorage.getItem('sid'); if (saved && sellers().some((x) => x.id === saved)) selectSeller(saved); }
    live();
  }));
  S.subs.push(F.onSnapshot(F.query(F.collection(F.db, 'complaints'), F.where('status', '==', 'open')), (qs) => {
    S.complaints = {}; qs.forEach((d) => (S.complaints[d.id] = { id: d.id, ...d.data() })); live();
  }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'catalog'), (qs) => { S.catalog = {}; qs.forEach((d) => (S.catalog[d.id] = { id: d.id, ...d.data() })); }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'events'), (qs) => { S.events = {}; qs.forEach((d) => (S.events[d.id] = { id: d.id, ...d.data() })); live(); }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'phoneIndex'), (qs) => {
    S.phoneIdx = {}; qs.forEach((d) => { const x = { id: d.id, ...d.data() }; (S.phoneIdx[x.hash] ||= []).push(x); }); live();
  }));
  if (!isAdmin()) subscribeMeals();
}

let mealsSub = null, mealsDay = '';
function subscribeMeals() {
  if (mealsDay === today() && mealsSub) return;
  if (mealsSub) mealsSub();
  mealsDay = today(); S.meals = {};
  mealsSub = F.onSnapshot(F.query(F.collection(F.db, 'meals'), F.where('date', '==', mealsDay)), (qs) => { S.meals = {}; qs.forEach((d) => (S.meals[d.id] = { id: d.id, ...d.data() })); live(); });
  S.subs.push(() => { if (mealsSub) mealsSub(); mealsSub = null; mealsDay = ''; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.profile && !isAdmin() && mealsDay && mealsDay !== today()) subscribeMeals(); });

function selectSeller(sid) {
  S.sellerSubs.forEach((u) => u()); S.sellerSubs = [];
  S.sid = sid || null; S.customers = {}; S.accounts = {}; S.routeChanges = {}; S.itemNames = []; S.itemPrices = {}; S.upi = null;
  if (isAdmin()) localStorage.setItem('sid', sid || '');
  if (!sid) return;
  S.sellerSubs.push(F.onSnapshot(F.sellerCol(sid, 'routeChanges'), (qs) => { S.routeChanges = {}; qs.forEach((d) => (S.routeChanges[d.id] = { id: d.id, ...d.data() })); live(); }));
  S.sellerSubs.push(F.onSnapshot(F.sellerCol(sid, 'customers'), (qs) => { S.customers = {}; qs.forEach((d) => (S.customers[d.id] = { id: d.id, ...d.data() })); live(); }));
  S.sellerSubs.push(F.onSnapshot(F.sellerDoc(sid, 'meta', 'upi'), (d) => { S.upi = d.exists() ? d.data() : null; }));
  S.sellerSubs.push(F.onSnapshot(F.sellerDoc(sid, 'meta', 'items'), (d) => {
    const x = d.exists() ? d.data() : {}, its = Object.entries(x).filter(([k, v]) => k.startsWith('i_') && v && v.name);
    S.itemNames = its.map(([, v]) => v.name); S.itemPrices = Object.fromEntries(its.map(([k, v]) => [k.slice(2), v.price]));
  }));
  S.sellerSubs.push(F.onSnapshot(F.sellerCol(sid, 'accounts'), (qs) => { S.accounts = {}; qs.forEach((d) => (S.accounts[d.id] = { id: d.id, ...d.data() })); live(); }));
}

function live() {
  const a = document.activeElement;
  if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return;
  if (S.refresh) S.refresh();
}

const accountsOf = (cid) => Object.values(S.accounts).filter((a) => a.customerId === cid);
// A customer is "paused" when every open account is inactive: kept in the route list (marked ⏸) but not counted.
const pausedCust = (cid) => { const o = accountsOf(cid).filter((a) => a.status !== 'closed'); return o.length > 0 && o.every((a) => a.inactive); };
const pauseMark = (cid) => (pausedCust(cid) ? `<span class="pill pause" title="${t('Inactive')}">⏸</span> ` : '');
const openBalance = (cid) => L.round2(accountsOf(cid).filter((a) => a.status !== 'closed').reduce((s, a) => s + (a.balance || 0), 0));

// ---------- auth ----------
F.onAuthStateChanged(F.auth, async (user) => {
  S.subs.forEach((u) => u()); S.sellerSubs.forEach((u) => u()); S.subs = []; S.sellerSubs = [];
  S.user = user; S.profile = null; S.sid = null;
  if (!user) { renderLogin(); return; }
  try {
    const ref = F.doc(F.db, 'users', user.uid);
    let snap = await F.getDoc(ref);
    if (!snap.exists() && user.email === F.emailOf(ADMIN_USERNAME)) {
      await F.setDoc(ref, { username: ADMIN_USERNAME, name: 'Admin', role: 'admin', active: true });
      const st = F.doc(F.db, 'settings', 'main');
      if (!(await F.getDoc(st)).exists()) await F.setDoc(st, { defaultMarginPct: 100, legacyMarginPct: 85 });
      snap = await F.getDoc(ref);
    }
    if (!snap.exists() || snap.data().active === false) { toast(t('This login is not active'), true); await F.logout(); return; }
    S.profile = snap.data();
  } catch (e) {
    toast(t('Could not load profile. Check internet and try again.'), true); console.error(e);
    view.innerHTML = `<div class="empty"><button class="btn" onclick="location.reload()">${t('Retry')}</button></div>`;
    return;
  }
  subscribeGlobal();
  if (!isAdmin()) selectSeller(S.profile.sellerKey || user.uid);
  document.body.classList.toggle('admin', isAdmin());
  $('#nav').hidden = false;
  if (!location.hash || location.hash === '#/login') go('#/home'); else route();
});

function renderLogin() {
  $('#nav').hidden = true;
  setTitle(APP_NAME); $('#hlogo').hidden = true;
  view.innerHTML = `
  <form id="loginForm" class="card login">
    <img class="loginlogo" src="icons/logo.svg" alt=""><div class="brand">${esc(APP_NAME)}</div>
    <label>${t('Username')}<input name="u" autocomplete="username" autocapitalize="none" required></label>
    <label>${t('Password')}<input name="p" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
    <div id="loginErr" class="loginerr"></div>
    <button class="btn primary" type="submit">${t('Log in')}</button>
    <button class="btn ghost" type="button" id="langBtn">${getLang() === 'ml' ? 'English' : 'മലയാളം'}</button>
  </form>`;
  $('#langBtn').onclick = () => { setLang(getLang() === 'ml' ? 'en' : 'ml'); renderLogin(); };
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await F.login(f.u.value, f.p.value); } catch (err) {
      const code = err.code || err.message || '';
      const msg = /invalid-credential|invalid-login|wrong-password|user-not-found|invalid-email/.test(code) ? t('Wrong username or password')
        : /network-request-failed/.test(code) ? t('No internet connection')
        : /too-many-requests/.test(code) ? t('Too many tries. Wait a few minutes and try again.')
        : /user-disabled/.test(code) ? t('This login is not active')
        : t('Login failed');
      $('#loginErr').innerHTML = `${esc(msg)}<small>${esc(code)} · ${esc(F.emailOf(f.u.value))}</small>`;
      toast(msg, true);
    }
  };
}

// ---------- router ----------
const routes = [
  [/^#\/home$/, renderHome],
  [/^#\/customers$/, renderCustomers],
  [/^#\/customer-new$/, () => renderCustomerForm(null)],
  [/^#\/customer-edit\/(\w+)$/, (id) => renderCustomerForm(id)],
  [/^#\/customer\/(\w+)$/, renderCustomer],
  [/^#\/account\/(\w+)\/(\w+)$/, renderAccount],
  [/^#\/sale\/(\w+)\/(\w+)$/, renderSale],
  [/^#\/collect\/(\w+)\/(\w+)$/, renderCollect],
  [/^#\/return\/(\w+)\/(\w+)$/, renderReturn],
  [/^#\/pick\/(sale|collect|order)$/, renderPick],
  [/^#\/complaints$/, renderComplaints],
  [/^#\/expenses$/, () => renderExpenses(false)],
  [/^#\/company-expenses$/, () => renderExpenses(true)],
  [/^#\/report$/, renderReport],
  [/^#\/menu$/, renderMenu],
  [/^#\/settings$/, renderSettings],
  [/^#\/users$/, renderUsers],
  [/^#\/app-settings$/, renderAppSettings],
  [/^#\/relogin\/([\w-]+)\/(handover|reset)$/, renderRelogin],
  [/^#\/backup$/, renderBackup],
  [/^#\/records$/, renderRecords],
  [/^#\/print-list$/, renderPrintList],
  [/^#\/categories$/, renderCategories],
  [/^#\/shop-link$/, renderShopLink],
  [/^#\/scrap$/, renderScrap],
  [/^#\/orders$/, renderOrders],
  [/^#\/order\/(\w+)$/, (cid) => renderOrderForm(cid, null)],
  [/^#\/order-edit\/(\w+)$/, (oid) => renderOrderForm(null, oid)],
  [/^#\/deliver\/(\w+)$/, renderDeliver],
  [/^#\/close-day$/, renderCloseDay],
  [/^#\/collections$/, renderCollections],
  [/^#\/upi$/, renderUpiSetup],
  [/^#\/cash-sale$/, renderCashSale],
  [/^#\/catalog$/, renderCatalog],
  [/^#\/catalog-edit\/([\w-]+)$/, renderCatalogEdit],
  [/^#\/cash-sales$/, renderCashSales],
  [/^#\/cash-return\/(\w+)$/, renderCashReturn],
];
const adminOnly = ['#/company-expenses', '#/users', '#/app-settings', '#/backup', '#/categories', '#/scrap', '#/catalog'];

async function route() {
  if (!S.profile) return;
  S.refresh = null;
  document.querySelectorAll('.tipbubble').forEach((x) => x.remove());
  const h = location.hash || '#/home';
  if (adminOnly.includes(h) && !isAdmin()) return go('#/home');
  $$('#nav a').forEach((a) => a.classList.toggle('on', h.startsWith(a.getAttribute('href'))));
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      try { await fn(...m.slice(1)); } catch (e) { console.error(e); toast(t('Something went wrong') + ': ' + (e.message || e), true); }
      window.scrollTo(0, 0);
      return;
    }
  }
  go('#/home');
}
window.addEventListener('hashchange', route);

// ---------- home ----------
const homeDate = () => new Date().toLocaleDateString(getLang() === 'ml' ? 'ml-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

async function renderHome() {
  setTitle(APP_NAME, null, homeDate());
  if (isAdmin() && !S.sid) {
    view.innerHTML = sellerBar() + `<div class="grid2">
      <a class="tile" href="#/report">📊 ${t('Reports')}</a>
      <a class="tile" href="#/orders">🚚 ${t('Orders')}</a>
      <a class="tile" href="#/company-expenses">${t('Company expenses')}</a>
      <a class="tile" href="#/complaints">${t('Complaints')} (${Object.keys(S.complaints).length})</a>
      <a class="tile" href="#/scrap">♻️ ${t('Scrap')}</a>
      <a class="tile" href="#/users">${t('Users')}</a></div>
      <div class="empty">${t('Choose a seller above to work on their customers.')}</div>
      <div id="calw"></div>
      <h3>🧮 ${t('Calculator')}</h3><div id="calcw"></div>`;
    bindSellerBar();
    mountCalendar($('#calw')); mountCalculator($('#calcw'));
    return;
  }
  const d = today(), sid = S.sid;
  view.innerHTML = sellerBar() + `<div class="loading">…</div>`;
  bindSellerBar();
  const [cols, exps, notes, visits, orders, closed] = await Promise.all([
    F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('date', '==', d))),
    F.fetchAll(F.query(F.sellerCol(sid, 'expenses'), F.where('date', '==', d))),
    F.fetchAll(F.query(F.sellerCol(sid, 'notes'), F.where('done', '==', false))),
    F.fetchAll(F.query(F.sellerCol(sid, 'visits'), F.where('date', '==', d))),
    F.fetchAll(F.query(F.sellerCol(sid, 'orders'), F.where('status', '==', 'pending'))),
    F.getDoc(F.sellerDoc(sid, 'dayClose', d)).then((x) => x.exists()).catch(() => false),
  ]);
  if (location.hash && location.hash !== '#/home') return;
  const fig = L.sellerReport({ collections: cols, expenses: exps });
  const due = notes.filter((n) => n.dueDate && n.dueDate <= d).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const soon = notes.filter((n) => n.dueDate && n.dueDate > d).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)).slice(0, 10);
  const noteRow = (n) => `<li class="task ${n.dueDate < d ? 'late' : ''}">
      <input type="checkbox" data-done="${n.id}">
      <a href="#/customer/${n.customerId}"><b>${esc(S.customers[n.customerId]?.name || n.customerName || '')}</b> · ${n.kind === 'promise' ? '🤝 ' : ''}${esc(n.text)}</a>
      <span class="muted">${fmtDate(n.dueDate)}</span></li>`;
  const deliver = orders.filter((o) => o.deliveryDate <= d);
  const busy = ROUTE_DAYS.filter((wd) => Object.values(S.customers).some((c) => daysOf(c).includes(wd)));
  const alerts = L.routeAlerts(d, allEvents(), S.routeChanges, busy, 2, ROUTE_DAYS);
  view.innerHTML = sellerBar() + `
    <div class="stats">
      <a class="stat" href="#/collections" id="colStat" onclick="try{sessionStorage.setItem('colDay','')}catch(e){}"><span>${t("Today's collection")} ›</span><b>${money(fig.collected)}</b><small>${splitLine(fig.collectedCash, fig.collectedUpi, fig.collectedScrap)}</small></a>
      <a class="stat" href="#/expenses"><span>${t('Cash in hand')} ›</span><b>${money(fig.cashInHand)}</b><small>${t('Expenses')} ${money(fig.expense)}</small></a>
    </div>
    ${alerts.map(alertCard).join('')}
    ${routeTile(new Set(cols.filter((c) => c.kind !== 'discount').map((c) => c.customerId)), new Set(visits.map((v) => v.customerId)))}
    ${deliver.length ? `<a class="banner" href="#/orders" style="display:block;text-decoration:none"><b>🚚 ${t("Today's deliveries")}: ${deliver.length}</b>
      <span class="small muted">${esc(Object.entries(deliver.flatMap((o) => o.items).reduce((m, i) => ((m[i.name] = (m[i.name] || 0) + Number(i.qty || 0)), m), {})).map(([n, q]) => `${n} × ${q}`).join(', '))}</span></a>` : ''}
    <div class="grid2">
      <a class="tile primary" href="#/pick/collect">+ ${t('Collection')}</a>
      <a class="tile" href="#/pick/sale">+ ${t('New sale')}</a>
      <a class="tile" href="#/pick/order">🚚 + ${t('Order')}</a>
      <a class="tile" href="#/cash-sale">🛒 ${t('Cash sale')}</a>
      <a class="tile" href="#/expenses">+ ${t('Expense')}</a>
      <button type="button" class="tile" id="upiTile">📲 ${t('UPI QR')}</button>
    </div>
    <a class="btn ghost" href="#/close-day">${closed ? '✓ ' + t('Day closed — view') : '🌙 ' + t('Close today')}</a>
    <h3>${t("Today's tasks")} ${due.length ? `<span class="pill bad">${due.length}</span>` : ''}</h3>
    <ul class="list">${due.map(noteRow).join('') || `<li class="muted">${t('Nothing due')}</li>`}</ul>
    ${soon.length ? `<h3>${t('Upcoming')}</h3><ul class="list">${soon.map(noteRow).join('')}</ul>` : ''}
    <div id="mealw">${mealCard()}</div>
    <h3>${t('Calendar')}</h3><div id="calw"></div>
    <h3>🧮 ${t('Calculator')}</h3><div id="calcw"></div>`;
  bindSellerBar();
  bindAlerts();
  bindMeal();
  const ut = $('#upiTile'); if (ut) ut.onclick = () => showUpiQr();
  mountCalendar($('#calw')); mountCalculator($('#calcw'));
  setTimeout(maintainBook, 3000);
  const rt = $('#routeTile'); if (rt) rt.onclick = () => { try { sessionStorage.setItem('custDay', 'today'); } catch {} go('#/customers'); };
  $$('[data-done]').forEach((cb) => (cb.onchange = () => {
    const b = F.writeBatch(F.db);
    b.update(F.sellerDoc(sid, 'notes', cb.dataset.done), { done: true, doneAt: Date.now() });
    F.commit(b, onWriteError);
    cb.closest('li').remove();
    toast(t('Done'));
  }));
}

/** Customers to visit today, in route order: today's own route first, then any route moved to today. */
function todayRouteList(plan = todayPlan()) {
  const seen = new Set(), groups = [];
  for (const pd of plan.days) {
    const list = L.routeSort(Object.values(S.customers).filter((c) => daysOf(c).includes(pd.day) && !seen.has(c.id)), pd.day);
    list.forEach((c) => seen.add(c.id));
    groups.push({ ...pd, list });
  }
  return groups;
}

function routeTile(paid, visited) {
  const plan = todayPlan();
  const changeNote = plan.change ? (plan.change.action === 'cancel'
    ? `${dayLabel(plan.change.day)} ${t('route cancelled today')}${plan.change.events ? ` (${esc(plan.change.events)})` : ''}`
    : `${dayLabel(plan.change.day)} ${t('route moved to')} ${fmtDate(plan.change.toDate)}`) : '';
  if (!plan.days.length) return `<div class="routetile off">${changeNote || t('No route today')}</div>`;
  const groups = todayRouteList(plan), every = groups.flatMap((g) => g.list), all = every.filter((c) => !pausedCust(c.id));
  const done = all.filter((c) => paid.has(c.id) || visited.has(c.id)).length;
  const due = every.reduce((s, c) => s + openBalance(c.id), 0);
  const label = groups.map((g) => dayLabel(g.day) + (g.moved ? ` (${t('moved')})` : '')).join(' + ');
  return `<button class="routetile" id="routeTile">
    <div class="rt-h"><span>🛵 ${t("Today's route")} · ${label}</span><em>${t('Open')}</em></div>
    <b>${done} / ${all.length} ${t('customers')}</b>
    <div class="dots">${all.map((c) => `<i class="${paid.has(c.id) ? 'paid' : visited.has(c.id) ? 'visit' : ''}"></i>`).join('')}</div>
    <small>${t('Total due')} ${money(due)}${changeNote ? ' · ' + changeNote : ''}</small></button>`;
}

// ---------- dinner order (Sat, Sun, Mon, Tue; sellers only) ----------
const MEAL_DAYS = [6, 0, 1, 2], MEAL_FROM = 18, MEAL_TO = 22; // 6 pm – 10 pm
const mealOpen = () => { const h = new Date().getHours(); return MEAL_DAYS.includes(todayDay()) && h >= MEAL_FROM && h < MEAL_TO; };
// Show / hide the card at 6 pm and 10 pm while Home stays open.
let mealShown = null;
setInterval(() => {
  const w = $('#mealw'); if (!w || !S.profile || isAdmin()) return;
  const open = mealOpen(); if (open === mealShown) return;
  if (open && mealsDay !== today()) subscribeMeals();
  w.innerHTML = mealCard(); bindMeal();
}, 30000);
function mealCard() {
  mealShown = mealOpen();
  if (isAdmin() || !mealShown) return '';
  const me = S.profile.sellerKey || S.user.uid, list = sellers();
  const msgs = list.map((x) => ({ x, m: S.meals[`${today()}_${x.id}`] }));
  const allIn = list.length && msgs.every((r) => r.m);
  const time = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return `<div class="card mealcard">
    <div class="row" style="padding:0"><b>🍽️ ${t('What do you want for dinner tonight?')}</b>${allIn ? `<span class="pill ok">✅ ${t('Everyone has said')}</span>` : ''}</div>
    <div class="meallist">${msgs.map(({ x, m }) => `<div class="mealmsg ${m ? '' : 'wait'} ${x.id === me ? 'me' : ''}">
      <span class="sc sc-good" style="background:${sellerColor(x.id)}">${esc(sellerInitial(x.id))}</span>
      <div>${m ? `<b>${L.foodEmoji(m.text)} ${esc(m.text)}</b><small>${esc(x.name)} · ${time(m.at)}</small>` : `<span>⏳ ${esc(x.name)} — ${t('waiting')}</span>`}</div></div>`).join('')}</div>
    <form id="mealf" class="toolbar" style="margin-bottom:0"><input name="m" placeholder="${t('e.g. 2 porotta, chicken curry')}" autocomplete="off" value=""><button class="btn primary" type="submit">${t('Send')}</button></form></div>`;
}
const SELLER_COLORS = ['#2E7D5B', '#C26A00', '#3D5AFE', '#8E24AA', '#00838F', '#AD1457'];
const sellerColor = (key) => SELLER_COLORS[Math.max(0, sellers().map((x) => x.id).sort().indexOf(key)) % SELLER_COLORS.length];
function bindMeal() {
  const f = $('#mealf'); if (!f) return;
  f.onsubmit = (e) => {
    e.preventDefault();
    const text = f.m.value.trim(); if (!text) return;
    const me = S.profile.sellerKey || S.user.uid, id = `${today()}_${me}`, doc = { date: today(), sellerKey: me, name: S.profile.name, text, at: Date.now() };
    const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'meals', id), doc); F.commit(b, onWriteError);
    S.meals[id] = { id, ...doc }; f.m.value = '';
    const card = f.closest('.mealcard'); card.outerHTML = mealCard(); bindMeal();
  };
}

// ---------- holiday route alerts ----------
function alertCard(a) {
  const n = Object.values(S.customers).filter((c) => daysOf(c).includes(a.day)).length;
  const prev = L.addDays(a.date, -1), def = prev >= today() ? prev : L.addDays(a.date, 1);
  return `<div class="banner warn" data-alert="${a.date}" data-day="${a.day}" data-names="${esc(a.names.join(', '))}">
    <b>📅 ${esc(a.names.join(', '))} — ${fmtDate(a.date)} (${dayLabel(a.day)})</b>
    <span class="small">${dayLabel(a.day)} ${t('route')} · ${n} ${t('customers')}. ${t('Move it to another day or cancel it for this week.')}</span>
    <div class="contact"><button class="btn small" data-mv>${t('Move to another day')}</button><button class="btn small" data-cx>${t('Cancel this week')}</button></div>
    <div class="mvbox" hidden><label>${t('Visit these customers on')}<input type="date" min="${today()}" max="${L.addDays(a.date, 6)}" value="${def}"></label>
      <button class="btn primary small" data-mvok>${t('Move route')}</button></div>
    <button class="linkbtn small muted" data-keep style="margin-top:6px;color:var(--muted)">${t('Go as usual')}</button></div>`;
}

function bindAlerts() {
  $$('[data-alert]').forEach((box) => {
    const date = box.dataset.alert, day = Number(box.dataset.day), events = box.dataset.names;
    const save = (action, toDate = '') => {
      const b = F.writeBatch(F.db), doc = { date, day, action, toDate, events, decidedAt: Date.now(), by: S.user.uid };
      b.set(F.sellerDoc(S.sid, 'routeChanges', date), doc);
      F.commit(b, onWriteError);
      S.routeChanges[date] = { id: date, ...doc };
      toast(t('Saved')); box.remove(); route();
    };
    $('[data-mv]', box).onclick = () => { $('.mvbox', box).hidden = false; };
    $('[data-mvok]', box).onclick = () => {
      const to = $('.mvbox input', box).value;
      if (!to || to === date) return toast(t('Choose another date'), true);
      save('move', to);
    };
    $('[data-cx]', box).onclick = () => { if (confirm(t('Cancel this route for this week?'))) save('cancel'); };
    $('[data-keep]', box).onclick = () => save('keep');
  });
}

// ---------- calendar widget ----------
const CAL = { tab: 'gen', month: '', sel: '' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function mountCalendar(el) {
  if (!el) return;
  if (!CAL.month) CAL.month = today().slice(0, 7);
  if (!CAL.sel) CAL.sel = today();
  const canWork = !!S.sid;
  if (!canWork) CAL.tab = 'gen';
  const [y, m] = CAL.month.split('-').map(Number);
  const first = `${CAL.month}-01`, startWd = L.weekdayOf(first);
  const last = L.addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
  const gridStart = L.addDays(first, -startWd);
  const evs = allEvents();
  // Work data for the month
  let work = {};
  if (canWork && CAL.tab === 'work') {
    const [cols, orders, notes] = await Promise.all([
      F.fetchAll(F.query(F.sellerCol(S.sid, 'collections'), F.where('date', '>=', first), F.where('date', '<=', last))),
      F.fetchAll(F.query(F.sellerCol(S.sid, 'orders'), F.where('deliveryDate', '>=', first), F.where('deliveryDate', '<=', last))),
      F.fetchAll(F.query(F.sellerCol(S.sid, 'notes'), F.where('done', '==', false))),
    ]);
    const add = (d, item) => (work[d] ||= []).push(item);
    const byDay = {};
    cols.filter((c) => c.kind !== 'discount').forEach((c) => { const x = (byDay[c.date] ||= { n: 0, amt: 0 }); if (c.kind !== 'refund') x.n++; x.amt += c.amount; });
    Object.entries(byDay).forEach(([d, x]) => add(d, { k: 'col', html: `💰 ${t('Collected')} <b>${money(L.round2(x.amt))}</b> <small>(${x.n})</small>` }));
    orders.filter((o) => o.status !== 'cancelled').forEach((o) => add(o.deliveryDate, { k: 'ord', html: `🚚 <a href="#/customer/${o.customerId}">${esc(o.customerName)}</a> · ${esc(o.items.map((i) => `${i.name} × ${i.qty}`).join(', '))}${o.status === 'delivered' ? ' ✓' : ''}` }));
    notes.filter((n) => n.dueDate && n.dueDate >= first && n.dueDate <= last).forEach((n) => add(n.dueDate, { k: n.kind === 'promise' ? 'pro' : 'rem', html: `${n.kind === 'promise' ? '🤝' : '🔔'} <a href="#/customer/${n.customerId}">${esc(n.customerName || '')}</a> · ${esc(n.text)}` }));
    Object.values(S.routeChanges).forEach((r) => {
      if (r.action === 'cancel') add(r.date, { k: 'rc', html: `⛔ ${dayLabel(r.day)} ${t('route cancelled')}` });
      if (r.action === 'move') { add(r.date, { k: 'rc', html: `↪ ${dayLabel(r.day)} ${t('route moved to')} ${fmtDate(r.toDate)}` }); add(r.toDate, { k: 'rc', html: `↩ ${dayLabel(r.day)} ${t('route (moved)')}` }); }
    });
  }
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = L.addDays(gridStart, i);
    if (i >= 35 && d > last) break;
    const wd = L.weekdayOf(d), dayEv = evs.filter((e) => e.date === d);
    const cls = [d.slice(0, 7) !== CAL.month ? 'out' : '', ROUTE_DAYS.includes(wd) ? '' : 'noroute', dayEv.some((e) => e.holiday) ? 'hol' : '', d === today() ? 'today' : '', d === CAL.sel ? 'sel' : ''].filter(Boolean).join(' ');
    const dots = CAL.tab === 'gen' ? (dayEv.length ? `<u class="${dayEv.some((e) => e.holiday) ? 'h' : ''}"></u>` : '')
      : (work[d] || []).slice(0, 3).map((w) => `<u class="${w.k === 'rc' || w.k === 'pro' ? 'w' : ''}"></u>`).join('');
    cells.push(`<button data-cd="${d}" class="${cls}">${Number(d.slice(8))}${dots ? `<i>${dots}</i>` : ''}</button>`);
  }
  const selEv = evs.filter((e) => e.date === CAL.sel);
  const listHtml = CAL.tab === 'gen'
    ? (selEv.map((e) => `<div class="kv"><span>${e.holiday ? '🔴' : '🔵'} ${esc(e.name)}</span>${isAdmin() && e.id ? `<button class="x" data-evdel="${e.id}">×</button>` : ''}</div>`).join('') || `<div class="muted small">${t('No holiday or event')}</div>`)
      + (isAdmin() ? `<form id="evf" class="two" style="align-items:end"><label>${t('Add event on')} ${fmtDate(CAL.sel)}<input name="n" required placeholder="${t('e.g. Local festival')}"></label>
        <div><label class="radio"><input type="checkbox" name="h" checked> ${t('Holiday')}</label><button class="btn small" type="submit">${t('Add')}</button></div></form>` : '')
    : ((work[CAL.sel] || []).map((w) => `<div class="kv"><span>${w.html}</span></div>`).join('') || `<div class="muted small">${t('Nothing on this day')}</div>`);
  el.innerHTML = `<div class="card cal">
    ${canWork ? `<div class="tabs"><button data-ct="gen" class="${CAL.tab === 'gen' ? 'on' : ''}">${t('General')}</button><button data-ct="work" class="${CAL.tab === 'work' ? 'on' : ''}">${t('Work')}</button></div>` : ''}
    <div class="calhead"><button data-cm="-1" aria-label="previous">‹</button><b>${t(MONTHS[m - 1])} ${y}</b><button data-cm="1" aria-label="next">›</button></div>
    <div class="calgrid">${(getLang() === 'ml' ? ['ഞാ', 'തി', 'ചൊ', 'ബു', 'വ്യാ', 'വെ', 'ശ'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).map((w) => `<span class="wd">${w}</span>`).join('')}${cells.join('')}</div>
    <div class="callist"><div class="small muted" style="margin-bottom:4px">${fmtDate(CAL.sel)}</div>${listHtml}</div></div>`;
  $$('[data-ct]', el).forEach((b) => (b.onclick = () => { CAL.tab = b.dataset.ct; mountCalendar(el); }));
  $$('[data-cm]', el).forEach((b) => (b.onclick = () => {
    const nm = new Date(Date.UTC(y, m - 1 + Number(b.dataset.cm), 1)).toISOString().slice(0, 7);
    CAL.month = nm; CAL.sel = nm === today().slice(0, 7) ? today() : nm + '-01'; mountCalendar(el);
  }));
  $$('[data-cd]', el).forEach((b) => (b.onclick = () => { CAL.sel = b.dataset.cd; if (CAL.sel.slice(0, 7) !== CAL.month) CAL.month = CAL.sel.slice(0, 7); mountCalendar(el); }));
  const evf = $('#evf', el);
  if (evf) evf.onsubmit = (e) => {
    e.preventDefault();
    const col = F.collection(F.db, 'events'), id = F.newId(col), b = F.writeBatch(F.db);
    const doc = { date: CAL.sel, name: evf.n.value.trim(), holiday: evf.h.checked, by: S.user.uid, createdAt: Date.now() };
    b.set(F.doc(col, id), doc); F.commit(b, onWriteError);
    S.events[id] = { id, ...doc }; toast(t('Saved')); mountCalendar(el);
  };
  $$('[data-evdel]', el).forEach((b) => (b.onclick = () => {
    if (!confirm(t('Delete this event?'))) return;
    const bt = F.writeBatch(F.db); bt.delete(F.doc(F.db, 'events', b.dataset.evdel)); F.commit(bt, onWriteError);
    delete S.events[b.dataset.evdel]; mountCalendar(el);
  }));
}

// ---------- receipt bar (after a collection, on the screen the seller returns to) ----------
function readReceipt() {
  try { const r = JSON.parse(sessionStorage.getItem('receipt') || 'null'); return r && Date.now() - (r.at || 0) < 30 * 60000 ? r : null; } catch { return null; }
}
function receiptBar(float = false) {
  const rc = readReceipt();
  if (!rc) return '';
  return `<div class="banner ${float ? 'float' : ''}" id="rcpt"><b>✓ ${t('Saved')} · ${esc(rc.customer || '')} · ${money(rc.amount)}${rc.discount ? ` + ${t('Discount')} ${money(rc.discount)}` : ''}</b><span class="small">${t('New balance')} ${money(rc.balance)}</span>
    <div class="contact">${rc.phone ? `<a class="btn wa" id="rcSend" href="https://wa.me/${L.waNumber(rc.phone)}?text=${encodeURIComponent(rc.text)}" target="_blank" rel="noopener">📩 ${t('Send receipt')}</a>` : `<span class="small muted">${t('No phone number saved')}</span>`}
    <button class="btn small" id="rcX">${t('Close')}</button></div></div>`;
}
function bindReceiptBar() {
  const x = $('#rcX'), s2 = $('#rcSend');
  const clear = () => { try { sessionStorage.removeItem('receipt'); } catch {} };
  if (x) x.onclick = () => { clear(); $('#rcpt')?.remove(); };
  if (s2) s2.addEventListener('click', () => setTimeout(() => { clear(); $('#rcpt')?.remove(); }, 300));
}
/** Where to go after saving a collection: the route list when it was started from the customer page. */
function setCollectBack(aid, to) { try { sessionStorage.setItem('collectBack', JSON.stringify({ aid, to, at: Date.now() })); } catch {} }
function takeCollectBack(aid) {
  try {
    const b = JSON.parse(sessionStorage.getItem('collectBack') || 'null'); sessionStorage.removeItem('collectBack');
    return b && b.aid === aid && Date.now() - b.at < 30 * 60000 ? b.to : null;
  } catch { return null; }
}

// ---------- customer score, shared phone index and 🚫 flags ----------
/** Phone numbers are shared as hashes, not as plain numbers. (Within the company only; a determined user could still test numbers one by one.) */
async function phoneHash(number) {
  const d = String(number || '').replace(/\D/g, '').slice(-10);
  if (d.length < 10 || !crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alameen:' + d));
  return [...new Uint8Array(buf)].slice(0, 10).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function hashesOf(phones) { return [...new Set((await Promise.all(phones.map((p) => phoneHash(p.number)))).filter(Boolean))]; }
const sellerInitial = (key) => {
  const nm = sellerName(key) || '?', first = nm[0].toUpperCase();
  const clash = sellers().some((x) => x.id !== key && (x.name || '')[0]?.toUpperCase() === first);
  return clash ? nm.slice(0, 2).toUpperCase() : first;
};
const bandOf = (n) => (n == null ? 'new' : n >= 80 ? 'good' : n >= 60 ? 'ok' : 'risk');
/** Index entries of other books for this customer's numbers, one per seller (lowest score, any flag). */
function othersOf(c, ownKey = S.sid) {
  const by = {};
  for (const h of c?.phoneHashes || []) for (const e of S.phoneIdx[h] || []) {
    if (e.sellerKey === ownKey) continue;
    const o = (by[e.sellerKey] ||= { key: e.sellerKey, name: e.sellerName || sellerName(e.sellerKey), score: e.score, ban: '' });
    if (e.score != null && (o.score == null || e.score < o.score)) o.score = e.score;
    if (e.ban) o.ban = e.ban;
  }
  return Object.values(by);
}
/** Write this customer's index entries (one per number), removing numbers no longer on the customer. */
const indexExists = (id) => Object.values(S.phoneIdx).some((arr) => arr.some((e) => e.id === id));
const indexDoc = (h, sid, c) => ({ hash: h, sellerKey: sid, sellerName: sellerName(sid), score: c.score?.score ?? null, ban: c.ban?.reason || '', updatedAt: Date.now() });
function writeIndex(b, sid, cid, c, hashes) {
  for (const h of c.phoneHashes || []) if (!hashes.includes(h) && indexExists(`${h}_${sid}_${cid}`)) b.delete(F.doc(F.db, 'phoneIndex', `${h}_${sid}_${cid}`));
  for (const h of hashes) b.set(F.doc(F.db, 'phoneIndex', `${h}_${sid}_${cid}`), indexDoc(h, sid, c));
}
function scoreTip(c) {
  const sc = c.score;
  if (!sc || sc.score == null) return t('New customer — not enough history for a score yet');
  const pr = sc.prior && sc.prior.w < 1 ? sc.prior : null;
  if (pr && pr.real == null) return `${t('Score')} ${sc.score}/100 · ${t('Starting score set by the seller; payments will decide it from now on.')}`;
  const pre = pr ? `${t('Starting score')} ${pr.start} · ${Math.round(pr.w * 100)}% ${t('from payments')} (${pr.real}) · ` : '';
  const p = sc.plan || {}, per = { daily: t('day'), weekly: t('week'), monthly: t('month') }[sc.freq] || t('week');
  return `${pre}${t('Score')} ${sc.score}/100 · ${t('Plan')}: ${rmoney(p.perPeriod)}/${per} · ${p.behind > 0 ? `${rmoney(p.behind)} ${t('behind')} (${p.behindPeriods} ${per})` : t('not behind')} · ${t('Average')} ${rmoney(p.average)}/${per}${sc.promises?.due ? ` · ${t('Promises kept')} ${sc.promises.kept}/${sc.promises.due}` : ''}`;
}
/** Badges: own score in a coloured circle, other sellers' scores as initial + score, flags as a struck-through red circle. */
function scoreBadges(c, big = false) {
  const own = c.score?.score;
  let h = `<span class="sc sc-${bandOf(own)} ${big ? 'big' : ''}" data-tip="${esc(scoreTip(c))}">${own ?? '–'}</span>`;
  if (c.ban) h += `<span class="sc sc-ban" data-tip="${esc(`🚫 ${c.ban.byName || ''}: ${c.ban.reason}`)}">${esc(sellerInitial(c.ban.by))}</span>`;
  for (const o of othersOf(c)) {
    h += `<span class="sc mini sc-${bandOf(o.score)}" data-tip="${esc(`${o.name}${t("'s customer too")} · ${t('Score')} ${o.score ?? t('new')}`)}">${esc(sellerInitial(o.key))}${o.score != null ? ' ' + o.score : ''}</span>`;
    if (o.ban) h += `<span class="sc sc-ban" data-tip="${esc(`🚫 ${o.name}: ${o.ban}`)}">${esc(sellerInitial(o.key))}</span>`;
  }
  return `<span class="scores">${h}</span>`;
}
/** Re-compute one customer's score from their accounts, sales, collections and promised dates; share it in the index. */
async function rescore(cid, sid = S.sid) {
  const c = S.customers[cid]; if (!c || !sid) return null;
  const w = F.where('customerId', '==', cid);
  const [sales, cols, visits] = await Promise.all([F.fetchAll(F.query(F.sellerCol(sid, 'sales'), w)), F.fetchAll(F.query(F.sellerCol(sid, 'collections'), w)), F.fetchAll(F.query(F.sellerCol(sid, 'visits'), w))]);
  const r = L.customerScore({ accounts: accountsOf(cid), sales, collections: cols, promises: visits.filter((v) => v.promiseDate), today: today(), prior: c.prior?.score ?? null });
  const score = { score: r.score ?? null, band: r.band, parts: r.parts || null, plan: r.plan || null, freq: r.freq || 'weekly', promises: r.promises || null, capped: r.capped || '', prior: r.prior || null, at: today() };
  const changed = JSON.stringify({ ...c.score, at: 0 }) !== JSON.stringify({ ...score, at: 0 });
  if (changed || c.score?.at !== today()) {
    const b = F.writeBatch(F.db);
    b.update(F.sellerDoc(sid, 'customers', cid), { score });
    if (changed) for (const h of c.phoneHashes || []) b.set(F.doc(F.db, 'phoneIndex', `${h}_${sid}_${cid}`), indexDoc(h, sid, { ...c, score }));
    F.commit(b, () => {});
    c.score = score;
  }
  return score;
}
const rescoreTimers = {};
function rescoreSoon(cid) { clearTimeout(rescoreTimers[cid]); rescoreTimers[cid] = setTimeout(() => rescore(cid).catch(() => {}), 1200); }
/** Once per session per book: add missing phone-index entries and refresh stale scores (route customers first). */
async function maintainBook() {
  const sid = S.sid; if (!sid || maintainBook.done === sid || !navigator.onLine) return;
  maintainBook.done = sid;
  const all = Object.values(S.customers);
  for (const c of all.filter((x) => !Array.isArray(x.phoneHashes))) {
    const hashes = await hashesOf(phonesOf(c)), b = F.writeBatch(F.db);
    writeIndex(b, sid, c.id, c, hashes); b.update(F.sellerDoc(sid, 'customers', c.id), { phoneHashes: hashes }); c.phoneHashes = hashes;
    F.commit(b, () => {});
  }
  // monthly accounts made before v32 have no lastPaid yet: read the last 62 days of collections once
  const need = Object.values(S.accounts).filter((a) => (a.frequency || 'weekly') === 'monthly' && a.status !== 'closed' && a.lastPaid === undefined);
  if (need.length) {
    const cols = await F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('date', '>=', L.addDays(today(), -62)))).catch(() => null);
    if (cols && S.sid === sid) {
      const last = {}; cols.forEach((c) => { if (c.kind === 'collection' && (!last[c.accountId] || c.date > last[c.accountId])) last[c.accountId] = c.date; });
      const b = F.writeBatch(F.db); need.forEach((a) => { b.update(F.sellerDoc(sid, 'accounts', a.id), { lastPaid: last[a.id] || '' }); a.lastPaid = last[a.id] || ''; }); F.commit(b, () => {});
    }
  }
  const plan = todayPlan(), stale = all.filter((c) => c.score?.at !== today()).sort((a, b) => onTodayRoute(b, plan) - onTodayRoute(a, plan));
  for (const c of stale.slice(0, 60)) { if (S.sid !== sid) return; try { await rescore(c.id, sid); } catch {} await new Promise((r) => setTimeout(r, 150)); }
  live();
}

// tap-to-see bubble for score circles and flags
document.addEventListener('click', (e) => {
  const tip = e.target.closest?.('[data-tip]');
  document.querySelectorAll('.tipbubble').forEach((x) => x.remove());
  if (!tip) return;
  e.preventDefault(); e.stopPropagation();
  const r = tip.getBoundingClientRect(), bub = document.createElement('div');
  bub.className = 'tipbubble'; bub.textContent = tip.dataset.tip;
  document.body.appendChild(bub);
  const w = Math.min(280, window.innerWidth - 24);
  bub.style.width = w + 'px';
  bub.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
  bub.style.top = (r.bottom + window.scrollY + 6) + 'px';
}, true);

// ---------- customers ----------
function renderCustomers() {
  setTitle(t('Customers'));
  if (needSeller()) return;
  const sid = S.sid;
  let filter = (() => { try { return sessionStorage.getItem('custDay') || 'all'; } catch { return 'all'; } })();
  let paidToday = new Set(), visitedToday = new Set();
  const loadPaid = async () => {
    const [cols, vis] = await Promise.all([F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('date', '==', today()))),
      F.fetchAll(F.query(F.sellerCol(sid, 'visits'), F.where('date', '==', today())))]);
    paidToday = new Set(cols.filter((c) => c.kind !== 'discount').map((c) => c.customerId));
    visitedToday = new Set(vis.map((v) => v.customerId));
    draw();
  };
  let arranging = null; // array of customer ids while arranging the route order
  const dayOfFilter = () => (filter === 'today' ? (todayPlan().days[0]?.day ?? todayDay()) : Number(filter));
  const matches = (c, f) => f === 'all' ? true : f === 'none' ? !daysOf(c).length : f === 'today' ? onTodayRoute(c) : daysOf(c).includes(Number(f));
  const draw = () => {
    if (arranging) return;
    const all = Object.values(S.customers);
    const plan = todayPlan(), isRoute = plan.days.length > 0;
    if (filter === 'today' && !isRoute) filter = 'all';
    const chips = [['all', t('All'), all.length], ...(isRoute ? [['today', t('Today'), all.filter((c) => matches(c, 'today')).length]] : []),
      ...ROUTE_DAYS.map((d) => [String(d), dayLabel(d), all.filter((c) => matches(c, String(d))).length]), ['none', t('No day'), all.filter((c) => matches(c, 'none')).length]];
    $('#dayf').innerHTML = chips.map(([k, l, n]) => `<button class="fchip ${k === filter ? 'on' : ''}" data-f="${k}">${l} <small>${n}</small></button>`).join('');
    $$('[data-f]').forEach((btn) => (btn.onclick = () => { filter = btn.dataset.f; try { sessionStorage.setItem('custDay', filter); } catch {} draw(); }));
    const qv = ($('#q')?.value || '').toLowerCase();
    const list = all.filter((c) => matches(c, filter))
      .filter((c) => searchHit(c, qv));
    const byRoute = filter !== 'all' && filter !== 'none';
    // Sections: one per route day (today can also carry a route moved here because of a holiday).
    const ids = new Set(list.map((c) => c.id));
    const sections = filter === 'today'
      ? todayRouteList(plan).map((g) => ({ head: g.moved ? `${dayLabel(g.day)} ${t('route (moved)')}` : '', list: g.list.filter((c) => ids.has(c.id)) }))
      : [{ head: '', list: byRoute ? L.routeSort(list, dayOfFilter()) : list.sort((a, b) => a.name.localeCompare(b.name)) }];
    $('#arrBar').hidden = !byRoute || !!qv || sections.length > 1;
    let n = 0;
    const note = filter === 'today' && plan.change ? `<li class="banner warn">${plan.change.action === 'cancel' ? `${dayLabel(plan.change.day)} ${t('route cancelled today')}` : `${dayLabel(plan.change.day)} ${t('route moved to')} ${fmtDate(plan.change.toDate)}`}</li>` : '';
    $('#clist').innerHTML = note + sections.map((sec) => {
      let lastLane = null;
      return (sec.head ? `<li class="lanehead moved">↩ ${esc(sec.head)}</li>` : '') + sec.list.map((c) => {
        n++;
        const lane = (c.lane || '').trim(), head = byRoute && lane.toLowerCase() !== lastLane ? `<li class="lanehead">${esc(lane || t('No lane'))}</li>` : '';
        lastLane = lane.toLowerCase();
        const accs = accountsOf(c.id).filter((a) => a.status !== 'closed'), paid = paidToday.has(c.id), nopay = !paid && visitedToday.has(c.id);
        const days = daysOf(c).map(dayLabel).join(' ');
        const dm = byRoute ? dueMark(c.id, paid) : '';
        return `${head}<li><a href="#/customer/${c.id}" data-cid="${c.id}" class="row ${paid ? 'paid' : ''} ${dm ? 'notdue' : ''}">
          <div>${placeBadge(c)}<b>${byRoute ? `<span class="seq">${n}</span>` : ''}${paid ? '<span class="tick">✓</span> ' : nopay ? `<span class="nopay" title="${t('Visited – no payment')}">⊘</span> ` : ''}${pauseMark(c.id)}${esc(c.name)}</b>${scoreBadges(c)}${dm}<small>${[esc(c.phone || ''), `${accs.length} ${t('accounts')}`, days].filter(Boolean).join(' · ')}</small></div>
          <div class="amt">${money(openBalance(c.id))}</div></a></li>`;
      }).join('');
    }).join('') || `<li class="muted">${t('No customers here')}</li>`;
    if (!n && !note) $('#clist').innerHTML = `<li class="muted">${t('No customers here')}</li>`;
    const due = list.reduce((s, c) => s + openBalance(c.id), 0);
    const np = byRoute ? list.filter((c) => pausedCust(c.id)).length : 0;
    const counted = byRoute ? list.filter((c) => !pausedCust(c.id)) : list;
    const seenC = counted.filter((c) => paidToday.has(c.id)).length, nvC = counted.filter((c) => !paidToday.has(c.id) && visitedToday.has(c.id)).length;
    $('#ctotal').textContent = `${list.length - np} ${t('customers')}${np ? ` (+ ⏸ ${np})` : ''} · ${t('Total due')} ${money(due)}${byRoute ? ` · ✓ ${seenC} ${t('paid today')}${nvC ? ` · ⊘ ${nvC}` : ''}` : ''}`;
  };
  view.innerHTML = sellerBar() + receiptBar(true) + `
    <div class="fchips" id="dayf"></div>
    <div class="toolbar"><input id="q" type="search" placeholder="${t('Search name, phone, lane')}"><a class="btn primary" href="#/customer-new">+ ${t('Add')}</a></div>
    <div class="muted small" id="ctotal"></div>
    <div class="arrbar" id="arrBar" hidden><button class="btn small" id="arrBtn">↕ ${t('Arrange order')}</button><button class="btn small" id="autoBtn">⏱ ${t('Order by collection times')}</button></div>
    <ul class="list" id="clist"></ul>
    <div class="arrsave" id="arrSave" hidden><button class="btn" id="arrCancel">${t('Cancel')}</button><button class="btn primary" id="arrOk">${t('Save order')}</button></div>`;
  bindSellerBar();
  bindReceiptBar();
  $('#q').oninput = draw;

  const startArrange = (ids, note) => {
    arranging = ids;
    const day = dayOfFilter();
    $('#dayf').classList.add('locked'); $('#q').disabled = true; $('#arrBar').hidden = true; $('#arrSave').hidden = false;
    $('#ctotal').textContent = note || t('Drag ≡ to put customers in the order you visit them.');
    $('#clist').innerHTML = ids.map((id, i) => { const c = S.customers[id]; return `<li class="arr" data-id="${id}"><span class="handle" aria-label="drag">≡</span><span class="seq">${i + 1}</span>
      <div>${placeBadge(c)}<b>${esc(c.name)}</b></div></li>`; }).join('');
    const renumber = () => $$('#clist .seq').forEach((el, i) => (el.textContent = i + 1));
    $$('#clist .handle').forEach((h) => {
      h.onpointerdown = (e) => {
        e.preventDefault();
        const li = h.closest('li'), pid = e.pointerId; li.classList.add('dragging');
        let scrollTimer = null;
        const move = (ev) => {
          const y = ev.clientY;
          clearInterval(scrollTimer);
          if (y < 90) scrollTimer = setInterval(() => window.scrollBy(0, -12), 16);
          else if (y > window.innerHeight - 140) scrollTimer = setInterval(() => window.scrollBy(0, 12), 16);
          const others = $$('#clist li.arr').filter((x) => x !== li);
          const before = others.find((x) => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; });
          if (before) { if (li.nextElementSibling !== before) $('#clist').insertBefore(li, before); } else $('#clist').appendChild(li);
        };
        // Listen on window: moving the row in the DOM would drop pointer capture on the handle.
        const onMove = (ev) => { if (ev.pointerId === pid) { ev.preventDefault(); move(ev); } };
        const up = (ev) => {
          if (ev.pointerId !== pid) return;
          clearInterval(scrollTimer); li.classList.remove('dragging'); renumber();
          window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', onMove, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      };
    });
    $('#arrCancel').onclick = endArrange;
    $('#arrOk').onclick = () => {
      const order = $$('#clist li.arr').map((li) => li.dataset.id), b = F.writeBatch(F.db);
      order.forEach((id, i) => b.update(F.sellerDoc(sid, 'customers', id), { [`routeOrder.${day}`]: i + 1 }));
      F.audit(b, S.user.uid, 'route-order', `sellers/${sid}/day/${day}`, null, { day, order });
      F.commit(b, onWriteError);
      order.forEach((id, i) => { const c = S.customers[id]; c.routeOrder = { ...(c.routeOrder || {}), [day]: i + 1 }; });
      toast(t('Route order saved')); endArrange();
    };
  };
  const endArrange = () => {
    arranging = null; $('#dayf').classList.remove('locked'); $('#q').disabled = false; $('#arrSave').hidden = true; draw();
  };
  const currentIds = () => L.routeSort(Object.values(S.customers).filter((c) => matches(c, filter)), dayOfFilter()).map((c) => c.id);
  $('#arrBtn').onclick = () => startArrange(currentIds());
  $('#autoBtn').onclick = async () => {
    const from = L.addDays(today(), -90);
    const [cols, vis] = await Promise.all([F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('date', '>=', from))),
      F.fetchAll(F.query(F.sellerCol(sid, 'visits'), F.where('date', '>=', from)))]);
    const ids = currentIds(), ordered = L.orderFromTimes([...cols, ...vis], dayOfFilter(), ids);
    if (!ordered.timed) return toast(t('No collection times yet for this day. Use the app on this route for a week or two first.'), true);
    startArrange([...ordered], `${t('Suggested from collection times. Check it, adjust by dragging, then save.')} (${ordered.timed}/${ids.length})`);
  };
  draw();
  setTimeout(maintainBook, 2500);
  loadPaid().then(() => {
    // Coming back after a collection: bring that customer into view so the next house is right below.
    let last = null; try { last = sessionStorage.getItem('lastCust'); sessionStorage.removeItem('lastCust'); } catch {}
    const el = last && $(`#clist [data-cid="${last}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  });
  S.refresh = draw;
}

function accountRowHtml(i, a = {}) {
  return `<div class="acc-row card" data-acc="${i}">
    <label>${t('Account name')}<input name="an" value="${esc(a.name || (i ? '' : 'Account 1'))}" required></label>
    <div class="two">
      <label>${t('Instalment')}<select name="af">${FREQ.map((f) => `<option value="${f}" ${f === (a.frequency || 'weekly') ? 'selected' : ''}>${freqLabel(f)}</option>`).join('')}</select></label>
      <label>${t('Opening balance')}<input name="ao" type="number" inputmode="decimal" min="0" step="any" placeholder="0"></label>
    </div>
    <label class="lpo" ${(a.frequency || 'weekly') === 'monthly' ? '' : 'hidden'}>${t('Last paid (old book)')} <small class="muted">(${t('optional')})</small><input name="alp" type="date" max="${today()}"></label></div>`;
}
/** Show the "last paid" date only for monthly accounts (account rows in a form). */
function bindAccountRows(root = document) {
  $$('.acc-row', root).forEach((row) => { const sel = $('[name=af]', row), box = $('.lpo', row); if (sel && box) sel.onchange = () => { box.hidden = sel.value !== 'monthly'; }; });
}
const accRowLastPaid = (row) => ($('[name=af]', row).value === 'monthly' ? $('[name=alp]', row)?.value || '' : '');

function newAccountDoc(cid, name, frequency, opening, lastPaidOld = '') {
  const queue = opening > 0 ? [{ ref: 'opening', date: '0000-00-00', seq: 0, remaining: opening, ratio: L.legacyRatio(S.settings.legacyMarginPct) }] : [];
  return { customerId: cid, name, frequency, openingBalance: opening, balance: opening, status: 'open', queue, date: today(), createdAt: Date.now(), lastPaid: '', ...(lastPaidOld ? { lastPaidOld } : {}) };
}

// ---------- monthly accounts: next instalment date ----------
// Base = the later of the last collection in the app (account.lastPaid) and the old book's last payment (lastPaidOld).
const addMonth = (d) => {
  const [y, m, dd] = d.split('-').map(Number), ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
};
function nextDueOf(a) {
  if ((a.frequency || 'weekly') !== 'monthly' || a.status === 'closed' || !(a.balance > 0)) return '';
  const base = [a.lastPaid || '', a.lastPaidOld || ''].sort().pop();
  return base ? addMonth(base) : '';
}
/** Earliest next due date when every open account of the customer is monthly and not due yet; '' otherwise. */
function notDueUntil(cid) {
  const accs = accountsOf(cid).filter((a) => a.status !== 'closed' && a.balance > 0 && !a.inactive);
  if (!accs.length) return '';
  let min = '';
  for (const a of accs) { const d = nextDueOf(a); if (!d || d <= today()) return ''; if (!min || d < min) min = d; }
  return min;
}
const dueMark = (cid, paid) => { const d = paid ? '' : notDueUntil(cid); return d ? `<span class="pill duep">${t('Due')} ${shortDate(d)}</span>` : ''; };
/** After a collection is removed or moved, find the account's real last collection date again. */
async function refreshLastPaid(sid, aid) {
  const cols = await F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('accountId', '==', aid))).catch(() => null);
  if (!cols) return;
  const last = cols.filter((c) => c.kind === 'collection').map((c) => c.date).sort().pop() || '';
  const a = S.accounts[aid]; if (a && (a.lastPaid || '') === last) return;
  const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), { lastPaid: last }); F.commit(b, () => {});
  if (a) a.lastPaid = last;
}

function renderCustomerForm(id) {
  if (needSeller()) return;
  const c = id ? S.customers[id] : null;
  if (id && !c) return go('#/customers');
  setTitle(c ? t('Edit customer') : t('New customer'), true);
  const pend = c ? null : readPending();
  const pendPaid = pend ? L.round2(pend.pays.reduce((s2, p) => s2 + p.amount, 0)) : 0;
  view.innerHTML = `${pend ? `<div class="banner" id="pendBox"><b>🛒 ${t('Cash sale')} ${money(pend.value)} · ${t('Paid')} ${money(pendPaid)} · ${t('Balance')} ${money(L.round2(pend.value - pendPaid))}</b>
      <span class="small">${esc(pend.lines.map((l) => `${l.name} × ${l.qty}`).join(', '))}</span>
      <span class="small muted">${t('The sale and what was paid go into the first account below.')}</span>
      <div class="contact"><button type="button" class="btn small" id="pendX">${t('Cancel this sale')}</button></div></div>` : ''}<form id="cf" class="form">
    <label>${t('Name')}<input name="name" value="${esc(c?.name)}" required></label>
    <div class="two place-in">
      <label>${t('House no.')}<input name="house" value="${esc(c?.house)}" autocapitalize="characters"></label>
      <label>${t('Lane')}<input name="lane" list="lanes" value="${esc(c?.lane)}" autocomplete="off"></label></div>
    <datalist id="lanes">${[...new Set(Object.values(S.customers).map((x) => (x.lane || '').trim()).filter(Boolean))].sort().map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
    <label>${t('Phone numbers')} <small class="muted">(★ ${t('default')})</small></label>
    <div id="phones">${(phonesOf(c).length ? phonesOf(c) : [{ primary: true }]).map((p, i) => phoneRowHtml(p, i)).join('')}</div>
    <div id="dupWarn"></div>
    <datalist id="plabels">${PHONE_LABELS.map((l) => `<option value="${t(l)}">`).join('')}</datalist>
    <div class="contact"><button type="button" class="btn ghost small" id="addPhone">+ ${t('Another number')}</button>${canPickContact() ? `<button type="button" class="btn ghost small" id="fromContacts">📇 ${t('From contacts')}</button>` : ''}</div>
    <label>${t('Address')}<textarea name="address" rows="2">${esc(c?.address)}</textarea></label>
    <label>${t('Route day')}</label>${dayPicker(daysOf(c))}
    <div class="card prior">
      <label class="chk"><input type="checkbox" name="pk" ${c?.prior ? 'checked' : ''}> ${t('I already know this customer')}</label>
      <div id="priorBox" ${c?.prior ? '' : 'hidden'}>
        <div class="prow"><input type="range" name="ps" min="0" max="100" step="5" value="${c?.prior?.score ?? 70}" aria-label="${t('Starting score')}"><span id="psv" class="sc big"></span></div>
        <p class="muted small">${t('Starting score from what you know. As payments come in, the app moves to the real payment score (fully after about 8 instalments).')}</p>
        <label>${t('Note')} <small class="muted">(${t('optional')})</small><input name="pnote" maxlength="120" value="${esc(c?.prior?.note || '')}" placeholder="${t('e.g. Known for 10 years / delayed payments before')}"></label>
      </div></div>
    ${c ? '' : `<h3>${t('Accounts')}</h3><div id="accs">${accountRowHtml(0)}</div>
      <button type="button" class="btn ghost" id="addAcc">+ ${t('Another account')}</button>
      <p class="muted small">${t('Opening balance: amount still due from the old book. Leave empty for a new customer.')}</p>`}
    <button class="btn primary" type="submit">${t('Save')}</button></form>`;
  let n = 1, pn = $$('.phonerow').length;
  if (!c) $('#addAcc').onclick = () => { $('#accs').insertAdjacentHTML('beforeend', accountRowHtml(n++)); bindAccountRows(); };
  bindAccountRows();
  // Number already a customer of another seller? Warn (never block) so the seller can ask them first.
  let cashSalesCache = null;
  if (pend) {
    const f0 = $('#cf'); if (pend.name) f0.name.value = pend.name;
    const pn0 = $('.phonerow [name=pn]'); if (pn0 && pend.phone) pn0.value = pend.phone;
    $('#pendX').onclick = () => { if (!confirm(t('Cancel this cash sale? Nothing is saved.'))) return; try { sessionStorage.removeItem('pendingCash'); } catch {} go('#/home'); };
  }
  const checkPhones = async () => {
    const hashes = await hashesOf($$('.phonerow [name=pn]').map((i) => ({ number: i.value })));
    const others = othersOf({ phoneHashes: hashes }, S.sid);
    let before = '';
    if (!c) { // the same number bought before as a walk-in cash sale (own book only)
      const nums = new Set($$('.phonerow [name=pn]').map((i) => last10(i.value)).filter((x) => x.length === 10));
      if (nums.size) {
        cashSalesCache ||= F.fetchAll(F.query(F.sellerCol(S.sid, 'sales'), F.where('cash', '==', true))).catch(() => []);
        const hits = (await cashSalesCache).filter((x) => nums.has(last10(x.buyerPhone))).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
        before = hits.map((x) => `<div class="infoline">🛒 ${t('Bought before as a cash sale')}: ${fmtDate(x.date)} · ${esc(cashItems(x))} · ${money(x.saleValue)}</div>`).join('');
      }
    }
    const dw = $('#dupWarn'); if (!dw) return; // the form was already saved and closed
    dw.innerHTML = others.map((o) => `<div class="warnline">📞 ${t('This number is also a customer of')} <b>${esc(o.name)}</b>${o.score != null ? ` (${t('Score')} ${o.score})` : ''}${o.ban ? ` · 🚫 ${esc(o.ban)}` : ''}. ${t('Ask them before adding.')}</div>`).join('') + before;
  };
  const bindPhones = () => {
    $$('[data-prm]').forEach((b) => (b.onclick = () => { if ($$('.phonerow').length > 1) b.parentElement.remove(); checkPhones(); }));
    $$('.phonerow [name=pn]').forEach((i) => (i.onchange = checkPhones));
  };
  $('#addPhone').onclick = () => { $('#phones').insertAdjacentHTML('beforeend', phoneRowHtml({}, pn++)); bindPhones(); };
  const fc = $('#fromContacts');
  if (fc) fc.onclick = async () => {
    const got = await pickContact(); if (!got) return;
    const f = $('#cf');
    if (got.name && !f.name.value.trim()) f.name.value = got.name;
    if (!got.numbers.length) return toast(t('This contact has no phone number'), true);
    const have = new Set($$('.phonerow [name=pn]').map((i) => last10(i.value)).filter(Boolean));
    const fresh = got.numbers.filter((n) => !have.has(last10(n)));
    if (!fresh.length) return toast(t('These numbers are already added'));
    let def = null; // ask only when the contact brings two or more numbers
    if (fresh.length > 1) { def = await askChoice(t('Which number should be the default?'), fresh); if (def == null) return; }
    const rows = () => $$('.phonerow');
    for (const n of fresh) {
      const empty = rows().find((r) => !$('[name=pn]', r).value.trim());
      let row = empty;
      if (!row) { $('#phones').insertAdjacentHTML('beforeend', phoneRowHtml({}, pn++)); row = rows().at(-1); }
      $('[name=pn]', row).value = n;
      if (def != null && n === fresh[def]) $('[name=pdef]', row).checked = true;
    }
    if (!$('input[name=pdef]:checked')) $('[name=pdef]', rows()[0]).checked = true;
    bindPhones(); checkPhones();
  };
  bindPhones();
  checkPhones();
  const pf = $('#cf'), psv = $('#psv');
  const showPs = () => { const v = Number(pf.ps.value); psv.textContent = v; psv.className = `sc big sc-${bandOf(v)}`; };
  pf.ps.oninput = showPs; showPs();
  pf.pk.onchange = () => { $('#priorBox').hidden = !pf.pk.checked; };
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const sb = $('#cf button[type=submit]'); if (sb.disabled) return; sb.disabled = true;
    const f = e.target, sid = S.sid, b = F.writeBatch(F.db);
    const def = $('input[name=pdef]:checked', f)?.value;
    const phones = $$('.phonerow', f).map((r) => ({ label: $('[name=pl]', r).value.trim(), number: $('[name=pn]', r).value.trim(), primary: $('[name=pdef]', r).value === def }))
      .filter((p) => p.number);
    if (phones.length && !phones.some((p) => p.primary)) phones[0].primary = true;
    const data = { name: f.name.value.trim(), house: f.house.value.trim(), lane: f.lane.value.trim(), phones, phone: phones.find((p) => p.primary)?.number || '',
      address: f.address.value.trim(), days: $$('input[name=day]:checked', f).map((x) => Number(x.value)) };
    // starting score from what the seller already knows (blended out by real payments, see L.customerScore)
    const prior = f.pk.checked ? { score: Number(f.ps.value), note: f.pnote.value.trim(), by: S.user.uid, at: today() } : null;
    const priorChanged = JSON.stringify(c?.prior ? { s: c.prior.score, n: c.prior.note || '' } : null) !== JSON.stringify(prior ? { s: prior.score, n: prior.note } : null);
    if (!c || priorChanged) data.prior = prior;
    const hashes = await hashesOf(phones);
    data.phoneHashes = hashes;
    if (c) {
      writeIndex(b, sid, id, c, hashes);
      const upd = { ...data };
      if (c.address && c.address !== data.address) upd.addressHistory = [...(c.addressHistory || []), { address: c.address, until: today() }];
      b.update(F.sellerDoc(sid, 'customers', id), upd);
      F.audit(b, S.user.uid, 'customer', `sellers/${sid}/customers/${id}`, { name: c.name, house: c.house || '', lane: c.lane || '', phones: phonesOf(c), address: c.address, days: daysOf(c), ...(priorChanged ? { prior: c.prior || null } : {}) }, data);
      F.commit(b, onWriteError);
      if (priorChanged) { c.prior = data.prior; rescoreSoon(id); }
      toast(t('Saved'));
      return go(`#/customer/${id}`);
    }
    const ccol = F.sellerCol(sid, 'customers');
    const cid = F.newId(ccol);
    const pendNow = pend ? readPending() : null;
    if (pendNow && !$$('.acc-row').length) { sb.disabled = false; return toast(t('Add an account for the cash sale balance'), true); }
    const mc = pendNow ? { modeCounts: { cash: pendNow.pays.filter((p) => p.mode === 'cash').length, upi: pendNow.pays.filter((p) => p.mode === 'upi').length } } : {};
    const startScore = prior ? { score: prior.score, band: bandOf(prior.score), parts: null, plan: null, freq: 'weekly', promises: null, capped: '', prior: { start: prior.score, w: 0, real: null }, at: today() } : null;
    b.set(F.doc(ccol, cid), { ...data, ...mc, ...(startScore ? { score: startScore } : {}), addressHistory: [], createdAt: Date.now() });
    writeIndex(b, sid, cid, startScore ? { score: startScore } : {}, hashes);
    let firstAid = null;
    $$('.acc-row').forEach((row, i) => {
      const acol = F.sellerCol(sid, 'accounts'), aid = F.newId(acol);
      let doc = newAccountDoc(cid, $('[name=an]', row).value.trim() || 'Account', $('[name=af]', row).value, num($('[name=ao]', row).value), accRowLastPaid(row));
      if (i === 0 && pendNow) doc = applyPendingSale(b, sid, cid, aid, doc, pendNow, data.name);
      if (i === 0) firstAid = aid;
      b.set(F.doc(acol, aid), doc);
    });
    if (pendNow) {
      F.audit(b, S.user.uid, 'cash-sale-to-customer', `sellers/${sid}/customers/${cid}`, null, { value: pendNow.value, paid: L.round2(pendNow.pays.reduce((s2, p) => s2 + p.amount, 0)) });
      try { sessionStorage.removeItem('pendingCash'); } catch {}
    }
    F.commit(b, onWriteError);
    toast(t('Saved'));
    if (pendNow) rescoreSoon(cid);
    let after = ''; try { after = sessionStorage.getItem('afterNewCustomer') || ''; sessionStorage.removeItem('afterNewCustomer'); } catch {}
    if (!pendNow && after === 'order') { try { sessionStorage.setItem('orderBack', '#/orders'); } catch {} return go(`#/order/${cid}`); }
    go(pendNow ? `#/account/${cid}/${firstAid}` : `#/customer/${cid}`);
  };
}

/** WhatsApp text for sharing one note about a customer (no phone number or balance). */
const noteShareText = (c, n) => [`*${APP_NAME} — ${t('Customer note')}*`, `${c.name}${placeOf(c) ? ' · ' + placeOf(c) : ''}`,
  c.score?.score != null ? `${t('Score')}: ${c.score.score}` : '', `${t('Note')}: ${n.text}`, `— ${S.profile?.name || ''}`].filter(Boolean).join('\n');

const VISIT_REASONS = [['away', 'Not at home'], ['nomoney', 'No money'], ['promise', 'Promised date']];
const reasonLabel = (r) => t((VISIT_REASONS.find((x) => x[0] === r) || [, r])[1]);

function scoreCardHtml(c) {
  const sc = c.score, p = sc?.plan, per = { daily: t('day'), weekly: t('week'), monthly: t('month') }[sc?.freq] || t('week');
  const others = othersOf(c);
  const pr = c.prior, pw = sc?.prior?.w ?? 0;
  const priorLine = pr ? `<div class="priorline">🤝 ${t('Starting score')} <b>${pr.score}</b>${pw >= 1 ? ` · ${t('payments decide now')}` : pw > 0 ? ` · ${Math.round(pw * 100)}% ${t('from payments')}` : ''}${pr.note ? ` · ${esc(pr.note)}` : ''}</div>` : '';
  const lines = !sc || sc.score == null || !p ? [pr ? t('Payments will decide the score after 4 weeks of history') : t('New customer — score after 4 weeks of history')]
    : [`<b>${t('Plan')}: ${rmoney(p.perPeriod)} / ${per}</b>`,
      `${t('Should have paid')} ${rmoney(p.expected)} · ${t('Paid')} ${rmoney(p.paid)}`,
      p.behind > 0 ? `<b style="color:var(--bad)">${rmoney(p.behind)} ${t('behind')} (${p.behindPeriods} ${per})</b>` : `<b style="color:var(--wa)">${t('Not behind')}</b>`,
      `${t('Their average')}: ${rmoney(p.average)} / ${per}`];
  return `<div class="scorecard">${scoreBadges(c, true)}<div class="txt">${lines.join('<br>')}${priorLine}
    ${others.map((o) => `<div style="margin-top:4px">👥 ${t('Also a customer of')} <b>${esc(o.name)}</b>${o.score != null ? ` · ${o.score}` : ''}${o.ban ? ` · 🚫 ${esc(o.ban)}` : ''} <a class="btn small wa" data-wa-seller="${o.key}" target="_blank" rel="noopener" hidden>💬</a></div>`).join('')}</div></div>`;
}

async function renderCustomer(cid) {
  if (needSeller()) return;
  const sid = S.sid;
  const draw = async () => {
    const c = S.customers[cid];
    if (!c) { view.innerHTML = `<div class="empty">${t('Customer not found')}</div>`; return; }
    setTitle(c.name, '#/customers');
    const accs = accountsOf(cid).sort((a, b) => (a.status === b.status ? a.createdAt - b.createdAt : a.status === 'closed' ? 1 : -1));
    const w = F.where('customerId', '==', cid);
    const [notesR, visitsR, ordersR] = await Promise.all([F.fetchAll(F.query(F.sellerCol(sid, 'notes'), w)), F.fetchAll(F.query(F.sellerCol(sid, 'visits'), w)), F.fetchAll(F.query(F.sellerCol(sid, 'orders'), w))]);
    const notes = notesR.sort((a, b) => b.createdAt - a.createdAt), visits = visitsR.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
    const orders = ordersR.filter((o) => o.status === 'pending').sort((a, b) => (a.deliveryDate < b.deliveryDate ? -1 : 1));
    const ph = c.phone, nextDay = L.nextRouteDate(daysOf(c), L.addDays(today(), -1));
    view.innerHTML = `
      <div class="card cust-head">
        ${placeBadge(c, true)}
        <div class="row" style="padding:0"><div><div class="nm">${esc(c.name)}</div>${c.address ? `<small>${esc(c.address)}</small>` : ''}</div>
          <a class="btn small" href="#/customer-edit/${cid}">${t('Edit')}</a></div>
        <div class="due"><div><span>${t('Total due')}</span><b>${money(openBalance(cid))}</b></div><span>${daysOf(c).map(dayLabel).join(' · ')}</span></div>
        <div class="grid2" style="margin:6px 0 0"><button class="btn primary" id="qCol">+ ${t('Collection')}</button><button class="btn" id="qSale">+ ${t('New sale')}</button></div>
        <div id="accPick" hidden></div>
        ${scoreCardHtml(c)}
      </div>
      <div class="qact">
        ${ph ? `<a class="btn" href="tel:${esc(ph)}"><span class="ic">📞</span>${t('Call')}</a><a class="btn" href="https://wa.me/${L.waNumber(ph)}" target="_blank" rel="noopener"><span class="ic">💬</span>WhatsApp</a>` : `<span></span><span></span>`}
        ${c.geo ? `<a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${c.geo.lat},${c.geo.lng}" target="_blank" rel="noopener"><span class="ic">🗺️</span>${t('Directions')}</a>`
          : `<button class="btn" id="geoBtn"><span class="ic">📍</span>${t('Save location')}</button>`}
      </div>
      <div class="contact" style="margin-top:0">
        <button class="btn" id="visitBtn">⊘ ${t('Visited – no payment')}</button>
        <a class="btn" href="#/order/${cid}">🚚 + ${t('Order')}</a></div>
      <form id="vf" class="card form" hidden>
        <b>${t('Visited – no payment')}</b>
        <div class="reasons">${VISIT_REASONS.map(([k, l], i) => `<label><input type="radio" name="r" value="${k}" ${i ? '' : 'checked'}><span>${t(l)}</span></label>`).join('')}</div>
        <label id="pdl" hidden>${t('Promised to pay on')}<input name="pd" type="date" min="${today()}" value="${nextDay}"></label>
        <label>${t('Note (optional)')}<input name="note"></label>
        <button class="btn primary" type="submit">${t('Save visit')}</button></form>
      ${c.geo ? `<div class="small muted">${t('Location saved')} ${fmtDate(c.geo.date)} · ±${Math.round(c.geo.acc)} m · <button class="linkbtn" id="geoBtn" style="color:var(--accent-text)">${t('Update location')}</button></div>` : ''}
      ${phonesOf(c).length > 1 || phonesOf(c)[0]?.label ? `<ul class="phonelist">${phonesOf(c).map((p) => `<li>${p.primary ? '<span class="star on">★</span>' : '<span class="star">☆</span>'}
        <span>${esc(p.label || '')}</span><b>${esc(p.number)}</b><a class="btn small" href="tel:${esc(p.number)}">📞</a></li>`).join('')}</ul>` : ''}
      ${ph ? `<div class="small" style="margin-top:6px"><a href="sms:${esc(ph)}">✉️ ${t('SMS')}</a></div>` : ''}
      ${orders.length ? `<h3>🚚 ${t('Orders')}</h3><ul class="list">${orders.map((o) => `<li><a class="row" href="#/order-edit/${o.id}"><div><b>${esc(o.items.map((i) => `${i.name} × ${i.qty}`).join(', '))}</b><small>${t('Deliver on')} ${fmtDate(o.deliveryDate)}</small>${noteLine(o)}</div><span class="pill ${o.deliveryDate <= today() ? 'bad' : ''}">${shortDate(o.deliveryDate)}</span></a></li>`).join('')}</ul>` : ''}
      <h3>${t('Accounts')}</h3>
      <ul class="list">${accs.map((a) => `<li><a class="row ${a.status === 'closed' ? 'closed' : ''}" href="#/account/${cid}/${a.id}">
        <div><b>${esc(a.name)}</b><small>${freqLabel(a.frequency)}${a.status === 'closed' ? ' · ' + t('Closed') : a.inactive ? ' · ⏸ ' + t('Inactive') : ''}</small></div>
        <div class="amt">${money(a.balance)}</div></a></li>`).join('')}</ul>
      <details class="card"><summary>+ ${t('Add account')}</summary>
        <form id="af">${accountRowHtml(1)}<button class="btn primary" type="submit">${t('Add account')}</button></form></details>
      <div class="contact">${c.ban
        ? (c.ban.by === sid || isAdmin() ? `<button class="btn small danger" id="unban">🚫 ${t('Remove flag')} (${esc(c.ban.reason)})</button>` : '')
        : `<button class="btn small" id="ban">🚫 ${t("Flag: don't give new items")}</button>`}</div>
      <h3>${t('Notes and reminders')}</h3>
      <form id="nf" class="card form">
        <textarea name="text" rows="2" placeholder="${t('Note, e.g. moved house / deliver item')}" required></textarea>
        <label>${t('Remind on (optional)')}<input name="due" type="date"></label>
        <button class="btn" type="submit">${t('Save note')}</button></form>
      <ul class="list">${notes.map((n) => `<li class="note ${n.done ? 'done' : ''}"><div class="row" style="padding:0;align-items:flex-start"><div>${n.kind === 'promise' ? '🤝 ' : ''}${esc(n.text)}</div>
        <a class="btn small" title="${t('Share')}" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(noteShareText(c, n))}">📤</a></div>
        <small class="muted">${fmtDate(n.date)}${n.dueDate ? ' · ' + t('Remind') + ' ' + fmtDate(n.dueDate) : ''}${n.done ? ' · ' + t('Done') : ''}</small></li>`).join('')}</ul>
      ${visits.length ? `<h3>⊘ ${t('Visits without payment')}</h3><ul class="list">${visits.map((v) => `<li class="note"><div>${reasonLabel(v.reason)}${v.promiseDate ? ' → ' + fmtDate(v.promiseDate) : ''}${v.note ? ' · ' + esc(v.note) : ''}</div><small class="muted">${fmtDate(v.date)}</small></li>`).join('')}</ul>` : ''}
      ${isAdmin() ? `<div class="contact" style="margin-top:18px"><button class="btn small danger" id="delCust">🗑 ${t('Delete customer')}</button></div>` : ''}`;
    const dc = $('#delCust');
    if (dc) dc.onclick = () => deleteCustomer(sid, cid, c, accs);
    $$('#geoBtn').forEach((gb) => (gb.onclick = () => {
      if (!navigator.geolocation) return toast(t('Location is not available on this phone'), true);
      if (c.geo && !confirm(t('Replace the saved location with where you are now?'))) return;
      gb.disabled = true; toast(t('Getting location…'));
      navigator.geolocation.getCurrentPosition((pos) => {
        const geo = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), acc: pos.coords.accuracy, date: today(), by: S.user.uid };
        const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'customers', cid), { geo }); F.commit(b, onWriteError);
        c.geo = geo; toast(`${t('Location saved')} (±${Math.round(geo.acc)} m)`); draw();
      }, (err) => { gb.disabled = false; toast(t('Could not get location') + ': ' + err.message, true); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }));
    const setBan = (ban) => {
      const b = F.writeBatch(F.db);
      b.update(F.sellerDoc(sid, 'customers', cid), { ban: ban || null });
      for (const h of c.phoneHashes || []) b.set(F.doc(F.db, 'phoneIndex', `${h}_${sid}_${cid}`), indexDoc(h, sid, { ...c, ban: ban || null }));
      F.audit(b, S.user.uid, 'customer-flag', `sellers/${sid}/customers/${cid}`, c.ban || null, ban || null);
      F.commit(b, onWriteError); c.ban = ban || null; draw();
    };
    const bb = $('#ban'), ub = $('#unban');
    if (bb) bb.onclick = () => { const r = (prompt(t('Reason (other sellers can read this)')) || '').trim(); if (r) setBan({ reason: r, by: sid, byName: sellerName(sid), at: today() }); };
    if (ub) ub.onclick = () => { if (confirm(t('Remove the flag?'))) setBan(null); };
    // WhatsApp buttons for the other sellers who also have this customer
    $$('[data-wa-seller]').forEach(async (a) => {
      const d = await F.getDoc(F.doc(F.db, 'shopSellers', a.dataset.waSeller)).catch(() => null);
      const wa = d?.exists() ? d.data().wa : '';
      if (wa) { a.href = `https://wa.me/${L.waNumber(wa)}?text=${encodeURIComponent(`${t('About customer')}: ${c.name}${placeOf(c) ? ' (' + placeOf(c) + ')' : ''} — ${t('how is this customer?')}`)}`; a.hidden = false; }
    });
    // Quick collection / sale: straight in with one open account, else pick the account.
    const openAccs = accs.filter((a) => a.status !== 'closed');
    const quick = (kind) => {
      const goTo = (aid) => { if (kind === 'collect') { setCollectBack(aid, '#/customers'); try { sessionStorage.setItem('lastCust', cid); } catch {} } go(`#/${kind}/${cid}/${aid}`); };
      if (!openAccs.length) {
        if (kind === 'collect') return toast(t('No open account'), true);
        toast(t('Add an account first'), true); const d = $('#af')?.closest('details'); if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); } return;
      }
      if (openAccs.length === 1) return goTo(openAccs[0].id);
      const box = $('#accPick');
      box.innerHTML = `<div class="small muted" style="margin:8px 0 4px">${kind === 'collect' ? t('Collection') : t('New sale')} — ${t('choose account')}</div>` +
        openAccs.map((a) => `<button class="row pick" data-qa="${a.id}" style="border:1px solid var(--line);border-radius:12px;margin:4px 0"><div><b>${esc(a.name)}</b><small>${freqLabel(a.frequency)}</small></div><div class="amt">${money(a.balance)}</div></button>`).join('');
      box.hidden = false;
      $$('[data-qa]', box).forEach((b) => (b.onclick = () => goTo(b.dataset.qa)));
    };
    $('#qCol').onclick = () => quick('collect');
    $('#qSale').onclick = () => quick('sale');
    const vf = $('#vf');
    $('#visitBtn').onclick = () => { vf.hidden = !vf.hidden; };
    $$('input[name=r]', vf).forEach((r) => (r.onchange = () => { $('#pdl').hidden = vf.r.value !== 'promise'; }));
    vf.onsubmit = (e) => {
      e.preventDefault();
      const reason = vf.r.value, pd = reason === 'promise' ? vf.pd.value : '', now = Date.now(), b = F.writeBatch(F.db);
      if (reason === 'promise' && !pd) return toast(t('Choose the promised date'), true);
      const vcol = F.sellerCol(sid, 'visits');
      b.set(F.doc(vcol, F.newId(vcol)), { customerId: cid, date: today(), reason, promiseDate: pd, note: vf.note.value.trim(), createdAt: now, by: S.user.uid });
      if (pd) { const ncol = F.sellerCol(sid, 'notes'); b.set(F.doc(ncol, F.newId(ncol)), { customerId: cid, customerName: c.name, kind: 'promise', text: t('Promised to pay') + (vf.note.value.trim() ? ' · ' + vf.note.value.trim() : ''), dueDate: pd, done: false, date: today(), createdAt: now }); }
      F.commit(b, onWriteError); toast(t('Visit saved')); rescoreSoon(cid); draw();
    };
    bindAccountRows($('#af'));
    $('#af').onsubmit = (e) => {
      e.preventDefault();
      const row = e.target, acol = F.sellerCol(sid, 'accounts'), b = F.writeBatch(F.db);
      b.set(F.doc(acol, F.newId(acol)), newAccountDoc(cid, $('[name=an]', row).value.trim() || 'Account', $('[name=af]', row).value, num($('[name=ao]', row).value), accRowLastPaid(row)));
      F.commit(b, onWriteError); toast(t('Saved'));
    };
    $('#nf').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target, ncol = F.sellerCol(sid, 'notes'), b = F.writeBatch(F.db);
      b.set(F.doc(ncol, F.newId(ncol)), { customerId: cid, customerName: c.name, text: f.text.value.trim(), dueDate: f.due.value || '', done: false, date: today(), createdAt: Date.now() });
      F.commit(b, onWriteError); toast(t('Saved')); draw();
    };
  };
  await draw();
  S.refresh = draw;
  rescore(cid).catch(() => {});
}

// ---------- pick customer for quick actions ----------
function renderPick(action) {
  setTitle(action === 'sale' ? t('New sale') : action === 'order' ? t('New order') : t('Collection'), action === 'order' ? '#/orders' : '#/home');
  if (needSeller()) return;
  try { sessionStorage.setItem('afterNewCustomer', action === 'order' ? 'order' : ''); } catch {}
  let paidToday = new Set(), visitedToday = new Set();
  const draw = () => {
    const qv = ($('#q')?.value || '').toLowerCase();
    // No search: today's route first in the same order as Customers → Today (arranged order, then lane / house no.),
    // a route moved here for a holiday after it, then everyone else by name. A search shows the hits by name.
    const plan = todayPlan(), all = Object.values(S.customers), byName = (x, y) => x.name.localeCompare(y.name);
    const sections = [];
    if (!qv && plan.days.length) {
      const seen = new Set();
      todayRouteList(plan).forEach((g) => { g.list.forEach((c) => seen.add(c.id)); sections.push({ head: g.moved ? `↩ ${dayLabel(g.day)} ${t('route (moved)')}` : '', cls: g.moved ? 'moved' : '', route: true, list: g.list }); });
      const rest = all.filter((c) => !seen.has(c.id)).sort(byName);
      if (rest.length) sections.push({ head: t('Others'), cls: '', route: false, list: rest });
    } else sections.push({ head: '', cls: '', route: false, list: all.filter((c) => searchHit(c, qv)).sort(byName) });
    let n = 0;
    const mark = (c) => (paidToday.has(c.id) ? '<span class="tick">✓</span> ' : visitedToday.has(c.id) ? `<span class="nopay" title="${t('Visited – no payment')}">⊘</span> ` : '');
    const name = (c, seq, dm = '') => `${placeBadge(c)}<b>${seq ? `<span class="seq">${seq}</span>` : ''}${mark(c)}${esc(c.name)}</b>${dm}`;
    const html = sections.map((sec) => {
      const rows = sec.list.map((c) => {
        const seq = sec.route ? ++n : 0, dm = sec.route ? dueMark(c.id, paidToday.has(c.id)) : '', paid = (paidToday.has(c.id) ? 'paid' : '') + (dm ? ' notdue' : '');
        if (action === 'order') return `<li><a class="row ${paid}" data-pick-order="${c.id}" href="#/order/${c.id}"><div>${name(c, seq, dm)}<small>${[esc(c.phone || ''), daysOf(c).map(dayLabel).join(' ')].filter(Boolean).join(' · ')}</small></div><div class="amt">${money(openBalance(c.id))}</div></a></li>`;
        return accountsOf(c.id).filter((a) => a.status !== 'closed').map((a, i) =>
          `<li><a class="row ${paid}" href="#/${action}/${c.id}/${a.id}"><div>${name(c, i ? 0 : seq, i ? '' : dm)}<small>${esc(a.name)} · ${freqLabel(a.frequency)}${nextDueOf(a) ? ` · ${t('Next due')} ${shortDate(nextDueOf(a))}` : ''}</small></div><div class="amt">${money(a.balance)}</div></a></li>`).join('');
      }).join('');
      return rows ? (sec.head ? `<li class="lanehead ${sec.cls}">${esc(sec.head)}</li>` : '') + rows : '';
    }).join('');
    $('#plist').innerHTML = html || `<li class="muted">${t('No matching customer')}</li>`;
    $$('[data-pick-order]').forEach((a) => (a.onclick = () => { try { sessionStorage.setItem('orderBack', '#/orders'); } catch {} }));
  };
  view.innerHTML = `<div class="toolbar"><input id="q" type="search" placeholder="${t('Search name or phone')}" autofocus><a class="btn" href="#/customer-new">+ ${t('New customer')}</a></div><ul class="list" id="plist"></ul>`;
  $('#q').oninput = draw;
  draw();
  const sid = S.sid;
  Promise.all([F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('date', '==', today()))),
    F.fetchAll(F.query(F.sellerCol(sid, 'visits'), F.where('date', '==', today())))]).then(([cols, vis]) => {
    if (!$('#plist')) return; // left the page already
    paidToday = new Set(cols.filter((c) => c.kind !== 'discount').map((c) => c.customerId));
    visitedToday = new Set(vis.map((v) => v.customerId));
    draw();
  }).catch(() => {});
}

// ---------- account ledger ----------
/**
 * Admin: delete a customer added by mistake. Allowed only when the customer has no transactions:
 * no sale, collection, discount or return on any account, and every account has a zero opening balance and balance.
 * Removes the customer, accounts, notes, visits, pending orders (and their to-buy lines) and shared-index entries.
 */
async function deleteCustomer(sid, cid, c, accs) {
  if (!isAdmin()) return;
  const w = F.where('customerId', '==', cid);
  const [sales, cols, rets, notes, visits, orders] = await Promise.all(['sales', 'collections', 'returns', 'notes', 'visits', 'orders']
    .map((k) => F.fetchAll(F.query(F.sellerCol(sid, k), w))));
  const money0 = accs.every((a) => !Number(a.openingBalance) && !Number(a.balance));
  if (sales.length || cols.length || rets.length || !money0) {
    alert(`${t('This customer has transactions and cannot be deleted.')}
${t('Sales')}: ${sales.length} · ${t('Collections')}: ${cols.length} · ${t('Returns')}: ${rets.length}${money0 ? '' : ' · ' + t('Balance or opening balance is not zero')}`);
    return;
  }
  const typed = prompt(`${t('Delete this customer?')}
${c.name}
${t('Accounts')}: ${accs.length} · ${t('Notes')}: ${notes.length} · ${t('Visits')}: ${visits.length} · ${t('Orders')}: ${orders.length}

${t('Type the customer name to confirm')}`);
  if (typed == null) return;
  if (typed.trim().toLowerCase() !== String(c.name).trim().toLowerCase()) { toast(t('Name did not match. Not deleted.'), true); return; }
  const b = F.writeBatch(F.db);
  accs.forEach((a) => b.delete(F.sellerDoc(sid, 'accounts', a.id)));
  notes.forEach((n) => b.delete(F.sellerDoc(sid, 'notes', n.id)));
  visits.forEach((v) => b.delete(F.sellerDoc(sid, 'visits', v.id)));
  orders.forEach((o) => { b.delete(F.sellerDoc(sid, 'orders', o.id)); b.delete(F.doc(F.db, 'demand', o.id)); });
  (c.phoneHashes || []).forEach((h) => b.delete(F.doc(F.db, 'phoneIndex', `${h}_${sid}_${cid}`)));
  b.delete(F.sellerDoc(sid, 'customers', cid));
  const { id: _i, ...before } = c;
  F.audit(b, S.user.uid, 'customer-delete', `sellers/${sid}/customers/${cid}`, { customer: before, accounts: accs.map((a) => ({ name: a.name, frequency: a.frequency })), notes: notes.length, visits: visits.length, orders: orders.length }, null);
  F.commit(b, onWriteError);
  delete S.customers[cid]; accs.forEach((a) => delete S.accounts[a.id]);
  toast(t('Customer deleted'));
  location.hash = '#/customers';
}

/** Patch that makes an account active or inactive; pauses are kept as date ranges for the score. */
function setActive(a, active) {
  const pauses = (a.pauses || []).map((p) => ({ ...p }));
  if (!active) { pauses.push({ from: today(), to: null }); return { inactive: true, inactiveSince: today(), pauses }; }
  const last = pauses.find((p) => !p.to); if (last) last.to = today();
  return { inactive: false, inactiveSince: null, pauses };
}

/**
 * Add or correct an account's opening balance (old-book balance) at any time.
 * Every entry of the account is replayed in order with the new opening, so the open items, each collection's
 * allocations and realised profit stay right. Only the balance moves, by the difference.
 */
async function editOpening(sid, cid, aid) {
  const a = S.accounts[aid]; if (!a) return false;
  if (!navigator.onLine) { toast(t('Needs internet, so that every entry of this account is loaded.'), true); return false; }
  const old = L.round2(Number(a.openingBalance) || 0);
  const v = prompt(`${t('Opening balance (old book)')}
${t('Now')}: ${money(old)}`, old ? String(old) : '');
  if (v == null) return false;
  const raw = String(v).trim().replace(/,/g, '');
  const amt = raw === '' ? 0 : L.round2(Number(raw));
  if (!Number.isFinite(amt) || amt < 0) { toast(t('Enter a valid amount'), true); return false; }
  if (amt === old) return false;
  const data = await loadAccountData(sid, aid);
  const op = (a.queue || []).find((q) => q.ref === 'opening');
  const ratio = op?.ratio ?? L.legacyRatio(S.settings.legacyMarginPct);
  const rp = L.replayAccount({ opening: amt > 0 ? { amount: amt, ratio } : null, sales: data.sales, collections: data.collections, returns: data.returns });
  const expect = L.round2((Number(a.balance) || 0) + amt - old);
  if (L.round2(rp.balance) !== expect) { toast(t('Some entries are still syncing. Try again in a minute.'), true); return false; }
  if (!confirm(`${t('Opening balance')}: ${money(old)} → ${money(amt)}
${t('Balance')}: ${money(a.balance)} → ${money(expect)}`)) return false;
  const b = F.writeBatch(F.db);
  const patch = { openingBalance: amt, balance: expect, queue: rp.queue };
  if (a.status === 'closed' && expect > 0) patch.status = 'open';
  b.update(F.sellerDoc(sid, 'accounts', aid), { ...patch, balance: F.increment(L.round2(amt - old)) });
  let changed = 0;
  for (const nc of rp.collections) {
    const oc = data.collections.find((x) => x.id === nc.id);
    if (oc && (JSON.stringify(oc.allocations || []) !== JSON.stringify(nc.allocations) || L.round2(oc.profit || 0) !== L.round2(nc.profit))) {
      b.update(F.sellerDoc(sid, 'collections', nc.id), { allocations: nc.allocations, profit: nc.profit }); changed++;
    }
  }
  F.audit(b, S.user.uid, 'opening-balance', `sellers/${sid}/accounts/${aid}`, { openingBalance: old, balance: a.balance }, { openingBalance: amt, balance: expect, collectionsUpdated: changed });
  F.commit(b, onWriteError);
  Object.assign(a, patch);
  toast(t('Opening balance saved')); rescoreSoon(cid);
  return true;
}

async function loadAccountData(sid, aid) {
  const w = F.where('accountId', '==', aid);
  const [sales, collections, returns] = await Promise.all([
    F.fetchAll(F.query(F.sellerCol(sid, 'sales'), w)),
    F.fetchAll(F.query(F.sellerCol(sid, 'collections'), w)),
    F.fetchAll(F.query(F.sellerCol(sid, 'returns'), w)),
  ]);
  return { sales, collections, returns };
}

const typeLabel = (r) => ({ opening: t('Opening balance'), sale: t('Sale'), advance: t('Advance'), collection: t('Collection'), return: t('Return'), discount: t('Discount') }[r.type]);
const rowDetail = (r) => r.type === 'sale' ? r.ref.items.map((i) => `${i.name} × ${i.qty}`).join(', ')
  : r.type === 'return' ? r.ref.items.map((i) => `${i.name} × ${i.qty}`).join(', ')
  : r.type === 'collection' || r.type === 'advance' ? [modeLabel(r.ref.mode), scrapDetail(r.ref), r.ref.note].filter(Boolean).join(' · ') : r.type === 'discount' ? r.ref.note || '' : '';

async function renderAccount(cid, aid) {
  if (needSeller()) return;
  const sid = S.sid;
  const draw = async () => {
    const c = S.customers[cid], a = S.accounts[aid];
    if (!c || !a) { view.innerHTML = `<div class="empty">${t('Account not found')}</div>`; return; }
    setTitle(`${c.name} · ${a.name}`, `#/customer/${cid}`);
    const data = await loadAccountData(sid, aid);
    const ledger = L.buildLedger(a.openingBalance, data.sales, data.collections, data.returns);
    // Self-check: the open items must add up to the balance. If two phones edited this account offline at once,
    // rebuild the open items from the entries (balances are never changed by this).
    const ledgerBal = ledger.length ? ledger.at(-1).balance : L.round2(a.openingBalance || 0);
    if (navigator.onLine && L.round2(ledgerBal) === L.round2(a.balance) && L.queueDue(a.queue) !== L.round2(Math.max(0, a.balance))) {
      const op = (a.queue || []).find((q) => q.ref === 'opening');
      const rp = L.replayAccount({ opening: a.openingBalance > 0 ? { amount: a.openingBalance, ratio: op?.ratio ?? L.legacyRatio(S.settings.legacyMarginPct) } : null, sales: data.sales, collections: data.collections, returns: data.returns });
      if (L.queueDue(rp.queue) === L.round2(Math.max(0, a.balance))) {
        const qb = F.writeBatch(F.db); qb.update(F.sellerDoc(sid, 'accounts', aid), { queue: rp.queue });
        F.audit(qb, S.user.uid, 'queue-repair', `sellers/${sid}/accounts/${aid}`, { due: L.queueDue(a.queue) }, { due: L.queueDue(rp.queue) });
        F.commit(qb, () => {}); a.queue = rp.queue;
      }
    }
    const open = (a.queue || []).filter((q) => q.remaining > 0 && q.ref !== 'opening');
    const saleById = Object.fromEntries(data.sales.map((s) => [s.id, s]));
    try { sessionStorage.removeItem('collectBack'); } catch {} // a collection started from this page returns here
    let rc = readReceipt();
    if (rc && rc.aid !== aid) rc = null;
    view.innerHTML = `
      ${rc ? `<div class="banner" id="rcpt"><b>✓ ${t('Saved')} · ${money(rc.amount)}${rc.discount ? ` + ${t('Discount')} ${money(rc.discount)}` : ''}</b><span class="small">${t('New balance')} ${money(rc.balance)}</span>
        <div class="contact">${rc.phone ? `<a class="btn wa" id="rcSend" href="https://wa.me/${L.waNumber(rc.phone)}?text=${encodeURIComponent(rc.text)}" target="_blank" rel="noopener">📩 ${t('Send receipt')}</a>` : `<span class="small muted">${t('No phone number saved')}</span>`}
        <button class="btn small" id="rcX">${t('Close')}</button></div></div>` : ''}
      <div class="card balance"><span>${t('Balance due')}</span><b>${money(a.balance)}</b>
        <small>${freqLabel(a.frequency)}${nextDueOf(a) ? ` · ${t('Next due')} ${fmtDate(nextDueOf(a))}` : ''}${a.status === 'closed' ? ' · ' + t('Closed') : a.inactive ? ' · ⏸ ' + t('Inactive') + (a.inactiveSince ? ' ' + t('since') + ' ' + fmtDate(a.inactiveSince) : '') : ''}</small>
        <button class="linkbtn obal" id="obal">${Number(a.openingBalance) > 0 ? `${t('Opening balance')}: ${money(a.openingBalance)} ✏️` : `+ ${t('Opening balance')}`}</button></div>
      <div class="grid2 acctiles">
        <a class="tile primary" href="#/collect/${cid}/${aid}">${t('Collection')}</a>
        <a class="tile" href="#/sale/${cid}/${aid}">${t('New sale')}</a>
        <a class="tile" href="#/return/${cid}/${aid}">${t('Return')}</a>
        <a class="tile" href="#/order/${cid}" id="accOrd">🚚 ${t('Order')}</a>
      </div>
      <div class="contact">
        <button class="btn wa" id="waStmt">${t('Send statement')} (WhatsApp)</button>
        <button class="btn" id="pdfStmt">PDF</button>
      </div>
      ${open.length ? `<h3>${t('Open sales')}</h3><ul class="list">${open.map((q) => { const s = saleById[q.ref]; return s ? `<li class="row"><div><b>${fmtDate(s.date)}</b><small>${esc(s.items.map((i) => i.name).join(', '))}</small></div><div class="amt">${money(q.remaining)}<small>${t('of')} ${money(s.saleValue - (s.creditedValue || 0))}</small></div></li>` : ''; }).join('')}</ul>` : ''}
      <h3>${t('Statement')}</h3>
      <table class="ledger"><thead><tr><th>${t('Date')}</th><th>${t('Details')}</th><th>+</th><th>−</th><th>${t('Balance')}</th></tr></thead><tbody>
      ${ledger.map((r) => `<tr class="${r.type}"><td>${fmtDate(r.date)}</td><td>${typeLabel(r)}<small>${esc(rowDetail(r))}</small>
        ${r.type === 'collection' || r.type === 'advance' || r.type === 'discount' ? `<button class="x" data-del="${r.ref.id}" title="${t('Delete')}">×</button>` : ''}
        ${r.type === 'sale' && isAdmin() ? `<button class="void" data-void="${r.ref.id}">${t('Void')}</button>` : ''}</td>
        <td>${r.sign > 0 ? money(r.amount) : ''}</td><td>${r.sign < 0 ? money(r.amount) : ''}</td><td>${money(r.balance)}</td></tr>`).join('')}
      </tbody></table>
      <form id="aef" class="card form edbox" hidden>
        <label>${t('Account name')}<input name="an" value="${esc(a.name)}" required maxlength="40"></label>
        <label>${t('Instalment')}<select name="af">${FREQ.map((f) => `<option value="${f}" ${f === (a.frequency || 'weekly') ? 'selected' : ''}>${freqLabel(f)}</option>`).join('')}</select></label>
        <label class="lpo" ${(a.frequency || 'weekly') === 'monthly' ? '' : 'hidden'}>${t('Last paid (old book)')} <small class="muted">(${t('optional')})</small><input name="alp" type="date" max="${today()}" value="${a.lastPaidOld || ''}"></label>
        <div class="contact"><button class="btn primary" type="submit">${t('Save')}</button><button class="btn" type="button" id="aefX">${t('Cancel')}</button></div></form>
      <div class="actions"><button class="btn" id="accEd">✏️ ${t('Edit account')}</button>${a.status !== 'closed' ? (a.inactive
        ? `<button class="btn" id="actTgl">▶ ${t('Make active')}</button>`
        : `<button class="btn" id="actTgl">⏸ ${t('Make inactive')}</button>`) : ''}${a.status === 'closed'
        ? `<button class="btn" id="reopen">${t('Reopen account')}</button>`
        : `<button class="btn" id="close" ${a.balance > 0 ? 'disabled' : ''}>${t('Close account')}</button>`}</div>
      ${a.balance > 0 && a.status !== 'closed' ? `<p class="muted small">${t('An account can be closed when the balance is zero.')}</p>` : ''}`;

    const stmtText = () => {
      const lines = ledger.slice(-25).map((r) => `${fmtDate(r.date) || '-'}  ${typeLabel(r)}${r.type === 'collection' || r.type === 'advance' ? ' (' + modeLabel(r.ref.mode) + ')' : ''}  ${r.sign > 0 ? '+' : '-'}${money(r.amount)}`);
      return `*${APP_NAME}*\n${c.name} — ${a.name}\n${t('Date')}: ${fmtDate(today())}\n\n${lines.join('\n')}\n\n*${t('Balance due')}: ${money(a.balance)}*`;
    };
    const tg = $('#actTgl');
    if (tg) tg.onclick = () => {
      const on = !a.inactive;
      if (on && !confirm(t('Make this account inactive? It stays in the route list marked ⏸ but is not counted, and the customer score does not count the paused time. A new sale makes it active again.'))) return;
      const patch = setActive(a, !on);
      const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), patch);
      F.audit(b, S.user.uid, on ? 'account-inactive' : 'account-active', `sellers/${sid}/accounts/${aid}`, null, patch);
      F.commit(b, onWriteError); Object.assign(a, patch); rescoreSoon(cid); draw();
    };
    const aef = $('#aef');
    $('#accEd').onclick = () => { aef.hidden = !aef.hidden; if (!aef.hidden) { aef.scrollIntoView({ block: 'center' }); aef.an.focus(); } };
    $('#aefX').onclick = () => { aef.hidden = true; };
    aef.af.onchange = () => { $('.lpo', aef).hidden = aef.af.value !== 'monthly'; };
    aef.onsubmit = (e) => {
      e.preventDefault();
      const name = aef.an.value.trim(), frequency = aef.af.value, lpo = frequency === 'monthly' ? aef.alp.value : (a.lastPaidOld || '');
      if (!name) return toast(t('Enter the account name'), true);
      const patch = {};
      if (lpo !== (a.lastPaidOld || '')) patch.lastPaidOld = lpo;
      if (name !== a.name) patch.name = name;
      if (frequency !== (a.frequency || 'weekly')) patch.frequency = frequency;
      if (!Object.keys(patch).length) { aef.hidden = true; return; }
      const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), patch);
      F.audit(b, S.user.uid, 'account-edit', `sellers/${sid}/accounts/${aid}`, { name: a.name, frequency: a.frequency || 'weekly', lastPaidOld: a.lastPaidOld || '' }, patch);
      F.commit(b, onWriteError); Object.assign(a, patch);
      if (patch.frequency) rescoreSoon(cid); // the score's allowed delay depends on daily / weekly / monthly
      toast(t('Saved')); draw();
    };
    $('#obal').onclick = () => editOpening(sid, cid, aid).then((ok) => ok && setTimeout(draw, 300));
    $('#accOrd').onclick = () => { try { sessionStorage.setItem('orderBack', `#/account/${cid}/${aid}`); } catch {} };
    $('#waStmt').onclick = () => window.open(`https://wa.me/${L.waNumber(c.phone)}?text=${encodeURIComponent(stmtText())}`, '_blank');
    $('#pdfStmt').onclick = () => makePdf({
      title: `Statement - ${c.name} (${a.name})`, subtitle: `${c.phone || ''}  |  ${fmtDate(today())}`,
      head: ['Date', 'Details', 'Debit', 'Credit', 'Balance'],
      rows: ledger.map((r) => [fmtDate(r.date), `${({ opening: 'Opening balance', sale: 'Sale', advance: 'Advance', collection: 'Collection', return: 'Return', discount: 'Discount' })[r.type]} ${r.type === 'collection' || r.type === 'advance' ? [MODE_EN[r.ref.mode] || 'Cash', (r.ref.scrapItems || []).map((i) => `${i.type} ${i.value}`).join(', '), r.ref.note].filter(Boolean).join(' ') : rowDetail(r)}`.slice(0, 60), r.sign > 0 ? pdfMoney(r.amount) : '', r.sign < 0 ? pdfMoney(r.amount) : '', pdfMoney(r.balance)]),
      foot: [`Balance due: ${pdfMoney(a.balance)}`],
      file: `statement-${c.name}-${a.name}.pdf`,
    });
    $$('[data-del]').forEach((btn) => (btn.onclick = () => {
      const col = data.collections.find((x) => x.id === btn.dataset.del);
      if (!col || !confirm(t('Delete this collection of') + ' ' + money(col.amount) + '?')) return;
      const b = F.writeBatch(F.db);
      b.delete(F.sellerDoc(sid, 'collections', col.id));
      if (col.mode === 'scrap') b.delete(F.doc(F.db, 'scrapIn', col.id));
      else if (col.kind !== 'discount') b.update(F.sellerDoc(sid, 'customers', cid), { [`modeCounts.${col.mode === 'upi' ? 'upi' : 'cash'}`]: F.increment(-1) });
      b.update(F.sellerDoc(sid, 'accounts', aid), { queue: L.reverseAllocations(a.queue || [], col.allocations), balance: F.increment(col.amount) });
      F.audit(b, S.user.uid, 'collection-delete', `sellers/${sid}/collections/${col.id}`, col, null);
      F.commit(b, onWriteError); toast(t('Deleted')); rescoreSoon(cid);
      setTimeout(draw, 300);
    }));
    const rx = $('#rcX'), rs = $('#rcSend');
    if (rx) rx.onclick = () => { sessionStorage.removeItem('receipt'); $('#rcpt').remove(); };
    if (rs) rs.addEventListener('click', () => sessionStorage.removeItem('receipt'));
    $$('[data-void]').forEach((btn) => (btn.onclick = () => voidSale(sid, cid, aid, a, data, btn.dataset.void).then((ok) => ok && setTimeout(draw, 300))));
    const cl = $('#close'), ro = $('#reopen');
    if (cl) cl.onclick = () => { const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), { status: 'closed', closedOn: today(), ...(a.inactive ? setActive(a, true) : {}) }); F.commit(b, onWriteError); toast(t('Account closed')); };
    if (ro) ro.onclick = () => { const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), { status: 'open' }); F.commit(b, onWriteError); };
  };
  await draw();
  S.refresh = draw;
}

/**
 * Admin: cancel a sale entered by mistake. Removes the sale and its advance,
 * and re-runs every other collection on the account so balances and realised profit stay right.
 */
async function voidSale(sid, cid, aid, a0, data0, saleId) {
  if (!isAdmin()) return false;
  const data = await loadAccountData(sid, aid); // fresh: entries may have synced since the page was drawn
  const a = S.accounts[aid] || a0, sale = data.sales.find((x) => x.id === saleId);
  if (!sale) return false;
  if (data.returns.some((r) => r.saleId === saleId)) { toast(t('This sale has a return. It cannot be voided — use Return instead.'), true); return false; }
  const adv = data.collections.filter((c) => c.kind === 'advance' && c.saleId === saleId);
  const advTotal = L.round2(adv.reduce((s2, c) => s2 + c.amount, 0));
  const msg = `${t('Void this sale?')}\n${fmtDate(sale.date)} · ${sale.items.map((i) => `${i.name} × ${i.qty}`).join(', ')} · ${money(sale.saleValue)}` +
    (adv.length ? `\n${t('Its advance of')} ${money(advTotal)} ${t('will also be removed.')}` : '');
  if (!confirm(msg)) return false;
  const v = L.voidFromQueue(a.queue || [], saleId, data.collections.filter((c) => !adv.includes(c)));
  const b = F.writeBatch(F.db);
  b.delete(F.sellerDoc(sid, 'sales', saleId));
  adv.forEach((c) => {
    b.delete(F.sellerDoc(sid, 'collections', c.id));
    if (c.mode === 'scrap') b.delete(F.doc(F.db, 'scrapIn', c.id));
    if (c.mode !== 'scrap') b.update(F.sellerDoc(sid, 'customers', cid), { [`modeCounts.${c.mode === 'upi' ? 'upi' : 'cash'}`]: F.increment(-1) });
  });
  v.collections.forEach((nc) => b.update(F.sellerDoc(sid, 'collections', nc.id), { allocations: nc.allocations, profit: nc.profit }));
  b.update(F.sellerDoc(sid, 'accounts', aid), { queue: v.queue, balance: F.increment(L.round2(advTotal - sale.saleValue)) });
  // A sale made when delivering an order: the order goes back to pending.
  const ords = await F.fetchAll(F.query(F.sellerCol(sid, 'orders'), F.where('saleId', '==', saleId)));
  ords.forEach((o) => {
    b.update(F.sellerDoc(sid, 'orders', o.id), { status: 'pending', saleId: '', deliveredOn: '' });
    b.set(F.doc(F.db, 'demand', o.id), demandDoc(sid, o, null));
  });
  F.audit(b, S.user.uid, 'sale-void', `sellers/${sid}/sales/${saleId}`, { sale, advances: adv }, null);
  F.commit(b, onWriteError);
  rescoreSoon(cid);
  toast(t('Sale voided'));
  return true;
}

// ---------- sale ----------
// ---------- free-typed item lines (no stock) ----------
// Items are typed with quantity and price. Cost is not entered: it is estimated from the default margin
// (App settings), so booked and realised profit stay approximate figures.
const estCost = (price) => L.round2((Number(price) || 0) / (1 + Math.max(0, Number(S.settings.defaultMarginPct) || 0) / 100));
const knownNames = () => [...new Set([...(S.itemNames || []), ...Object.values(S.catalog).map((c) => c.name)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
const lastPrice = (name) => { const k = L.nameKey(name); return (S.itemPrices || {})[k] || S.catalog[k]?.price || ''; };
/** Sale lines saved on the sale: name, qty, price each, estimated cost each. */
const toSaleLines = (rows) => rows.filter((l) => l.name.trim() && l.qty > 0 && l.price > 0)
  .map((l) => ({ name: l.name.trim(), qty: Math.round(l.qty), price: L.round2(l.price), unitCost: estCost(l.price), returned: 0 }));
/** Remember typed item names and their last price for suggestions (per seller book; one field per item, merged). */
function rememberItems(b, sid, lines) {
  const upd = {};
  for (const l of lines) {
    const k = L.nameKey(l.name);
    if (S.itemPrices[k] === l.price && (S.itemNames || []).includes(l.name)) continue;
    upd[`i_${k}`] = { name: l.name, price: l.price, at: Date.now() };
    S.itemPrices[k] = l.price; if (!S.itemNames.some((n) => L.nameKey(n) === k)) S.itemNames.push(l.name);
  }
  if (Object.keys(upd).length) b.set(F.sellerDoc(sid, 'meta', 'items'), upd, { merge: true });
}
/**
 * Item line editor. rows: [{name, qty, price}] (edited in place). onChange(total) after every change.
 * Typing a known name fills its last price when the price is empty.
 */
function mountLines(el, rows, onChange) {
  if (!rows.length) rows.push({ name: '', qty: 1, price: 0 });
  const draw = () => {
    el.innerHTML = `<datalist id="inames">${knownNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${rows.map((l, i) => `<div class="iline" data-i="${i}">
        <input class="in" data-f="name" list="inames" placeholder="${t('Item')}" value="${esc(l.name)}" autocomplete="off">
        <div class="iline-n"><label>${t('Qty')}<input data-f="qty" type="number" min="1" inputmode="numeric" value="${l.qty || ''}"></label>
          <label>${t('Price each')}<input data-f="price" type="number" step="any" min="0" inputmode="decimal" value="${l.price || ''}"></label>
          <div class="ltot"><span>${t('Amount')}</span><b data-lt="${i}">${money(L.round2((l.qty || 0) * (l.price || 0)))}</b></div>
          <button type="button" class="x" data-rm="${i}" aria-label="${t('Remove')}">×</button></div></div>`).join('')}
      <button type="button" class="btn ghost small" id="addLine">+ ${t('Another item')}</button>`;
    $$('.iline', el).forEach((row) => {
      const i = +row.dataset.i, l = rows[i];
      $$('[data-f]', row).forEach((inp) => (inp.oninput = () => {
        const f = inp.dataset.f;
        if (f === 'name') l.name = inp.value; else l[f] = f === 'qty' ? Math.round(num(inp.value)) : num(inp.value);
        $(`[data-lt="${i}"]`, el).textContent = money(L.round2((l.qty || 0) * (l.price || 0)));
        onChange(total());
      }));
      $('[data-f=name]', row).onchange = () => {
        const pr = $('[data-f=price]', row);
        if (!num(pr.value) && lastPrice(l.name)) { l.price = lastPrice(l.name); pr.value = l.price; $(`[data-lt="${i}"]`, el).textContent = money(L.round2((l.qty || 0) * l.price)); onChange(total()); }
      };
    });
    $$('[data-rm]', el).forEach((btn) => (btn.onclick = () => { rows.splice(+btn.dataset.rm, 1); if (!rows.length) rows.push({ name: '', qty: 1, price: 0 }); draw(); onChange(total()); }));
    $('#addLine', el).onclick = () => { rows.push({ name: '', qty: 1, price: 0 }); draw(); onChange(total()); $$('.iline [data-f=name]', el).at(-1).focus(); };
  };
  const total = () => L.round2(rows.reduce((s, l) => s + (l.name.trim() ? (l.qty || 0) * (l.price || 0) : 0), 0));
  draw(); onChange(total());
}
const PER = { daily: [365, 'day'], weekly: [52, 'week'], monthly: [12, 'month'] };

function renderSale(cid, aid) {
  if (needSeller()) return;
  const sid = S.sid, c = S.customers[cid], a = S.accounts[aid];
  if (!c || !a) return go('#/customers');
  setTitle(`${t('New sale')} · ${c.name}`, true);
  let order = null;
  try { const o = JSON.parse(sessionStorage.getItem('saleOrder') || 'null'); if (o && o.customerId === cid) order = o; } catch {}
  const rows = order ? order.items.map((i) => ({ name: i.name, qty: Number(i.qty) || 1, price: Number(lastPrice(i.name)) || 0 })) : [];
  const [perN, perW] = PER[a.frequency] || PER.weekly;
  const warns = riskWarnings(c);
  view.innerHTML = `${warns.length ? `<div class="banner warn"><b>⚠ ${t('Check before giving')}</b>${warns.map((w) => `<div class="small">${w}</div>`).join('')}</div>` : ''}
    ${order ? `<div class="banner"><b>🚚 ${t('Delivering order')}</b><span class="small">${esc(order.items.map((i) => `${i.name} × ${i.qty}`).join(', '))}</span></div>` : ''}
    <div class="card form"><small class="muted">${esc(a.name)} · ${t('Balance')} ${money(a.balance)}</small>
      <div id="lines"></div>
      <div class="row total"><span>${t('Total')}</span><b id="total">₹0</b></div>
      <div class="two"><label>${t('Advance received')}<input id="adv" type="number" step="any" min="0" inputmode="decimal" placeholder="0"></label>
      <label>${t('Date')}<input id="sdate" type="date" value="${today()}" max="${today()}"></label></div>
      <label>${t('Advance paid by')}</label>${payPicker('advMode', L.preferredMode(c.modeCounts))}
      ${upiQrBoxHtml()}
      <div class="calcbox" id="calc"></div>
      <button class="btn primary" id="saveSale">${t('Save sale')}</button></div>`;
  let tot = 0;
  const calc = () => {
    const adv = Math.min(num($('#adv').value), tot), rest = L.round2(tot - adv);
    $('#total').textContent = money(tot);
    $('#calc').innerHTML = tot ? `<div class="kv"><span>${t('Balance of this sale')}</span><b>${money(rest)}</b></div>
      <div class="kv"><span>${t('New account balance')}</span><b>${money(L.round2(a.balance + rest))}</b></div>
      ${rest > 0 ? `<div class="kv small"><span>${t('To finish in a year')}</span><span>${money(Math.ceil(rest / perN))} / ${t(perW)}</span></div>` : ''}` : '';
  };
  const advQr = bindUpiQr(view, { amount: () => Math.min(num($('#adv').value), tot || Infinity), note: () => `${APP_NAME} - ${c.name}`, visible: () => pickedMode('advMode') === 'upi' });
  $$('input[name=advMode]').forEach((r) => (r.onchange = advQr));
  mountLines($('#lines'), rows, (v) => { tot = v; calc(); advQr(); });
  $('#adv').oninput = () => { calc(); advQr(); };
  $('#saveSale').onclick = () => {
    const lines = toSaleLines(rows);
    if (!lines.length) return toast(t('Enter at least one item with quantity and price'), true);
    if (rows.some((l) => l.name.trim() && !(l.price > 0))) return toast(t('Enter the price of every item'), true);
    if (rows.some((l) => l.name.trim() && !(l.qty >= 1))) return toast(t('Enter the quantity of every item'), true);
    if ($('#saveSale').disabled) return;
    $('#saveSale').disabled = true;
    const { value, cost } = L.saleTotals(lines);
    const adv = Math.min(num($('#adv').value), value);
    const date = $('#sdate').value || today();
    const b = F.writeBatch(F.db), scol = F.sellerCol(sid, 'sales'), saleId = F.newId(scol), now = Date.now();
    b.set(F.doc(scol, saleId), { accountId: aid, customerId: cid, date, items: lines, saleValue: value, cost, advance: adv, creditedValue: 0, creditedCost: 0, costEstimated: true, createdAt: now, by: S.user.uid });
    rememberItems(b, sid, lines);
    let queue = L.addSaleToQueue(a.queue || [], saleId, date, value, cost);
    if (adv > 0) {
      const r = L.allocate(queue, adv, saleId), advMode = pickedMode('advMode');
      b.update(F.sellerDoc(sid, 'customers', cid), { [`modeCounts.${advMode}`]: F.increment(1) });
      queue = r.queue;
      const ccol = F.sellerCol(sid, 'collections');
      b.set(F.doc(ccol, F.newId(ccol)), { accountId: aid, customerId: cid, date, amount: adv, kind: 'advance', mode: advMode, ...upiTag(advMode, pickedUpi('upito')), saleId, note: '', allocations: r.allocations, profit: r.profit, createdAt: now, by: S.user.uid });
    }
    b.update(F.sellerDoc(sid, 'accounts', aid), { queue, balance: F.increment(L.round2(value - adv)), status: 'open', ...(a.inactive ? setActive(a, true) : {}) });
    if (order) {
      b.update(F.sellerDoc(sid, 'orders', order.id), { status: 'delivered', deliveredOn: date, saleId, accountId: aid });
      b.delete(F.doc(F.db, 'demand', order.id));
      sessionStorage.removeItem('saleOrder');
    }
    F.commit(b, onWriteError);
    rescoreSoon(cid);
    toast(t('Sale saved'));
    go(`#/account/${cid}/${aid}`);
  };
}

// ---------- collection ----------
const scrapLineHtml = () => `<div class="scrapline"><select name="st">${scrapTypes().map((x) => `<option value="${esc(x)}">${esc(t(x))}</option>`).join('')}</select>
  <input name="sv" type="number" step="any" min="0" inputmode="decimal" placeholder="${t('Value ₹')}"><button type="button" class="x" data-srm>×</button></div>`;

function renderCollect(cid, aid) {
  if (needSeller()) return;
  const sid = S.sid, c = S.customers[cid], a = S.accounts[aid];
  if (!c || !a) return go('#/customers');
  setTitle(`${t('Collection')} · ${c.name}`, true);
  view.innerHTML = `<form id="colf" class="card form">
    <div class="balance"><span>${esc(a.name)} · ${t('Balance due')}</span><b>${money(a.balance)}</b></div>
    <label>${t('Paid by')}</label>${payPicker('mode', L.preferredMode(c.modeCounts), L.PAY_MODES)}
    <div id="scrapBox" hidden>
      <div class="muted small">${t('Material taken instead of money. Enter the value given for each type.')}</div>
      <div id="slines">${scrapLineHtml()}</div>
      <button type="button" class="btn ghost small" id="addS">+ ${t('Another type')}</button></div>
    <label>${t('Amount received')}<input name="amt" type="number" step="any" min="0" inputmode="decimal" autofocus></label>
    ${upiQrBoxHtml()}
    <details id="discBox" class="discbox"><summary>💸 ${t('Discount')}</summary>
      <div class="discrow"><input name="disc" type="number" step="any" min="0" inputmode="decimal" placeholder="0">
        <div class="seg" style="margin:0"><label><input type="radio" name="dunit" value="rs" checked><span>₹</span></label><label><input type="radio" name="dunit" value="pct"><span>%</span></label></div></div>
      <button type="button" class="btn small" id="settle">✓ ${t('Settle in full')}</button>
      <div class="small muted" id="discInfo"></div></details>
    <label>${t('Date')}<input name="date" type="date" value="${today()}"></label>
    <label>${t('Note (optional)')}<input name="note"></label>
    <button class="btn primary" type="submit">${t('Save collection')}</button></form>`;
  const f = $('#colf');
  const scrapItems = () => $$('.scrapline', f).map((r) => ({ type: $('[name=st]', r).value, value: L.round2(num($('[name=sv]', r).value)) })).filter((x) => x.value > 0);
  const sum = () => { if (pickedMode('mode', f) === 'scrap') f.amt.value = L.round2(scrapItems().reduce((s2, x) => s2 + x.value, 0)) || ''; };
  const bindS = () => { $$('[name=sv]', f).forEach((i) => (i.oninput = sum)); $$('[data-srm]', f).forEach((b) => (b.onclick = () => { if ($$('.scrapline', f).length > 1) b.parentElement.remove(); sum(); })); };
  // Discount: in rupees or % of what is still due after this payment; "settle in full" gives the rest as discount.
  const discAmt = () => {
    const after = Math.max(0, L.round2(a.balance - num(f.amt.value))), v = num(f.disc.value);
    const d = pickedMode('dunit', f) === 'pct' ? L.round2((after * v) / 100) : L.round2(v);
    return Math.min(Math.max(0, d), after);
  };
  const showDisc = () => {
    const d = discAmt();
    $('#discInfo').textContent = d > 0 ? `${t('Discount')} ${money(d)} · ${t('New balance')} ${money(L.round2(a.balance - num(f.amt.value) - d))}` : '';
  };
  f.disc.oninput = showDisc; f.amt.addEventListener('input', showDisc);
  $$('input[name=dunit]', f).forEach((r) => (r.onchange = showDisc));
  $('#settle').onclick = () => { f.querySelector('input[name=dunit][value=rs]').checked = true; f.disc.value = Math.max(0, L.round2(a.balance - num(f.amt.value))); showDisc(); };
  const qrBtn = bindUpiQr(f, { amount: () => num(f.amt.value), note: () => `${APP_NAME} - ${c.name}`, visible: () => pickedMode('mode', f) === 'upi' });
  f.amt.addEventListener('input', qrBtn);
  const onMode = () => { const sc = pickedMode('mode', f) === 'scrap'; $('#scrapBox').hidden = !sc; f.amt.readOnly = sc; if (sc) sum(); showDisc(); qrBtn(); };
  $$('input[name=mode]', f).forEach((r) => (r.onchange = onMode));
  $('#addS').onclick = () => { $('#slines').insertAdjacentHTML('beforeend', scrapLineHtml()); bindS(); };
  bindS(); onMode();
  f.onsubmit = (e) => {
    e.preventDefault();
    const mode = pickedMode('mode', f), items = mode === 'scrap' ? scrapItems() : [];
    const amt = Math.max(0, L.round2(mode === 'scrap' ? items.reduce((s2, x) => s2 + x.value, 0) : num(f.amt.value)));
    const disc = discAmt();
    if (amt <= 0 && disc <= 0) return toast(mode === 'scrap' ? t('Enter the value of the scrap') : t('Enter the amount'), true);
    const sb = $('button[type=submit]', f); if (sb.disabled) return; sb.disabled = true;
    const date = f.date.value || today(), now = Date.now();
    const b = F.writeBatch(F.db), ccol = F.sellerCol(sid, 'collections'), id = F.newId(ccol);
    let queue = a.queue || [];
    if (disc > 0) {
      const dr = L.allocateDiscount(L.allocate(queue, amt).queue, disc);
      b.set(F.doc(ccol, F.newId(ccol)), { accountId: aid, customerId: cid, date, amount: disc, kind: 'discount', mode: 'discount', note: f.note.value.trim(), allocations: dr.allocations, profit: dr.profit, createdAt: now + 1, by: S.user.uid });
    }
    const r = L.allocate(queue, amt);
    queue = disc > 0 ? L.allocateDiscount(r.queue, disc).queue : r.queue;
    if (amt > 0 && mode !== 'scrap') b.update(F.sellerDoc(sid, 'customers', cid), { [`modeCounts.${mode}`]: F.increment(1) });
    const doc = { accountId: aid, customerId: cid, date, amount: amt, kind: 'collection', mode, ...upiTag(mode, pickedUpi('upito', f)), note: f.note.value.trim(), allocations: r.allocations, profit: r.profit, createdAt: now, by: S.user.uid };
    if (mode === 'scrap') {
      doc.scrapItems = items;
      b.set(F.doc(F.db, 'scrapIn', id), { sellerKey: sid, collectionId: id, date, items, total: amt, customerName: c.name, createdAt: now, by: S.user.uid });
    }
    if (amt > 0) b.set(F.doc(ccol, id), doc);
    else if (mode === 'scrap') b.delete(F.doc(F.db, 'scrapIn', id));
    const bal = L.round2(a.balance - amt - disc);
    const closeIt = a.inactive && bal === 0 && confirm(t('This inactive account is now fully paid. Close the account?'));
    b.update(F.sellerDoc(sid, 'accounts', aid), { queue, balance: F.increment(-L.round2(amt + disc)), ...(amt > 0 && date > (a.lastPaid || '') ? { lastPaid: date } : {}), ...(closeIt ? { status: 'closed', closedOn: today(), ...setActive(a, true) } : {}) });
    F.commit(b, onWriteError);
    rescoreSoon(cid);
    const text = [`*${APP_NAME}*`, `${c.name} — ${a.name}`,
      amt > 0 ? `${money(amt)} ${t('received')} (${fmtDate(date)}, ${modeLabel(mode)}${mode === 'scrap' ? ': ' + scrapDetail(doc) : ''}).` : '',
      disc > 0 ? `${t('Discount')}: ${money(disc)}` : '', `${t('Balance')}: *${money(bal)}*`, t('Thank you')].filter(Boolean).join('\n');
    try { sessionStorage.setItem('receipt', JSON.stringify({ aid, customer: c.name, amount: amt, discount: disc, balance: bal, phone: c.phone || '', text, at: Date.now() })); } catch {}
    go(takeCollectBack(aid) || `#/account/${cid}/${aid}`);
  };
}

// ---------- cash sale (walk-in buyer on the route, no account) ----------
// Stored as a normal sale + payment entries with cash: true and no customer, so reports, day closing,
// stock history and categories count it like any other sale. Paid in full at once; a part payment
// needs a customer account, so the buyer is added as a customer and the sale goes to their first account.
const cashItems = (s) => s.items.map((i) => `${i.name} × ${i.qty}${i.returned ? ` (↩ ${i.returned})` : ''}`).join(', ');
const payTotals = (pays) => pays.filter((p) => p.amount > 0).map((p) => `${modeLabel(p.mode)} ${money(p.amount)}`).join(' · ');
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
function cashReceiptText(sale, pays) {
  return [`*${APP_NAME}*`, `🛒 ${t('Cash sale')} · ${fmtDate(sale.date)}`, sale.buyerName || '', '',
    ...sale.items.map((i) => `${i.name} × ${i.qty} — ${money(i.price * i.qty)}`), '',
    `*${t('Total')}: ${money(sale.saleValue)}*`, `${t('Paid')}: ${payTotals(pays)}`, t('Thank you')].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}

/** Write a cash sale (paid in full) into the batch. Returns the sale id. */
function writeCashSale(b, sid, { lines, value, cost, pays, date, name, phone }) {
  const scol = F.sellerCol(sid, 'sales'), saleId = F.newId(scol), now = Date.now();
  b.set(F.doc(scol, saleId), { accountId: null, customerId: null, cash: true, buyerName: name || '', buyerPhone: phone || '', date, items: lines, saleValue: value, cost, advance: value, creditedValue: 0, creditedCost: 0, costEstimated: true, createdAt: now, by: S.user.uid });
  rememberItems(b, sid, lines);
  const ccol = F.sellerCol(sid, 'collections');
  L.cashPayments(value, cost, pays).forEach((p, k) => {
    const id = F.newId(ccol);
    const doc = { accountId: null, customerId: null, cash: true, buyerName: name || '', date, amount: p.amount, kind: 'cash', mode: p.mode, ...upiTag(p.mode, p.upiTo), saleId, note: '', allocations: [{ ref: saleId, amount: p.amount, profit: p.profit }], profit: p.profit, createdAt: now + k, by: S.user.uid };
    if (p.mode === 'scrap') {
      doc.scrapItems = p.scrapItems || [];
      b.set(F.doc(F.db, 'scrapIn', id), { sellerKey: sid, collectionId: id, date, items: doc.scrapItems, total: p.amount, customerName: name || t('Cash sale'), createdAt: now, by: S.user.uid });
    }
    b.set(F.doc(ccol, id), doc);
  });
  return saleId;
}

/**
 * Part-paid cash sale turned into a customer: put the sale and what was paid (as advances) into the new
 * customer's first account. Writes into the batch and returns the account doc with its queue and balance.
 */
function applyPendingSale(b, sid, cid, aid, acc, pend, custName) {
  const scol = F.sellerCol(sid, 'sales'), saleId = F.newId(scol), now = Date.now(), date = pend.date || today();
  const pays = pend.pays.filter((p) => p.amount > 0), paid = L.round2(pays.reduce((s, p) => s + p.amount, 0));
  b.set(F.doc(scol, saleId), { accountId: aid, customerId: cid, date, items: pend.lines, saleValue: pend.value, cost: pend.cost, advance: paid, creditedValue: 0, creditedCost: 0, fromCashSale: true, costEstimated: true, createdAt: now, by: S.user.uid });
  rememberItems(b, sid, pend.lines);
  let queue = L.addSaleToQueue(acc.queue || [], saleId, date, pend.value, pend.cost);
  const ccol = F.sellerCol(sid, 'collections');
  pays.forEach((p, k) => {
    const r = L.allocate(queue, p.amount, saleId); queue = r.queue;
    const id = F.newId(ccol);
    const doc = { accountId: aid, customerId: cid, date, amount: p.amount, kind: 'advance', mode: p.mode, ...upiTag(p.mode, p.upiTo), saleId, note: '', allocations: r.allocations, profit: r.profit, createdAt: now + k, by: S.user.uid };
    if (p.mode === 'scrap') {
      doc.scrapItems = p.scrapItems || [];
      b.set(F.doc(F.db, 'scrapIn', id), { sellerKey: sid, collectionId: id, date, items: doc.scrapItems, total: p.amount, customerName: custName, createdAt: now, by: S.user.uid });
    }
    b.set(F.doc(ccol, id), doc);
  });
  return { ...acc, queue, balance: L.round2((acc.balance || 0) + pend.value - paid) };
}
const readPending = () => { try { const p = JSON.parse(sessionStorage.getItem('pendingCash') || 'null'); return p && Date.now() - p.at < 6 * 3600e3 ? p : null; } catch { return null; } };

function renderCashSale() {
  if (needSeller()) return;
  const sid = S.sid;
  setTitle(t('Cash sale'), true);
  try { sessionStorage.removeItem('pendingCash'); } catch {} // a part-paid cart left behind is dropped
  const rows = [];
  let cashTouched = false, tot = 0;
  view.innerHTML = `
    <div class="card form" id="csf">
      <div id="lines"></div>
      <div class="row total"><span>${t('Total')}</span><b id="total">₹0</b></div>
      <div class="two"><label>${t('Name (optional)')}<input id="bname" autocomplete="off"></label>
        <label>${t('Phone (optional)')}<input id="bphone" type="tel" inputmode="tel" autocomplete="off"></label></div>
      <label>${t('Paid')}</label>
      <div class="two"><label>${t('Cash')}<input id="pcash" type="number" step="any" min="0" inputmode="decimal"></label>
        <label>UPI<input id="pupi" type="number" step="any" min="0" inputmode="decimal"></label></div>
      ${upiQrBoxHtml()}
      <details id="scrapPay" class="discbox"><summary>♻️ ${t('Scrap')}</summary>
        <div class="muted small">${t('Material taken instead of money. Enter the value given for each type.')}</div>
        <div id="slines">${scrapLineHtml()}</div><button type="button" class="btn ghost small" id="addS">+ ${t('Another type')}</button></details>
      <div id="payInfo" class="small"></div>
      <label>${t('Date')}<input id="sdate" type="date" value="${today()}" max="${today()}"></label>
      <button class="btn primary" id="saveCash">${t('Save cash sale')}</button></div>`;
  const value = () => tot;
  const scrapItems = () => $$('#slines .scrapline').map((r) => ({ type: $('[name=st]', r).value, value: L.round2(num($('[name=sv]', r).value)) })).filter((x) => x.value > 0);
  const scrapTotal = () => L.round2(scrapItems().reduce((s, x) => s + x.value, 0));
  const pays = () => [{ mode: 'cash', amount: L.round2(num($('#pcash').value)) }, { mode: 'upi', amount: L.round2(num($('#pupi').value)), ...upiTag('upi', pickedUpi('upito')) }, { mode: 'scrap', amount: scrapTotal(), scrapItems: scrapItems() }];
  const paidNow = () => L.round2(pays().reduce((s, p) => s + p.amount, 0));
  const info = () => {
    const v = value(), p = paidNow(), bal = L.round2(v - p);
    $('#payInfo').innerHTML = !v ? '' : bal < 0 ? `<span class="bad">${t('Paid is more than the total')} (${money(-bal)})</span>`
      : bal > 0 ? `<span class="warnline">${t('Paid')} ${money(p)} · ${t('Balance')} ${money(bal)} — ${t('a balance needs a customer account')}</span>` : `✓ ${t('Paid in full')}`;
  };
  const refill = () => { if (!cashTouched) $('#pcash').value = Math.max(0, L.round2(value() - num($('#pupi').value) - scrapTotal())) || ''; info(); };
  const total = () => { $('#total').textContent = money(value()); refill(); };
  const bindS = () => { $$('#slines [name=sv]').forEach((i) => (i.oninput = refill)); $$('#slines [data-srm]').forEach((b) => (b.onclick = () => { if ($$('#slines .scrapline').length > 1) b.parentElement.remove(); refill(); })); };
  $('#addS').onclick = () => { $('#slines').insertAdjacentHTML('beforeend', scrapLineHtml()); bindS(); };
  $('#pcash').oninput = () => { cashTouched = true; info(); };
  const cashQr = bindUpiQr($('#csf'), { amount: () => num($('#pupi').value), note: () => `${APP_NAME} - ${t('Cash sale')}`, visible: () => num($('#pupi').value) > 0 });
  $('#pupi').oninput = () => { refill(); cashQr(); };
  bindS();
  mountLines($('#lines'), rows, (v) => { tot = v; total(); });
  $('#saveCash').onclick = () => {
    const lines = toSaleLines(rows);
    if (!lines.length) return toast(t('Enter at least one item with quantity and price'), true);
    if (rows.some((l) => l.name.trim() && !(l.price > 0))) return toast(t('Enter the price of every item'), true);
    if (rows.some((l) => l.name.trim() && !(l.qty >= 1))) return toast(t('Enter the quantity of every item'), true);
    const { value: v, cost } = L.saleTotals(lines), p = pays(), paid = paidNow(), date = $('#sdate').value || today();
    const name = $('#bname').value.trim(), phone = $('#bphone').value.trim();
    if (paid > v + 0.005) return toast(t('Paid is more than the total'), true);
    if (paid < v - 0.005) {
      if (!confirm(`${t('Balance')} ${money(L.round2(v - paid))}.\n${t('A balance needs a customer account. Add this buyer as a customer now? The sale and what was paid go into their account.')}`)) return;
      try { sessionStorage.setItem('pendingCash', JSON.stringify({ lines, value: v, cost, pays: p.filter((x) => x.amount > 0), date, name, phone, at: Date.now() })); } catch {}
      return go('#/customer-new');
    }
    if ($('#saveCash').disabled) return; $('#saveCash').disabled = true;
    const b = F.writeBatch(F.db);
    const saleId = writeCashSale(b, sid, { lines, value: v, cost, pays: p, date, name, phone });
    F.audit(b, S.user.uid, 'cash-sale', `sellers/${sid}/sales/${saleId}`, null, { value: v, paid, buyer: name });
    F.commit(b, onWriteError);
    try { sessionStorage.setItem('cashRcpt', JSON.stringify({ saleId, phone, text: cashReceiptText({ date, items: lines, saleValue: v, buyerName: name }, p), at: Date.now() })); } catch {}
    toast(t('Cash sale saved'));
    go('#/cash-sales');
  };
}

async function renderCashSales() {
  setTitle(t('Cash sales'), '#/menu');
  if (needSeller()) return;
  const sid = S.sid;
  let month = today().slice(0, 7);
  const draw = async () => {
    view.innerHTML = sellerBar() + '<div class="loading">…</div>';
    const [sales, cols] = await Promise.all([F.fetchAll(F.query(F.sellerCol(sid, 'sales'), F.where('cash', '==', true))), F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('cash', '==', true)))]);
    const list = sales.filter((s) => (s.date || '').startsWith(month)).sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : a.date < b.date ? 1 : -1));
    const paysOf = (id) => cols.filter((c) => c.saleId === id && c.kind === 'cash');
    let rc = null; try { rc = JSON.parse(sessionStorage.getItem('cashRcpt') || 'null'); if (rc && Date.now() - rc.at > 3600e3) rc = null; } catch {}
    const tot = L.round2(list.reduce((s, x) => s + x.saleValue - (x.creditedValue || 0), 0));
    view.innerHTML = sellerBar() + `
      ${rc ? `<div class="banner" id="rcpt"><b>✓ ${t('Cash sale saved')}</b>
        <div class="contact">${rc.phone ? `<a class="btn wa" href="https://wa.me/${L.waNumber(rc.phone)}?text=${encodeURIComponent(rc.text)}" target="_blank" rel="noopener">📩 ${t('Send receipt')}</a>` : `<a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(rc.text)}" target="_blank" rel="noopener">📩 ${t('Send receipt')}</a>`}
        <button class="btn small" id="rcX">${t('Close')}</button></div></div>` : ''}
      <div class="toolbar"><input type="month" id="cm" value="${month}"><a class="btn primary" href="#/cash-sale">+ ${t('Cash sale')}</a></div>
      <div class="muted small">${list.length} ${t('cash sales')} · ${money(tot)}</div>
      <ul class="list">${list.map((s) => {
        const left = s.items.some((i) => i.qty - (i.returned || 0) > 0), hasRet = s.items.some((i) => i.returned);
        return `<li class="card"><div class="row" style="padding:0"><div><b>${fmtDate(s.date)} · ${esc(s.buyerName || t('Walk-in buyer'))}</b>${s.buyerPhone ? `<small>${esc(s.buyerPhone)}</small>` : ''}<small>${esc(cashItems(s))}</small><small>${payTotals(paysOf(s.id))}</small></div>
          <div class="amt">${money(s.saleValue - (s.creditedValue || 0))}${s.creditedValue ? `<small>↩ ${money(s.creditedValue)}</small>` : ''}</div></div>
          <div class="contact">${s.buyerPhone ? `<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${L.waNumber(s.buyerPhone)}?text=${encodeURIComponent(cashReceiptText(s, paysOf(s.id)))}">📩</a>` : ''}
          ${left ? `<a class="btn small" href="#/cash-return/${s.id}">↩ ${t('Return')}</a>` : ''}
          ${isAdmin() && !hasRet ? `<button class="btn small danger" style="width:auto" data-cvoid="${s.id}">${t('Void')}</button>` : ''}</div></li>`;
      }).join('') || `<li class="muted">${t('No cash sales this month')}</li>`}</ul>`;
    bindSellerBar();
    $('#cm').onchange = (e) => { month = e.target.value || today().slice(0, 7); draw(); };
    const x = $('#rcX'); if (x) x.onclick = () => { try { sessionStorage.removeItem('cashRcpt'); } catch {} $('#rcpt').remove(); };
    $$('[data-cvoid]').forEach((b) => (b.onclick = () => voidCashSale(sid, list.find((s) => s.id === b.dataset.cvoid), paysOf(b.dataset.cvoid)).then((ok) => ok && setTimeout(draw, 300))));
  };
  await draw();
}

/** Admin: cancel a cash sale entered by mistake (no returns). Its payments are removed. */
async function voidCashSale(sid, s, pays) {
  if (!isAdmin() || !s) return false;
  if (s.items.some((i) => i.returned)) { toast(t('This sale has a return. It cannot be voided — use Return instead.'), true); return false; }
  if (!confirm(`${t('Void this cash sale?')}\n${fmtDate(s.date)} · ${cashItems(s)} · ${money(s.saleValue)}`)) return false;
  const all = await F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('saleId', '==', s.id)));
  const b = F.writeBatch(F.db);
  b.delete(F.sellerDoc(sid, 'sales', s.id));
  [...new Map([...pays, ...all].map((c) => [c.id, c])).values()].forEach((c) => { b.delete(F.sellerDoc(sid, 'collections', c.id)); if (c.mode === 'scrap') b.delete(F.doc(F.db, 'scrapIn', c.id)); });
  F.audit(b, S.user.uid, 'cash-sale-void', `sellers/${sid}/sales/${s.id}`, s, null);
  F.commit(b, onWriteError); toast(t('Voided'));
  return true;
}

async function renderCashReturn(saleId) {
  if (needSeller()) return;
  const sid = S.sid;
  setTitle(`${t('Return')} · ${t('Cash sale')}`, '#/cash-sales');
  const d = await F.getDoc(F.sellerDoc(sid, 'sales', saleId));
  if (!d.exists()) return go('#/cash-sales');
  const s = { id: saleId, ...d.data() };
  if (!s.cash) return go('#/cash-sales');
  view.innerHTML = `<form id="rf" class="card form">
    <div class="small muted">${fmtDate(s.date)} · ${esc(s.buyerName || t('Walk-in buyer'))}</div>
    <div id="ritems">${s.items.map((i, k) => { const left = i.qty - (i.returned || 0); return left > 0 ? `<label>${esc(i.name)} <small class="muted">(${t('max')} ${left} · ${money(i.price)})</small><input type="number" min="0" max="${left}" value="0" data-ri="${k}" inputmode="numeric"></label>` : ''; }).join('')}</div>
    <fieldset><legend>${t('Condition')}</legend>
      <label class="opt"><input type="radio" name="cond" value="stock" checked><span>${t('Good')}<small>${t('Taken back in good condition')}</small></span></label>
      <label class="opt"><input type="radio" name="cond" value="complaint"><span>${t('Complaint')}<small>${t('Repair it or send it back to the supplier')}</small></span></label>
      <label class="opt"><input type="radio" name="cond" value="scrap"><span>${t('Damage')}<small>${t('Cannot be repaired; written off as a loss')}</small></span></label></fieldset>
    <label>${t('Money given back by')}</label>${payPicker('rmode', 'cash')}
    <div class="row total"><span>${t('Refund')}</span><b id="ramt">₹0</b></div>
    <label>${t('Date')}<input name="date" type="date" value="${today()}" max="${today()}"></label>
    <button class="btn primary" type="submit">${t('Save return')}</button></form>`;
  const f = $('#rf');
  const picked = () => $$('[data-ri]').map((inp) => { const k = +inp.dataset.ri, it = s.items[k]; return { k, qty: Math.max(0, Math.min(Math.round(num(inp.value)), it.qty - (it.returned || 0))) }; }).filter((x) => x.qty > 0);
  const calc = () => { $('#ramt').textContent = money(picked().reduce((t2, p) => t2 + s.items[p.k].price * p.qty, 0)); };
  $$('[data-ri]').forEach((inp) => (inp.oninput = calc));
  f.onsubmit = (e) => {
    e.preventDefault();
    const p = picked(); if (!p.length) return toast(t('Enter quantity to return'), true);
    const sb = $('button[type=submit]', f); if (sb.disabled) return; sb.disabled = true;
    const cond = f.cond.value, date = f.date.value || today(), mode = pickedMode('rmode', f), now = Date.now();
    const items = p.map((x) => ({ name: s.items[x.k].name, qty: x.qty, price: s.items[x.k].price, unitCost: s.items[x.k].unitCost }));
    const amount = L.round2(items.reduce((t2, i) => t2 + i.price * i.qty, 0)), cost = L.round2(items.reduce((t2, i) => t2 + i.unitCost * i.qty, 0));
    const b = F.writeBatch(F.db), rcol = F.sellerCol(sid, 'returns'), rid = F.newId(rcol);
    b.set(F.doc(rcol, rid), { saleId: s.id, accountId: null, customerId: null, cash: true, date, items, condition: cond, credited: true, amount, cost, refundMode: mode, createdAt: now, by: S.user.uid });
    b.update(F.sellerDoc(sid, 'sales', s.id), { items: s.items.map((it, k) => { const x = p.find((q) => q.k === k); return x ? { ...it, returned: (it.returned || 0) + x.qty } : it; }),
      creditedValue: L.round2((s.creditedValue || 0) + amount), creditedCost: L.round2((s.creditedCost || 0) + cost) });
    const rf = L.cashRefund(amount, cost, mode), ccol = F.sellerCol(sid, 'collections');
    b.set(F.doc(ccol, F.newId(ccol)), { accountId: null, customerId: null, cash: true, buyerName: s.buyerName || '', date, kind: 'refund', saleId: s.id, returnId: rid, mode, amount: rf.amount, profit: rf.profit, allocations: [], note: t('Refund'), createdAt: now, by: S.user.uid });
    items.forEach((i) => {
      if (cond === 'complaint') { const cc = F.collection(F.db, 'complaints'); b.set(F.doc(cc, F.newId(cc)), { ...i, sellerId: sid, returnId: rid, customerName: s.buyerName || t('Cash sale'), credited: true, status: 'open', date, createdAt: now }); }
      if (cond === 'scrap') { const sc = F.collection(F.db, 'scrapLosses'); b.set(F.doc(sc, F.newId(sc)), { name: i.name, qty: i.qty, amount: L.round2(i.unitCost * i.qty), sellerId: sid, returnId: rid, date, createdAt: now }); }
    });
    F.commit(b, onWriteError);
    toast(t('Return saved'));
    go('#/cash-sales');
  };
}

// ---------- return ----------
async function renderReturn(cid, aid) {
  if (needSeller()) return;
  const sid = S.sid, c = S.customers[cid], a = S.accounts[aid];
  if (!c || !a) return go('#/customers');
  setTitle(`${t('Return')} · ${c.name}`, true);
  const sales = (await F.fetchAll(F.query(F.sellerCol(sid, 'sales'), F.where('accountId', '==', aid))))
    .filter((s) => s.items.some((i) => i.qty - (i.returned || 0) > 0)).sort((x, y) => (x.date < y.date ? 1 : -1));
  if (!sales.length) { view.innerHTML = `<div class="empty">${t('No sales to return from')}</div>`; return; }
  view.innerHTML = `<form id="rf" class="card form">
    <label>${t('Sale')}<select name="sale">${sales.map((s) => `<option value="${s.id}">${fmtDate(s.date)} · ${esc(s.items.map((i) => i.name).join(', ')).slice(0, 60)}</option>`).join('')}</select></label>
    <div id="ritems"></div>
    <fieldset><legend>${t('Condition')}</legend>
      <label class="opt"><input type="radio" name="cond" value="stock" checked><span>${t('Good')}<small>${t('Taken back in good condition')}</small></span></label>
      <label class="opt"><input type="radio" name="cond" value="complaint"><span>${t('Complaint')}<small>${t('Repair it or send it back to the supplier')}</small></span></label>
      <label class="opt"><input type="radio" name="cond" value="scrap"><span>${t('Damage')}<small>${t('Cannot be repaired; written off as a loss')}</small></span></label></fieldset>
    <label class="radio"><input type="checkbox" name="credit" checked> ${t('Reduce amount from customer balance')}</label>
    <div class="row total"><span>${t('Credit amount')}</span><b id="ramt">₹0</b></div>
    <label>${t('Date')}<input name="date" type="date" value="${today()}"></label>
    <button class="btn primary" type="submit">${t('Save return')}</button></form>`;
  const f = $('#rf');
  const cur = () => sales.find((s) => s.id === f.sale.value);
  const drawItems = () => {
    const s = cur();
    $('#ritems').innerHTML = s.items.map((i, k) => {
      const left = i.qty - (i.returned || 0);
      return left > 0 ? `<label>${esc(i.name)} <small class="muted">(${t('max')} ${left} · ${money(i.price)})</small><input type="number" min="0" max="${left}" value="0" data-ri="${k}" inputmode="numeric"></label>` : '';
    }).join('');
    $$('[data-ri]').forEach((inp) => (inp.oninput = calc));
    calc();
  };
  const picked = () => { const s = cur(); return $$('[data-ri]').map((inp) => ({ k: +inp.dataset.ri, qty: Math.max(0, Math.min(num(inp.value), s.items[+inp.dataset.ri].qty - (s.items[+inp.dataset.ri].returned || 0))) })).filter((x) => x.qty > 0); };
  const calc = () => { const s = cur(); $('#ramt').textContent = money(picked().reduce((t2, p) => t2 + s.items[p.k].price * p.qty, 0)); };
  f.sale.onchange = drawItems;
  drawItems();
  f.onsubmit = (e) => {
    e.preventDefault();
    const s = cur(), p = picked();
    if (!p.length) return toast(t('Enter quantity to return'), true);
    const sb = $('button[type=submit]', f); if (sb.disabled) return; sb.disabled = true;
    const cond = f.cond.value, credited = f.credit.checked, date = f.date.value || today();
    const items = p.map((x) => ({ name: s.items[x.k].name, qty: x.qty, price: s.items[x.k].price, unitCost: s.items[x.k].unitCost }));
    const amount = L.round2(items.reduce((t2, i) => t2 + i.price * i.qty, 0));
    const cost = L.round2(items.reduce((t2, i) => t2 + i.unitCost * i.qty, 0));
    const b = F.writeBatch(F.db), rcol = F.sellerCol(sid, 'returns'), rid = F.newId(rcol), now = Date.now();
    b.set(F.doc(rcol, rid), { saleId: s.id, accountId: aid, customerId: cid, date, items, condition: cond, credited, amount, cost, createdAt: now, by: S.user.uid });
    const newItems = s.items.map((it, k) => { const x = p.find((q) => q.k === k); return x ? { ...it, returned: (it.returned || 0) + x.qty } : it; });
    const saleUpd = { items: newItems };
    if (credited) {
      saleUpd.creditedValue = L.round2((s.creditedValue || 0) + amount);
      saleUpd.creditedCost = L.round2((s.creditedCost || 0) + cost);
      const queue = L.creditReturn(a.queue || [], s.id, amount, s.saleValue - saleUpd.creditedValue, s.cost - saleUpd.creditedCost);
      b.update(F.sellerDoc(sid, 'accounts', aid), { queue, balance: F.increment(-amount) });
    }
    b.update(F.sellerDoc(sid, 'sales', s.id), saleUpd);
    items.forEach((i) => {
      if (cond === 'complaint') { const cc = F.collection(F.db, 'complaints'); b.set(F.doc(cc, F.newId(cc)), { ...i, sellerId: sid, returnId: rid, customerName: c.name, credited, status: 'open', date, createdAt: now }); }
      if (cond === 'scrap' && credited) { const sc = F.collection(F.db, 'scrapLosses'); b.set(F.doc(sc, F.newId(sc)), { name: i.name, qty: i.qty, amount: L.round2(i.unitCost * i.qty), sellerId: sid, returnId: rid, date, createdAt: now }); }
    });
    F.commit(b, onWriteError);
    rescoreSoon(cid);
    toast(t('Return saved'));
    go(`#/account/${cid}/${aid}`);
  };
}

async function compressImage(file, maxSide = 1280, maxLen = 700000) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  let q = 0.7, data = cv.toDataURL('image/jpeg', q);
  while (data.length > maxLen && q > 0.3) { q -= 0.1; data = cv.toDataURL('image/jpeg', q); }
  return data;
}

// ---------- complaints ----------
function renderComplaints() {
  setTitle(t('Complaint items'), true);
  const draw = () => {
    const list = Object.values(S.complaints).sort((a, b) => b.createdAt - a.createdAt);
    view.innerHTML = `<ul class="list">${list.map((c) => `<li class="card">
      <div><b>${esc(c.name)}</b> × ${c.qty}<small>${esc(c.customerName || '')} · ${esc(sellerName(c.sellerId))} · ${fmtDate(c.date)}</small></div>
      ${isAdmin() ? `<div class="contact"><button class="btn" data-ok="${c.id}">${t('Repaired')}</button><button class="btn danger" data-scrap="${c.id}">${t('Damage')}</button></div>` : ''}
      </li>`).join('') || `<li class="muted">${t('No open complaints')}</li>`}</ul>`;
    $$('[data-ok]').forEach((b) => (b.onclick = () => {
      const c = S.complaints[b.dataset.ok], bt = F.writeBatch(F.db);
      bt.update(F.doc(F.db, 'complaints', c.id), { status: 'repaired', resolvedOn: today() });
      F.commit(bt, onWriteError); toast(t('Marked repaired'));
    }));
    $$('[data-scrap]').forEach((b) => (b.onclick = () => {
      const c = S.complaints[b.dataset.scrap], bt = F.writeBatch(F.db);
      bt.update(F.doc(F.db, 'complaints', c.id), { status: 'scrapped', resolvedOn: today() });
      if (c.credited) { const sc = F.collection(F.db, 'scrapLosses'); bt.set(F.doc(sc, F.newId(sc)), { name: c.name, qty: c.qty, amount: L.round2(c.unitCost * c.qty), sellerId: c.sellerId, returnId: c.returnId, date: today(), createdAt: Date.now() }); }
      F.commit(bt, onWriteError); toast(t('Written off as damage'));
    }));
  };
  draw();
  S.refresh = draw;
}

// ---------- expenses ----------
async function renderExpenses(company) {
  setTitle(company ? t('Company expenses') : t('My expenses'), company ? '#/menu' : null);
  if (!company && needSeller()) return;
  const col = company ? F.collection(F.db, 'companyExpenses') : F.sellerCol(S.sid, 'expenses');
  const cats = company ? ['Rent', 'Vehicle maintenance', 'Salary', 'Other'] : ['Fuel', 'Food', 'Other'];
  let day = today();
  const draw = async () => {
    const list = (await F.fetchAll(F.query(col, F.where('date', '==', day)))).sort((a, b) => b.createdAt - a.createdAt);
    $('#elist').innerHTML = list.map((x) => `<li class="row"><div><b>${t(x.category)}</b><small>${modeLabel(x.mode)}${x.note ? ' · ' + esc(x.note) : ''}</small></div>
      <div class="amt">${money(x.amount)} <button class="x" data-del="${x.id}">×</button></div></li>`).join('') || `<li class="muted">${t('No expenses on this day')}</li>`;
    const fx = L.sellerReport({ expenses: list });
    $('#etot').textContent = money(fx.expense);
    $('#esplit').textContent = splitLine(fx.expenseCash, fx.expenseUpi);
    $$('[data-del]').forEach((b) => (b.onclick = () => {
      const x = list.find((y) => y.id === b.dataset.del);
      if (!confirm(t('Delete this expense?'))) return;
      const bt = F.writeBatch(F.db);
      bt.delete(F.doc(col, x.id));
      F.audit(bt, S.user.uid, company ? 'company-expense-delete' : 'expense-delete', col.path + '/' + x.id, x, null);
      F.commit(bt, onWriteError); setTimeout(draw, 300);
    }));
  };
  view.innerHTML = (company ? '' : sellerBar()) + `
    <form id="ef" class="card form">
      <div class="two"><label>${t('Type')}<select name="cat">${cats.map((c) => `<option value="${c}">${t(c)}</option>`).join('')}</select></label>
      <label>${t('Amount')}<input name="amt" type="number" step="any" min="1" inputmode="decimal" required></label></div>
      <label>${t('Paid by')}</label>${payPicker('mode', 'cash')}
      <label>${t('Note (optional)')}<input name="note"></label>
      <button class="btn primary" type="submit">${t('Add expense')}</button></form>
    <div class="toolbar"><input type="date" id="eday" value="${day}"><div class="amt">${t('Total')} <b id="etot"></b><small id="esplit"></small></div></div>
    <ul class="list" id="elist"></ul>`;
  if (!company) bindSellerBar();
  $('#eday').onchange = (e) => { day = e.target.value || today(); draw(); };
  $('#ef').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target, bt = F.writeBatch(F.db);
    bt.set(F.doc(col, F.newId(col)), { category: f.cat.value, mode: pickedMode('mode', f), amount: L.round2(num(f.amt.value)), note: f.note.value.trim(), date: day, createdAt: Date.now(), by: S.user.uid });
    F.commit(bt, onWriteError); const keep = pickedMode('mode', f); f.reset(); f.querySelector(`input[name=mode][value=${keep}]`).checked = true; toast(t('Saved')); setTimeout(draw, 200);
  };
  await draw();
}

// ---------- reports ----------
async function sellerData(sid, from, to) {
  const rng = (name) => F.fetchAll(F.query(F.sellerCol(sid, name), F.where('date', '>=', from), F.where('date', '<=', to)));
  const [sales, collections, returns, expenses] = await Promise.all([rng('sales'), rng('collections'), rng('returns'), rng('expenses')]);
  return { sales, collections, returns, expenses };
}
async function sellerFigures(sid, from, to) { return L.sellerReport(await sellerData(sid, from, to)); }

// Profit figures are not shown any more (no purchase prices in the app; the margin-based estimate misled more
// than it helped). The money logic still keeps them inside the data, so they can come back if costs are entered later.
const REP_FIELDS = [['salesValue', 'Sales'], ['cashSales', '— Cash sales'], ['collected', 'Collected'], ['collectedCash', '— Cash'], ['collectedUpi', '— UPI'], ['collectedScrap', '— Scrap'],
  ['discount', 'Discounts given'], ['expense', 'Personal expenses'], ['expenseCash', '— Cash'], ['expenseUpi', '— UPI'], ['cashInHand', 'Cash in hand']];
const repRowCls = (k) => (k === 'cashInHand' ? 'cash' : /Cash$|Upi$|Scrap$|^cashSales$/.test(k) ? 'sub' : '');
const repLbl = (l) => (l === '— Cash' ? '— ' + t('Cash') : l === '— Scrap' ? '— ' + t('Scrap') : l === '— Cash sales' ? '— ' + t('Cash sales') : t(l));
const shiftDate = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const msOfDate = (d, end = false) => new Date(`${d}T${end ? '23:59:59.999' : '00:00:00'}`).getTime();
const BAND_UI = { good: ['🟢', 'Good'], ok: ['🟡', 'Average'], risk: ['🔴', 'Risk'], new: ['⚪', 'New'] };
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** Collections per day (or per month for long ranges) as simple horizontal bars, plus the previous period. */
function collectionBars(cols, from, to, prevTotal, prevFrom, prevTo) {
  const len = daysBetween(from, to) + 1, monthly = len > 62;
  const keys = [];
  if (monthly) { for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftDate(m + '-01', 32).slice(0, 7)) keys.push(m); }
  else for (let d = from; d <= to; d = shiftDate(d, 1)) keys.push(d);
  const by = {};
  keys.forEach((k) => (by[k] = []));
  cols.forEach((c) => { const k = monthly ? c.date.slice(0, 7) : c.date; if (by[k]) by[k].push(c); });
  const vals = keys.map((k) => L.sellerReport({ collections: by[k] }).collected), max = Math.max(1, ...vals), total = L.round2(vals.reduce((s, v) => s + v, 0));
  const diff = L.round2(total - prevTotal), arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  const label = (k) => (monthly ? new Date(k + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
    : new Date(k + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }));
  return `<h3>${t('Collection')} ${monthly ? t('by month') : t('by day')}</h3>
    <div class="card"><div class="kv"><span>${t('Previous period')} <small>${fmtDate(prevFrom)}${prevFrom !== prevTo ? ' – ' + fmtDate(prevTo) : ''}</small></span><b>${money(prevTotal)}</b></div>
      <div class="kv"><span>${t('This period')}</span><b>${money(total)} ${arrow ? `<span class="${diff > 0 ? 'up' : 'down'}">${arrow} ${money(Math.abs(diff))}${prevTotal > 0 ? ` (${pct(Math.abs(diff), prevTotal)}%)` : ''}</span>` : ''}</b></div>
      ${len > 1 ? `<div class="bars">${keys.map((k, i) => `<div class="bar"><span>${label(k)}</span><i style="width:${(vals[i] / max) * 100}%${vals[i] ? '' : ';min-width:0'}"></i><b>${vals[i] ? money(vals[i]) : '–'}</b></div>`).join('')}</div>` : ''}</div>`;
}

/** Growth in the period: new customers, sales, accounts closed. */
const growthHtml = (g) => `<h3>${t('Growth')}</h3><table class="rep">
  <tr><td>${t('New customers')}</td><td>${g.newCustomers}</td></tr>
  <tr><td>${t('New sales')}</td><td>${g.sales}</td></tr>
  <tr class="sub"><td>— ${t('Cash sales')}</td><td>${g.cashSales}</td></tr>
  <tr><td>${t('Accounts closed (fully paid)')}</td><td>${g.closed}</td></tr></table>`;
const growthOf = (customers, accounts, sales, from, to) => ({
  newCustomers: customers.filter((c) => c.createdAt >= msOfDate(from) && c.createdAt <= msOfDate(to, true)).length,
  sales: sales.filter((s) => !s.cash).length, cashSales: sales.filter((s) => s.cash).length,
  closed: accounts.filter((a) => a.status === 'closed' && a.closedOn >= from && a.closedOn <= to).length,
});

/** A seller's customers and accounts: live for the book on screen, read once for the others (admin). */
async function bookSnapshot(key) {
  if (key === S.sid) return { customers: Object.values(S.customers), accounts: Object.values(S.accounts) };
  const [customers, accounts] = await Promise.all([F.fetchAll(F.sellerCol(key, 'customers')), F.fetchAll(F.sellerCol(key, 'accounts'))]);
  return { customers, accounts };
}

/** Money still to collect, split by frequency and score, and how long each open account has gone without paying.
 *  Only the last 90 days of collections are read (keeps reads low): older or never = "90+ days". */
function outstandingOf(snap, recent, seller = '') {
  const cust = Object.fromEntries(snap.customers.map((c) => [c.id, c])), cutoff = shiftDate(today(), -90), last = {};
  recent.forEach((c) => { if (!c.accountId || c.kind === 'discount' || c.kind === 'refund') return; if (!last[c.accountId] || c.date > last[c.accountId]) last[c.accountId] = c.date; });
  const r = { total: 0, n: 0, byFreq: { daily: 0, weekly: 0, monthly: 0 }, byBand: { good: 0, ok: 0, risk: 0, new: 0 }, paused: 0, pausedN: 0, rows: [] };
  for (const a of snap.accounts) {
    if (a.status === 'closed' || !(a.balance > 0.004)) continue;
    const c = cust[a.customerId]; if (!c) continue;
    r.total += a.balance; r.n++;
    r.byFreq[a.frequency || 'weekly'] = (r.byFreq[a.frequency || 'weekly'] || 0) + a.balance;
    r.byBand[bandOf(c.score?.score)] += a.balance;
    if (a.inactive) { r.paused += a.balance; r.pausedN++; continue; }
    const lp = [last[a.id] || '', a.lastPaidOld || ''].sort().pop(), ref = lp || (a.date && a.date >= cutoff ? a.date : '');
    r.rows.push({ c, a, lp, days: ref ? daysBetween(ref, today()) : 91, seller });
  }
  return r;
}
function mergeOutstanding(list) {
  const m = { total: 0, n: 0, byFreq: { daily: 0, weekly: 0, monthly: 0 }, byBand: { good: 0, ok: 0, risk: 0, new: 0 }, paused: 0, pausedN: 0, rows: [] };
  for (const r of list) {
    m.total += r.total; m.n += r.n; m.paused += r.paused; m.pausedN += r.pausedN; m.rows.push(...r.rows);
    for (const k in r.byFreq) m.byFreq[k] = (m.byFreq[k] || 0) + r.byFreq[k];
    for (const k in r.byBand) m.byBand[k] += r.byBand[k];
  }
  return m;
}

/** Route days: customers, money outstanding, collected and visits without payment in the period. */
function routeStats(customers, accounts, cols, visits, from, to) {
  const cust = Object.fromEntries(customers.map((c) => [c.id, c]));
  const groupOf = (cid, date) => { const ds = daysOf(cust[cid]); if (!ds.length) return 'none'; const w = weekdayOf(date); return String(ds.includes(w) ? w : ds[0]); };
  const keys = [...ROUTE_DAYS.map(String), 'none'], G = {};
  keys.forEach((k) => (G[k] = { customers: 0, outstanding: 0, collected: [], paid: new Set(), nopay: 0, runs: 0 }));
  customers.forEach((c) => { const ds = daysOf(c); (ds.length ? ds.map(String) : ['none']).forEach((k) => { if (G[k]) G[k].customers++; }); });
  accounts.forEach((a) => { if (a.status === 'closed' || !(a.balance > 0) || !cust[a.customerId]) return; const ds = daysOf(cust[a.customerId]); const k = ds.length ? String(ds[0]) : 'none'; if (G[k]) G[k].outstanding += a.balance; });
  const paidOn = new Set();
  cols.forEach((c) => { if (!c.customerId || c.cash || c.kind === 'discount' || c.kind === 'refund' || !cust[c.customerId]) return; const g = G[groupOf(c.customerId, c.date)]; if (!g) return; g.collected.push(c); g.paid.add(c.customerId); paidOn.add(c.customerId + c.date); });
  const seenV = new Set();
  visits.forEach((v) => { if (!cust[v.customerId] || paidOn.has(v.customerId + v.date) || seenV.has(v.customerId + v.date)) return; seenV.add(v.customerId + v.date); const g = G[groupOf(v.customerId, v.date)]; if (g) g.nopay++; });
  for (let d = from; d <= to; d = shiftDate(d, 1)) { const k = String(weekdayOf(d)); if (G[k]) G[k].runs++; }
  return keys.map((k) => ({ key: k, label: k === 'none' ? t('No day') : dayLabel(Number(k)), ...G[k], collectedAmt: L.sellerReport({ collections: G[k].collected }).collected }));
}

/** Expenses by type (personal or company), split cash / UPI. */
function expenseTable(list, title) {
  const by = {};
  list.forEach((x) => { const k = x.category || 'Other'; by[k] ||= { cash: 0, upi: 0 }; by[k][x.mode === 'upi' ? 'upi' : 'cash'] += Number(x.amount) || 0; });
  const rows = Object.entries(by).sort((a, b) => (b[1].cash + b[1].upi) - (a[1].cash + a[1].upi));
  const tot = rows.reduce((s, [, v]) => s + v.cash + v.upi, 0);
  return `<h3>${esc(title)}</h3>${rows.length ? `<table class="rep"><thead><tr><th>${t('Type')}</th><th>${t('Cash')}</th><th>UPI</th><th>${t('Total')}</th></tr></thead><tbody>
    ${rows.map(([k, v]) => `<tr><td>${esc(t(k))}<small>${pct(v.cash + v.upi, tot)}%</small></td><td>${money(L.round2(v.cash))}</td><td>${money(L.round2(v.upi))}</td><td><b>${money(L.round2(v.cash + v.upi))}</b></td></tr>`).join('')}
    <tr class="cash"><td>${t('Total')}</td><td></td><td></td><td>${money(L.round2(tot))}</td></tr></tbody></table>` : `<p class="muted">${t('No expenses in this period')}</p>`}`;
}

async function renderReport() {
  setTitle(t('Reports'));
  let st = (() => { try { return JSON.parse(sessionStorage.getItem('rep') || 'null'); } catch { return null; } })() || { mode: 'today' };
  st.tab ||= 'sum';
  const rangeOf = (m) => { const d = today(); return m === 'week' ? [L.weekStart(d), d] : m === 'month' ? [d.slice(0, 8) + '01', d] : m === 'year' ? [d.slice(0, 5) + '01-01', d] : [d, d]; };
  if (st.mode !== 'custom') [st.from, st.to] = rangeOf(st.mode);
  const chips = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Choose dates']];
  const tabs = [['sum', 'Summary'], ['out', 'Outstanding'], ['route', 'Routes'], ['exp', 'Expenses']];
  view.innerHTML = `<div class="seg reptabs" id="rtabs">${tabs.map(([k, l]) => `<label><input type="radio" name="rtab" value="${k}" ${st.tab === k ? 'checked' : ''}><span>${t(l)}</span></label>`).join('')}</div>
    <div id="rdates"><div class="fchips" id="rchips">${chips.map(([k, l]) => `<button class="fchip ${st.mode === k ? 'on' : ''}" data-r="${k}">${k === 'custom' ? '📅 ' : ''}${t(l)}</button>`).join('')}</div>
    <div class="card form" id="rcust" ${st.mode === 'custom' ? '' : 'hidden'}><div class="two">
      <label>${t('From')}<input type="date" id="rf" value="${st.from}"></label><label>${t('To')}<input type="date" id="rt" value="${st.to}"></label></div></div>
    <div class="banner" id="rrange" style="padding:8px 14px"></div></div>
    <div id="out"></div>`;
  let runId = 0;
  const run = async () => {
    const my = ++runId, live = () => my === runId && $('#out');
    const from = st.mode === 'custom' ? $('#rf').value || today() : st.from, to = st.mode === 'custom' ? $('#rt').value || today() : st.to;
    try { sessionStorage.setItem('rep', JSON.stringify({ ...st, from, to })); } catch {}
    $('#rdates').hidden = st.tab === 'out';
    $('#rrange').innerHTML = `<b>${fmtDate(from)}${from !== to ? ' – ' + fmtDate(to) : ''}</b>`;
    $('#out').innerHTML = '<div class="loading">…</div>';
    const len = daysBetween(from, to) + 1, pFrom = shiftDate(from, -len), pTo = shiftDate(from, -1);
    const prevCollected = async (key, a, b) => L.sellerReport({ collections: await F.fetchAll(F.query(F.sellerCol(key, 'collections'), F.where('date', '>=', a), F.where('date', '<=', b))) }).collected;
    const admin = isAdmin();
    const ss = admin ? L.holderPeriods(Object.entries(S.users).map(([uid, u]) => ({ ...u, uid })), from, to) : [];
    const me = admin ? null : L.holderPeriods([{ ...S.profile, uid: S.user.uid }], from, to)[0];

    if (st.tab === 'sum') {
      if (!admin) {
        const d = me ? await sellerData(S.sid, me.from, me.to) : { sales: [], collections: [], returns: [], expenses: [] };
        const r = L.sellerReport(d), prev = await prevCollected(S.sid, pFrom, pTo);
        if (!live()) return;
        $('#out').innerHTML = `<table class="rep">${REP_FIELDS.map(([k, l]) => `<tr class="${repRowCls(k)}"><td>${repLbl(l)}</td><td>${money(r[k])}</td></tr>`).join('')}</table>
          ${collectionBars(d.collections, from, to, prev, pFrom, pTo)}
          ${growthHtml(growthOf(Object.values(S.customers), Object.values(S.accounts), d.sales, from, to))}
          <button class="btn" id="pdf">PDF</button>`;
        $('#pdf').onclick = () => makePdf({ title: `Report - ${S.profile.name}`, subtitle: `${fmtDate(from)} to ${fmtDate(to)}`, head: ['Item', 'Amount'], rows: REP_FIELDS.map(([k, l]) => [l, pdfMoney(r[k])]), file: `report-${S.profile.username}-${from}-${to}.pdf` });
        return;
      }
      const raws = await Promise.all(ss.map((p) => sellerData(p.key, p.from, p.to)));
      const reps = raws.map((r) => L.sellerReport(r));
      const rng = (c) => F.fetchAll(F.query(F.collection(F.db, c), F.where('date', '>=', from), F.where('date', '<=', to)));
      const keys = [...new Set(ss.map((p) => p.key))];
      const inRange = (k) => [F.where('createdAt', '>=', msOfDate(from)), F.where('createdAt', '<=', msOfDate(to, true))];
      const [cexp, scrap, ssales, prevs, newCust, closedAcc] = await Promise.all([rng('companyExpenses'), rng('scrapLosses'), rng('scrapSales'),
        Promise.all(keys.map((k) => prevCollected(k, pFrom, pTo))),
        Promise.all(keys.map((k) => F.fetchAll(F.query(F.sellerCol(k, 'customers'), ...inRange(k))))),
        Promise.all(keys.map((k) => F.fetchAll(F.query(F.sellerCol(k, 'accounts'), F.where('closedOn', '>=', from), F.where('closedOn', '<=', to)))))]);
      if (!live()) return;
      const co = L.companyReport(reps, cexp, scrap, ssales);
      const allCols = raws.flatMap((r) => r.collections), allSales = raws.flatMap((r) => r.sales);
      const g = growthOf(newCust.flat(), closedAcc.flat().map((a) => ({ ...a, status: 'closed' })), allSales, from, to);
      $('#out').innerHTML = `<div class="scroll"><table class="rep"><thead><tr><th></th>${ss.map((p) => `<th>${esc(p.name)}${p.from !== from || p.to !== to ? `<small>${fmtDate(p.from)} – ${fmtDate(p.to)}</small>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${REP_FIELDS.map(([k, l]) => `<tr class="${repRowCls(k)}"><td>${repLbl(l)}</td>${reps.map((r) => `<td>${money(r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <h3>${t('Company')}</h3><table class="rep">
        <tr><td>${t('Sales')}</td><td>${money(co.salesValue)}</td></tr>
        <tr><td>${t('Collected')}</td><td>${money(co.collected)}</td></tr>
        <tr class="sub"><td>— ${t('Cash')}</td><td>${money(co.collectedCash)}</td></tr>
        <tr class="sub"><td>— UPI</td><td>${money(co.collectedUpi)}</td></tr>
        <tr class="sub"><td>— ${t('Scrap')}</td><td>${money(co.collectedScrap)}</td></tr>
        <tr><td>${t('Discounts given')}</td><td>${money(co.discount)}</td></tr>
        <tr><td>${t('Personal expenses')}</td><td>− ${money(co.personalExpense)}</td></tr>
        <tr><td>${t('Company expenses')}</td><td>− ${money(co.companyExpense)}</td></tr>
        <tr class="sub"><td>— ${t('Cash')}</td><td>${money(co.companyExpenseCash)}</td></tr>
        <tr class="sub"><td>— UPI</td><td>${money(co.companyExpenseUpi)}</td></tr>
        ${ssales.length ? `<tr><td>${t('Scrap sold')}<small>${t('credited value')} ${money(co.scrapSoldCredited)}</small></td><td>${money(co.scrapSold)}</td></tr>
        <tr class="sub"><td>${co.scrapGain >= 0 ? t('Scrap gain') : t('Scrap loss')}</td><td>${co.scrapGain >= 0 ? '+' : '−'} ${money(Math.abs(co.scrapGain))}</td></tr>` : ''}
        <tr class="cash"><td>${t('Cash in hand')}</td><td>${money(co.cashInHand)}</td></tr></table>
        <p class="muted small">${t('Cash in hand = cash collected − expenses paid in cash + money from scrap sold. Scrap taken as payment is not cash until it is sold.')}</p>
        ${collectionBars(allCols, from, to, L.round2(prevs.reduce((s, v) => s + v, 0)), pFrom, pTo)}
        ${growthHtml(g)}
        <button class="btn" id="pdf">PDF</button>`;
      $('#pdf').onclick = () => makePdf({
        title: 'Company report', subtitle: `${fmtDate(from)} to ${fmtDate(to)}`,
        head: ['Item', ...ss.map((s) => s.name)], rows: REP_FIELDS.map(([k, l]) => [l, ...reps.map((r) => pdfMoney(r[k]))]),
        foot: [`Collected: Cash ${pdfMoney(co.collectedCash)} | UPI ${pdfMoney(co.collectedUpi)} | Scrap ${pdfMoney(co.collectedScrap)}`, `Company expenses: ${pdfMoney(co.companyExpense)} (Cash ${pdfMoney(co.companyExpenseCash)} | UPI ${pdfMoney(co.companyExpenseUpi)})`,
          `Scrap sold: ${pdfMoney(co.scrapSold)} (credited ${pdfMoney(co.scrapSoldCredited)}, gain ${pdfMoney(co.scrapGain)})`, `Cash in hand: ${pdfMoney(co.cashInHand)}`],
        file: `company-report-${from}-${to}.pdf`,
      });
      return;
    }

    if (st.tab === 'out') {
      const sellersNow = admin ? L.holderPeriods(Object.entries(S.users).map(([uid, u]) => ({ ...u, uid })), today(), today()) : [{ key: S.sid, name: S.profile.name }];
      const cut = shiftDate(today(), -90);
      const parts = await Promise.all(sellersNow.map(async (p) => {
        const [snap, recent] = await Promise.all([bookSnapshot(p.key), F.fetchAll(F.query(F.sellerCol(p.key, 'collections'), F.where('date', '>=', cut)))]);
        return { p, r: outstandingOf(snap, recent, p.key) };
      }));
      if (!live()) return;
      const m = mergeOutstanding(parts.map((x) => x.r)), nameOf = Object.fromEntries(sellersNow.map((p) => [p.key, p.name]));
      let min = Number(st.od) || 30;
      const draw = () => {
        const rows = m.rows.filter((x) => x.days >= min).sort((a, b) => (b.days - a.days) || (b.a.balance - a.a.balance));
        const sum = L.round2(rows.reduce((s, x) => s + x.a.balance, 0));
        $('#out').innerHTML = `
          <div class="card balance"><span>${t('Total to collect')} · ${m.n} ${t('accounts')}</span><b>${money(L.round2(m.total))}</b></div>
          ${admin && parts.length > 1 ? `<table class="rep">${parts.map(({ p, r }) => `<tr><td>${esc(p.name)}<small>${r.n} ${t('accounts')}</small></td><td>${money(L.round2(r.total))}</td></tr>`).join('')}</table>` : ''}
          <h3>${t('By instalment')}</h3><table class="rep">${FREQ.map((f) => `<tr><td>${freqLabel(f)}</td><td>${money(L.round2(m.byFreq[f] || 0))}</td></tr>`).join('')}</table>
          <h3>${t('By score')}</h3><table class="rep">${Object.entries(BAND_UI).map(([k, [ic, l]]) => `<tr class="${k === 'risk' ? 'risk' : ''}"><td>${ic} ${t(l)}<small>${pct(m.byBand[k], m.total)}%</small></td><td>${money(L.round2(m.byBand[k]))}</td></tr>`).join('')}</table>
          ${m.pausedN ? `<p class="muted small">⏸ ${t('Inactive accounts')}: ${money(L.round2(m.paused))} (${m.pausedN}) — ${t('included in the total, not in the overdue list.')}</p>` : ''}
          <h3>${t('Not paid for')}</h3>
          <div class="fchips">${[14, 30, 60, 90].map((d) => `<button class="fchip ${d === min ? 'on' : ''}" data-od="${d}">${d}+ ${t('days')}</button>`).join('')}</div>
          <div class="card"><div class="kv"><span>${rows.length} ${t('accounts')}</span><b>${money(sum)}</b></div></div>
          <ul class="list">${rows.map((x) => { const own = x.seller === S.sid; const inner = `<div>${placeBadge(x.c)}<b>${esc(x.c.name)}</b>${scoreBadges(x.c)}<small>${admin ? esc(nameOf[x.seller] || '') + ' · ' : ''}${esc(x.a.name)} · ${freqLabel(x.a.frequency)} · ${t('Last paid')}: ${x.lp ? fmtDate(x.lp) : '—'}</small></div>
              <div class="amt">${money(x.a.balance)}<small class="${x.days >= 60 ? 'bad' : ''}">${x.days > 90 ? '90+' : x.days} ${t('days')}</small></div>`;
            return `<li>${own ? `<a class="row" href="#/account/${x.c.id}/${x.a.id}">${inner}</a>` : `<div class="row">${inner}</div>`}</li>`; }).join('') || `<li class="muted">${t('Nobody in this list')} 👍</li>`}</ul>
          <p class="muted small">${t('Days since the last payment (or since the account was opened). Payments older than 90 days are not read, so they show as 90+.')}</p>`;
        $$('[data-od]').forEach((b) => (b.onclick = () => { min = Number(b.dataset.od); st.od = min; try { sessionStorage.setItem('rep', JSON.stringify(st)); } catch {} draw(); }));
      };
      draw();
      return;
    }

    if (st.tab === 'route') {
      if (!S.sid) { $('#out').innerHTML = sellerBar() + `<div class="empty">${t('Choose a seller above to see their customers.')}</div>`; bindSellerBar(); return; } // admin: the seller chosen in the bar
      const [cols, visits] = await Promise.all(['collections', 'visits'].map((c) => F.fetchAll(F.query(F.sellerCol(S.sid, c), F.where('date', '>=', from), F.where('date', '<=', to)))));
      if (!live()) return;
      const rs = routeStats(Object.values(S.customers), Object.values(S.accounts), cols, visits, from, to).filter((g) => g.customers || g.collectedAmt);
      $('#out').innerHTML = sellerBar() + `${rs.map((g) => `<div class="card routecard">
          <div class="kv"><b>${esc(g.label)} · ${g.customers} ${t('customers')}</b><span>${t('To collect')} <b>${money(L.round2(g.outstanding))}</b></span></div>
          <div class="kv"><span>${t('Collected')}${g.key !== 'none' ? ` · ${g.runs} ${g.runs === 1 ? t('day') : t('days')}` : ''}</span><b>${money(g.collectedAmt)}</b></div>
          ${g.key !== 'none' && g.runs ? `<div class="kv small"><span>${t('Average per route day')}</span><span>${money(Math.round(g.collectedAmt / g.runs))}</span></div>` : ''}
          <div class="kv small"><span>✓ ${t('Paid')}: ${g.paid.size} ${t('people')}</span><span>⊘ ${t('Visited – no payment')}: ${g.nopay}</span></div>
          ${g.customers ? `<div class="meter"><i style="width:${pct(g.paid.size, g.customers)}%"></i></div><div class="small muted">${pct(g.paid.size, g.customers)}% ${t('of customers paid at least once')}</div>` : ''}</div>`).join('') || `<p class="muted">${t('No customers yet')}</p>`}
        <p class="muted small">${t('A customer on two route days is counted on both; money is counted on the day it was collected.')}</p>`;
      bindSellerBar();
      return;
    }

    // expenses
    if (!admin) {
      const d = me ? await sellerData(S.sid, me.from, me.to) : { expenses: [] };
      if (!live()) return;
      $('#out').innerHTML = expenseTable(d.expenses, t('Personal expenses'));
      return;
    }
    const raws = await Promise.all(ss.map((p) => sellerData(p.key, p.from, p.to)));
    const cexp = await F.fetchAll(F.query(F.collection(F.db, 'companyExpenses'), F.where('date', '>=', from), F.where('date', '<=', to)));
    if (!live()) return;
    $('#out').innerHTML = expenseTable(cexp, t('Company expenses')) + ss.map((p, i) => expenseTable(raws[i].expenses, `${t('Personal expenses')} · ${p.name}`)).join('');
  };
  $$('input[name=rtab]').forEach((r) => (r.onchange = () => { st.tab = r.value; run(); }));
  $$('[data-r]').forEach((b) => (b.onclick = () => {
    st = { mode: b.dataset.r, tab: st.tab, od: st.od };
    if (st.mode !== 'custom') [st.from, st.to] = rangeOf(st.mode);
    $$('[data-r]').forEach((x) => x.classList.toggle('on', x === b));
    $('#rcust').hidden = st.mode !== 'custom';
    if (st.mode === 'custom') { if (!$('#rf').value) $('#rf').value = today(); if (!$('#rt').value) $('#rt').value = today(); }
    run();
  }));
  $('#rf').onchange = run; $('#rt').onchange = run;
  run();
}

async function makePdf({ title, subtitle, head, rows, foot = [], file }) {
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36;
    let y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(APP_NAME, M, y); y += 20;
    doc.setFontSize(12); doc.text(title, M, y); y += 15;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(subtitle || '', M, y); y += 20;
    const colW = (W - 2 * M) / head.length;
    const widths = head.length === 5 ? [60, W - 2 * M - 60 - 3 * 80, 80, 80, 80] : head.map(() => colW);
    const drawRow = (cells, bold) => {
      if (y > H - M) { doc.addPage(); y = M; }
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      let x = M;
      cells.forEach((c, i) => { const s = doc.splitTextToSize(String(c ?? ''), widths[i] - 6)[0] || ''; doc.text(s, i === 0 || (head.length === 5 && i === 1) ? x + 2 : x + widths[i] - 4, y, { align: i === 0 || (head.length === 5 && i === 1) ? 'left' : 'right' }); x += widths[i]; });
      y += 15;
      doc.setDrawColor(220); doc.line(M, y - 11, W - M, y - 11);
    };
    drawRow(head, true);
    rows.forEach((r) => drawRow(r, false));
    y += 8; doc.setFont('helvetica', 'bold');
    foot.forEach((f) => { if (y > H - M) { doc.addPage(); y = M; } doc.text(f, M, y); y += 15; });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(`Generated ${new Date().toLocaleString('en-IN')}`, M, H - 20);
    const blob = doc.output('blob');
    const f = new File([blob], file.replace(/[^\w.-]+/g, '_'), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title });
    else doc.save(f.name);
  } catch (e) {
    if (e.name !== 'AbortError') toast(t('Could not make PDF') + ': ' + e.message, true);
  }
}

// ---------- printable list & per-customer statements ----------
const recScope = () => { try { return sessionStorage.getItem('recScope') || 'all'; } catch { return 'all'; } };

/** Books (seller customer sets) this login may export: own book for a seller; all or one for admin. */
function recBooks(scope = recScope()) {
  if (!isAdmin()) return [{ key: S.sid, name: S.profile.name }];
  const all = sellers().map((x) => ({ key: x.id, name: x.name }));
  return scope === 'all' ? all : all.filter((b) => b.key === scope);
}

async function loadBook(key, withHistory) {
  const g = (n) => F.fetchAll(F.sellerCol(key, n));
  const [customers, accounts, collections] = await Promise.all([g('customers'), g('accounts'), g('collections')]);
  const out = { customers, accounts, collections };
  if (withHistory) { const [sales, returns] = await Promise.all([g('sales'), g('returns')]); Object.assign(out, { sales, returns }); }
  return out;
}

async function shareOrSave(blob, name, type) {
  const file = new File([blob], name.replace(/[^\w.-]+/g, '_'), { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: file.name });
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
}

function renderRecords() {
  setTitle(t('Print list & statements'), '#/menu');
  const scopeSel = isAdmin() ? `<label>${t('Seller')}<select id="recScope"><option value="all">${t('All sellers')}</option>${sellers().map((x) => `<option value="${x.id}" ${recScope() === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : '';
  view.innerHTML = `<div class="card form">${scopeSel}
    <h3>🖨️ ${t('Customer balance list')}</h3>
    <p class="muted small">${t('All customers with house no., lane, phone and balance of each open account, in route order. Print it or save as PDF once a month.')}</p>
    <a class="btn primary" href="#/print-list">${t('Open printable list')}</a>
    <h3>📊 ${t('Customer statements (Excel)')}</h3>
    <p class="muted small">${t('One sheet per customer with every sale, advance, collection and return, and the running balance. A summary sheet comes first.')}</p>
    <button class="btn primary" id="stmtX">${t('Download statements')}</button><div id="stS" class="muted small"></div></div>`;
  const sel = $('#recScope'); if (sel) sel.onchange = () => { try { sessionStorage.setItem('recScope', sel.value); } catch {} };
  $('#stmtX').onclick = async () => {
    const btn = $('#stmtX'); btn.disabled = true;
    try {
      $('#stS').textContent = t('Collecting data…');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const X = window.XLSX, wb = X.utils.book_new(), summary = [], used = new Set();
      const books = recBooks();
      const sheetName = (nm) => { let base = String(nm).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Customer', n = base, i = 2; while (used.has(n.toLowerCase())) n = `${base.slice(0, 26)} ${i++}`; used.add(n.toLowerCase()); return n; };
      const typeName = { opening: 'Opening balance', sale: 'Sale', advance: 'Advance', collection: 'Collection', return: 'Return', discount: 'Discount' };
      const sheets = [];
      for (const bk of books) {
        const d = await loadBook(bk.key, true);
        const custs = d.customers.sort((a, b) => a.name.localeCompare(b.name));
        for (const c of custs) {
          const accs = d.accounts.filter((a) => a.customerId === c.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          const due = L.round2(accs.filter((a) => a.status !== 'closed').reduce((s2, a) => s2 + (a.balance || 0), 0));
          const name = sheetName(c.name);
          summary.push({ Seller: bk.name, Customer: c.name, 'House no.': c.house || '', Lane: c.lane || '', Phone: c.phone || '', Accounts: accs.length, 'Balance due': due, Sheet: name });
          const rows = [[c.name], [`${placeOf(c)}${placeOf(c) ? '  |  ' : ''}${phonesOf(c).map((p) => `${p.label ? p.label + ': ' : ''}${p.number}`).join(', ')}`], [`Seller: ${bk.name}   |   Printed: ${fmtDate(today())}`], []];
          for (const a of accs) {
            rows.push([`Account: ${a.name} (${a.frequency})${a.status === 'closed' ? ' — closed' : ''}`, '', '', '', '', '', `Balance: ${L.round2(a.balance || 0)}`]);
            rows.push(['Date', 'Type', 'Details', 'Mode', 'Debit (+)', 'Credit (−)', 'Balance']);
            const led = L.buildLedger(a.openingBalance, d.sales.filter((x) => x.accountId === a.id), d.collections.filter((x) => x.accountId === a.id), d.returns.filter((x) => x.accountId === a.id));
            for (const r of led) {
              const det = r.type === 'sale' || r.type === 'return' ? r.ref.items.map((i) => `${i.name} x${i.qty}`).join(', ') : [(r.ref?.scrapItems || []).map((i) => `${i.type} ${i.value}`).join(', '), r.ref?.note].filter(Boolean).join(' · ');
              const mode = r.type === 'collection' || r.type === 'advance' ? MODE_EN[r.ref.mode] || 'Cash' : '';
              rows.push([fmtDate(r.date) || '-', typeName[r.type], det, mode, r.sign > 0 ? r.amount : '', r.sign < 0 ? r.amount : '', r.balance]);
            }
            rows.push([]);
          }
          const ws = X.utils.aoa_to_sheet(rows);
          ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 34 }, { wch: 7 }, { wch: 11 }, { wch: 11 }, { wch: 12 }];
          sheets.push([name, ws]);
        }
      }
      const sws = X.utils.json_to_sheet(summary.length ? summary : [{ Customer: '—' }]);
      sws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 9 }, { wch: 18 }, { wch: 13 }, { wch: 9 }, { wch: 12 }, { wch: 24 }];
      X.utils.book_append_sheet(wb, sws, 'Summary');
      sheets.forEach(([n, ws]) => X.utils.book_append_sheet(wb, ws, n));
      const who = books.length === 1 ? books[0].name : 'all';
      $('#stS').textContent = `${summary.length} ${t('customers')}`;
      await shareOrSave(new Blob([X.write(wb, { bookType: 'xlsx', type: 'array' })]), `statements-${who}-${today()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (err) { if (err.name !== 'AbortError') toast(t('Could not make the file') + ': ' + err.message, true); }
    finally { btn.disabled = false; }
  };
}

async function renderPrintList() {
  setTitle(t('Customer balance list'), '#/records');
  view.innerHTML = `<div class="loading">…</div>`;
  const books = recBooks(), now = today(), dayOrder = [1, 2, 3, 6, 0];
  let grand = 0, html = '';
  for (const bk of books) {
    const d = await loadBook(bk.key, false);
    const lastPay = {};
    d.collections.forEach((c) => { if (!lastPay[c.accountId] || c.date > lastPay[c.accountId]) lastPay[c.accountId] = c.date; });
    const rowsOf = (c) => d.accounts.filter((a) => a.customerId === c.id && a.status !== 'closed' && L.round2(a.balance || 0) !== 0);
    const groups = [...dayOrder.map((dd) => [dayLabel(dd), d.customers.filter((c) => (daysOf(c)[0] === undefined ? false : dayOrder.find((x) => daysOf(c).includes(x)) === dd)), dd]),
      [t('No day'), d.customers.filter((c) => !daysOf(c).length), null]];
    let bookTotal = 0, body = '';
    for (const [label, custs, dd] of groups) {
      const list = (dd === null ? custs.sort((a, b) => a.name.localeCompare(b.name)) : L.routeSort(custs, dd)).filter((c) => rowsOf(c).length);
      if (!list.length) continue;
      let gTotal = 0, n = 0;
      const trs = list.map((c) => {
        const accs = rowsOf(c); n++;
        return accs.map((a, i) => { gTotal += a.balance || 0; return `<tr>${i === 0 ? `<td rowspan="${accs.length}">${n}</td><td rowspan="${accs.length}" class="pl">${esc(placeOf(c))}</td><td rowspan="${accs.length}"><b>${esc(c.name)}</b></td><td rowspan="${accs.length}">${esc(c.phone || '')}</td>` : ''}
          <td>${a.inactive ? '⏸ ' : ''}${esc(a.name)}</td><td class="num">${money(a.balance)}</td><td>${fmtDate(lastPay[a.id] || '') || '—'}</td></tr>`; }).join('');
      }).join('');
      bookTotal += gTotal;
      body += `<h4>${esc(label)} · ${list.length} ${t('customers')} · ${money(gTotal)}</h4>
        <table class="plist"><thead><tr><th>#</th><th>${t('House no.')} · ${t('Lane')}</th><th>${t('Name')}</th><th>${t('Phone')}</th><th>${t('Account')}</th><th>${t('Balance')}</th><th>${t('Last paid')}</th></tr></thead><tbody>${trs}</tbody></table>`;
    }
    grand += bookTotal;
    html += `<section class="pbook"><h3>${esc(bk.name)} — ${t('Total due')} ${money(bookTotal)}</h3>${body || `<p class="muted">${t('No open balances')}</p>`}</section>`;
  }
  view.innerHTML = `<div class="noprint actions"><button class="btn primary" id="doPrint">🖨️ ${t('Print / Save as PDF')}</button>
      <p class="muted small">${t('In the print screen choose your printer, or “Save as PDF”.')}</p></div>
    <div class="printarea"><h2>${esc(APP_NAME)} — ${t('Customer balance list')}</h2><p class="muted small">${fmtDate(now)} · ${t('Open accounts with a balance only')}</p>
    ${html}${books.length > 1 ? `<h3>${t('Grand total due')}: ${money(grand)}</h3>` : ''}</div>`;
  $('#doPrint').onclick = () => window.print();
}

// ---------- menu & settings ----------
function renderMenu() {
  setTitle(t('Menu'));
  view.innerHTML = `<ul class="list menu">
    ${isAdmin() ? '' : `<li><a href="#/expenses">💸 ${t('My expenses')}</a></li>`}
    ${isAdmin() ? `<li><a href="#/expenses">💸 ${t('Seller expenses')}</a></li>` : ''}
    <li><a href="#/orders">🚚 ${t('Orders')}</a></li>
    ${S.sid ? `<li><a href="#/cash-sales">🛒 ${t('Cash sales')}</a></li>` : ''}
    ${S.sid ? `<li><a href="#/close-day">🌙 ${t('Close today')}</a></li>` : ''}
    <li><a href="#/complaints">🛠️ ${t('Complaint items')} (${Object.keys(S.complaints).length})</a></li>
    <li><a href="#/shop-link">🛍️ ${t('Shop link')}</a></li>
    ${S.sid ? `<li><a href="#/upi">📲 ${t('My UPI')}</a></li>` : ''}
    ${isAdmin() ? `<li><a href="#/company-expenses">🏢 ${t('Company expenses')}</a></li>
      <li><a href="#/scrap">♻️ ${t('Scrap')}</a></li>
      <li><a href="#/catalog">🛍️ ${t('Shop catalog')}</a></li>
      <li><a href="#/categories">♻️ ${t('Scrap types')}</a></li>
      <li><a href="#/users">👤 ${t('Users')}</a></li><li><a href="#/backup">💾 ${t('Backup (Excel)')}</a></li><li><a href="#/app-settings">⚙️ ${t('App settings')}</a></li>` : ''}
    <li><a href="#/records">🖨️ ${t('Print list & statements')}</a></li>
    <li><a href="#/settings">🌓 ${t('Language, theme and password')}</a></li>
    <li><button class="linkbtn" id="lo">${t('Log out')} (${esc(S.profile.name)})</button></li></ul>
    <p class="muted small center">${navigator.onLine ? t('Online') : t('Offline — entries will sync later')}</p>`;
  $('#lo').onclick = () => { if (confirm(t('Log out?'))) F.logout(); };
}

function applyTheme(m) {
  try { localStorage.setItem('theme', m); } catch {}
  document.documentElement.setAttribute('data-theme', m);
  const dark = m === 'dark' || (m === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#0E1412' : '#F3F5F2');
}
const themeNow = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };

function renderSettings() {
  setTitle(t('Language, theme and password'), '#/menu');
  view.innerHTML = `<div class="card form"><label>${t('Language')}<select id="lang"><option value="en">English</option><option value="ml" ${getLang() === 'ml' ? 'selected' : ''}>മലയാളം</option></select></label>
    <label>${t('Theme')}</label><div class="seg" id="theme">${[['auto', '🌓', 'Auto'], ['light', '☀️', 'Light'], ['dark', '🌙', 'Dark']].map(([k, i, l]) =>
      `<label><input type="radio" name="th" value="${k}" ${themeNow() === k ? 'checked' : ''}><span>${i} ${t(l)}</span></label>`).join('')}</div>
    <p class="muted small">${t('Auto follows the phone: light in the day, dark at night if the phone is set that way. This choice is for this phone only.')}</p></div>
    <form id="pw" class="card form"><h3>${t('Change password')}</h3>
      <label>${t('Current password')}<input name="cur" type="password" required></label>
      <label>${t('New password')}<input name="nw" type="password" minlength="6" required></label>
      <button class="btn primary" type="submit">${t('Change password')}</button></form>`;
  $('#lang').onchange = (e) => { setLang(e.target.value); applyNav(); renderSettings(); };
  $$('#theme input').forEach((r) => (r.onchange = () => applyTheme(r.value)));
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await F.changeOwnPassword(e.target.cur.value, e.target.nw.value); toast(t('Password changed')); e.target.reset(); }
    catch (err) { toast(t('Could not change password') + ': ' + (err.code || err.message), true); }
  };
}

function renderUsers() {
  setTitle(t('Users'), '#/menu');
  const draw = () => {
    const list = Object.entries(S.users).sort((a, b) => (a[1].active === false) - (b[1].active === false) || a[1].name.localeCompare(b[1].name));
    $('#ulist').innerHTML = list.map(([id, u]) => `<li class="card"><div><b>${esc(u.name)}</b><small>@${esc(u.username)} · ${u.role === 'admin' ? t('Admin') : t('Seller')}${u.active === false ? ' · ' + t('Inactive') : ''}</small></div>
      ${u.role === 'admin' ? '' : `<div class="contact">
        ${u.active === false ? '' : `<a class="btn small" href="#/relogin/${id}/handover">${t('Hand over to new person')}</a>
          <a class="btn small" href="#/relogin/${id}/reset">${t('New login (forgot password)')}</a>`}
        <button class="btn small" data-tog="${id}">${u.active === false ? t('Activate') : t('Deactivate')}</button></div>`}</li>`).join('');
    $$('[data-tog]').forEach((b) => (b.onclick = () => {
      const u = S.users[b.dataset.tog], bt = F.writeBatch(F.db);
      bt.update(F.doc(F.db, 'users', b.dataset.tog), { active: u.active === false });
      F.commit(bt, onWriteError);
    }));
  };
  view.innerHTML = `<ul class="list" id="ulist"></ul>
    <form id="nu" class="card form"><h3>${t('Add seller')}</h3>
      <label>${t('Name')}<input name="name" required></label>
      <label>${t('Username')}<input name="u" autocapitalize="none" pattern="[a-z0-9_.\\-]+" required></label>
      <label>${t('Password')} <small class="muted">(${t('min 6 characters')})</small><input name="p" type="text" minlength="6" required></label>
      <button class="btn primary" type="submit">${t('Create login')}</button>
      <p class="muted small">${t('A new seller starts with no customers. To give an existing seller\'s customers to someone else, use Hand over.')}</p></form>`;
  $('#nu').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, username = f.u.value.trim().toLowerCase();
    try {
      const uid = await F.createLogin(username, f.p.value);
      await F.setDoc(F.doc(F.db, 'users', uid), { username, name: f.name.value.trim(), role: 'seller', active: true, sellerKey: uid });
      toast(t('Login created')); f.reset();
    } catch (err) { toast(t('Could not create login') + ': ' + (err.code || err.message), true); }
  };
  draw();
  S.refresh = draw;
}

function renderRelogin(oldId, mode) {
  if (!isAdmin()) return go('#/home');
  const u = S.users[oldId];
  if (!u || u.role !== 'seller' || u.active === false) return go('#/users');
  const handover = mode === 'handover';
  setTitle(handover ? t('Hand over to new person') : t('New login (forgot password)'), '#/users');
  view.innerHTML = `<form id="rl" class="card form">
    <p>${handover
      ? `${t('All customers, accounts and balances of')} <b>${esc(u.name)}</b> ${t('will move to the new person. Reports up to the day before the handover date stay with')} ${esc(u.name)}.`
      : `${t('Same person, new username and password. Customers and reports stay the same.')}`}</p>
    ${handover ? `<label>${t('New person name')}<input name="name" required></label>` : ''}
    <label>${t('New username')}<input name="u" autocapitalize="none" pattern="[a-z0-9_.\\-]+" value="${handover ? '' : esc(u.username) + '2'}" required></label>
    <label>${t('Password')} <small class="muted">(${t('min 6 characters')})</small><input name="p" type="text" minlength="6" required></label>
    ${handover ? `<label>${t('Handover date')}<input name="date" type="date" value="${today()}" required></label>` : ''}
    <button class="btn primary" type="submit">${handover ? t('Hand over') : t('Create login')}</button>
    <p class="muted small">${t('The old login')} (@${esc(u.username)}) ${t('will be deactivated.')}</p></form>`;
  $('#rl').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, username = f.u.value.trim().toLowerCase(), key = keyOf(oldId, u);
    if (handover && !confirm(`${u.name} → ${f.name.value.trim()} ?`)) return;
    try {
      const uid = await F.createLogin(username, f.p.value);
      const bt = F.writeBatch(F.db);
      if (handover) {
        const date = f.date.value || today();
        bt.set(F.doc(F.db, 'users', uid), { username, name: f.name.value.trim(), role: 'seller', active: true, sellerKey: key, heldFrom: date });
        bt.update(F.doc(F.db, 'users', oldId), { active: false, heldTo: L.addDays(date, -1), handedTo: uid });
        bt.set(F.doc(F.db, 'shopSellers', key), { name: f.name.value.trim(), wa: '', updatedAt: Date.now() }); // new person sets their own number
        F.audit(bt, S.user.uid, 'handover', `users/${oldId}`, { holder: u.name }, { holder: f.name.value.trim(), date });
      } else {
        const keep = { username, name: u.name, role: 'seller', active: true, sellerKey: key };
        if (u.heldFrom) keep.heldFrom = u.heldFrom;
        bt.set(F.doc(F.db, 'users', uid), keep);
        bt.update(F.doc(F.db, 'users', oldId), { active: false, replaced: true });
        F.audit(bt, S.user.uid, 'login-replace', `users/${oldId}`, { username: u.username }, { username });
      }
      await bt.commit();
      if (S.sid === key) selectSeller(key);
      toast(t('Done') + ': @' + username);
      go('#/users');
    } catch (err) { toast(t('Could not create login') + ': ' + (err.code || err.message), true); }
  };
}

async function renderBackup() {
  setTitle(t('Backup (Excel)'), '#/menu');
  view.innerHTML = `<div class="card">
    <p>${t('Downloads all data as one Excel file: customers, accounts, sales, collections, returns, notes, expenses, visits, orders, scrap and users.')}</p>
    <p class="muted small">${t('Do this once a week and keep the file in Google Drive or WhatsApp.')}</p>
    <button class="btn primary" id="go">${t('Download backup')}</button><div id="bs" class="muted small"></div></div>`;
  $('#go').onclick = async () => {
    const btn = $('#go'); btn.disabled = true;
    try {
      if (!navigator.onLine) throw new Error(t('Connect to the internet first'));
      $('#bs').textContent = t('Collecting data…');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const X = window.XLSX, wb = X.utils.book_new();
      const all = (c) => F.fetchAll(F.collection(F.db, c));
      const items = (arr) => (arr || []).map((i) => `${i.name} x${i.qty} @${i.price ?? i.unitCost}`).join('; ');
      const add = (name, rows) => X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows.length ? rows : [{ empty: '' }]), name);
      const users = Object.entries(S.users).map(([uid, u]) => ({ uid, ...u }));
      const keys = [...new Set(users.filter((u) => u.role === 'seller').map((u) => u.sellerKey || u.uid))];
      const holder = (k) => users.filter((u) => (u.sellerKey || u.uid) === k && !u.replaced).sort((a, b) => (a.active === false) - (b.active === false))[0]?.name || k;
      const per = { customers: [], accounts: [], sales: [], collections: [], returns: [], notes: [], expenses: [], visits: [], orders: [] };
      for (const k of keys) {
        const got = await Promise.all(Object.keys(per).map((c) => F.fetchAll(F.sellerCol(k, c))));
        Object.keys(per).forEach((c, i) => got[i].forEach((d) => per[c].push({ seller: holder(k), ...d })));
      }
      const cname = Object.fromEntries(per.customers.map((c) => [c.id, c.name]));
      const aname = Object.fromEntries(per.accounts.map((a) => [a.id, a.name]));
      const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN') : '');
      add('Customers', per.customers.map((c) => ({ seller: c.seller, id: c.id, name: c.name, houseNo: c.house || '', lane: c.lane || '', phone: c.phone, otherPhones: phonesOf(c).filter((p) => !p.primary).map((p) => `${p.label} ${p.number}`.trim()).join('; '), address: c.address, routeDays: daysOf(c).map((x) => DAY_KEYS[x]).join(' '), lat: c.geo?.lat ?? '', lng: c.geo?.lng ?? '', oldAddresses: (c.addressHistory || []).map((h) => `${h.address} (till ${h.until})`).join('; '), cashCount: c.modeCounts?.cash || 0, upiCount: c.modeCounts?.upi || 0 })));
      add('Accounts', per.accounts.map((a) => ({ seller: a.seller, id: a.id, customer: cname[a.customerId], customerId: a.customerId, account: a.name, frequency: a.frequency, openingBalance: a.openingBalance, balance: a.balance, status: a.status })));
      const cashName = (x) => `Cash sale${x.buyerName ? ': ' + x.buyerName : ''}`;
      add('Sales', per.sales.map((x) => ({ seller: x.seller, date: x.date, customer: x.cash ? cashName(x) : cname[x.customerId], account: aname[x.accountId], items: items(x.items), saleValue: x.saleValue, cost: x.cost, advance: x.advance, returnedValue: x.creditedValue || 0, id: x.id })));
      add('Collections', per.collections.map((x) => ({ seller: x.seller, date: x.date, customer: x.cash ? cashName(x) : cname[x.customerId], account: aname[x.accountId], type: x.kind, mode: MODE_EN[x.mode] || 'Cash', upiTo: x.upiTo || '', scrap: (x.scrapItems || []).map((i) => `${i.type} ${i.value}`).join('; '), amount: x.amount, profit: x.profit, note: x.note, enteredBy: userName(x.by), at: when(x.createdAt) })));
      add('Returns', per.returns.map((x) => ({ seller: x.seller, date: x.date, customer: x.cash ? 'Cash sale' : cname[x.customerId], account: aname[x.accountId], items: items(x.items), condition: x.condition, credited: x.credited ? 'yes' : 'no', amount: x.amount, cost: x.cost })));
      add('Notes', per.notes.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId] || x.customerName, note: x.text, remindOn: x.dueDate, done: x.done ? 'yes' : 'no' })));
      add('Expenses', per.expenses.map((x) => ({ seller: x.seller, date: x.date, type: x.category, mode: x.mode === 'upi' ? 'UPI' : 'Cash', amount: x.amount, note: x.note })));
      add('Visits', per.visits.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId], reason: x.reason, promisedDate: x.promiseDate || '', note: x.note })));
      add('Orders', per.orders.map((x) => ({ seller: x.seller, ordered: when(x.createdAt), customer: x.customerName, items: (x.items || []).map((i) => `${i.name} x${i.qty}`).join('; '), deliveryDate: x.deliveryDate, status: x.status, note: x.note })));
      const [cexp, comp, scrap, sIn, sSales] = await Promise.all([all('companyExpenses'), all('complaints'), all('scrapLosses'), all('scrapIn'), all('scrapSales')]);
      add('Company expenses', cexp.map((x) => ({ date: x.date, type: x.category, mode: x.mode === 'upi' ? 'UPI' : 'Cash', amount: x.amount, note: x.note })));
      add('Complaints', comp.map((x) => ({ date: x.date, item: x.name, qty: x.qty, customer: x.customerName, status: x.status, resolvedOn: x.resolvedOn || '' })));
      add('Damage losses', scrap.map((x) => ({ date: x.date, item: x.name, qty: x.qty, amount: x.amount })));
      add('Scrap taken', sIn.map((x) => ({ date: x.date, seller: holder(x.sellerKey), customer: x.customerName, items: (x.items || []).map((i) => `${i.type} ${i.value}`).join('; '), total: x.total })));
      add('Scrap sold', sSales.map((x) => ({ date: x.date, items: (x.items || []).map((i) => `${i.type} ${i.value}`).join('; '), creditedValue: x.credited, received: x.received, mode: x.mode === 'upi' ? 'UPI' : 'Cash', note: x.note })));
      add('Users', users.map((u) => ({ name: u.name, username: u.username, role: u.role, active: u.active === false ? 'no' : 'yes', heldFrom: u.heldFrom || '', heldTo: u.heldTo || '', bookKey: u.sellerKey || '' })));
      const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
      const file = new File([out], `alameen-backup-${today()}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      $('#bs').textContent = `${per.customers.length} ${t('customers')} · ${per.collections.length} ${t('entries')}`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: file.name });
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
      const bt = F.writeBatch(F.db); bt.set(F.doc(F.db, 'settings', 'main'), { lastBackup: today() }, { merge: true }); F.commit(bt, () => {});
    } catch (err) {
      if (err.name !== 'AbortError') toast(t('Backup failed') + ': ' + err.message, true);
    } finally { btn.disabled = false; }
  };
}

function renderAppSettings() {
  setTitle(t('App settings'), '#/menu');
  const s = S.settings;
  view.innerHTML = `<form id="as" class="card form">
    <!-- Margins only feed the (hidden) profit estimate; kept as they are, not shown. -->
    <input name="dm" type="hidden" value="${s.defaultMarginPct}"><input name="lm" type="hidden" value="${s.legacyMarginPct}">
    <label>${t("Admin's WhatsApp number (for day-end summaries)")}<input name="aw" type="tel" inputmode="tel" value="${esc(s.adminWa || '')}"></label>
    <button class="btn primary" type="submit">${t('Save')}</button></form>
    <div class="card form" style="border-color:var(--bad)">
      <h3 style="margin-top:0;color:var(--bad)">🗑️ ${t('Delete all test data')}</h3>
      <p class="small muted">${t('Removes all customers, accounts, sales, collections, returns, notes, visits, orders, expenses, complaints, scrap, catalog and day closings. Keeps users, passwords, these settings, categories, scrap types, calendar events and shop WhatsApp numbers.')}</p>
      <p class="small">${s.lastBackup === today() ? `✓ ${t('Backup taken today')}` : `⚠ ${t('Take a backup first (Menu → Backup). This button works only after today\'s backup.')}`}</p>
      <button class="btn danger" id="wipe" ${s.lastBackup === today() ? '' : 'disabled'}>${t('Delete all test data')}</button><div id="wipeS" class="small muted"></div></div>`;
  $('#wipe').onclick = () => wipeTestData();
  $('#as').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target, b = F.writeBatch(F.db);
    const upd = { defaultMarginPct: Math.max(0, num(f.dm.value)), legacyMarginPct: num(f.lm.value), adminWa: f.aw.value.trim() };
    b.set(F.doc(F.db, 'settings', 'main'), upd, { merge: true });
    F.audit(b, S.user.uid, 'settings', 'settings/main', { defaultMarginPct: s.defaultMarginPct, legacyMarginPct: s.legacyMarginPct }, { defaultMarginPct: upd.defaultMarginPct, legacyMarginPct: upd.legacyMarginPct });
    F.commit(b, onWriteError); toast(t('Saved'));
    Object.assign(S.settings, upd);
  };
}

// ---------- delete all test data (admin) ----------
const WIPE_TOP = ['stock', 'purchases', 'billPhotos', 'complaints', 'scrapLosses', 'companyExpenses', 'catalog', 'catalogPhotos', 'demand', 'scrapIn', 'scrapSales', 'stockMoves', 'phoneIndex', 'nameMap', 'meals', 'auditLog'];
const WIPE_BOOK = ['customers', 'accounts', 'sales', 'collections', 'returns', 'notes', 'expenses', 'visits', 'orders', 'routeChanges', 'dayClose', 'meta'];
async function wipeTestData() {
  if (!isAdmin()) return;
  if (!navigator.onLine) return toast(t('Connect to the internet first'), true);
  if (S.settings.lastBackup !== today()) return toast(t('Take a backup first (Menu → Backup).'), true);
  const keys = [...new Set(Object.entries(S.users).filter(([, u]) => u.role === 'seller').map(([uid, u]) => keyOf(uid, u)))];
  $('#wipeS').textContent = t('Counting…');
  let nCust = 0; for (const k of keys) nCust += (await F.fetchAll(F.sellerCol(k, 'customers'))).length;
  if ((prompt(`${nCust} ${t('customers')} ${t('and everything else listed will be deleted for good.')}\n${t('Type DELETE to continue')}`) || '').trim() !== 'DELETE') { $('#wipeS').textContent = ''; return; }
  const btn = $('#wipe'); btn.disabled = true;
  const paths = [];
  for (const c of WIPE_TOP) (await F.fetchAll(F.collection(F.db, c))).forEach((d) => paths.push(F.doc(F.db, c, d.id)));
  for (const k of keys) for (const c of WIPE_BOOK) (await F.fetchAll(F.sellerCol(k, c))).forEach((d) => paths.push(F.sellerDoc(k, c, d.id)));
  try {
    for (let i = 0; i < paths.length; i += 400) {
      const b = F.writeBatch(F.db); paths.slice(i, i + 400).forEach((r) => b.delete(r)); await b.commit();
      $('#wipeS').textContent = `${Math.min(i + 400, paths.length)} / ${paths.length}`;
    }
    const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'settings', 'main'), { movesV1: true, wipedAt: Date.now() }, { merge: true }); await b.commit();
    toast(t('All test data deleted')); setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(t('Could not delete') + ': ' + (e.code || e.message), true); btn.disabled = false; }
}

// ---------- categories & scrap types (admin) ----------
function renderCategories() {
  setTitle(t('Scrap types'), '#/menu');
  const draw = () => {
    const types = scrapTypes();
    view.innerHTML = `<div class="card"><h3 style="margin-top:0">♻️ ${t('Scrap types')}</h3>
      ${types.map((c) => `<div class="kv"><span>${esc(t(c))}</span>${c === 'Others' ? '' : `<button class="x" data-sdel="${esc(c)}">×</button>`}</div>`).join('')}
      <form id="sf2" class="toolbar"><input name="n" placeholder="${t('New scrap type')}" required><button class="btn primary" type="submit">${t('Add')}</button></form></div>`;
    const saveSettings = (upd) => { const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'settings', 'main'), upd, { merge: true }); return b; };
    $('#sf2').onsubmit = (e) => {
      e.preventDefault(); const n = e.target.n.value.trim();
      if (!n || types.some((c) => c.toLowerCase() === n.toLowerCase())) return toast(t('Already there'), true);
      const next = [...types.filter((c) => c !== 'Others'), n, 'Others'];
      F.commit(saveSettings({ scrapTypes: next }), onWriteError); S.settings.scrapTypes = next; draw();
    };
    $$('[data-sdel]').forEach((b) => (b.onclick = () => {
      if (!confirm(t('Delete this scrap type?'))) return;
      const next = types.filter((x) => x !== b.dataset.sdel);
      F.commit(saveSettings({ scrapTypes: next }), onWriteError); S.settings.scrapTypes = next; draw();
    }));
  };
  draw();
}

// ---------- shop catalog (admin keeps the items by hand: name, photo, description, price, available) ----------
function renderCatalog() {
  setTitle(t('Shop catalog'), '#/menu');
  if (!isAdmin()) return go('#/home');
  const draw = () => {
    const list = Object.values(S.catalog).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    view.innerHTML = `<div class="toolbar"><a class="btn primary" href="#/catalog-edit/new">+ ${t('Add item')}</a><a class="btn" href="#/shop-link">🛍️ ${t('Shop link')}</a></div>
      <p class="muted small">${t('These items are shown on the shop link. Tap Available / Sold out to change it.')}</p>
      <ul class="list">${list.map((c) => `<li class="row"><a href="#/catalog-edit/${c.id}" style="flex:1;text-decoration:none;color:inherit"><b>${esc(c.name)}</b>
        <small>${money(c.price || 0)}${c.show ? '' : ' · ' + t('Hidden')}${c.hasPhoto ? ' · 📷' : ''}</small></a>
        <button class="pill ${c.available ? 'ok' : 'bad'}" data-av="${c.id}">${c.available ? t('Available') : t('Sold out')}</button></li>`).join('') || `<li class="muted">${t('No items yet')}</li>`}</ul>`;
    $$('[data-av]').forEach((b) => (b.onclick = () => {
      const c = S.catalog[b.dataset.av], bt = F.writeBatch(F.db);
      bt.update(F.doc(F.db, 'catalog', c.id), { available: !c.available, updatedAt: Date.now() });
      F.commit(bt, onWriteError); c.available = !c.available; draw();
    }));
  };
  draw();
  S.refresh = draw;
}

async function renderCatalogEdit(key) {
  if (!isAdmin()) return go('#/home');
  const isNew = key === 'new', c0 = isNew ? {} : S.catalog[key];
  if (!c0) return go('#/catalog');
  setTitle(isNew ? t('Add item') : t('Edit item'), '#/catalog');
  let photo = null, oldPhoto = null;
  view.innerHTML = `<form id="ef" class="card form">
    <label>${t('Item name')}<input name="name" value="${esc(c0.name || '')}" required></label>
    <label>${t('Price')}<input name="price" type="number" step="any" min="0" inputmode="decimal" value="${c0.price || ''}"></label>
    <div class="row" style="padding:6px 0"><img id="cph" class="thumb" alt="" hidden>
      <label class="btn small" style="flex:1">📷 ${t('Photo')}<input id="cpf" type="file" accept="image/*" hidden></label></div>
    <label>${t('Description for customers')}<textarea name="desc" rows="2">${esc(c0.description || '')}</textarea></label>
    <label class="radio"><input type="checkbox" name="show" ${isNew || c0.show ? 'checked' : ''}> ${t('Show in the customer catalog')}</label>
    <label class="radio"><input type="checkbox" name="avail" ${isNew || c0.available ? 'checked' : ''}> ${t('Available')}</label>
    <button class="btn primary" type="submit">${t('Save')}</button>
    ${isNew ? '' : `<button class="btn danger" type="button" id="del">${t('Delete item')}</button>`}</form>`;
  if (c0.hasPhoto) F.getDoc(F.doc(F.db, 'catalogPhotos', key)).then((d) => { if (d.exists()) { oldPhoto = d.data().data; if ($('#cph')) { $('#cph').src = oldPhoto; $('#cph').hidden = false; } } }).catch(() => {});
  $('#cpf').onchange = async (e) => { const file = e.target.files[0]; if (!file) return; photo = await compressImage(file, 800, 250000); $('#cph').src = photo; $('#cph').hidden = false; };
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, name = f.name.value.trim(); if (!name) return;
    const nk = L.nameKey(name);
    if (!isNew && nk !== key && c0.hasPhoto && !photo && !oldPhoto) { // renamed: the old photo must be copied to the new name first
      const d = await F.getDoc(F.doc(F.db, 'catalogPhotos', key)).catch(() => null);
      if (d?.exists()) oldPhoto = d.data().data; else return toast(t('The photo is still loading. Try again in a moment.'), true);
    }
    if (nk !== key && S.catalog[nk]) return toast(t('An item with this name is already in the catalog'), true);
    const b = F.writeBatch(F.db);
    const docData = { name, category: '', description: f.desc.value.trim(), show: f.show.checked, available: f.avail.checked, price: L.round2(num(f.price.value)), hasPhoto: !!(photo || oldPhoto || c0.hasPhoto), updatedAt: Date.now() };
    b.set(F.doc(F.db, 'catalog', nk), docData);
    if (photo || (nk !== key && oldPhoto)) b.set(F.doc(F.db, 'catalogPhotos', nk), { data: photo || oldPhoto, updatedAt: Date.now() });
    if (!isNew && nk !== key) { b.delete(F.doc(F.db, 'catalog', key)); if (c0.hasPhoto) b.delete(F.doc(F.db, 'catalogPhotos', key)); }
    F.audit(b, S.user.uid, 'catalog', `catalog/${nk}`, isNew ? null : { name: c0.name, price: c0.price, show: c0.show, available: c0.available }, { name, price: docData.price, show: docData.show, available: docData.available });
    F.commit(b, onWriteError); S.catalog[nk] = { id: nk, ...docData }; if (!isNew && nk !== key) delete S.catalog[key];
    toast(t('Saved')); go('#/catalog');
  };
  const del = $('#del');
  if (del) del.onclick = () => {
    if (!confirm(t('Delete this item from the catalog?'))) return;
    const b = F.writeBatch(F.db); b.delete(F.doc(F.db, 'catalog', key)); if (c0.hasPhoto) b.delete(F.doc(F.db, 'catalogPhotos', key));
    F.audit(b, S.user.uid, 'catalog-delete', `catalog/${key}`, { name: c0.name }, null);
    F.commit(b, onWriteError); delete S.catalog[key]; go('#/catalog');
  };
}

// ---------- shop link (public catalog) ----------
const shopUrl = (key) => new URL('shop.html?s=' + encodeURIComponent(key), location.href.split('#')[0]).href;

async function renderShopLink() {
  setTitle(t('Shop link'), '#/menu');
  const shown = Object.values(S.catalog).filter((c) => c.show).length;
  const intro = `<p class="muted small">${t('Customers open this link without logging in. They see the photo, description, price and whether the item is available — never the cost. "Ask on WhatsApp" goes to your number.')}</p>
    <p class="small">🛍️ ${shown} ${t('items are shown in the catalog.')} ${isAdmin() ? `<a href="#/catalog">${t('Edit the catalog')}</a>` : ''}</p>`;
  if (isAdmin()) {
    const rows = await Promise.all(sellers().map(async (x) => { const d = await F.getDoc(F.doc(F.db, 'shopSellers', x.id)).catch(() => null); return { ...x, wa: d?.exists() ? d.data().wa : '' }; }));
    view.innerHTML = `<div class="card">${intro}</div><ul class="list">${rows.map((x) => `<li class="card"><b>${esc(x.name)}</b>
      <small>${x.wa ? '📱 ' + esc(x.wa) : '⚠ ' + t('WhatsApp number not set yet — the seller sets it in Menu → Shop link')}</small>
      <div class="contact"><a class="btn small" href="${esc(shopUrl(x.id))}" target="_blank" rel="noopener">${t('Open')}</a><button class="btn small" data-share="${x.id}">${t('Share link')}</button></div></li>`).join('')}</ul>`;
  } else {
    const d = await F.getDoc(F.doc(F.db, 'shopSellers', S.sid)).catch(() => null);
    const wa = d?.exists() ? d.data().wa : '';
    view.innerHTML = `<form id="wf" class="card form">${intro}
      <label>${t('My WhatsApp number')}<input name="wa" type="tel" inputmode="tel" value="${esc(wa)}" required placeholder="98xxxxxxxx"></label>
      <button class="btn primary" type="submit">${t('Save')}</button></form>
      <div class="card"><b>${t('My shop link')}</b><div class="small" style="word-break:break-all;margin:6px 0">${esc(shopUrl(S.sid))}</div>
      <div class="contact"><a class="btn small" href="${esc(shopUrl(S.sid))}" target="_blank" rel="noopener">${t('Open')}</a><button class="btn small wa" data-share="${S.sid}">${t('Share link')}</button></div></div>`;
    $('#wf').onsubmit = (e) => {
      e.preventDefault();
      const b = F.writeBatch(F.db);
      b.set(F.doc(F.db, 'shopSellers', S.sid), { name: S.profile.name, wa: e.target.wa.value.trim(), updatedAt: Date.now() });
      F.commit(b, onWriteError); toast(t('Saved'));
    };
  }
  $$('[data-share]').forEach((b) => (b.onclick = async () => {
    const url = shopUrl(b.dataset.share), text = `${APP_NAME} — ${t('see our items')}: ${url}`;
    try { if (navigator.share) return await navigator.share({ title: APP_NAME, text, url }); } catch (e) { if (e.name === 'AbortError') return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }));
}

// ---------- scrap taken as payment (admin) ----------
async function renderScrap() {
  setTitle(t('Scrap'), '#/menu');
  view.innerHTML = '<div class="loading">…</div>';
  const [ins, sales] = await Promise.all([F.fetchAll(F.collection(F.db, 'scrapIn')), F.fetchAll(F.collection(F.db, 'scrapSales'))]);
  const st = L.scrapStock(ins, sales), types = Object.entries(st).filter(([, v]) => Math.abs(v) > 0.001);
  const total = L.round2(types.reduce((s2, [, v]) => s2 + v, 0));
  view.innerHTML = `<div class="card"><h3 style="margin-top:0">♻️ ${t('Scrap on hand')} <span class="muted">(${t('credited value')})</span></h3>
      ${types.map(([k, v]) => `<div class="kv"><span>${esc(t(k))}</span><b>${money(v)}</b></div>`).join('') || `<div class="muted small">${t('No scrap on hand')}</div>`}
      ${types.length ? `<div class="kv"><b>${t('Total')}</b><b>${money(total)}</b></div>` : ''}</div>
    ${types.length ? `<form id="ssf" class="card form"><h3 style="margin-top:0">${t('Record scrap sale')}</h3>
      ${types.map(([k, v]) => `<label class="radio"><input type="checkbox" name="ty" value="${esc(k)}" data-v="${v}" checked> ${esc(t(k))} <small>${money(v)}</small></label>`).join('')}
      <div class="kv"><span>${t('Credited value of what is sold')}</span><b id="ssc">${money(total)}</b></div>
      <label>${t('Amount received')}<input name="amt" type="number" step="any" min="0" inputmode="decimal" required></label>
      <label>${t('Received by')}</label>${payPicker('smode', 'cash')}
      <div class="two"><label>${t('Date')}<input name="date" type="date" value="${today()}"></label><label>${t('Note (optional)')}<input name="note"></label></div>
      <div id="ssg" class="small"></div>
      <button class="btn primary" type="submit">${t('Save scrap sale')}</button></form>` : ''}
    <h3>${t('Scrap sales')}</h3><ul class="list">${sales.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 20).map((x) => `<li class="row"><div><b>${fmtDate(x.date)}</b><small>${esc((x.items || []).map((i) => t(i.type)).join(', '))} · ${t('credited')} ${money(x.credited)}</small></div>
      <div class="amt">${money(x.received)}<small class="${x.received - x.credited >= 0 ? '' : 'neg'}">${x.received - x.credited >= 0 ? '+' : '−'}${money(Math.abs(x.received - x.credited))}</small></div></li>`).join('') || `<li class="muted">${t('None yet')}</li>`}</ul>
    <h3>${t('Scrap taken from customers')}</h3><ul class="list">${ins.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30).map((x) => `<li class="row"><div><b>${esc(x.customerName || '')}</b><small>${fmtDate(x.date)} · ${esc(sellerName(x.sellerKey))} · ${esc((x.items || []).map((i) => `${t(i.type)} ${money(i.value)}`).join(', '))}</small></div><div class="amt">${money(x.total)}</div></li>`).join('') || `<li class="muted">${t('None yet')}</li>`}</ul>`;
  const f = $('#ssf');
  if (!f) return;
  const credited = () => L.round2($$('[name=ty]:checked', f).reduce((s2, c) => s2 + Number(c.dataset.v), 0));
  const upd = () => { $('#ssc').textContent = money(credited()); const g = L.round2(num(f.amt.value) - credited()); $('#ssg').textContent = f.amt.value ? `${g >= 0 ? t('Gain') : t('Loss')}: ${money(Math.abs(g))}` : ''; };
  $$('[name=ty]', f).forEach((c) => (c.onchange = upd)); f.amt.oninput = upd;
  f.onsubmit = (e) => {
    e.preventDefault();
    const items = $$('[name=ty]:checked', f).map((c) => ({ type: c.value, value: Number(c.dataset.v) }));
    if (!items.length) return toast(t('Choose what was sold'), true);
    const col = F.collection(F.db, 'scrapSales'), b = F.writeBatch(F.db);
    b.set(F.doc(col, F.newId(col)), { date: f.date.value || today(), items, credited: credited(), received: L.round2(num(f.amt.value)), mode: pickedMode('smode', f), note: f.note.value.trim(), createdAt: Date.now(), by: S.user.uid });
    F.commit(b, onWriteError); toast(t('Saved')); setTimeout(renderScrap, 300);
  };
}

// ---------- orders ----------
const orderText = (o) => o.items.map((i) => `${i.name} × ${i.qty}`).join(', ');
// "To buy": an order item goes there only when its seller taps 🛒. The shared demand/<orderId> doc keeps, per item,
// how many are still to buy (toBuy). The admin (or that seller) marks items bought; the order itself stays in To carry.
/** Demand doc for a pending order; toBuy per item comes from `want` (index -> count) or else the previous doc. */
function demandDoc(sid, o, prev, want = null) {
  const items = o.items.map((i, k) => {
    const old = prev?.items?.[k], same = old && String(old.name).trim().toLowerCase() === String(i.name).trim().toLowerCase();
    const tb = want ? want[k] : same ? Number(old.toBuy) || 0 : 0;
    return { name: i.name, qty: i.qty, toBuy: Math.max(0, Math.min(Number(i.qty) || 0, Math.round(tb || 0))) };
  });
  return { sellerKey: sid, items, deliveryDate: o.deliveryDate, updatedAt: Date.now() };
}
const toBuyOf = (dm, k) => Number(dm?.items?.[k]?.toBuy) || 0;
const orderLineHtml = (i = {}) => `<div class="orderline"><label class="obuy" title="${t('Needs buying')}"><input type="checkbox" name="ob" ${i.toBuy > 0 ? 'checked' : ''}><span>🛒</span></label><input name="on" list="snames" placeholder="${t('Item')}" value="${esc(i.name || '')}">
  <input name="oq" type="number" min="1" inputmode="numeric" value="${i.qty || 1}"><button type="button" class="x" data-orm>×</button></div>`;

/** Warnings (never blocks) before giving goods to a customer: low score, flags, other sellers, a low starting score note. */
function riskWarnings(c) {
  const warns = [];
  if (c.score?.band === 'risk') warns.push(`${t('Score')} ${c.score.score} — ${c.score.prior && c.score.prior.real == null ? t('starting score set by the seller') : t('this customer is behind on payments')}`);
  if (c.prior && c.prior.score < 60 && c.prior.note && (c.score?.prior?.w ?? 0) < 1) warns.push(`🤝 ${esc(c.prior.note)}`);
  if (c.ban) warns.push(`🚫 ${esc(c.ban.byName || '')}: ${esc(c.ban.reason)}`);
  othersOf(c).forEach((x) => { if (x.ban) warns.push(`🚫 ${esc(x.name)}: ${esc(x.ban)}`); else if (x.score != null && x.score < 60) warns.push(`${esc(x.name)} — ${t('Score')} ${x.score}`); });
  return warns;
}

async function renderOrderForm(cid, oid) {
  if (needSeller()) return;
  const sid = S.sid;
  let o = null;
  if (oid) { const d = await F.getDoc(F.sellerDoc(sid, 'orders', oid)); if (!d.exists()) return go('#/orders'); o = { id: oid, ...d.data() }; cid = o.customerId; }
  const c = S.customers[cid];
  if (!c) return go('#/customers');
  setTitle(`${o ? t('Order') : t('New order')} · ${c.name}`, true);
  const def = o?.deliveryDate || L.nextRouteDate(daysOf(c), today());
  let prevDm = null;
  if (o) { const dd = await F.getDoc(F.doc(F.db, 'demand', o.id)).catch(() => null); prevDm = dd?.exists() ? dd.data() : null; o.items = o.items.map((i, k) => ({ ...i, toBuy: toBuyOf(prevDm, k) })); }
  // Warn (never block) before taking an order from a risky or flagged customer.
  const warns = riskWarnings(c);
  view.innerHTML = `${warns.length ? `<div class="banner warn"><b>⚠ ${t('Check before delivering')}</b>${warns.map((w) => `<div class="small">${w}</div>`).join('')}</div>` : ''}
    <div class="row" style="padding:4px 2px">${scoreBadges(c)}</div>
    <form id="of" class="card form">
    ${o && o.status !== 'pending' ? `<div class="banner warn">${o.status === 'delivered' ? '✓ ' + t('Delivered') + ' ' + fmtDate(o.deliveredOn) : t('Cancelled')}</div>` : ''}
    <label>${t('Items')}</label><div id="olines">${(o?.items || [{}]).map(orderLineHtml).join('')}</div>
    <datalist id="snames">${knownNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <button type="button" class="btn ghost small" id="addO">+ ${t('Another item')}</button>
    <label>${t('Deliver on')} <small class="muted">(${t('next route day')})</small><input name="dd" type="date" value="${def}" required></label>
    <label>${t('Note (optional)')}<input name="note" value="${esc(o?.note || '')}"></label>
    <p class="muted small">🛒 = ${t('not in hand, needs buying: the item also shows in To buy.')} ${t('No advance is taken on an order. When you deliver, the sale is entered as usual.')}</p>
    <button class="btn primary" type="submit">${t('Save order')}</button>
    ${o && o.status === 'pending' ? `<div class="contact"><a class="btn" href="#/deliver/${o.id}">✓ ${t('Delivered')}</a><button type="button" class="btn" id="nw">+7 ${t('Next week')}</button><button type="button" class="btn danger" id="ocx">${t('Cancel order')}</button></div>` : ''}</form>`;
  const f = $('#of');
  const bind = () => { $$('[data-orm]', f).forEach((b) => (b.onclick = () => { if ($$('.orderline', f).length > 1) b.parentElement.remove(); })); };
  $('#addO').onclick = () => { $('#olines').insertAdjacentHTML('beforeend', orderLineHtml()); bind(); };
  bind();
  const save = (patch, want = null) => {
    const b = F.writeBatch(F.db), id = o?.id || F.newId(F.sellerCol(sid, 'orders'));
    const doc = { ...(o || { customerId: cid, customerName: c.name, status: 'pending', createdAt: Date.now(), by: S.user.uid }), ...patch };
    delete doc.id;
    doc.items = doc.items.map(({ name, qty }) => ({ name, qty }));
    b.set(F.sellerDoc(sid, 'orders', id), doc);
    if (doc.status === 'pending') b.set(F.doc(F.db, 'demand', id), demandDoc(sid, doc, prevDm, want));
    else b.delete(F.doc(F.db, 'demand', id));
    F.commit(b, onWriteError);
    return id;
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const lines = $$('.orderline', f).map((r) => ({ name: $('[name=on]', r).value.trim(), qty: Math.max(1, Math.round(num($('[name=oq]', r).value))), buy: $('[name=ob]', r).checked })).filter((i) => i.name);
    if (!lines.length) return toast(t('Add at least one item'), true);
    // 🛒 on: keep what is still to buy for an unchanged item (part may be bought already), else the whole quantity
    const want = lines.map((i) => { if (!i.buy) return 0; const old = o?.items?.find((x) => x.name.trim().toLowerCase() === i.name.toLowerCase() && x.toBuy > 0); return old ? Math.min(old.toBuy, i.qty) : i.qty; });
    save({ items: lines.map(({ name, qty }) => ({ name, qty })), deliveryDate: f.dd.value, note: f.note.value.trim(), customerName: c.name }, want);
    let back = ''; try { back = sessionStorage.getItem('orderBack') || ''; sessionStorage.removeItem('orderBack'); } catch {}
    toast(t('Order saved')); go(back || `#/customer/${cid}`);
  };
  const nw = $('#nw'), cx = $('#ocx');
  if (nw) nw.onclick = () => { save({ deliveryDate: L.addDays(o.deliveryDate, 7) }); toast(t('Moved to') + ' ' + fmtDate(L.addDays(o.deliveryDate, 7))); history.back(); };
  if (cx) cx.onclick = () => { if (!confirm(t('Cancel this order?'))) return; save({ status: 'cancelled', cancelledOn: today() }); toast(t('Order cancelled')); history.back(); };
}

async function renderDeliver(oid) {
  if (needSeller()) return;
  const sid = S.sid, d = await F.getDoc(F.sellerDoc(sid, 'orders', oid));
  if (!d.exists()) return go('#/orders');
  const o = { id: oid, ...d.data() }, c = S.customers[o.customerId];
  if (!c) return go('#/orders');
  try { sessionStorage.setItem('saleOrder', JSON.stringify(o)); } catch {}
  const open = accountsOf(c.id).filter((a) => a.status !== 'closed');
  if (open.length === 1) return go(`#/sale/${c.id}/${open[0].id}`);
  setTitle(`${t('Deliver')} · ${c.name}`, true);
  view.innerHTML = `<div class="card"><b>🚚 ${esc(orderText(o))}</b><small>${t('Which account should this sale go into?')}</small></div>
    <ul class="list">${open.map((a) => `<li><a class="row" href="#/sale/${c.id}/${a.id}"><div><b>${esc(a.name)}</b><small>${freqLabel(a.frequency)}</small></div><div class="amt">${money(a.balance)}</div></a></li>`).join('')}</ul>
    <form id="naf" class="card form">${accountRowHtml(1, { name: o.items[0]?.name || '' })}<button class="btn primary" type="submit">${t('New account and sale')}</button></form>`;
  bindAccountRows($('#naf'));
  $('#naf').onsubmit = (e) => {
    e.preventDefault();
    const row = e.target, acol = F.sellerCol(sid, 'accounts'), aid = F.newId(acol), b = F.writeBatch(F.db);
    const doc = newAccountDoc(c.id, $('[name=an]', row).value.trim() || 'Account', $('[name=af]', row).value, num($('[name=ao]', row).value), accRowLastPaid(row));
    b.set(F.doc(acol, aid), doc); F.commit(b, onWriteError);
    S.accounts[aid] = { id: aid, ...doc };
    go(`#/sale/${c.id}/${aid}`);
  };
}

const noteLine = (o) => (o.note ? `<div class="onote">📝 ${esc(o.note)}</div>` : '');
async function renderOrders() {
  setTitle(t('Orders'));
  let tab = (() => { try { return sessionStorage.getItem('ordTab') || 'carry'; } catch { return 'carry'; } })();
  if (!S.sid) tab = 'buy';
  let day = today();
  const draw = async () => {
    try { sessionStorage.setItem('ordTab', tab); } catch {}
    const tabs = `${sellerBar()}${S.sid ? `<a class="btn primary block" id="newOrd" href="#/pick/order" style="margin-bottom:8px">+ ${t('New order')}</a>` : ''}<div class="tabs">${S.sid ? `<button data-ot="carry" class="${tab === 'carry' ? 'on' : ''}">${t('To carry')}</button>` : ''}
      <button data-ot="buy" class="${tab === 'buy' ? 'on' : ''}">${t('To buy')}</button>${S.sid ? `<button data-ot="all" class="${tab === 'all' ? 'on' : ''}">${t('All pending')}</button>` : ''}</div>`;
    view.innerHTML = tabs + '<div class="loading">…</div>';
    let body = '';
    let dms = {};
    if (tab === 'buy') {
      const demand = await F.fetchAll(F.collection(F.db, 'demand'));
      dms = Object.fromEntries(demand.map((d) => [d.id, d]));
      // per seller (names are spelt differently by each seller), same item name added up inside a seller
      const groups = {};
      for (const d of demand) (d.items || []).forEach((i, k) => {
        if (!(Number(i.toBuy) > 0)) return;
        const g = (groups[d.sellerKey] ||= {}), key = String(i.name).trim().toLowerCase();
        const r = (g[key] ||= { name: String(i.name).trim(), qty: 0, first: d.deliveryDate, refs: [] });
        r.qty += Number(i.toBuy); if (d.deliveryDate < r.first) r.first = d.deliveryDate; r.refs.push([d.id, k]);
      });
      const keys = Object.keys(groups).sort((x, y) => (x === S.sid ? -1 : y === S.sid ? 1 : sellerName(x).localeCompare(sellerName(y))));
      S._buy = groups;
      body = `<p class="muted small">${t('Only items marked 🛒 in an order. Customer names are not shown here.')}</p>
        ${keys.map((k) => `<h3>${esc(sellerName(k))}</h3><ul class="list">${Object.entries(groups[k]).sort((x, y) => (x[1].first < y[1].first ? -1 : 1)).map(([key, r]) =>
          `<li class="card buyrow"><div><b>${esc(r.name)}</b> <b class="bq">× ${r.qty}</b><small>${t('first needed')} ${fmtDate(r.first)}</small></div>
            ${k === S.sid || isAdmin() ? `<button class="btn small primary" data-bought="${esc(k)}|${esc(key)}">✓ ${t('Bought')}</button>` : ''}</li>`).join('')}</ul>`).join('')
          || `<div class="empty">${t('Nothing to buy. Tap 🛒 on an order item in To carry when it has to be bought.')}</div>`}`;
    } else {
      const [all, mine] = await Promise.all([F.fetchAll(F.query(F.sellerCol(S.sid, 'orders'), F.where('status', '==', 'pending'))),
        F.fetchAll(F.query(F.collection(F.db, 'demand'), F.where('sellerKey', '==', S.sid)))]);
      all.sort((a, b) => (a.deliveryDate < b.deliveryDate ? -1 : 1));
      dms = Object.fromEntries(mine.map((d) => [d.id, d]));
      const chips = (o) => `<div class="ichips">${o.items.map((i, k) => { const tb = toBuyOf(dms[o.id], k);
        return `<button class="ichip ${tb ? 'buy' : ''}" data-tb="${o.id}|${k}" title="${t('Needs buying')}">${tb ? '🛒 ' : ''}${esc(i.name)} × ${i.qty}${tb && tb < i.qty ? ` <small>(${tb} ${t('to buy')})</small>` : ''}</button>`; }).join('')}</div>`;
      if (tab === 'carry') {
        const wd = L.weekdayOf(day), list = all.filter((o) => o.deliveryDate <= day);
        const pos = new Map(L.routeSort(Object.values(S.customers), wd).map((c, i) => [c.id, i]));
        list.sort((a, b) => (pos.get(a.customerId) ?? 1e9) - (pos.get(b.customerId) ?? 1e9));
        const agg = {}; list.forEach((o) => o.items.forEach((i, k) => { const n = i.name.trim(), x = (agg[n] ||= { ready: 0, buy: 0 }), tb = toBuyOf(dms[o.id], k); x.buy += tb; x.ready += Math.max(0, Number(i.qty || 0) - tb); }));
        body = `<div class="toolbar"><input type="date" id="od" value="${day}"></div>
          <div class="card"><b>📦 ${t('Load these items')}</b>${Object.entries(agg).map(([n, q]) => `<div class="kv"><span>${esc(n)}</span><span>${q.ready ? `<b>× ${q.ready}</b>` : ''}${q.buy ? ` <span class="pill bad">🛒 ${q.buy} ${t('still to buy')}</span>` : ''}</span></div>`).join('') || `<div class="muted small">${t('No deliveries for this day')}</div>`}</div>
          <p class="muted small">${t('Tap an item to send it to To buy (🛒); tap again to take it back.')}</p>
          <ul class="list">${list.map((o) => { const c = S.customers[o.customerId]; return `<li class="card ordcard"><a class="row" href="#/order-edit/${o.id}"><div>${placeBadge(c)}<b>${esc(o.customerName)}</b>${noteLine(o)}</div>
            <span class="pill ${o.deliveryDate < day ? 'bad' : 'ok'}">${o.deliveryDate < day ? t('Late') + ' ' + shortDate(o.deliveryDate) : shortDate(o.deliveryDate)}</span></a>${chips(o)}</li>`; }).join('')}</ul>`;
      } else {
        body = `<ul class="list">${all.map((o) => `<li class="card"><div class="row" style="padding:0"><div><b>${esc(o.customerName)}</b>${noteLine(o)}</div><span class="pill ${o.deliveryDate < today() ? 'bad' : ''}">${fmtDate(o.deliveryDate)}</span></div>${chips(o)}
          <div class="contact"><a class="btn small" href="#/deliver/${o.id}">✓ ${t('Delivered')}</a><input type="date" data-od="${o.id}" value="${o.deliveryDate}" style="flex:1;margin:0"><button class="btn small" data-nw="${o.id}">+7</button><button class="btn small danger" style="width:auto" data-ocx="${o.id}">×</button></div></li>`).join('') || `<li class="muted">${t('No pending orders')}</li>`}</ul>`;
      }
      S._orders = all;
    }
    view.innerHTML = tabs + body;
    bindSellerBar();
    $$('[data-ot]').forEach((b) => (b.onclick = () => { tab = b.dataset.ot; draw(); }));
    const od = $('#od'); if (od) od.onchange = () => { day = od.value || today(); draw(); };
    const upd = (id, patch) => {
      const o = S._orders.find((x) => x.id === id), b = F.writeBatch(F.db);
      b.update(F.sellerDoc(S.sid, 'orders', id), patch);
      if (patch.status === 'cancelled') b.delete(F.doc(F.db, 'demand', id)); else b.set(F.doc(F.db, 'demand', id), demandDoc(S.sid, { ...o, ...patch }, dms[id]));
      F.commit(b, onWriteError); setTimeout(draw, 250);
    };
    $$('[data-od]').forEach((i) => (i.onchange = () => i.value && upd(i.dataset.od, { deliveryDate: i.value })));
    $$('[data-nw]').forEach((b) => (b.onclick = () => { const o = S._orders.find((x) => x.id === b.dataset.nw); upd(o.id, { deliveryDate: L.addDays(o.deliveryDate, 7) }); }));
    $$('[data-ocx]').forEach((b) => (b.onclick = () => { if (confirm(t('Cancel this order?'))) upd(b.dataset.ocx, { status: 'cancelled', cancelledOn: today() }); }));
    // 🛒 on one item of an order: all of it to buy, or back to "in hand"
    $$('[data-tb]').forEach((btn) => (btn.onclick = () => {
      const [id, k] = btn.dataset.tb.split('|'), o = S._orders.find((x) => x.id === id); if (!o) return;
      const want = o.items.map((_, j) => toBuyOf(dms[id], j)); want[k] = want[k] > 0 ? 0 : Number(o.items[k].qty) || 1;
      const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'demand', id), demandDoc(S.sid, o, dms[id], want)); F.commit(b, onWriteError);
      toast(want[k] ? `🛒 ${o.items[k].name} → ${t('To buy')}` : `${o.items[k].name}: ${t('in hand')}`); setTimeout(draw, 250);
    }));
    // ✓ Bought (admin, or the seller for their own items): how many, then earliest delivery first; the rest stays in To buy
    $$('[data-bought]').forEach((btn) => (btn.onclick = async () => {
      const [k, key] = btn.dataset.bought.split('|'), r = S._buy?.[k]?.[key]; if (!r) return;
      let n = r.qty;
      if (r.qty > 1) { n = await askNumber(`${r.name}: ${t('how many did you buy?')}`, r.qty, r.qty); if (n == null) return; }
      const refs = r.refs.slice().sort((x, y) => (dms[x[0]].deliveryDate < dms[y[0]].deliveryDate ? -1 : 1)), touched = {};
      for (const [id, j] of refs) {
        if (n <= 0) break;
        const d = (touched[id] ||= structuredClone(dms[id])), take = Math.min(n, Number(d.items[j].toBuy) || 0);
        d.items[j].toBuy -= take; n -= take;
      }
      const b = F.writeBatch(F.db);
      for (const [id, d] of Object.entries(touched)) b.update(F.doc(F.db, 'demand', id), { items: d.items, updatedAt: Date.now(), boughtBy: S.user.uid });
      F.audit(b, S.user.uid, 'bought', `demand/${r.refs[0][0]}`, { item: r.name, seller: k, toBuy: r.qty }, { bought: r.qty - Math.max(0, n) });
      F.commit(b, onWriteError); toast(`✓ ${r.name}`); setTimeout(draw, 250);
    }));
  };
  await draw();
}

// ---------- collections of a day: list, edit, delete ----------
const KIND_LABEL = { collection: 'Collection', advance: 'Advance', cash: 'Cash sale', refund: 'Refund', discount: 'Discount' };
/** Remove a collection or discount from its account (balance and open items put back). */
function removeCollection(b, sid, col) {
  b.delete(F.sellerDoc(sid, 'collections', col.id));
  if (col.kind === 'collection' && col.accountId) setTimeout(() => refreshLastPaid(sid, col.accountId), 600);
  if (col.mode === 'scrap') b.delete(F.doc(F.db, 'scrapIn', col.id));
  else if (col.kind !== 'discount' && col.customerId) b.update(F.sellerDoc(sid, 'customers', col.customerId), { [`modeCounts.${col.mode === 'upi' ? 'upi' : 'cash'}`]: F.increment(-1) });
  const a = S.accounts[col.accountId];
  if (a) { const q = L.reverseAllocations(a.queue || [], col.allocations); b.update(F.sellerDoc(sid, 'accounts', a.id), { queue: q, balance: F.increment(col.amount) }); a.queue = q; a.balance = L.round2(a.balance + col.amount); }
  if (col.kind === 'advance' && col.saleId) b.update(F.sellerDoc(sid, 'sales', col.saleId), { advance: F.increment(-col.amount) });
}
async function closedReminder(sid, dates) {
  for (const d of new Set(dates)) {
    const x = await F.getDoc(F.sellerDoc(sid, 'dayClose', d)).catch(() => null);
    if (x?.exists()) { toast(`${fmtDate(d)}: ${t('day already closed — open Close today and send again')}`); return; }
  }
}
/**
 * Edit one collection. patch: {amount?, mode?, date?, note?}. A new amount puts the old one back on the account's
 * open items and allocates the new one (an advance goes to its own sale first); the balance moves by the difference.
 */
function editCollection(sid, col, patch) {
  const b = F.writeBatch(F.db), upd = {}, a = S.accounts[col.accountId];
  const amt = patch.amount != null ? L.round2(patch.amount) : col.amount;
  if (col.kind !== 'cash' && amt !== col.amount) {
    if (amt <= 0) { removeCollection(b, sid, col); F.audit(b, S.user.uid, 'collection-delete', `sellers/${sid}/collections/${col.id}`, col, null); F.commit(b, onWriteError); return 'deleted'; }
    if (!a) { toast(t('Account not found'), true); return false; }
    const r = L.allocate(L.reverseAllocations(a.queue || [], col.allocations), amt, col.kind === 'advance' ? col.saleId : null);
    Object.assign(upd, { amount: amt, allocations: r.allocations, profit: r.profit });
    b.update(F.sellerDoc(sid, 'accounts', a.id), { queue: r.queue, balance: F.increment(L.round2(col.amount - amt)) });
    a.queue = r.queue; a.balance = L.round2(a.balance + col.amount - amt);
    if (col.kind === 'advance' && col.saleId) b.update(F.sellerDoc(sid, 'sales', col.saleId), { advance: F.increment(L.round2(amt - col.amount)) });
  }
  if (patch.mode && patch.mode !== col.mode && col.mode !== 'scrap') {
    upd.mode = patch.mode;
    if (col.customerId) b.update(F.sellerDoc(sid, 'customers', col.customerId), { [`modeCounts.${col.mode === 'upi' ? 'upi' : 'cash'}`]: F.increment(-1), [`modeCounts.${patch.mode}`]: F.increment(1) });
  }
  const newMode = upd.mode || col.mode;
  if (newMode === 'upi') { const v = patch.upiTo || col.upiTo || upiDefault()?.vpa || ''; if (v && v !== col.upiTo) upd.upiTo = v; }
  else if (col.upiTo) upd.upiTo = F.deleteField();
  if (col.kind === 'collection' && patch.date && patch.date !== col.date) upd.date = patch.date;
  if (col.kind === 'collection' && patch.note != null && patch.note !== (col.note || '')) upd.note = patch.note;
  if (!Object.keys(upd).length) return false;
  b.update(F.sellerDoc(sid, 'collections', col.id), upd);
  F.audit(b, S.user.uid, 'collection-edit', `sellers/${sid}/collections/${col.id}`, { amount: col.amount, mode: col.mode, upiTo: col.upiTo || '', date: col.date, note: col.note || '' }, { ...upd, ...(upd.upiTo !== undefined && typeof upd.upiTo !== 'string' ? { upiTo: '' } : {}) });
  F.commit(b, onWriteError);
  if (upd.date && col.accountId) setTimeout(() => refreshLastPaid(sid, col.accountId), 600);
  return 'saved';
}

async function renderCollections() {
  setTitle(t('Collections'), '#/home');
  if (needSeller()) return;
  const sid = S.sid;
  let day = (() => { try { return sessionStorage.getItem('colDay') || today(); } catch { return today(); } })();
  let open = null;
  const draw = async () => {
    try { sessionStorage.setItem('colDay', day); } catch {}
    const cols = (await F.fetchAll(F.query(F.sellerCol(sid, 'collections'), F.where('date', '==', day)))).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const fig = L.sellerReport({ collections: cols });
    const pays = cols.filter((c) => c.kind !== 'discount'), discs = cols.filter((c) => c.kind === 'discount');
    const people = new Set(pays.filter((c) => c.kind !== 'refund').map((c) => c.customerId || 'cash:' + c.saleId)).size;
    const time = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '');
    const who = (c) => (c.cash ? `🛒 ${esc(c.buyerName || t('Walk-in buyer'))}` : esc(S.customers[c.customerId]?.name || '?'));
    const link = (c) => (c.cash ? '#/cash-sales' : `#/account/${c.customerId}/${c.accountId}`);
    const row = (c) => {
      const editable = c.kind === 'collection' || c.kind === 'advance' || (c.kind === 'cash' && c.mode !== 'scrap');
      const canDel = c.kind === 'collection' || c.kind === 'discount';
      return `<li class="card colrow"><div class="row" style="padding:0">
        <a href="${link(c)}" style="flex:1;text-decoration:none;color:inherit"><b>${who(c)}</b>
          <small>${time(c.createdAt)} · ${esc(S.accounts[c.accountId]?.name || '')}${c.accountId ? ' · ' : ''}${t(KIND_LABEL[c.kind] || 'Collection')}${c.kind === 'discount' ? '' : ' · ' + modeLabel(c.mode)}${c.mode === 'upi' && c.upiTo && upiIds().length > 1 ? ' → ' + esc(upiToLabel(c.upiTo)) : ''}${c.note ? ' · ' + esc(c.note) : ''}</small></a>
        <div class="amt">${money(c.amount)}</div></div>
        ${editable || canDel ? `<div class="contact">${editable ? `<button class="btn small" data-ed="${c.id}">✏️ ${t('Edit')}</button>` : ''}${canDel ? `<button class="btn small danger" style="width:auto" data-cdel="${c.id}">× ${t('Delete')}</button>` : ''}</div>` : ''}
        ${open === c.id ? `<form class="form edbox" data-edf="${c.id}">
          ${c.kind !== 'cash' ? `<label>${t('Amount')}<input name="amt" type="number" step="any" min="0" inputmode="decimal" value="${c.amount}"></label>` : ''}
          ${c.mode !== 'scrap' ? `<label>${t('Paid by')}</label>${payPicker('em_' + c.id, c.mode)}${upiPickHtml('eu_' + c.id, c.upiTo)}` : `<div class="small muted">${t('Scrap: delete and enter again to change it.')}</div>`}
          ${c.kind === 'collection' ? `<div class="two"><label>${t('Date')}<input name="date" type="date" value="${c.date}" max="${today()}"></label><label>${t('Note')}<input name="note" value="${esc(c.note || '')}"></label></div>` : ''}
          ${c.kind === 'advance' ? `<div class="small muted">${t('Advance of a sale: 0 removes it.')}</div>` : c.kind === 'cash' ? `<div class="small muted">${t('Cash sale: only Cash / UPI can change here. For a wrong amount the admin voids it in Cash sales.')}</div>` : ''}
          <div class="contact"><button class="btn primary" type="submit">${t('Save')}</button><button class="btn" type="button" data-edx>${t('Cancel')}</button></div></form>` : ''}</li>`;
    };
    view.innerHTML = sellerBar() + `
      <div class="toolbar"><input type="date" id="cdate" value="${day}" max="${today()}"></div>
      <div class="card"><div class="kv"><span>${t('Collected')} · ${people} ${t('people')}</span><b>${money(fig.collected)}</b></div>
        <div class="small muted">${splitLine(fig.collectedCash, fig.collectedUpi, fig.collectedScrap)}</div></div>
      <ul class="list">${pays.map(row).join('') || `<li class="muted">${t('No collections on this day')}</li>`}</ul>
      ${discs.length ? `<h3>💸 ${t('Discounts')}</h3><ul class="list">${discs.map(row).join('')}</ul>` : ''}`;
    bindSellerBar();
    $('#cdate').onchange = (e) => { day = e.target.value || today(); open = null; draw(); };
    const find = (id) => cols.find((x) => x.id === id);
    $$('[data-ed]').forEach((b) => (b.onclick = () => { open = open === b.dataset.ed ? null : b.dataset.ed; draw(); }));
    $$('[data-edx]').forEach((b) => (b.onclick = () => { open = null; draw(); }));
    $$('[data-cdel]').forEach((b) => (b.onclick = () => {
      const c = find(b.dataset.cdel);
      if (!c || !confirm(`${t('Delete this entry?')}\n${S.customers[c.customerId]?.name || ''} · ${money(c.amount)}`)) return;
      const bt = F.writeBatch(F.db); removeCollection(bt, sid, c);
      F.audit(bt, S.user.uid, c.kind === 'discount' ? 'discount-delete' : 'collection-delete', `sellers/${sid}/collections/${c.id}`, c, null);
      F.commit(bt, onWriteError); toast(t('Deleted')); if (c.customerId) rescoreSoon(c.customerId); closedReminder(sid, [c.date]); setTimeout(draw, 300);
    }));
    $$('[data-edf]').forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault();
      const c = find(f.dataset.edf), patch = {};
      if (f.amt) { const v = Number(String(f.amt.value).replace(/,/g, '')); if (!Number.isFinite(v) || v < 0) return toast(t('Enter a valid amount'), true); patch.amount = v; }
      if (c.mode !== 'scrap') { patch.mode = pickedMode('em_' + c.id, f); if (patch.mode === 'upi') patch.upiTo = pickedUpi('eu_' + c.id, f); }
      if (f.date) patch.date = f.date.value || c.date;
      if (f.note) patch.note = f.note.value.trim();
      if (patch.amount === 0 && c.kind === 'collection' && !confirm(t('Amount 0 deletes this collection. Continue?'))) return;
      const res = editCollection(sid, c, patch);
      if (!res) { open = null; return draw(); }
      toast(res === 'deleted' ? t('Deleted') : t('Saved')); open = null;
      if (c.customerId) rescoreSoon(c.customerId); closedReminder(sid, [c.date, patch.date || c.date]); setTimeout(draw, 300);
    }));
  };
  await draw();
}

// ---------- UPI QR (each seller's own UPI IDs; payments go straight to that seller) ----------
// Kept in the seller's book: sellers/<key>/meta/upi {ids: [{label, vpa, name}], def, vpa, name}.
// vpa/name mirror the default ID (older versions stored only those). The QR is made on the phone (works offline).
// The app cannot see whether the money arrived: the seller checks their UPI app, then saves the collection.
const VPA_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;
const upiIds = () => {
  const u = S.upi || {};
  if (Array.isArray(u.ids) && u.ids.length) return u.ids.filter((x) => x && x.vpa);
  return u.vpa ? [{ label: '', vpa: u.vpa, name: u.name || '' }] : [];
};
const upiDefIdx = () => { const n = upiIds().length, d = Number(S.upi?.def) || 0; return d >= 0 && d < n ? d : 0; };
const upiDefault = () => upiIds()[upiDefIdx()] || null;
const upiByVpa = (vpa) => upiIds().find((x) => x.vpa === vpa) || null;
const upiLabel = (u) => (u ? u.label || u.vpa : '');
/** Name of a saved ID for a collection's upiTo (falls back to the ID itself if it was removed later). */
const upiToLabel = (vpa) => (vpa ? upiLabel(upiByVpa(vpa)) || vpa : '');
/** Fields to store on a collection paid by UPI: which of the seller's IDs the money went to. */
const upiTag = (mode, vpa) => { const v = vpa || upiDefault()?.vpa; return mode === 'upi' && v ? { upiTo: v } : {}; };
/** Picker for the receiving ID; empty when the seller has 0 or 1 IDs. */
const upiPickHtml = (name, sel) => {
  const ids = upiIds(); if (ids.length < 2) return '';
  const cur = upiByVpa(sel) ? sel : upiDefault().vpa;
  return `<div class="upipick"><span class="small muted">${t('To')}</span><div class="seg" role="radiogroup">${ids.map((u) =>
    `<label><input type="radio" name="${name}" value="${esc(u.vpa)}" ${u.vpa === cur ? 'checked' : ''}><span>${esc(upiLabel(u))}</span></label>`).join('')}</div></div>`;
};
const pickedUpi = (name, root = document) => root.querySelector(`input[name=${name}]:checked`)?.value || upiDefault()?.vpa || '';
function upiUri(u, amount, note) {
  const q = [`pa=${encodeURIComponent(u.vpa).replace(/%40/g, "@")}`, `pn=${encodeURIComponent(u.name || u.vpa)}`];
  if (amount > 0) q.push(`am=${(Math.round(amount * 100) / 100).toFixed(2)}`);
  q.push('cu=INR');
  if (note) q.push(`tn=${encodeURIComponent(String(note).slice(0, 50))}`);
  return `upi://pay?${q.join('&')}`;
}
function qrSvg(text) {
  /* global qrcode */
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
}
/** Full-screen QR card (always dark on white so every phone camera reads it).
 *  With 2+ IDs, chips on top switch the QR; onPick(vpa) tells the caller which one is showing. */
function showUpiQr(amount = 0, note = '', { pick = '', onPick = null } = {}) {
  const ids = upiIds();
  if (!ids.length) { if (confirm(t('Your UPI ID is not set yet. Set it now?'))) go('#/upi'); return; }
  let cur = upiByVpa(pick) || upiDefault();
  const ov = document.createElement('div');
  ov.className = 'qrov';
  const draw = () => {
    ov.innerHTML = `<div class="qrcard" role="dialog" aria-label="UPI QR">
      <div class="qrtop"><b>${esc(cur.name || '')}</b><button type="button" class="x" id="qrX" aria-label="${t('Close')}">×</button></div>
      ${ids.length > 1 ? `<div class="qrchips">${ids.map((u, i) => `<button type="button" class="qrchip ${u.vpa === cur.vpa ? 'on' : ''}" data-qi="${i}">${esc(upiLabel(u))}</button>`).join('')}</div>` : ''}
      ${amount > 0 ? `<div class="qramt">${money(amount)}</div>` : `<div class="qrhint">${t('Scan and enter the amount')}</div>`}
      <div class="qrimg">${qrSvg(upiUri(cur, amount, note))}</div>
      <div class="qrvpa">${esc(cur.vpa)}</div>
      <div class="qrlogos">GPay · PhonePe · Paytm · BHIM</div>
      <div class="qrnote">${t('After the money arrives in your UPI app, save the collection.')}</div></div>`;
    $('#qrX', ov).onclick = close;
    $$('[data-qi]', ov).forEach((b) => (b.onclick = () => { cur = ids[Number(b.dataset.qi)]; if (onPick) onPick(cur.vpa); draw(); }));
  };
  const close = () => ov.remove();
  document.body.appendChild(ov);
  draw();
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

/** "Show UPI QR" block for a form: box html + a refresh() that shows it when visible() and labels the amount. */
const upiQrBoxHtml = () => `<div id="upiBox" hidden>${upiPickHtml('upito')}<button type="button" class="btn upiqr" id="upiQrBtn">📲 ${t('Show UPI QR')}</button></div>`;
function bindUpiQr(root, { amount, note, visible }) {
  const box = $('#upiBox', root), btn = $('#upiQrBtn', root);
  const refresh = () => { const v = L.round2(amount() || 0); box.hidden = !visible(); btn.textContent = `📲 ${t('Show UPI QR')}${v > 0 ? ' · ' + money(v) : ''}`; };
  btn.onclick = () => showUpiQr(L.round2(amount() || 0), note(), {
    pick: pickedUpi('upito', root), onPick: (v) => { const r = root.querySelector(`input[name=upito][value="${CSS.escape(v)}"]`); if (r) r.checked = true; } });
  refresh();
  return refresh;
}

function renderUpiSetup() {
  setTitle(t('My UPI'), '#/menu');
  if (needSeller()) return;
  const sid = S.sid;
  let editing = null; // index being edited, -1 = new, null = form closed
  const save = (ids, def) => {
    const d = Math.min(Math.max(0, def), Math.max(0, ids.length - 1)), main = ids[d] || null;
    const doc = { ids, def: d, vpa: main?.vpa || '', name: main?.name || '', updatedAt: Date.now(), by: S.user.uid };
    const b = F.writeBatch(F.db);
    b.set(F.sellerDoc(sid, 'meta', 'upi'), doc);
    F.audit(b, S.user.uid, 'upi', `sellers/${sid}/meta/upi`, S.upi ? { ids: upiIds(), def: upiDefIdx() } : null, { ids, def: d });
    F.commit(b, onWriteError); S.upi = doc;
  };
  const draw = () => {
    const ids = upiIds(), def = upiDefIdx();
    const e = editing != null && editing >= 0 ? ids[editing] : null;
    const formHtml = editing == null ? '' : `<form id="uf" class="card form">
      <h3>${e ? t('Edit UPI ID') : t('Add a UPI ID')}</h3>
      <label>${t('Label')} <small class="muted">(${t('e.g. GPay, SBI')})</small><input name="lb" value="${esc(e?.label || '')}" maxlength="20"></label>
      <label>${t('UPI ID')}<input name="vpa" value="${esc(e?.vpa || '')}" placeholder="name@okaxis" autocapitalize="off" autocomplete="off" spellcheck="false" required></label>
      <label>${t('Name shown to the customer')}<input name="nm" value="${esc(e?.name || ids[def]?.name || S.profile?.name || '')}" required></label>
      <div class="contact"><button class="btn primary" type="submit">${t('Save')}</button><button class="btn" type="button" id="ufX">${t('Cancel')}</button></div></form>`;
    view.innerHTML = sellerBar() + `
      <p class="muted small">${t('Customers scan this QR to pay straight into your own UPI account. Find your UPI ID in GPay / PhonePe / Paytm (profile).')}</p>
      ${ids.length ? `<ul class="list">${ids.map((u, i) => `<li class="card"><div class="row" style="padding:0">
          <label class="star" title="${t('Default')}"><input type="radio" name="udef" value="${i}" ${i === def ? 'checked' : ''}><span>★</span></label>
          <div style="flex:1"><b>${esc(upiLabel(u))}</b><small>${esc(u.vpa)} · ${esc(u.name || '')}${i === def ? ' · ' + t('default') : ''}</small></div></div>
          <div class="contact"><button class="btn small" data-uq="${i}">📲 ${t('QR')}</button><button class="btn small" data-ue="${i}">✏️ ${t('Edit')}</button><button class="btn small danger" style="width:auto" data-ud="${i}">× ${t('Delete')}</button></div></li>`).join('')}</ul>`
        : `<p class="muted">${t('No UPI ID yet.')}</p>`}
      ${editing == null ? `<button class="btn primary" id="uAdd">+ ${t('Add a UPI ID')}</button>` : ''}
      ${formHtml}
      ${ids.length > 1 ? `<p class="muted small">${t('★ = shown first. You can switch to another ID on the QR screen.')}</p>` : ''}
      <p class="muted small">${t('Test once: scan it from another phone and send ₹1.')}</p>`;
    bindSellerBar();
    const add = $('#uAdd'); if (add) add.onclick = () => { editing = -1; draw(); $('#uf input[name=lb]')?.focus(); };
    $$('input[name=udef]').forEach((r) => (r.onchange = () => { save(upiIds(), Number(r.value)); toast(t('Saved')); draw(); }));
    $$('[data-uq]').forEach((b) => (b.onclick = () => showUpiQr(0, '', { pick: ids[Number(b.dataset.uq)].vpa })));
    $$('[data-ue]').forEach((b) => (b.onclick = () => { editing = Number(b.dataset.ue); draw(); }));
    $$('[data-ud]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.ud), u = ids[i];
      if (!confirm(`${t('Delete this UPI ID?')}\n${u.vpa}`)) return;
      const rest = ids.filter((_, k) => k !== i);
      save(rest, i === def ? 0 : def > i ? def - 1 : def); editing = null; toast(t('Deleted')); draw();
    }));
    const f = $('#uf');
    if (!f) return;
    $('#ufX').onclick = () => { editing = null; draw(); };
    f.onsubmit = (ev) => {
      ev.preventDefault();
      const vpa = f.vpa.value.trim().replace(/\s+/g, ''), name = f.nm.value.trim(), label = f.lb.value.trim();
      if (!VPA_RE.test(vpa)) return toast(t('That does not look like a UPI ID (example: name@okaxis)'), true);
      const list = upiIds().map((x) => ({ label: x.label || '', vpa: x.vpa, name: x.name || '' }));
      if (list.some((x, k) => k !== editing && x.vpa.toLowerCase() === vpa.toLowerCase())) return toast(t('This UPI ID is already added'), true);
      const item = { label, vpa, name };
      if (editing >= 0) list[editing] = item; else list.push(item);
      save(list, upiDefIdx()); editing = null; toast(t('Saved')); draw();
    };
  };
  draw();
}

// ---------- day-end closing ----------
async function renderCloseDay() {
  setTitle(t('Close today'), '#/home');
  if (needSeller()) return;
  const sid = S.sid;
  let day = today();
  const draw = async () => {
    view.innerHTML = sellerBar() + '<div class="loading">…</div>';
    const q = (n) => F.fetchAll(F.query(F.sellerCol(sid, n), F.where('date', '==', day)));
    const [cols, exps, visits, closedDoc] = await Promise.all([q('collections'), q('expenses'), q('visits'), F.getDoc(F.sellerDoc(sid, 'dayClose', day))]);
    const fig = L.sellerReport({ collections: cols, expenses: exps });
    const plan = L.dayPlan(day, S.routeChanges, ROUTE_DAYS), seen = new Set();
    const routeList = plan.days.flatMap((pd) => L.routeSort(Object.values(S.customers).filter((c) => daysOf(c).includes(pd.day) && !seen.has(c.id) && seen.add(c.id)), pd.day)).filter((c) => !pausedCust(c.id));
    const paid = new Set(cols.filter((c) => c.kind !== 'discount').map((c) => c.customerId)), vis = new Map(visits.map((v) => [v.customerId, v]));
    const nopay = [...vis.values()].filter((v) => !paid.has(v.customerId));
    const notSeen = routeList.filter((c) => !paid.has(c.id) && !vis.has(c.id));
    const visited = routeList.filter((c) => paid.has(c.id) || vis.has(c.id)).length;
    const name = (id) => S.customers[id]?.name || '?';
    const closed = closedDoc.exists() ? closedDoc.data() : null;
    const text = [`*${APP_NAME} — ${t('Day closing')}*`, `${S.profile.role === 'admin' ? sellerName(sid) : S.profile.name} · ${fmtDate(day)}`, '',
      `${t('Collected')}: *${money(fig.collected)}* (${cols.filter((x) => x.kind !== 'discount' && x.kind !== 'refund').length})`, `  ${t('Cash')} ${money(fig.collectedCash)} · UPI ${money(fig.collectedUpi)}${fig.collectedScrap ? ` · ${t('Scrap')} ${money(fig.collectedScrap)}` : ''}`,
      `${t('Expenses')}: ${money(fig.expense)} (${t('Cash')} ${money(fig.expenseCash)} · UPI ${money(fig.expenseUpi)})`, `*${t('Cash in hand')}: ${money(fig.cashInHand)}*`, '',
      routeList.length ? `${t('Route')}: ${visited}/${routeList.length} ${t('visited')}` : '',
      nopay.length ? `${t('No payment')}: ${nopay.map((v) => `${name(v.customerId)} (${reasonLabel(v.reason)}${v.promiseDate ? ' → ' + fmtDate(v.promiseDate) : ''})`).join(', ')}` : '',
      notSeen.length ? `${t('Not visited')}: ${notSeen.map((c) => c.name).join(', ')}` : ''].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').trim();
    view.innerHTML = sellerBar() + `
      <div class="toolbar"><input type="date" id="cdd" value="${day}" max="${today()}"></div>
      ${closed ? `<div class="banner">✓ ${t('Closed at')} ${new Date(closed.closedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      <div class="card">
        <div class="kv"><span>${t('Collected')} (${cols.filter((x) => x.kind !== 'discount' && x.kind !== 'refund').length})</span><b>${money(fig.collected)}</b></div>
        <div class="kv small"><span>— ${t('Cash')}</span><span>${money(fig.collectedCash)}</span></div>
        <div class="kv small"><span>— UPI</span><span>${money(fig.collectedUpi)}</span></div>
        ${fig.collectedScrap ? `<div class="kv small"><span>— ${t('Scrap')}</span><span>${money(fig.collectedScrap)}</span></div>` : ''}
        <div class="kv"><span>${t('Expenses')}</span><b>− ${money(fig.expense)}</b></div>
        <div class="kv small"><span>— ${t('Cash')}</span><span>${money(fig.expenseCash)}</span></div>
        <div class="kv small"><span>— UPI</span><span>${money(fig.expenseUpi)}</span></div>
        <div class="balance" style="margin-top:8px"><span>${t('Cash in hand')}</span><b>${money(fig.cashInHand)}</b></div></div>
      ${routeList.length ? `<div class="card"><b>🛵 ${t('Route')}: ${visited} / ${routeList.length} ${t('visited')}</b>
        ${nopay.length ? `<h3>⊘ ${t('No payment')}</h3>${nopay.map((v) => `<div class="kv"><span>${esc(name(v.customerId))}</span><span class="small">${esc(reasonLabel(v.reason))}${v.promiseDate ? ' → ' + fmtDate(v.promiseDate) : ''}</span></div>`).join('')}` : ''}
        ${notSeen.length ? `<h3>${t('Not visited')}</h3><div class="small">${notSeen.map((c) => esc(c.name)).join(', ')}</div>` : ''}</div>` : ''}
      <button class="btn primary" id="cdSend">📤 ${closed ? t('Send again to admin') : t('Close day and send to admin')}</button>
      ${S.settings.adminWa ? '' : `<p class="muted small">${t("Admin's WhatsApp number is not set (Admin → App settings), so WhatsApp will ask whom to send to.")}</p>`}`;
    bindSellerBar();
    $('#cdd').onchange = (e) => { day = e.target.value || today(); draw(); };
    $('#cdSend').onclick = () => {
      const b = F.writeBatch(F.db);
      b.set(F.sellerDoc(sid, 'dayClose', day), { date: day, figures: fig, routeTotal: routeList.length, visited, nopay: nopay.length, closedAt: Date.now(), by: S.user.uid });
      F.commit(b, onWriteError);
      const wa = S.settings.adminWa ? L.waNumber(S.settings.adminWa) : '';
      window.open(`https://wa.me/${wa}?text=${encodeURIComponent(text)}`, '_blank');
      setTimeout(draw, 400);
    };
  };
  await draw();
}


// ---------- calculator (Home, under the calendar) ----------
/** Evaluate "12×450+5%"-style input without eval: × ÷ before + −; "a + b%" adds b% of a, a lone "b%" is b/100. */
function calcEval(expr) {
  const tk = String(expr).match(/\d*\.?\d+%?|[+\-×÷]/g) || [];
  const val = (t, prefix, op) => { const p = t.endsWith('%'), n = parseFloat(t); if (!p) return n; return (op === '+' || op === '−' || op === '-') && prefix != null ? (prefix * n) / 100 : n / 100; };
  let sum = 0, sumOp = '+', term = null, termOp = null, lastAdd = null;
  const flush = () => { if (term == null) return; sum = sumOp === '+' ? sum + term : sum - term; term = null; };
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (/[+\-×÷]/.test(t) && t.length === 1) {
      if (t === '×' || t === '÷') termOp = t;
      else { flush(); sumOp = t === '+' ? '+' : '-'; lastAdd = sum; termOp = null; }
      continue;
    }
    const v = termOp ? parseFloat(t) / (t.endsWith('%') ? 100 : 1) : val(t, lastAdd, sumOp === '+' ? '+' : '-');
    if (term == null || !termOp) term = v; else term = termOp === '×' ? term * v : term / v;
    termOp = null;
  }
  flush();
  return Number.isFinite(sum) ? Math.round(sum * 100) / 100 : NaN;
}
function mountCalculator(el) {
  if (!el) return;
  let expr = '', hist = '', done = false;
  const keys = ['C', '⌫', '%', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '0', '.', '='];
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : t('Error'));
  const draw = () => {
    el.innerHTML = `<div class="calc"><div class="calc-h">${esc(hist)}</div><div class="calc-d">${esc(expr || '0')}</div>
      <div class="calc-k">${keys.map((k) => `<button type="button" class="ck ${/[÷×−+=]/.test(k) ? 'op' : ''} ${k === '0' ? 'z' : ''} ${k === 'C' || k === '⌫' ? 'fn' : ''}" data-k="${k}">${k}</button>`).join('')}</div></div>`;
    $$('[data-k]', el).forEach((b) => (b.onclick = () => press(b.dataset.k)));
  };
  const press = (k) => {
    const last = expr.slice(-1);
    if (done && (/\d/.test(k) || k === '.')) expr = ''; // a digit after = starts a new sum
    done = false;
    if (k === 'C') { expr = ''; hist = ''; }
    else if (k === '⌫') expr = expr.slice(0, -1);
    else if (k === '=') { if (!expr) return; const r0 = calcEval(expr.replace(/−/g, '-')), r = Math.abs(r0) < 1e15 ? r0 : NaN; hist = `${expr} =`; expr = Number.isFinite(r) ? String(r).replace('-', '−') : ''; if (!Number.isFinite(r)) hist += ` ${t('Error')}`; done = true; }
    else if (/[÷×−+]/.test(k)) { if (!expr && k !== '−') return; expr = /[÷×−+]/.test(last) ? expr.slice(0, -1) + k : expr + k; }
    else if (k === '%') { if (/\d/.test(last)) expr += '%'; }
    else if (k === '.') { const cur = expr.split(/[÷×−+]/).pop(); if (!cur.includes('.') && !cur.includes('%')) expr += cur ? '.' : '0.'; }
    else { if (last === '%') return; expr += k; }
    draw();
    const d = $('.calc-d', el); if (d && /[÷×−+%]/.test(expr) && !/[÷×−+]$/.test(expr)) { const r = calcEval(expr.replace(/−/g, '-')); if (Number.isFinite(r)) d.dataset.preview = '= ' + fmt(r); }
  };
  draw();
}

// ---------- shell ----------
function applyNav() {
  const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  $('#nav').innerHTML = [['#/home', 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z', 'Home'],
    ['#/customers', 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8', 'Customers'],
    ['#/orders', 'M1 3h13v12H1zM14 8h4l3 3v4h-7M5.5 18.5a2 2 0 1 0 0-.01M17.5 18.5a2 2 0 1 0 0-.01', 'Orders'], ['#/report', 'M4 20V10M10 20V4M16 20v-7M22 20H2', 'Reports'],
    ['#/menu', 'M4 6h16M4 12h16M4 18h16', 'Menu']]
    .map(([h, d, l]) => `<a href="${h}">${ic(d)}${t(l)}</a>`).join('');
  document.documentElement.lang = getLang();
}
applyNav();
window.addEventListener('online', () => document.body.classList.remove('offline'));
window.addEventListener('offline', () => document.body.classList.add('offline'));
if (!navigator.onLine) document.body.classList.add('offline');
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    // Check for a new version whenever the app comes back to the screen.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  // A new version took over: offer a one-tap reload instead of reloading in the middle of an entry.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || $('#updBar')) return;
    document.body.insertAdjacentHTML('beforeend', `<button id="updBar" class="updbar">${t('New version available — tap to update')}</button>`);
    $('#updBar').onclick = () => location.reload();
  });
}
