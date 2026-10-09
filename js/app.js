import * as F from './db.js';
import * as L from './logic.js';
import { t, getLang, setLang } from './i18n.js';
import { APP_NAME, ADMIN_USERNAME } from './config.js';
import { KERALA_HOLIDAYS } from './holidays.js';

// ---------- state ----------
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_CATEGORIES = ['Crockery', 'Furniture', 'Electronics', 'Carpet/Mat', 'Others'];
const DEFAULT_SCRAP_TYPES = ['Aluminium', 'Steel', 'Ottu', 'Copper', 'Others'];
const S = {
  user: null, profile: null, sid: null,
  users: {}, settings: { defaultMarginPct: 100, legacyMarginPct: 85, geminiKey: '', geminiModel: DEFAULT_MODEL },
  stock: {}, customers: {}, accounts: {}, complaints: {}, catalog: {}, events: {}, routeChanges: {}, nameMap: {}, phoneIdx: {}, meals: {},
  subs: [], sellerSubs: [], refresh: null,
};
const categories = () => (S.settings.categories?.length ? S.settings.categories : DEFAULT_CATEGORIES);
const scrapTypes = () => (S.settings.scrapTypes?.length ? S.settings.scrapTypes : DEFAULT_SCRAP_TYPES);
const catOf = (s) => (s?.category && categories().includes(s.category) ? s.category : 'Others');
/** Category of a sale line: follows renames; falls back to the stock item's category. */
const lineCat = (l) => {
  let c = l.category; const rn = S.settings.categoryRenames || {};
  for (let i = 0; i < 6 && c && rn[c]; i++) c = rn[c];
  return c && categories().includes(c) ? c : catOf(S.stock[l.stockId]);
};

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
  S.subs.forEach((u) => u()); S.subs = []; S.stockReady = S.catalogReady = false;
  S.subs.push(F.onSnapshot(F.doc(F.db, 'settings', 'main'), (d) => {
    if (d.exists()) Object.assign(S.settings, d.data());
    if (isAdmin() && !S.settings.movesV1) setTimeout(backfillMoves, 4000);
  }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'users'), (qs) => {
    S.users = {}; qs.forEach((d) => (S.users[d.id] = d.data()));
    if (isAdmin() && !S.sid) { const saved = localStorage.getItem('sid'); if (saved && sellers().some((x) => x.id === saved)) selectSeller(saved); }
    live();
  }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'stock'), (qs) => { S.stock = {}; qs.forEach((d) => (S.stock[d.id] = { id: d.id, ...d.data() })); S.stockReady = true; syncCatalogSoon(); live(); }));
  S.subs.push(F.onSnapshot(F.query(F.collection(F.db, 'complaints'), F.where('status', '==', 'open')), (qs) => {
    S.complaints = {}; qs.forEach((d) => (S.complaints[d.id] = { id: d.id, ...d.data() })); live();
  }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'catalog'), (qs) => { S.catalog = {}; qs.forEach((d) => (S.catalog[d.id] = { id: d.id, ...d.data() })); S.catalogReady = true; syncCatalogSoon(); }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'events'), (qs) => { S.events = {}; qs.forEach((d) => (S.events[d.id] = { id: d.id, ...d.data() })); live(); }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'nameMap'), (qs) => { S.nameMap = {}; qs.forEach((d) => (S.nameMap[d.id] = { id: d.id, ...d.data() })); }));
  S.subs.push(F.onSnapshot(F.collection(F.db, 'phoneIndex'), (qs) => {
    S.phoneIdx = {}; qs.forEach((d) => { const x = { id: d.id, ...d.data() }; (S.phoneIdx[x.hash] ||= []).push(x); }); live();
  }));
  if (!isAdmin()) subscribeMeals();
}

/**
 * Keep the public catalog's Available/Sold-out tag and price in step with stock.
 * Any logged-in phone does this after stock changes; it only writes when something differs.
 */
let syncTimer = null;
let mealsSub = null, mealsDay = '';
function subscribeMeals() {
  if (mealsDay === today() && mealsSub) return;
  if (mealsSub) mealsSub();
  mealsDay = today(); S.meals = {};
  mealsSub = F.onSnapshot(F.query(F.collection(F.db, 'meals'), F.where('date', '==', mealsDay)), (qs) => { S.meals = {}; qs.forEach((d) => (S.meals[d.id] = { id: d.id, ...d.data() })); live(); });
  S.subs.push(() => { if (mealsSub) mealsSub(); mealsSub = null; mealsDay = ''; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.profile && !isAdmin() && mealsDay && mealsDay !== today()) subscribeMeals(); });
function syncCatalogSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncCatalog, 1500); }
function syncCatalog() {
  if (!S.stockReady || !S.catalogReady) return; // never judge "sold out" before stock has loaded
  const lots = {};
  Object.values(S.stock).forEach((s) => (lots[L.nameKey(s.name)] ||= []).push(s));
  const b = F.writeBatch(F.db); let n = 0;
  for (const c of Object.values(S.catalog)) {
    const ls = lots[c.id] || [], live = ls.filter((x) => x.qty > 0);
    const available = live.length > 0;
    const price = Math.max(0, ...(live.length ? live : ls).map((x) => Number(x.maxPrice) || 0)) || c.price || 0;
    if (c.available !== available || c.price !== price) { b.update(F.doc(F.db, 'catalog', c.id), { available, price }); n++; }
  }
  if (n) F.commit(b, () => {});
}

function selectSeller(sid) {
  S.sellerSubs.forEach((u) => u()); S.sellerSubs = [];
  S.sid = sid || null; S.customers = {}; S.accounts = {}; S.routeChanges = {};
  if (isAdmin()) localStorage.setItem('sid', sid || '');
  if (!sid) return;
  S.sellerSubs.push(F.onSnapshot(F.sellerCol(sid, 'routeChanges'), (qs) => { S.routeChanges = {}; qs.forEach((d) => (S.routeChanges[d.id] = { id: d.id, ...d.data() })); live(); }));
  S.sellerSubs.push(F.onSnapshot(F.sellerCol(sid, 'customers'), (qs) => { S.customers = {}; qs.forEach((d) => (S.customers[d.id] = { id: d.id, ...d.data() })); live(); }));
  S.sellerSubs.push(F.onSnapshot(F.sellerCol(sid, 'accounts'), (qs) => { S.accounts = {}; qs.forEach((d) => (S.accounts[d.id] = { id: d.id, ...d.data() })); live(); }));
}

function live() {
  const a = document.activeElement;
  if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return;
  if (S.refresh) S.refresh();
}

const accountsOf = (cid) => Object.values(S.accounts).filter((a) => a.customerId === cid);
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
      if (!(await F.getDoc(st)).exists()) await F.setDoc(st, { defaultMarginPct: 100, legacyMarginPct: 85, geminiKey: '', geminiModel: DEFAULT_MODEL });
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
  setTitle(APP_NAME);
  view.innerHTML = `
  <form id="loginForm" class="card login">
    <div class="brand">${esc(APP_NAME)}</div>
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
  [/^#\/pick\/(sale|collect)$/, renderPick],
  [/^#\/stock$/, renderStock],
  [/^#\/purchase(?:\/(photo))?$/, renderPurchase],
  [/^#\/stock-edit\/(\w+)$/, renderStockEdit],
  [/^#\/item\/([\w-]+)$/, renderItem],
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
];
const adminOnly = ['#/company-expenses', '#/users', '#/app-settings', '#/backup', '#/categories', '#/scrap'];

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
      <div id="calw"></div>`;
    bindSellerBar();
    mountCalendar($('#calw'));
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
      <div class="stat"><span>${t("Today's collection")}</span><b>${money(fig.collected)}</b><small>${splitLine(fig.collectedCash, fig.collectedUpi, fig.collectedScrap)}</small></div>
      <div class="stat"><span>${t('Cash in hand')}</span><b>${money(fig.cashInHand)}</b><small>${t('Expenses')} ${money(fig.expense)}</small></div>
    </div>
    ${alerts.map(alertCard).join('')}
    ${routeTile(new Set(cols.filter((c) => c.kind !== 'discount').map((c) => c.customerId)), new Set(visits.map((v) => v.customerId)))}
    ${mealCard()}
    ${deliver.length ? `<a class="banner" href="#/orders" style="display:block;text-decoration:none"><b>🚚 ${t("Today's deliveries")}: ${deliver.length}</b>
      <span class="small muted">${esc(Object.entries(deliver.flatMap((o) => o.items).reduce((m, i) => ((m[i.name] = (m[i.name] || 0) + Number(i.qty || 0)), m), {})).map(([n, q]) => `${n} × ${q}`).join(', '))}</span></a>` : ''}
    <div class="grid2">
      <a class="tile primary" href="#/pick/collect">+ ${t('Collection')}</a>
      <a class="tile" href="#/pick/sale">+ ${t('New sale')}</a>
      <a class="tile" href="#/expenses">+ ${t('Expense')}</a>
      <a class="tile" href="#/purchase/photo">📷 ${t('Stock from bill')}</a>
    </div>
    <a class="btn ghost" href="#/close-day">${closed ? '✓ ' + t('Day closed — view') : '🌙 ' + t('Close today')}</a>
    <h3>${t("Today's tasks")} ${due.length ? `<span class="pill bad">${due.length}</span>` : ''}</h3>
    <ul class="list">${due.map(noteRow).join('') || `<li class="muted">${t('Nothing due')}</li>`}</ul>
    ${soon.length ? `<h3>${t('Upcoming')}</h3><ul class="list">${soon.map(noteRow).join('')}</ul>` : ''}
    <h3>${t('Calendar')}</h3><div id="calw"></div>`;
  bindSellerBar();
  bindAlerts();
  bindMeal();
  mountCalendar($('#calw'));
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
  const groups = todayRouteList(plan), all = groups.flatMap((g) => g.list);
  const done = all.filter((c) => paid.has(c.id) || visited.has(c.id)).length;
  const due = all.reduce((s, c) => s + openBalance(c.id), 0);
  const label = groups.map((g) => dayLabel(g.day) + (g.moved ? ` (${t('moved')})` : '')).join(' + ');
  return `<button class="routetile" id="routeTile">
    <div class="rt-h"><span>🛵 ${t("Today's route")} · ${label}</span><em>${t('Open')}</em></div>
    <b>${done} / ${all.length} ${t('customers')}</b>
    <div class="dots">${all.map((c) => `<i class="${paid.has(c.id) ? 'paid' : visited.has(c.id) ? 'visit' : ''}"></i>`).join('')}</div>
    <small>${t('Total due')} ${money(due)}${changeNote ? ' · ' + changeNote : ''}</small></button>`;
}

// ---------- dinner order (Sat, Sun, Mon, Tue; sellers only) ----------
const MEAL_DAYS = [6, 0, 1, 2];
function mealCard() {
  if (isAdmin() || !MEAL_DAYS.includes(todayDay())) return '';
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
    cols.filter((c) => c.kind !== 'discount').forEach((c) => { const x = (byDay[c.date] ||= { n: 0, amt: 0 }); x.n++; x.amt += c.amount; });
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
  const p = sc.plan || {}, per = { daily: t('day'), weekly: t('week'), monthly: t('month') }[sc.freq] || t('week');
  return `${t('Score')} ${sc.score}/100 · ${t('Plan')}: ${rmoney(p.perPeriod)}/${per} · ${p.behind > 0 ? `${rmoney(p.behind)} ${t('behind')} (${p.behindPeriods} ${per})` : t('not behind')} · ${t('Average')} ${rmoney(p.average)}/${per}${sc.promises?.due ? ` · ${t('Promises kept')} ${sc.promises.kept}/${sc.promises.due}` : ''}`;
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
  const r = L.customerScore({ accounts: accountsOf(cid), sales, collections: cols, promises: visits.filter((v) => v.promiseDate), today: today() });
  const score = { score: r.score ?? null, band: r.band, parts: r.parts || null, plan: r.plan || null, freq: r.freq || 'weekly', promises: r.promises || null, capped: r.capped || '', at: today() };
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
        return `${head}<li><a href="#/customer/${c.id}" data-cid="${c.id}" class="row ${paid ? 'paid' : ''}">
          <div>${placeBadge(c)}<b>${byRoute ? `<span class="seq">${n}</span>` : ''}${paid ? '<span class="tick">✓</span> ' : nopay ? `<span class="nopay" title="${t('Visited – no payment')}">⊘</span> ` : ''}${esc(c.name)}</b>${scoreBadges(c)}<small>${[esc(c.phone || ''), `${accs.length} ${t('accounts')}`, days].filter(Boolean).join(' · ')}</small></div>
          <div class="amt">${money(openBalance(c.id))}</div></a></li>`;
      }).join('');
    }).join('') || `<li class="muted">${t('No customers here')}</li>`;
    if (!n && !note) $('#clist').innerHTML = `<li class="muted">${t('No customers here')}</li>`;
    const due = list.reduce((s, c) => s + openBalance(c.id), 0), seen = list.filter((c) => paidToday.has(c.id)).length, nv = list.filter((c) => !paidToday.has(c.id) && visitedToday.has(c.id)).length;
    $('#ctotal').textContent = `${list.length} ${t('customers')} · ${t('Total due')} ${money(due)}${byRoute ? ` · ✓ ${seen} ${t('paid today')}${nv ? ` · ⊘ ${nv}` : ''}` : ''}`;
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
    </div></div>`;
}

function newAccountDoc(cid, name, frequency, opening) {
  const queue = opening > 0 ? [{ ref: 'opening', date: '0000-00-00', seq: 0, remaining: opening, ratio: L.legacyRatio(S.settings.legacyMarginPct) }] : [];
  return { customerId: cid, name, frequency, openingBalance: opening, balance: opening, status: 'open', queue, date: today(), createdAt: Date.now() };
}

function renderCustomerForm(id) {
  if (needSeller()) return;
  const c = id ? S.customers[id] : null;
  if (id && !c) return go('#/customers');
  setTitle(c ? t('Edit customer') : t('New customer'), true);
  view.innerHTML = `<form id="cf" class="form">
    <label>${t('Name')}<input name="name" value="${esc(c?.name)}" required></label>
    <div class="two place-in">
      <label>${t('House no.')}<input name="house" value="${esc(c?.house)}" autocapitalize="characters"></label>
      <label>${t('Lane')}<input name="lane" list="lanes" value="${esc(c?.lane)}" autocomplete="off"></label></div>
    <datalist id="lanes">${[...new Set(Object.values(S.customers).map((x) => (x.lane || '').trim()).filter(Boolean))].sort().map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
    <label>${t('Phone numbers')} <small class="muted">(★ ${t('default')})</small></label>
    <div id="phones">${(phonesOf(c).length ? phonesOf(c) : [{ primary: true }]).map((p, i) => phoneRowHtml(p, i)).join('')}</div>
    <div id="dupWarn"></div>
    <datalist id="plabels">${PHONE_LABELS.map((l) => `<option value="${t(l)}">`).join('')}</datalist>
    <button type="button" class="btn ghost small" id="addPhone">+ ${t('Another number')}</button>
    <label>${t('Address')}<textarea name="address" rows="2">${esc(c?.address)}</textarea></label>
    <label>${t('Route day')}</label>${dayPicker(daysOf(c))}
    ${c ? '' : `<h3>${t('Accounts')}</h3><div id="accs">${accountRowHtml(0)}</div>
      <button type="button" class="btn ghost" id="addAcc">+ ${t('Another account')}</button>
      <p class="muted small">${t('Opening balance: amount still due from the old book. Leave empty for a new customer.')}</p>`}
    <button class="btn primary" type="submit">${t('Save')}</button></form>`;
  let n = 1, pn = $$('.phonerow').length;
  if (!c) $('#addAcc').onclick = () => $('#accs').insertAdjacentHTML('beforeend', accountRowHtml(n++));
  // Number already a customer of another seller? Warn (never block) so the seller can ask them first.
  const checkPhones = async () => {
    const hashes = await hashesOf($$('.phonerow [name=pn]').map((i) => ({ number: i.value })));
    const others = othersOf({ phoneHashes: hashes }, S.sid);
    $('#dupWarn').innerHTML = others.map((o) => `<div class="warnline">📞 ${t('This number is also a customer of')} <b>${esc(o.name)}</b>${o.score != null ? ` (${t('Score')} ${o.score})` : ''}${o.ban ? ` · 🚫 ${esc(o.ban)}` : ''}. ${t('Ask them before adding.')}</div>`).join('');
  };
  const bindPhones = () => {
    $$('[data-prm]').forEach((b) => (b.onclick = () => { if ($$('.phonerow').length > 1) b.parentElement.remove(); checkPhones(); }));
    $$('.phonerow [name=pn]').forEach((i) => (i.onchange = checkPhones));
  };
  $('#addPhone').onclick = () => { $('#phones').insertAdjacentHTML('beforeend', phoneRowHtml({}, pn++)); bindPhones(); };
  bindPhones();
  checkPhones();
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, sid = S.sid, b = F.writeBatch(F.db);
    const def = $('input[name=pdef]:checked', f)?.value;
    const phones = $$('.phonerow', f).map((r) => ({ label: $('[name=pl]', r).value.trim(), number: $('[name=pn]', r).value.trim(), primary: $('[name=pdef]', r).value === def }))
      .filter((p) => p.number);
    if (phones.length && !phones.some((p) => p.primary)) phones[0].primary = true;
    const data = { name: f.name.value.trim(), house: f.house.value.trim(), lane: f.lane.value.trim(), phones, phone: phones.find((p) => p.primary)?.number || '',
      address: f.address.value.trim(), days: $$('input[name=day]:checked', f).map((x) => Number(x.value)) };
    const hashes = await hashesOf(phones);
    data.phoneHashes = hashes;
    if (c) {
      writeIndex(b, sid, id, c, hashes);
      const upd = { ...data };
      if (c.address && c.address !== data.address) upd.addressHistory = [...(c.addressHistory || []), { address: c.address, until: today() }];
      b.update(F.sellerDoc(sid, 'customers', id), upd);
      F.audit(b, S.user.uid, 'customer', `sellers/${sid}/customers/${id}`, { name: c.name, house: c.house || '', lane: c.lane || '', phones: phonesOf(c), address: c.address, days: daysOf(c) }, data);
      F.commit(b, onWriteError);
      toast(t('Saved'));
      return go(`#/customer/${id}`);
    }
    const ccol = F.sellerCol(sid, 'customers');
    const cid = F.newId(ccol);
    b.set(F.doc(ccol, cid), { ...data, addressHistory: [], createdAt: Date.now() });
    writeIndex(b, sid, cid, {}, hashes);
    $$('.acc-row').forEach((row) => {
      const acol = F.sellerCol(sid, 'accounts');
      b.set(F.doc(acol, F.newId(acol)), newAccountDoc(cid, $('[name=an]', row).value.trim() || 'Account', $('[name=af]', row).value, num($('[name=ao]', row).value)));
    });
    F.commit(b, onWriteError);
    toast(t('Saved'));
    go(`#/customer/${cid}`);
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
  const lines = !sc || sc.score == null ? [t('New customer — score after 4 weeks of history')]
    : [`<b>${t('Plan')}: ${rmoney(p.perPeriod)} / ${per}</b>`,
      `${t('Should have paid')} ${rmoney(p.expected)} · ${t('Paid')} ${rmoney(p.paid)}`,
      p.behind > 0 ? `<b style="color:var(--bad)">${rmoney(p.behind)} ${t('behind')} (${p.behindPeriods} ${per})</b>` : `<b style="color:var(--wa)">${t('Not behind')}</b>`,
      `${t('Their average')}: ${rmoney(p.average)} / ${per}`];
  return `<div class="scorecard">${scoreBadges(c, true)}<div class="txt">${lines.join('<br>')}
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
      ${orders.length ? `<h3>🚚 ${t('Orders')}</h3><ul class="list">${orders.map((o) => `<li><a class="row" href="#/order-edit/${o.id}"><div><b>${esc(o.items.map((i) => `${i.name} × ${i.qty}`).join(', '))}</b><small>${t('Deliver on')} ${fmtDate(o.deliveryDate)}${o.note ? ' · ' + esc(o.note) : ''}</small></div><span class="pill ${o.deliveryDate <= today() ? 'bad' : ''}">${shortDate(o.deliveryDate)}</span></a></li>`).join('')}</ul>` : ''}
      <h3>${t('Accounts')}</h3>
      <ul class="list">${accs.map((a) => `<li><a class="row ${a.status === 'closed' ? 'closed' : ''}" href="#/account/${cid}/${a.id}">
        <div><b>${esc(a.name)}</b><small>${freqLabel(a.frequency)}${a.status === 'closed' ? ' · ' + t('Closed') : ''}</small></div>
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
      ${visits.length ? `<h3>⊘ ${t('Visits without payment')}</h3><ul class="list">${visits.map((v) => `<li class="note"><div>${reasonLabel(v.reason)}${v.promiseDate ? ' → ' + fmtDate(v.promiseDate) : ''}${v.note ? ' · ' + esc(v.note) : ''}</div><small class="muted">${fmtDate(v.date)}</small></li>`).join('')}</ul>` : ''}`;
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
    $('#af').onsubmit = (e) => {
      e.preventDefault();
      const row = e.target, acol = F.sellerCol(sid, 'accounts'), b = F.writeBatch(F.db);
      b.set(F.doc(acol, F.newId(acol)), newAccountDoc(cid, $('[name=an]', row).value.trim() || 'Account', $('[name=af]', row).value, num($('[name=ao]', row).value)));
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
  setTitle(action === 'sale' ? t('New sale') : t('Collection'), '#/home');
  if (needSeller()) return;
  const draw = () => {
    const qv = ($('#q')?.value || '').toLowerCase();
    const list = Object.values(S.customers).filter((c) => searchHit(c, qv))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#plist').innerHTML = list.flatMap((c) => accountsOf(c.id).filter((a) => a.status !== 'closed').map((a) =>
      `<li><a class="row" href="#/${action}/${c.id}/${a.id}"><div>${placeBadge(c)}<b>${esc(c.name)}</b><small>${esc(a.name)} · ${freqLabel(a.frequency)}</small></div><div class="amt">${money(a.balance)}</div></a></li>`)).join('')
      || `<li class="muted">${t('No matching customer')} · <a href="#/customer-new">${t('Add customer')}</a></li>`;
  };
  view.innerHTML = `<div class="toolbar"><input id="q" type="search" placeholder="${t('Search name or phone')}" autofocus></div><ul class="list" id="plist"></ul>`;
  $('#q').oninput = draw;
  draw();
}

// ---------- account ledger ----------
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
        <small>${freqLabel(a.frequency)}${a.status === 'closed' ? ' · ' + t('Closed') : ''}</small></div>
      <div class="grid3">
        <a class="tile primary" href="#/collect/${cid}/${aid}">${t('Collection')}</a>
        <a class="tile" href="#/sale/${cid}/${aid}">${t('New sale')}</a>
        <a class="tile" href="#/return/${cid}/${aid}">${t('Return')}</a>
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
      <div class="actions">${a.status === 'closed'
        ? `<button class="btn" id="reopen">${t('Reopen account')}</button>`
        : `<button class="btn" id="close" ${a.balance > 0 ? 'disabled' : ''}>${t('Close account')}</button>`}</div>
      ${a.balance > 0 && a.status !== 'closed' ? `<p class="muted small">${t('An account can be closed when the balance is zero.')}</p>` : ''}`;

    const stmtText = () => {
      const lines = ledger.slice(-25).map((r) => `${fmtDate(r.date) || '-'}  ${typeLabel(r)}${r.type === 'collection' || r.type === 'advance' ? ' (' + modeLabel(r.ref.mode) + ')' : ''}  ${r.sign > 0 ? '+' : '-'}${money(r.amount)}`);
      return `*${APP_NAME}*\n${c.name} — ${a.name}\n${t('Date')}: ${fmtDate(today())}\n\n${lines.join('\n')}\n\n*${t('Balance due')}: ${money(a.balance)}*`;
    };
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
    if (cl) cl.onclick = () => { const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), { status: 'closed', closedOn: today() }); F.commit(b, onWriteError); toast(t('Account closed')); };
    if (ro) ro.onclick = () => { const b = F.writeBatch(F.db); b.update(F.sellerDoc(sid, 'accounts', aid), { status: 'open' }); F.commit(b, onWriteError); };
  };
  await draw();
  S.refresh = draw;
}

/**
 * Admin: cancel a sale entered by mistake. Puts unreturned items back in stock, removes its advance,
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
    (adv.length ? `\n${t('Its advance of')} ${money(advTotal)} ${t('will also be removed.')}` : '') + `\n${t('Items go back to stock.')}`;
  if (!confirm(msg)) return false;
  const v = L.voidFromQueue(a.queue || [], saleId, data.collections.filter((c) => !adv.includes(c)));
  const b = F.writeBatch(F.db);
  b.delete(F.sellerDoc(sid, 'sales', saleId));
  sale.items.forEach((_, i) => b.delete(F.doc(F.db, 'stockMoves', `sale_${saleId}_${i}`)));
  adv.forEach((c) => {
    b.delete(F.sellerDoc(sid, 'collections', c.id));
    if (c.mode !== 'scrap') b.update(F.sellerDoc(sid, 'customers', cid), { [`modeCounts.${c.mode === 'upi' ? 'upi' : 'cash'}`]: F.increment(-1) });
  });
  v.collections.forEach((nc) => b.update(F.sellerDoc(sid, 'collections', nc.id), { allocations: nc.allocations, profit: nc.profit }));
  b.update(F.sellerDoc(sid, 'accounts', aid), { queue: v.queue, balance: F.increment(L.round2(advTotal - sale.saleValue)) });
  sale.items.forEach((i) => {
    const left = i.qty - (i.returned || 0);
    if (left <= 0) return;
    if (S.stock[i.stockId]) b.update(F.doc(F.db, 'stock', i.stockId), { qty: F.increment(left) });
    else { const sc = F.collection(F.db, 'stock'); b.set(F.doc(sc, F.newId(sc)), { name: i.name, qty: left, unitCost: i.unitCost, maxPrice: L.maxPrice(i.unitCost, S.settings.defaultMarginPct), category: i.category || 'Others', addedBy: S.user.uid, createdAt: Date.now() }); }
  });
  // A sale made when delivering an order: the order goes back to pending.
  const ords = await F.fetchAll(F.query(F.sellerCol(sid, 'orders'), F.where('saleId', '==', saleId)));
  ords.forEach((o) => {
    b.update(F.sellerDoc(sid, 'orders', o.id), { status: 'pending', saleId: '', deliveredOn: '' });
    b.set(F.doc(F.db, 'demand', o.id), { sellerKey: sid, items: o.items.map((i) => ({ name: i.name, qty: i.qty })), deliveryDate: o.deliveryDate, updatedAt: Date.now() });
  });
  F.audit(b, S.user.uid, 'sale-void', `sellers/${sid}/sales/${saleId}`, { sale, advances: adv }, null);
  F.commit(b, onWriteError);
  rescoreSoon(cid);
  toast(t('Sale voided'));
  return true;
}

// ---------- sale ----------
function renderSale(cid, aid) {
  if (needSeller()) return;
  const sid = S.sid, c = S.customers[cid], a = S.accounts[aid];
  if (!c || !a) return go('#/customers');
  setTitle(`${t('New sale')} · ${c.name}`, true);
  const cart = []; // {stockId, name, qty, unitCost, price, max, category}
  let cat = 'all', order = null, missing = [];
  try { const o = JSON.parse(sessionStorage.getItem('saleOrder') || 'null'); if (o && o.customerId === cid) order = o; } catch {}
  if (order) {
    for (const it of order.items) {
      const lot = Object.values(S.stock).filter((x) => x.qty > 0 && x.name.trim().toLowerCase() === it.name.trim().toLowerCase()).sort((x, y) => y.qty - x.qty)[0];
      if (!lot) { missing.push(`${it.name} × ${it.qty}`); continue; }
      cart.push({ stockId: lot.id, name: lot.name, qty: Math.min(Number(it.qty) || 1, lot.qty), unitCost: lot.unitCost, price: lot.maxPrice, max: lot.qty, category: catOf(lot) });
      if (lot.qty < it.qty) missing.push(`${it.name} × ${it.qty - lot.qty}`);
    }
  }
  const drawStock = () => {
    const qv = ($('#sq').value || '').toLowerCase();
    $('#scat').innerHTML = catChips(Object.values(S.stock).filter((x) => x.qty > 0), cat);
    $$('#scat [data-cat]').forEach((b) => (b.onclick = () => { cat = b.dataset.cat; drawStock(); }));
    const items = Object.values(S.stock).filter((s) => s.qty > 0 && (cat === 'all' || catOf(s) === cat) && (!qv || s.name.toLowerCase().includes(qv))).sort((x, y) => x.name.localeCompare(y.name)).slice(0, 60);
    $('#slist').innerHTML = items.map((s) => `<li><button type="button" class="row pick" data-add="${s.id}"><div><b>${esc(s.name)}</b><small>${t('In stock')}: ${s.qty}</small></div><div class="amt">${money(s.maxPrice)}</div></button></li>`).join('') || `<li class="muted">${t('No stock found')}</li>`;
    $$('[data-add]').forEach((b) => (b.onclick = () => {
      const s = S.stock[b.dataset.add];
      const ex = cart.find((x) => x.stockId === s.id);
      if (ex) { if (ex.qty < s.qty) ex.qty++; } else cart.push({ stockId: s.id, name: s.name, qty: 1, unitCost: s.unitCost, price: s.maxPrice, max: s.qty, category: catOf(s) });
      drawCart();
    }));
  };
  const drawCart = () => {
    $('#cart').innerHTML = cart.map((l, i) => `<div class="cartline">
      <div class="nm"><b>${esc(l.name)}</b><button type="button" class="x" data-rm="${i}">×</button></div>
      <div class="two"><label>${t('Qty')}<input type="number" min="1" max="${l.max}" value="${l.qty}" data-q="${i}" inputmode="numeric"></label>
      <label>${t('Price each')}<input type="number" step="any" value="${l.price}" data-p="${i}" inputmode="decimal"></label></div></div>`).join('') || `<p class="muted">${t('Tap items below to add them.')}</p>`;
    $$('[data-rm]').forEach((b) => (b.onclick = () => { cart.splice(+b.dataset.rm, 1); drawCart(); }));
    $$('[data-q]').forEach((inp) => (inp.oninput = () => { cart[+inp.dataset.q].qty = Math.max(1, Math.min(cart[+inp.dataset.q].max, Math.round(num(inp.value)))); total(); }));
    $$('[data-p]').forEach((inp) => (inp.oninput = () => { cart[+inp.dataset.p].price = num(inp.value); total(); }));
    total();
  };
  const total = () => { $('#total').textContent = money(L.saleTotals(cart).value); };
  view.innerHTML = `
    ${order ? `<div class="banner"><b>🚚 ${t('Delivering order')}</b><span class="small">${esc(order.items.map((i) => `${i.name} × ${i.qty}`).join(', '))}</span>
      ${missing.length ? `<div class="warnline">${t('Not in stock')}: ${esc(missing.join(', '))}</div>` : ''}</div>` : ''}
    <div class="card"><small class="muted">${esc(a.name)} · ${t('Balance')} ${money(a.balance)}</small>
      <div id="cart"></div>
      <div class="row total"><span>${t('Total')}</span><b id="total">₹0</b></div>
      <div class="two"><label>${t('Advance received')}<input id="adv" type="number" step="any" min="0" inputmode="decimal" placeholder="0"></label>
      <label>${t('Date')}<input id="sdate" type="date" value="${today()}" max="${today()}"></label></div>
      <label>${t('Advance paid by')}</label>${payPicker('advMode', L.preferredMode(c.modeCounts))}
      <button class="btn primary" id="saveSale">${t('Save sale')}</button></div>
    <h3>${t('Add items from stock')}</h3>
    <div class="fchips" id="scat"></div>
    <input id="sq" type="search" placeholder="${t('Search stock')}">
    <ul class="list" id="slist"></ul>`;
  $('#sq').oninput = drawStock;
  drawStock(); drawCart();
  $('#saveSale').onclick = () => {
    if (!cart.length) return toast(t('Add at least one item'), true);
    if ($('#saveSale').disabled) return;
    $('#saveSale').disabled = true;
    const lines = cart.map((l) => ({ stockId: l.stockId, name: l.name, qty: l.qty, unitCost: l.unitCost, price: l.price, returned: 0, category: l.category || 'Others' }));
    const { value, cost } = L.saleTotals(lines);
    const adv = Math.min(num($('#adv').value), value);
    const date = $('#sdate').value || today();
    const b = F.writeBatch(F.db), scol = F.sellerCol(sid, 'sales'), saleId = F.newId(scol), now = Date.now();
    b.set(F.doc(scol, saleId), { accountId: aid, customerId: cid, date, items: lines, saleValue: value, cost, advance: adv, creditedValue: 0, creditedCost: 0, createdAt: now, by: S.user.uid });
    lines.forEach((l, i) => { b.update(F.doc(F.db, 'stock', l.stockId), { qty: F.increment(-l.qty) }); logMove(b, `sale_${saleId}_${i}`, { name: l.name, type: 'sale', qty: l.qty, date, refId: saleId, sellerKey: sid }); });
    let queue = L.addSaleToQueue(a.queue || [], saleId, date, value, cost);
    if (adv > 0) {
      const r = L.allocate(queue, adv, saleId), advMode = pickedMode('advMode');
      b.update(F.sellerDoc(sid, 'customers', cid), { [`modeCounts.${advMode}`]: F.increment(1) });
      queue = r.queue;
      const ccol = F.sellerCol(sid, 'collections');
      b.set(F.doc(ccol, F.newId(ccol)), { accountId: aid, customerId: cid, date, amount: adv, kind: 'advance', mode: advMode, saleId, note: '', allocations: r.allocations, profit: r.profit, createdAt: now, by: S.user.uid });
    }
    b.update(F.sellerDoc(sid, 'accounts', aid), { queue, balance: F.increment(L.round2(value - adv)), status: 'open' });
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
  const onMode = () => { const sc = pickedMode('mode', f) === 'scrap'; $('#scrapBox').hidden = !sc; f.amt.readOnly = sc; if (sc) sum(); showDisc(); };
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
    const doc = { accountId: aid, customerId: cid, date, amount: amt, kind: 'collection', mode, note: f.note.value.trim(), allocations: r.allocations, profit: r.profit, createdAt: now, by: S.user.uid };
    if (mode === 'scrap') {
      doc.scrapItems = items;
      b.set(F.doc(F.db, 'scrapIn', id), { sellerKey: sid, collectionId: id, date, items, total: amt, customerName: c.name, createdAt: now, by: S.user.uid });
    }
    if (amt > 0) b.set(F.doc(ccol, id), doc);
    else if (mode === 'scrap') b.delete(F.doc(F.db, 'scrapIn', id));
    b.update(F.sellerDoc(sid, 'accounts', aid), { queue, balance: F.increment(-L.round2(amt + disc)) });
    F.commit(b, onWriteError);
    rescoreSoon(cid);
    const bal = L.round2(a.balance - amt - disc);
    const text = [`*${APP_NAME}*`, `${c.name} — ${a.name}`,
      amt > 0 ? `${money(amt)} ${t('received')} (${fmtDate(date)}, ${modeLabel(mode)}${mode === 'scrap' ? ': ' + scrapDetail(doc) : ''}).` : '',
      disc > 0 ? `${t('Discount')}: ${money(disc)}` : '', `${t('Balance')}: *${money(bal)}*`, t('Thank you')].filter(Boolean).join('\n');
    try { sessionStorage.setItem('receipt', JSON.stringify({ aid, customer: c.name, amount: amt, discount: disc, balance: bal, phone: c.phone || '', text, at: Date.now() })); } catch {}
    go(takeCollectBack(aid) || `#/account/${cid}/${aid}`);
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
      <label class="opt"><input type="radio" name="cond" value="stock" checked><span>${t('Good')}<small>${t('Goes back to stock')}</small></span></label>
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
    const items = p.map((x) => ({ stockId: s.items[x.k].stockId, name: s.items[x.k].name, qty: x.qty, price: s.items[x.k].price, unitCost: s.items[x.k].unitCost, category: lineCat(s.items[x.k]) }));
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
    items.forEach((i, k) => {
      logMove(b, `ret_${rid}_${k}`, { name: i.name, type: cond === 'stock' ? 'return' : cond === 'complaint' ? 'complaint' : 'damage', qty: i.qty, date, refId: s.id, sellerKey: sid });
      if (cond === 'stock') {
        if (S.stock[i.stockId]) b.update(F.doc(F.db, 'stock', i.stockId), { qty: F.increment(i.qty) });
        else { const sc = F.collection(F.db, 'stock'); b.set(F.doc(sc, F.newId(sc)), { name: i.name, qty: i.qty, unitCost: i.unitCost, maxPrice: L.maxPrice(i.unitCost, S.settings.defaultMarginPct), category: i.category || 'Others', addedBy: S.user.uid, createdAt: now }); }
      }
      if (cond === 'complaint') { const cc = F.collection(F.db, 'complaints'); b.set(F.doc(cc, F.newId(cc)), { ...i, sellerId: sid, returnId: rid, customerName: c.name, credited, status: 'open', date, createdAt: now }); }
      if (cond === 'scrap' && credited) { const sc = F.collection(F.db, 'scrapLosses'); b.set(F.doc(sc, F.newId(sc)), { name: i.name, qty: i.qty, amount: L.round2(i.unitCost * i.qty), sellerId: sid, returnId: rid, date, createdAt: now }); }
    });
    F.commit(b, onWriteError);
    rescoreSoon(cid);
    toast(t('Return saved'));
    go(`#/account/${cid}/${aid}`);
  };
}

// ---------- stock movement log (shared, no prices of sales, no customer names) ----------
/** Add one movement line: type in | sale | return | complaint | damage | adjust. Ids are fixed so the backfill and live writes never double up. */
function logMove(b, id, m) {
  const sk = m.sellerKey || S.sid || 'admin';
  b.set(F.doc(F.db, 'stockMoves', id), { name: m.name, nameKey: L.nameKey(m.name), type: m.type, qty: Number(m.qty) || 0, date: m.date || today(),
    sellerKey: sk, sellerName: sk === 'admin' ? 'Admin' : sellerName(sk), refId: m.refId || '', cost: m.cost ?? null, supplier: m.supplier || '', billName: m.billName || '', createdAt: Date.now() });
}

// ---------- stock ----------
/** Category filter chips with item count and stock value at cost. */
function catChips(items, sel, extra = '') {
  const val = (arr) => money(Math.round(arr.reduce((s, i) => s + Math.max(0, i.qty) * (i.unitCost || 0), 0)));
  const chip = (k, l, arr) => `<button class="fchip ${k === sel ? 'on' : ''}" data-cat="${esc(k)}">${esc(l)} <small>${arr.length} · ${val(arr)}</small></button>`;
  return chip('all', t('All'), items) + categories().map((c) => [c, items.filter((i) => catOf(i) === c)]).filter(([, arr]) => arr.length).map(([c, arr]) => chip(c, t(c), arr)).join('') + extra;
}

function renderStock() {
  setTitle(t('Stock'));
  let cat = (() => { try { return sessionStorage.getItem('stockCat') || 'all'; } catch { return 'all'; } })(), shopOnly = false;
  const inShop = (x) => !!S.catalog[L.nameKey(x.name)]?.show;
  const draw = () => {
    const qv = ($('#q')?.value || '').toLowerCase(), all = $('#all')?.checked;
    const base = Object.values(S.stock).filter((s) => (all || s.qty !== 0) && (!qv || s.name.toLowerCase().includes(qv)));
    if (cat !== 'all' && !categories().includes(cat)) cat = 'all';
    $('#scat').innerHTML = catChips(base, cat, `<button class="fchip ${shopOnly ? 'on' : ''}" data-shop>🛍️ ${t('In catalog')} <small>${base.filter(inShop).length}</small></button>`);
    $$('#scat [data-cat]').forEach((b) => (b.onclick = () => { cat = b.dataset.cat; try { sessionStorage.setItem('stockCat', cat); } catch {} draw(); }));
    $('#scat [data-shop]').onclick = () => { shopOnly = !shopOnly; draw(); };
    const items = base.filter((s) => (cat === 'all' || catOf(s) === cat) && (!shopOnly || inShop(s))).sort((x, y) => x.name.localeCompare(y.name));
    const val = items.reduce((s, i) => s + Math.max(0, i.qty) * i.unitCost, 0);
    $('#sum').textContent = `${items.length} ${t('items')} · ${t('Stock value (cost)')} ${money(val)}`;
    $('#list').innerHTML = items.map((s) => `<li><a class="row" href="#/item/${L.nameKey(s.name)}">
      <div><b>${esc(s.name)}${inShop(s) ? ' <span title="' + t('In catalog') + '">🛍️</span>' : ''}</b><small>${esc(t(catOf(s)))} · ${t('Cost')} ${money(s.unitCost)} · ${t('Price')} ${money(s.maxPrice)}</small></div>
      <div class="amt ${s.qty < 0 ? 'neg' : ''}">${s.qty}${s.qty < 0 ? ' ⚠' : ''}</div></a></li>`).join('') || `<li class="muted">${t('No stock yet')}</li>`;
  };
  const nComp = Object.keys(S.complaints).length;
  view.innerHTML = `
    <div class="grid2"><a class="tile primary" href="#/purchase/photo">📷 ${t('From bill photo')}</a><a class="tile" href="#/purchase">+ ${t('Add manually')}</a></div>
    <div class="contact" style="margin-top:0">
      ${nComp ? `<a class="btn small" href="#/complaints">${t('Complaint items')} (${nComp})</a>` : ''}
      <a class="btn small" href="#/orders">🚚 ${t('To buy')}</a>
      ${isAdmin() ? `<a class="btn small" href="#/categories">${t('Categories')}</a>` : ''}
      <a class="btn small" href="#/shop-link">🛍️ ${t('Shop link')}</a></div>
    <div class="fchips" id="scat" style="margin-top:10px"></div>
    <div class="toolbar"><input id="q" type="search" placeholder="${t('Search stock')}"><label class="radio small"><input type="checkbox" id="all"> ${t('Show sold out')}</label></div>
    <div class="muted small" id="sum"></div><ul class="list" id="list"></ul>`;
  $('#q').oninput = draw; $('#all').onchange = draw;
  draw();
  S.refresh = draw;
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

const RETIRED_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

/** Pick the newest Flash model this key can use (used when the saved model is retired). */
async function pickModel(key, lite = false) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  if (!r.ok) return null;
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => (lite ? /^gemini-[\d.]+-flash-lite$/ : /^gemini-[\d.]+-flash$/).test(n));
  names.sort((x, y) => parseFloat(y.split('-')[1]) - parseFloat(x.split('-')[1]));
  return names[0] || null;
}

/** POST to Gemini generateContent with the saved key and model; falls back to a newer Flash model on 404. */
async function gemini(body) {
  const key = S.settings.geminiKey;
  if (!key) throw new Error(t('AI key not set. Admin → App settings.'));
  let model = S.settings.geminiModel;
  if (!model || RETIRED_MODELS.includes(model)) model = DEFAULT_MODEL;
  const call = (m) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  });
  const remember = (m) => { S.settings.geminiModel = m; if (isAdmin()) { const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'settings', 'main'), { geminiModel: m }, { merge: true }); F.commit(b, () => {}); } };
  let res = await call(model);
  if (res.status === 404) {
    const alt = await pickModel(key);
    if (alt && alt !== model) { res = await call(alt); if (res.ok) remember(alt); }
  }
  // Free-tier limit hit on this model: try the lighter models, which usually have higher free limits.
  if (res.status === 429) {
    const lite = await pickModel(key, true);
    for (const m of [...new Set(['gemini-flash-lite-latest', lite].filter((x) => x && x !== model))]) {
      res = await call(m);
      if (res.ok) { remember(m); break; }
      if (res.status !== 429 && res.status !== 404) break;
    }
  }
  if (res.status === 429) throw new Error(t('The free AI limit is used up for now. Wait a minute and try again; if it keeps happening, today\'s free limit is over.'));
  if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
  return res.json();
}

async function readBill(dataUrl) {
  const prompt = 'Read this purchase bill. It may be printed or handwritten, in English or Malayalam. ' +
    'Return only JSON: {"supplier": string, "date": "YYYY-MM-DD" or "", "items": [{"name": string, "qty": number, "unitCost": number}]}. ' +
    'unitCost is the price of ONE unit; if only a line total is shown, divide it by qty. Write each item name exactly as printed on the bill. ' +
    `Also give each item a "category", exactly one of: ${JSON.stringify(categories())} (use "Others" if unsure). ` +
    'Do not include totals, taxes, discounts or round-off as items.';
  const j = await gemini({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: dataUrl.split(',')[1] } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';
  return JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim());
}

function renderPurchase(mode) {
  setTitle(mode ? t('Stock from bill') : t('Add stock'), '#/stock');
  let photo = null;
  const m = S.settings.defaultMarginPct;
  const catSel = (sel) => `<select name="cat" aria-label="${t('Category')}">${categories().map((c) => `<option value="${esc(c)}" ${c === sel ? 'selected' : ''}>${esc(t(c))}</option>`).join('')}</select>`;
  let lastCat = 'Others';
  // A bill line keeps the supplier's name (billName); "our name" is filled from what was learned before.
  const lineHtml = (l = {}) => {
    const learned = l.billName ? S.nameMap[L.nameKey(l.billName)] : null;
    const name = learned ? learned.ourName : l.name || '';
    const cat = learned?.category || l.category;
    return `<div class="pline" data-bill="${esc(l.billName || '')}">
    ${l.billName ? `<div class="billname">🧾 ${esc(l.billName)}${learned ? ` <span class="pill ok">${t('remembered')}</span>` : ''}</div>` : ''}
    <input name="n" placeholder="${t('Our item name')}" value="${esc(name)}" list="snames">
    <input name="q" type="number" min="1" placeholder="${t('Qty')}" value="${l.qty || ''}" inputmode="numeric">
    <input name="c" type="number" step="any" min="0" placeholder="${t('Cost each')}" value="${l.unitCost || ''}" inputmode="decimal">
    <span class="mp"></span><button type="button" class="x" data-rm>×</button>
    ${catSel(categories().includes(cat) ? cat : lastCat)}</div>`;
  };
  view.innerHTML = `
    ${mode ? `<div class="card"><label class="btn primary block">📷 ${t('Take / choose bill photo')}<input id="ph" type="file" accept="image/*" capture="environment" hidden></label>
      <img id="prev" class="billprev" hidden><div id="aiStat" class="muted small"></div></div>` : ''}
    <form id="pf" class="card form">
      <div class="two"><label>${t('Supplier')}<input name="sup"></label><label>${t('Bill date')}<input name="date" type="date" value="${today()}"></label></div>
      <div class="muted small">${t('Selling price = cost')} + ${m}%</div>
      <div class="phead"><span>${t('Item name')}</span><span>${t('Qty')}</span><span>${t('Cost each')}</span><span>${t('Price')}</span><span></span></div>
      <div id="lines">${lineHtml()}</div>
      <datalist id="snames">${[...new Set(Object.values(S.stock).map((x) => x.name))].sort().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <button type="button" class="btn ghost" id="addLine">+ ${t('Add row')}</button>
      <div class="row total"><span>${t('Bill total')}</span><b id="btot">₹0</b></div>
      <button class="btn primary" type="submit">${t('Save to stock')}</button></form>`;
  const recalc = () => {
    let tot = 0;
    $$('.pline').forEach((r) => {
      const q = num($('[name=q]', r).value), c = num($('[name=c]', r).value);
      tot += q * c;
      $('.mp', r).textContent = c ? money(L.maxPrice(c, m)) : '';
    });
    $('#btot').textContent = money(tot);
  };
  const bindLines = () => {
    $$('.pline input').forEach((i) => (i.oninput = recalc)); $$('[data-rm]').forEach((b) => (b.onclick = () => { b.parentElement.remove(); recalc(); }));
    $$('.pline select').forEach((sl) => (sl.onchange = () => { lastCat = sl.value; }));
    // Typing a name already in stock picks that item's category.
    $$('.pline [name=n]').forEach((i) => i.addEventListener('change', () => { const ex = Object.values(S.stock).find((x) => x.name.toLowerCase() === i.value.trim().toLowerCase()); if (ex) $('select', i.parentElement).value = catOf(ex); }));
    recalc();
  };
  $('#addLine').onclick = () => { $('#lines').insertAdjacentHTML('beforeend', lineHtml()); bindLines(); };
  bindLines();
  if (mode) {
    $('#ph').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      photo = await compressImage(file);
      $('#prev').src = photo; $('#prev').hidden = false;
      $('#aiStat').textContent = t('Reading bill…');
      try {
        const r = await readBill(photo);
        const f = $('#pf');
        if (r.supplier) f.sup.value = r.supplier;
        if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) f.date.value = r.date;
        if (Array.isArray(r.items) && r.items.length) { $('#lines').innerHTML = r.items.map((it) => lineHtml({ ...it, billName: it.name })).join(''); bindLines(); }
        $('#aiStat').textContent = `${(r.items || []).length} ${t('items read. Check every row before saving.')}`;
      } catch (err) {
        $('#aiStat').textContent = t('Could not read the bill. Enter items by hand.') + ' (' + err.message + ')';
      }
    };
  }
  $('#pf').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const lines = $$('.pline').map((r) => ({ name: $('[name=n]', r).value.trim(), billName: r.dataset.bill || '', qty: Math.round(num($('[name=q]', r).value)), unitCost: num($('[name=c]', r).value), category: $('[name=cat]', r).value })).filter((l) => l.name && l.qty > 0);
    if (!lines.length) return toast(t('Add at least one item'), true);
    const b = F.writeBatch(F.db), pcol = F.collection(F.db, 'purchases'), pid = F.newId(pcol), now = Date.now();
    const total = L.round2(lines.reduce((s, l) => s + l.qty * l.unitCost, 0));
    b.set(F.doc(pcol, pid), { date: f.date.value || today(), supplier: f.sup.value.trim(), lines, total, hasPhoto: !!photo, addedBy: S.user.uid, createdAt: now });
    if (photo) b.set(F.doc(F.db, 'billPhotos', pid), { data: photo, createdAt: now });
    // Remember bill name -> our name (shared by everyone) when it is new or changed.
    lines.filter((l) => l.billName).forEach((l) => {
      const k = L.nameKey(l.billName), old = S.nameMap[k];
      if (!old || old.ourName !== l.name || old.category !== l.category) {
        const doc = { billName: l.billName, ourName: l.name, category: l.category, by: S.user.uid, updatedAt: now };
        b.set(F.doc(F.db, 'nameMap', k), doc); S.nameMap[k] = { id: k, ...doc };
      }
    });
    lines.forEach((l, i) => {
      const scol = F.collection(F.db, 'stock');
      b.set(F.doc(scol, F.newId(scol)), { name: l.name, qty: l.qty, unitCost: l.unitCost, maxPrice: L.maxPrice(l.unitCost, m), category: l.category, purchaseId: pid, addedBy: S.user.uid, createdAt: now });
      logMove(b, `pur_${pid}_${i}`, { name: l.name, type: 'in', qty: l.qty, date: f.date.value || today(), refId: pid, cost: l.unitCost, supplier: f.sup.value.trim(), billName: l.billName || '', sellerKey: isAdmin() ? 'admin' : S.sid });
    });
    F.commit(b, onWriteError);
    toast(`${lines.length} ${t('items added to stock')}`);
    go('#/stock');
  };
}

// ---------- item page: details and history of one item (all stock lots with the same name) ----------
async function renderItem(key) {
  const lots = Object.values(S.stock).filter((x) => L.nameKey(x.name) === key).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  setTitle(lots[0]?.name || S.catalog[key]?.name || t('Item'), '#/stock');
  view.innerHTML = '<div class="loading">…</div>';
  const moves = (await F.fetchAll(F.query(F.collection(F.db, 'stockMoves'), F.where('nameKey', '==', key))))
    .sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : a.date < b.date ? 1 : -1));
  const name = lots[0]?.name || moves[0]?.name || S.catalog[key]?.name || '';
  if (!name) { view.innerHTML = `<div class="empty">${t('Item not found')}</div>`; return; }
  setTitle(name, '#/stock');
  const sum = (type) => moves.filter((m) => m.type === type).reduce((s2, m) => s2 + m.qty, 0);
  const ins = moves.filter((m) => m.type === 'in'), outs = moves.filter((m) => m.type === 'sale');
  const backs = moves.filter((m) => ['return', 'complaint', 'damage', 'adjust'].includes(m.type));
  const inStock = lots.reduce((s2, x) => s2 + Math.max(0, x.qty), 0);
  const live = lots.filter((x) => x.qty > 0), maxP = Math.max(0, ...(live.length ? live : lots).map((x) => x.maxPrice || 0));
  const lastIn = ins[0]?.date || '', soldSince = lastIn ? outs.filter((m) => m.date >= lastIn).reduce((s2, m) => s2 + m.qty, 0) : 0;
  // Price and customer only for own sales (admin: all). Others' sales show date, seller and quantity.
  const mine = (m) => isAdmin() || m.sellerKey === S.sid;
  const det = {}, custCache = {};
  await Promise.all(outs.filter(mine).slice(0, 40).map(async (m) => {
    try {
      const sd = await F.getDoc(F.sellerDoc(m.sellerKey, 'sales', m.refId)); if (!sd.exists()) return;
      const sale = sd.data(), line = (sale.items || []).find((i) => L.nameKey(i.name) === key);
      let cust = m.sellerKey === S.sid ? S.customers[sale.customerId] : null;
      if (!cust) { const ck = `${m.sellerKey}/${sale.customerId}`; custCache[ck] ||= F.getDoc(F.sellerDoc(m.sellerKey, 'customers', sale.customerId)).then((d) => (d.exists() ? d.data() : null)).catch(() => null); cust = await custCache[ck]; }
      det[m.id] = { price: line?.price, customer: cust?.name || '', cid: sale.customerId, book: m.sellerKey };
    } catch {}
  }));
  const priced = Object.values(det).filter((d) => d.price != null);
  const avg = priced.length ? priced.reduce((s2, d) => s2 + d.price, 0) / priced.length : 0;
  const cat = S.catalog[key], typeL = { return: t('Returned to stock'), complaint: t('Complaint'), damage: t('Damage'), adjust: t('Stock corrected') };
  view.innerHTML = `
    <div class="card">
      <div class="row" style="padding:0;align-items:flex-start"><div><div class="cust-head"><div class="nm">${esc(name)}</div></div>
        <small>${esc(t(catOf(lots[0] || { category: cat?.category })))}${cat?.show ? ' · 🛍️ ' + t('In catalog') : ''}</small>
        ${cat?.description ? `<small>${esc(cat.description)}</small>` : ''}</div>
        <img id="iph" class="thumb" alt="" hidden></div>
      <div class="cust-head" style="margin-top:8px"><div class="due"><div><span>${t('In stock')}</span><b>${inStock}</b></div>
        <span>${t('Price')} ${money(maxP)}${lots[0] ? `<br>${t('Cost')} ${money(lots[0].unitCost)}` : ''}</span></div></div>
    </div>
    <div class="card">
      <div class="kv"><span>${t('Total bought')}</span><b>${sum('in')}</b></div>
      <div class="kv"><span>${t('Total sold')}</span><b>${sum('sale')}</b></div>
      ${sum('return') ? `<div class="kv"><span>${t('Returned to stock')}</span><b>${sum('return')}</b></div>` : ''}
      ${sum('damage') + sum('complaint') ? `<div class="kv"><span>${t('Damage / complaint')}</span><b>${sum('damage') + sum('complaint')}</b></div>` : ''}
      ${lastIn ? `<div class="kv"><span>${t('Last came on')}</span><b>${fmtDate(lastIn)}</b></div><div class="kv"><span>${t('Sold since then')}</span><b>${soldSince}</b></div>` : ''}
      ${ins[1] ? `<div class="kv"><span>${t('Came before that')}</span><b>${fmtDate(ins[1].date)}</b></div>` : ''}
      ${avg ? `<div class="kv"><span>${isAdmin() ? t('Average selling price') : t('My average selling price')}</span><b>${money(Math.round(avg))}</b></div>` : ''}
    </div>
    <h3>📥 ${t('Came in (bought)')}</h3>
    <ul class="list">${ins.map((m) => `<li class="row"><div><b>${fmtDate(m.date)}</b><small>${esc(m.supplier || '')}${m.billName && m.billName !== name ? ` · 🧾 ${esc(m.billName)}` : ''}</small></div>
      <div class="amt">× ${m.qty}<small>${m.cost != null ? money(m.cost) : ''}</small></div></li>`).join('') || `<li class="muted">${t('None yet')}</li>`}</ul>
    <h3>📤 ${t('Went out (sold)')}</h3>
    <ul class="list">${outs.map((m) => { const d = det[m.id];
      return `<li class="row"><div><b>${fmtDate(m.date)}</b><small>${d && d.customer ? (d.book === S.sid ? `<a href="#/customer/${d.cid}">${esc(d.customer)}</a>` : esc(d.customer)) + (isAdmin() ? ' · ' + esc(m.sellerName) : '') : esc(m.sellerName)}</small></div>
        <div class="amt">× ${m.qty}${d && d.price != null ? `<small>${money(d.price)}</small>` : ''}</div></li>`; }).join('') || `<li class="muted">${t('None yet')}</li>`}</ul>
    ${backs.length ? `<h3>↩ ${t('Returns and corrections')}</h3><ul class="list">${backs.map((m) => `<li class="row"><div><b>${fmtDate(m.date)}</b><small>${typeL[m.type]} · ${esc(m.sellerName)}</small></div><div class="amt">${m.qty > 0 && m.type !== 'adjust' ? '' : ''}${m.type === 'adjust' && m.qty > 0 ? '+' : ''}${m.qty}</div></li>`).join('')}</ul>` : ''}
    ${isAdmin() && lots.length ? `<h3>${t('Stock lots')}</h3><ul class="list">${lots.map((x) => `<li><a class="row" href="#/stock-edit/${x.id}"><div><b>${t('Qty')} ${x.qty}</b><small>${t('Cost')} ${money(x.unitCost)} · ${t('Price')} ${money(x.maxPrice)} · ${fmtDate(new Date(x.createdAt || 0).toISOString().slice(0, 10))}</small></div><span class="btn small">${t('Edit')}</span></a></li>`).join('')}</ul>` : ''}`;
  if (cat?.hasPhoto) F.getDoc(F.doc(F.db, 'catalogPhotos', key)).then((d) => { if (d.exists() && $('#iph')) { $('#iph').src = d.data().data; $('#iph').hidden = false; } }).catch(() => {});
}

/**
 * Admin, once: build the movement log from everything entered before v15 (purchases, sales, returns).
 * Fixed ids make it safe to run again; new entries already write their own lines.
 */
async function backfillMoves() {
  if (!isAdmin() || S.settings.movesV1 || backfillMoves.running || !navigator.onLine) return;
  backfillMoves.running = true;
  try {
    const all = [], add = (id, m) => all.push([id, m]);
    const purchases = await F.fetchAll(F.collection(F.db, 'purchases'));
    purchases.forEach((p) => (p.lines || []).forEach((l, i) => add(`pur_${p.id}_${i}`, { name: l.name, type: 'in', qty: l.qty, date: p.date, refId: p.id, cost: l.unitCost, supplier: p.supplier, billName: l.billName || '', sellerKey: S.users[p.addedBy]?.role === 'seller' ? keyOf(p.addedBy) : 'admin' })));
    const keys = [...new Set(Object.entries(S.users).filter(([, u]) => u.role === 'seller').map(([uid, u]) => keyOf(uid, u)))];
    for (const k of keys) {
      const [sales, rets] = await Promise.all([F.fetchAll(F.sellerCol(k, 'sales')), F.fetchAll(F.sellerCol(k, 'returns'))]);
      sales.forEach((sd) => (sd.items || []).forEach((l, i) => add(`sale_${sd.id}_${i}`, { name: l.name, type: 'sale', qty: l.qty, date: sd.date, refId: sd.id, sellerKey: k })));
      rets.forEach((r) => (r.items || []).forEach((l, i) => add(`ret_${r.id}_${i}`, { name: l.name, type: r.condition === 'stock' ? 'return' : r.condition === 'complaint' ? 'complaint' : 'damage', qty: l.qty, date: r.date, refId: r.saleId, sellerKey: k })));
    }
    for (let i = 0; i < all.length; i += 400) { const b = F.writeBatch(F.db); all.slice(i, i + 400).forEach(([id, m]) => logMove(b, id, m)); await b.commit(); }
    const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'settings', 'main'), { movesV1: true }, { merge: true }); await b.commit();
    S.settings.movesV1 = true;
  } catch (e) { console.warn('backfill', e); } finally { backfillMoves.running = false; }
}

async function renderStockEdit(id) {
  if (!isAdmin()) return go('#/stock');
  const s = S.stock[id];
  if (!s) return go('#/stock');
  setTitle(t('Edit stock item'), '#/stock');
  const key = L.nameKey(s.name), cat0 = S.catalog[key] || {};
  let photo = null;
  view.innerHTML = `<form id="ef" class="card form">
    <label>${t('Item name')}<input name="name" value="${esc(s.name)}"></label>
    <label>${t('Category')}<select name="cat">${categories().map((c) => `<option value="${esc(c)}" ${c === catOf(s) ? 'selected' : ''}>${esc(t(c))}</option>`).join('')}</select></label>
    <div class="two"><label>${t('Qty')}<input name="qty" type="number" value="${s.qty}"></label>
    <label>${t('Cost each')}<input name="cost" type="number" step="any" value="${s.unitCost}"></label></div>
    <label>${t('Selling price (max)')}<input name="price" type="number" step="any" value="${s.maxPrice}"></label>
    <div class="muted small">${t('Added by')} ${esc(userName(s.addedBy))}</div>
    <h3>🛍️ ${t('Shop catalog')}</h3>
    <label class="radio"><input type="checkbox" name="show" ${cat0.show ? 'checked' : ''}> ${t('Show in the customer catalog')}</label>
    <div class="row" style="padding:6px 0"><img id="cph" class="thumb" alt="" hidden>
      <label class="btn small" style="flex:1">📷 ${t('Photo')}<input id="cpf" type="file" accept="image/*" hidden></label></div>
    <label>${t('Description for customers')}<textarea name="desc" rows="2">${esc(cat0.description || '')}</textarea></label>
    <p class="muted small">${t('Photo, description and the show switch are shared by all stock with this name. Cost is never shown to customers.')}</p>
    <button class="btn primary" type="submit">${t('Save')}</button>
    <button class="btn danger" type="button" id="del">${t('Delete item')}</button></form>`;
  let oldPhoto = null;
  if (cat0.hasPhoto) F.getDoc(F.doc(F.db, 'catalogPhotos', key)).then((d) => { if (d.exists()) { oldPhoto = d.data().data; if ($('#cph')) { $('#cph').src = oldPhoto; $('#cph').hidden = false; } } }).catch(() => {});
  $('#cpf').onchange = async (e) => { const file = e.target.files[0]; if (!file) return; photo = await compressImage(file, 800, 250000); $('#cph').src = photo; $('#cph').hidden = false; };
  $('#ef').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target, upd = { name: f.name.value.trim(), category: f.cat.value, qty: Math.round(num(f.qty.value)), unitCost: num(f.cost.value), maxPrice: num(f.price.value) };
    const b = F.writeBatch(F.db);
    b.update(F.doc(F.db, 'stock', id), upd);
    if (upd.qty !== s.qty) logMove(b, `adj_${id}_${Date.now()}`, { name: upd.name, type: 'adjust', qty: upd.qty - s.qty, sellerKey: 'admin', refId: id });
    F.audit(b, S.user.uid, 'stock', `stock/${id}`, { name: s.name, category: catOf(s), qty: s.qty, unitCost: s.unitCost, maxPrice: s.maxPrice }, upd);
    const nk = L.nameKey(upd.name), desc = f.desc.value.trim(), show = f.show.checked;
    if (show || S.catalog[nk] || desc || photo) {
      const lots = Object.values(S.stock).filter((x) => L.nameKey(x.id === id ? upd.name : x.name) === nk).map((x) => (x.id === id ? { ...x, ...upd } : x));
      const live = lots.filter((x) => x.qty > 0);
      b.set(F.doc(F.db, 'catalog', nk), { name: upd.name, category: upd.category, description: desc, show,
        available: live.length > 0, price: Math.max(0, ...(live.length ? live : lots).map((x) => Number(x.maxPrice) || 0)),
        hasPhoto: !!(photo || S.catalog[nk]?.hasPhoto), updatedAt: Date.now() }, { merge: true });
      if (photo || (nk !== key && oldPhoto)) b.set(F.doc(F.db, 'catalogPhotos', nk), { data: photo || oldPhoto, updatedAt: Date.now() });
      if (!photo && nk !== key && oldPhoto) b.set(F.doc(F.db, 'catalog', nk), { hasPhoto: true }, { merge: true });
    }
    // Renamed and no other stock keeps the old name: remove the old catalog entry.
    if (nk !== key && S.catalog[key] && !Object.values(S.stock).some((x) => x.id !== id && L.nameKey(x.name) === key)) {
      b.delete(F.doc(F.db, 'catalog', key)); if (cat0.hasPhoto) b.delete(F.doc(F.db, 'catalogPhotos', key));
    }
    F.commit(b, onWriteError); toast(t('Saved')); go('#/stock');
  };
  $('#del').onclick = () => {
    if (!confirm(t('Delete this stock item?'))) return;
    const b = F.writeBatch(F.db);
    b.delete(F.doc(F.db, 'stock', id));
    F.audit(b, S.user.uid, 'stock-delete', `stock/${id}`, s, null);
    F.commit(b, onWriteError); go('#/stock');
  };
}

function renderComplaints() {
  setTitle(t('Complaint items'), true);
  const draw = () => {
    const list = Object.values(S.complaints).sort((a, b) => b.createdAt - a.createdAt);
    view.innerHTML = `<ul class="list">${list.map((c) => `<li class="card">
      <div><b>${esc(c.name)}</b> × ${c.qty}<small>${esc(c.customerName || '')} · ${esc(sellerName(c.sellerId))} · ${fmtDate(c.date)}</small></div>
      ${isAdmin() ? `<div class="contact"><button class="btn" data-ok="${c.id}">${t('Back to stock')}</button><button class="btn danger" data-scrap="${c.id}">${t('Damage')}</button></div>` : ''}
      </li>`).join('') || `<li class="muted">${t('No open complaints')}</li>`}</ul>`;
    $$('[data-ok]').forEach((b) => (b.onclick = () => {
      const c = S.complaints[b.dataset.ok], bt = F.writeBatch(F.db);
      bt.update(F.doc(F.db, 'complaints', c.id), { status: 'to-stock', resolvedOn: today() });
      logMove(bt, `cmp_${c.id}`, { name: c.name, type: 'return', qty: c.qty, sellerKey: c.sellerId, refId: c.returnId });
      if (S.stock[c.stockId]) bt.update(F.doc(F.db, 'stock', c.stockId), { qty: F.increment(c.qty) });
      else { const sc = F.collection(F.db, 'stock'); bt.set(F.doc(sc, F.newId(sc)), { name: c.name, qty: c.qty, unitCost: c.unitCost, maxPrice: L.maxPrice(c.unitCost, S.settings.defaultMarginPct), category: c.category || 'Others', addedBy: S.user.uid, createdAt: Date.now() }); }
      F.commit(bt, onWriteError); toast(t('Moved to stock'));
    }));
    $$('[data-scrap]').forEach((b) => (b.onclick = () => {
      const c = S.complaints[b.dataset.scrap], bt = F.writeBatch(F.db);
      bt.update(F.doc(F.db, 'complaints', c.id), { status: 'scrapped', resolvedOn: today() });
      logMove(bt, `cmp_${c.id}`, { name: c.name, type: 'damage', qty: c.qty, sellerKey: c.sellerId, refId: c.returnId });
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

async function renderReport() {
  setTitle(t('Reports'));
  let st = (() => { try { return JSON.parse(sessionStorage.getItem('rep') || 'null'); } catch { return null; } })() || { mode: 'today' };
  const rangeOf = (m) => { const d = today(); return m === 'week' ? [L.weekStart(d), d] : m === 'month' ? [d.slice(0, 8) + '01', d] : m === 'year' ? [d.slice(0, 5) + '01-01', d] : [d, d]; };
  if (st.mode !== 'custom') [st.from, st.to] = rangeOf(st.mode);
  const chips = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Choose dates']];
  view.innerHTML = `<div class="fchips" id="rchips">${chips.map(([k, l]) => `<button class="fchip ${st.mode === k ? 'on' : ''}" data-r="${k}">${k === 'custom' ? '📅 ' : ''}${t(l)}</button>`).join('')}</div>
    <div class="card form" id="rcust" ${st.mode === 'custom' ? '' : 'hidden'}><div class="two">
      <label>${t('From')}<input type="date" id="rf" value="${st.from}"></label><label>${t('To')}<input type="date" id="rt" value="${st.to}"></label></div></div>
    <div class="banner" id="rrange" style="padding:8px 14px"></div>
    <div id="out"></div>`;
  const run = async () => {
    const from = st.mode === 'custom' ? $('#rf').value || today() : st.from, to = st.mode === 'custom' ? $('#rt').value || today() : st.to;
    try { sessionStorage.setItem('rep', JSON.stringify({ ...st, from, to })); } catch {}
    $('#rrange').innerHTML = `<b>${fmtDate(from)}${from !== to ? ' – ' + fmtDate(to) : ''}</b>`;
    $('#out').innerHTML = '<div class="loading">…</div>';
    const fields = [['salesValue', 'Sales'], ['collected', 'Collected'], ['collectedCash', '— Cash'], ['collectedUpi', '— UPI'], ['collectedScrap', '— Scrap'],
      ['discount', 'Discounts given'], ['booked', 'Booked profit'], ['realised', 'Realised profit'], ['expense', 'Personal expenses'], ['expenseCash', '— Cash'], ['expenseUpi', '— UPI'],
      ['cashInHand', 'Cash in hand'], ['net', 'Net']];
    const rowCls = (k) => (k === 'net' ? 'net' : k === 'cashInHand' ? 'cash' : /Cash$|Upi$|Scrap$/.test(k) ? 'sub' : '');
    const lbl = (l) => (l === '— Cash' ? '— ' + t('Cash') : l === '— Scrap' ? '— ' + t('Scrap') : t(l));
    if (!isAdmin()) {
      const [me] = L.holderPeriods([{ ...S.profile, uid: S.user.uid }], from, to);
      const r = me ? await sellerFigures(S.sid, me.from, me.to) : L.sellerReport({});
      $('#out').innerHTML = `<table class="rep">${fields.map(([k, l]) => `<tr class="${rowCls(k)}"><td>${lbl(l)}</td><td>${money(r[k])}</td></tr>`).join('')}</table>
        <button class="btn" id="pdf">PDF</button>`;
      $('#pdf').onclick = () => makePdf({ title: `Report - ${S.profile.name}`, subtitle: `${fmtDate(from)} to ${fmtDate(to)}`, head: ['Item', 'Amount'], rows: fields.map(([k, l]) => [l, pdfMoney(r[k])]), file: `report-${S.profile.username}-${from}-${to}.pdf` });
      return;
    }
    const ss = L.holderPeriods(Object.entries(S.users).map(([uid, u]) => ({ ...u, uid })), from, to);
    const raws = await Promise.all(ss.map((p) => sellerData(p.key, p.from, p.to)));
    const reps = raws.map((r) => L.sellerReport(r));
    const rng = (c) => F.fetchAll(F.query(F.collection(F.db, c), F.where('date', '>=', from), F.where('date', '<=', to)));
    const [cexp, scrap, ssales] = await Promise.all([rng('companyExpenses'), rng('scrapLosses'), rng('scrapSales')]);
    const co = L.companyReport(reps, cexp, scrap, ssales);
    const cr = L.categoryReport(raws.flatMap((r) => r.sales), raws.flatMap((r) => r.returns), lineCat);
    const crRows = Object.entries(cr).sort((a, b) => b[1].value - a[1].value);
    $('#out').innerHTML = `<div class="scroll"><table class="rep"><thead><tr><th></th>${ss.map((p) => `<th>${esc(p.name)}${p.from !== from || p.to !== to ? `<small>${fmtDate(p.from)} – ${fmtDate(p.to)}</small>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${fields.map(([k, l]) => `<tr class="${rowCls(k)}"><td>${lbl(l)}</td>${reps.map((r) => `<td>${money(r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <h3>${t('Company')}</h3><table class="rep">
      <tr><td>${t('Sales')}</td><td>${money(co.salesValue)}</td></tr>
      <tr><td>${t('Collected')}</td><td>${money(co.collected)}</td></tr>
      <tr class="sub"><td>— ${t('Cash')}</td><td>${money(co.collectedCash)}</td></tr>
      <tr class="sub"><td>— UPI</td><td>${money(co.collectedUpi)}</td></tr>
      <tr class="sub"><td>— ${t('Scrap')}</td><td>${money(co.collectedScrap)}</td></tr>
      <tr><td>${t('Discounts given')}</td><td>${money(co.discount)}</td></tr>
      <tr><td>${t('Booked profit')}</td><td>${money(co.booked)}</td></tr>
      <tr><td>${t('Realised profit')}</td><td>${money(co.realised)}</td></tr>
      <tr><td>${t('Personal expenses')}</td><td>− ${money(co.personalExpense)}</td></tr>
      <tr><td>${t('Company expenses')}</td><td>− ${money(co.companyExpense)}</td></tr>
      <tr class="sub"><td>— ${t('Cash')}</td><td>${money(co.companyExpenseCash)}</td></tr>
      <tr class="sub"><td>— UPI</td><td>${money(co.companyExpenseUpi)}</td></tr>
      <tr><td>${t('Damage loss')}</td><td>− ${money(co.scrap)}</td></tr>
      ${ssales.length ? `<tr><td>${t('Scrap sold')}<small>${t('credited value')} ${money(co.scrapSoldCredited)}</small></td><td>${money(co.scrapSold)}</td></tr>
      <tr class="sub"><td>${co.scrapGain >= 0 ? t('Scrap gain') : t('Scrap loss')}</td><td>${co.scrapGain >= 0 ? '+' : '−'} ${money(Math.abs(co.scrapGain))}</td></tr>` : ''}
      <tr class="cash"><td>${t('Cash in hand')}</td><td>${money(co.cashInHand)}</td></tr>
      <tr class="net"><td>${t('Company net')}</td><td>${money(co.net)}</td></tr></table>
      <p class="muted small">${t('Cash in hand = cash collected − expenses paid in cash + money from scrap sold. Scrap taken as payment is not cash until it is sold.')}</p>
      <h3>${t('By category')}</h3>
      <table class="rep"><thead><tr><th>${t('Category')}</th><th>${t('Qty')}</th><th>${t('Sales')}</th><th>${t('Booked profit')}</th></tr></thead>
      <tbody>${crRows.map(([c, r]) => `<tr><td>${esc(t(c))}</td><td>${r.qty}</td><td>${money(r.value)}</td><td>${money(r.profit)}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${t('No sales')}</td></tr>`}</tbody></table>
      <button class="btn" id="pdf">PDF</button>`;
    $('#pdf').onclick = () => makePdf({
      title: 'Company report', subtitle: `${fmtDate(from)} to ${fmtDate(to)}`,
      head: ['Item', ...ss.map((s) => s.name)], rows: fields.map(([k, l]) => [l, ...reps.map((r) => pdfMoney(r[k]))]),
      foot: [`Collected: Cash ${pdfMoney(co.collectedCash)} | UPI ${pdfMoney(co.collectedUpi)} | Scrap ${pdfMoney(co.collectedScrap)}`, `Company expenses: ${pdfMoney(co.companyExpense)} (Cash ${pdfMoney(co.companyExpenseCash)} | UPI ${pdfMoney(co.companyExpenseUpi)})`,
        `Damage loss: ${pdfMoney(co.scrap)}`, `Scrap sold: ${pdfMoney(co.scrapSold)} (credited ${pdfMoney(co.scrapSoldCredited)}, gain ${pdfMoney(co.scrapGain)})`, `Cash in hand: ${pdfMoney(co.cashInHand)}`, `Company net: ${pdfMoney(co.net)}`,
        '', 'By category (qty / sales / booked profit):', ...crRows.map(([c, r]) => `${c}: ${r.qty} / ${pdfMoney(r.value)} / ${pdfMoney(r.profit)}`)],
      file: `company-report-${from}-${to}.pdf`,
    });
  };
  $$('[data-r]').forEach((b) => (b.onclick = () => {
    st = { mode: b.dataset.r };
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
          <td>${esc(a.name)}</td><td class="num">${money(a.balance)}</td><td>${fmtDate(lastPay[a.id] || '') || '—'}</td></tr>`; }).join('');
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
    ${S.sid ? `<li><a href="#/close-day">🌙 ${t('Close today')}</a></li>` : ''}
    <li><a href="#/complaints">🛠️ ${t('Complaint items')} (${Object.keys(S.complaints).length})</a></li>
    <li><a href="#/shop-link">🛍️ ${t('Shop link')}</a></li>
    ${isAdmin() ? `<li><a href="#/company-expenses">🏢 ${t('Company expenses')}</a></li>
      <li><a href="#/scrap">♻️ ${t('Scrap')}</a></li>
      <li><a href="#/categories">🗂️ ${t('Categories and scrap types')}</a></li>
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
    <p>${t('Downloads all data as one Excel file: customers, accounts, sales, collections, returns, notes, expenses, visits, orders, stock, scrap, purchases and users. Bill photos are not included.')}</p>
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
      add('Sales', per.sales.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId], account: aname[x.accountId], items: items(x.items), saleValue: x.saleValue, cost: x.cost, advance: x.advance, returnedValue: x.creditedValue || 0, id: x.id })));
      add('Collections', per.collections.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId], account: aname[x.accountId], type: x.kind, mode: MODE_EN[x.mode] || 'Cash', scrap: (x.scrapItems || []).map((i) => `${i.type} ${i.value}`).join('; '), amount: x.amount, profit: x.profit, note: x.note, enteredBy: userName(x.by), at: when(x.createdAt) })));
      add('Returns', per.returns.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId], account: aname[x.accountId], items: items(x.items), condition: x.condition, credited: x.credited ? 'yes' : 'no', amount: x.amount, cost: x.cost })));
      add('Notes', per.notes.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId] || x.customerName, note: x.text, remindOn: x.dueDate, done: x.done ? 'yes' : 'no' })));
      add('Expenses', per.expenses.map((x) => ({ seller: x.seller, date: x.date, type: x.category, mode: x.mode === 'upi' ? 'UPI' : 'Cash', amount: x.amount, note: x.note })));
      add('Visits', per.visits.map((x) => ({ seller: x.seller, date: x.date, customer: cname[x.customerId], reason: x.reason, promisedDate: x.promiseDate || '', note: x.note })));
      add('Orders', per.orders.map((x) => ({ seller: x.seller, ordered: when(x.createdAt), customer: x.customerName, items: (x.items || []).map((i) => `${i.name} x${i.qty}`).join('; '), deliveryDate: x.deliveryDate, status: x.status, note: x.note })));
      const [stock, purchases, cexp, comp, scrap, sIn, sSales] = await Promise.all([all('stock'), all('purchases'), all('companyExpenses'), all('complaints'), all('scrapLosses'), all('scrapIn'), all('scrapSales')]);
      add('Company expenses', cexp.map((x) => ({ date: x.date, type: x.category, mode: x.mode === 'upi' ? 'UPI' : 'Cash', amount: x.amount, note: x.note })));
      add('Stock', stock.map((x) => ({ item: x.name, category: catOf(x), qty: x.qty, unitCost: x.unitCost, maxPrice: x.maxPrice, addedBy: userName(x.addedBy), added: when(x.createdAt), id: x.id })));
      add('Purchases', purchases.map((x) => ({ date: x.date, supplier: x.supplier, items: items(x.lines), total: x.total, addedBy: userName(x.addedBy) })));
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
    <label>${t('Default margin % (on cost)')}<input name="dm" type="number" step="any" value="${s.defaultMarginPct}"></label>
    <label>${t('Old balance margin %')}<input name="lm" type="number" step="any" value="${s.legacyMarginPct}"></label>
    <p class="muted small">${t('Changing the old balance margin affects accounts created after the change.')}</p>
    <label>${t("Admin's WhatsApp number (for day-end summaries)")}<input name="aw" type="tel" inputmode="tel" value="${esc(s.adminWa || '')}"></label>
    <label>${t('Gemini API key (bill reading)')}<input name="gk" type="password" value="${esc(s.geminiKey || '')}" autocomplete="off"></label>
    <label>${t('Gemini model')}<input name="gm" value="${esc(s.geminiModel || DEFAULT_MODEL)}"></label>
    <button class="btn primary" type="submit">${t('Save')}</button></form>
    <div class="card form" style="border-color:var(--bad)">
      <h3 style="margin-top:0;color:var(--bad)">🗑️ ${t('Delete all test data')}</h3>
      <p class="small muted">${t('Removes all customers, accounts, sales, collections, returns, notes, visits, orders, expenses, stock, purchases, complaints, scrap, catalog and day closings. Keeps users, passwords, these settings, categories, scrap types, calendar events and shop WhatsApp numbers.')}</p>
      <p class="small">${s.lastBackup === today() ? `✓ ${t('Backup taken today')}` : `⚠ ${t('Take a backup first (Menu → Backup). This button works only after today\'s backup.')}`}</p>
      <button class="btn danger" id="wipe" ${s.lastBackup === today() ? '' : 'disabled'}>${t('Delete all test data')}</button><div id="wipeS" class="small muted"></div></div>`;
  $('#wipe').onclick = () => wipeTestData();
  $('#as').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target, b = F.writeBatch(F.db);
    const upd = { defaultMarginPct: num(f.dm.value), legacyMarginPct: num(f.lm.value), adminWa: f.aw.value.trim(), geminiKey: f.gk.value.trim(), geminiModel: f.gm.value.trim() || DEFAULT_MODEL };
    const oldM = s.defaultMarginPct;
    b.set(F.doc(F.db, 'settings', 'main'), upd, { merge: true });
    F.audit(b, S.user.uid, 'settings', 'settings/main', { defaultMarginPct: s.defaultMarginPct, legacyMarginPct: s.legacyMarginPct }, { defaultMarginPct: upd.defaultMarginPct, legacyMarginPct: upd.legacyMarginPct });
    F.commit(b, onWriteError); toast(t('Saved'));
    Object.assign(S.settings, upd);
    // New margin: offer to re-price all stock now. Past sales keep their price.
    const items = Object.values(S.stock).filter((x) => x.maxPrice !== L.maxPrice(x.unitCost, upd.defaultMarginPct));
    if (upd.defaultMarginPct !== oldM && items.length && confirm(`${t('Margin changed to')} ${upd.defaultMarginPct}%.\n${t('Update the selling price of all')} ${items.length} ${t('stock items to cost +')} ${upd.defaultMarginPct}%?\n${t('Past sales do not change.')}`)) {
      for (let i = 0; i < items.length; i += 400) {
        const bt = F.writeBatch(F.db);
        items.slice(i, i + 400).forEach((x) => bt.update(F.doc(F.db, 'stock', x.id), { maxPrice: L.maxPrice(x.unitCost, upd.defaultMarginPct) }));
        if (i === 0) F.audit(bt, S.user.uid, 'reprice-all', 'stock', { marginPct: oldM }, { marginPct: upd.defaultMarginPct, items: items.length });
        F.commit(bt, onWriteError);
      }
      toast(`${items.length} ${t('prices updated')}`);
    }
  };
}

// ---------- delete all test data (admin) ----------
const WIPE_TOP = ['stock', 'purchases', 'billPhotos', 'complaints', 'scrapLosses', 'companyExpenses', 'catalog', 'catalogPhotos', 'demand', 'scrapIn', 'scrapSales', 'stockMoves', 'phoneIndex', 'nameMap', 'meals', 'auditLog'];
const WIPE_BOOK = ['customers', 'accounts', 'sales', 'collections', 'returns', 'notes', 'expenses', 'visits', 'orders', 'routeChanges', 'dayClose'];
async function wipeTestData() {
  if (!isAdmin()) return;
  if (!navigator.onLine) return toast(t('Connect to the internet first'), true);
  if (S.settings.lastBackup !== today()) return toast(t('Take a backup first (Menu → Backup).'), true);
  const keys = [...new Set(Object.entries(S.users).filter(([, u]) => u.role === 'seller').map(([uid, u]) => keyOf(uid, u)))];
  $('#wipeS').textContent = t('Counting…');
  let nCust = 0; for (const k of keys) nCust += (await F.fetchAll(F.sellerCol(k, 'customers'))).length;
  const nStock = Object.keys(S.stock).length;
  if ((prompt(`${nCust} ${t('customers')} · ${nStock} ${t('stock items')} ${t('and everything else listed will be deleted for good.')}\n${t('Type DELETE to continue')}`) || '').trim() !== 'DELETE') { $('#wipeS').textContent = ''; return; }
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
  setTitle(t('Categories and scrap types'), '#/menu');
  const draw = () => {
    const cats = categories(), types = scrapTypes();
    const count = (c) => Object.values(S.stock).filter((x) => catOf(x) === c).length;
    view.innerHTML = `<div class="card"><h3 style="margin-top:0">🗂️ ${t('Stock categories')}</h3>
      ${cats.map((c) => `<div class="kv"><span>${esc(t(c))} <small class="muted">(${count(c)})</small></span><span>${c === 'Others' ? '' : `<button class="btn small" data-ren="${esc(c)}">${t('Rename')}</button> <button class="x" data-cdel="${esc(c)}">×</button>`}</span></div>`).join('')}
      <form id="cf2" class="toolbar"><input name="n" placeholder="${t('New category')}" required><button class="btn primary" type="submit">${t('Add')}</button></form>
      <p class="muted small">${t('Deleting a category moves its items to Others.')}</p></div>
      <div class="card"><h3 style="margin-top:0">♻️ ${t('Scrap types')}</h3>
      ${types.map((c) => `<div class="kv"><span>${esc(t(c))}</span>${c === 'Others' ? '' : `<button class="x" data-sdel="${esc(c)}">×</button>`}</div>`).join('')}
      <form id="sf2" class="toolbar"><input name="n" placeholder="${t('New scrap type')}" required><button class="btn primary" type="submit">${t('Add')}</button></form></div>
      <div class="card"><h3 style="margin-top:0">🧾 ${t('Bill names remembered')}</h3>
      ${Object.values(S.nameMap).sort((a, b) => a.billName.localeCompare(b.billName)).map((m) => `<div class="kv"><span class="small">${esc(m.billName)} → <b>${esc(m.ourName)}</b> <span class="muted">(${esc(t(m.category || 'Others'))})</span></span><button class="x" data-nmdel="${m.id}">×</button></div>`).join('') || `<div class="muted small">${t('None yet. They are learned when you save a bill read from a photo.')}</div>`}</div>`;
    const saveSettings = (upd) => { const b = F.writeBatch(F.db); b.set(F.doc(F.db, 'settings', 'main'), upd, { merge: true }); return b; };
    const restock = (from, to, b0) => { // move stock (and catalog) from one category to another, in chunks
      const ids = Object.values(S.stock).filter((x) => catOf(x) === from || x.category === from);
      let b = b0, n = 0;
      for (const x of ids) { b.update(F.doc(F.db, 'stock', x.id), { category: to }); x.category = to; if (++n % 400 === 0) { F.commit(b, onWriteError); b = F.writeBatch(F.db); } }
      Object.values(S.catalog).filter((c) => c.category === from).forEach((c) => b.update(F.doc(F.db, 'catalog', c.id), { category: to }));
      F.commit(b, onWriteError);
    };
    $('#cf2').onsubmit = (e) => {
      e.preventDefault(); const n = e.target.n.value.trim();
      if (!n || cats.some((c) => c.toLowerCase() === n.toLowerCase())) return toast(t('Already there'), true);
      const next = [...cats.filter((c) => c !== 'Others'), n, 'Others'];
      F.commit(saveSettings({ categories: next }), onWriteError); S.settings.categories = next; draw();
    };
    $$('[data-ren]').forEach((b) => (b.onclick = () => {
      const old = b.dataset.ren, n = (prompt(t('New name for') + ' ' + old, old) || '').trim();
      if (!n || n === old) return;
      if (cats.some((c) => c.toLowerCase() === n.toLowerCase())) return toast(t('Already there'), true);
      const next = cats.map((c) => (c === old ? n : c)), renames = { ...(S.settings.categoryRenames || {}), [old]: n };
      const bt = saveSettings({ categories: next, categoryRenames: renames });
      F.audit(bt, S.user.uid, 'category-rename', 'settings/main', { name: old }, { name: n });
      S.settings.categories = next; S.settings.categoryRenames = renames;
      restock(old, n, bt); toast(t('Saved')); draw();
    }));
    $$('[data-cdel]').forEach((b) => (b.onclick = () => {
      const c = b.dataset.cdel;
      if (!confirm(`${t('Delete category')} "${c}"? ${count(c)} ${t('items will move to Others.')}`)) return;
      const next = cats.filter((x) => x !== c), bt = saveSettings({ categories: next });
      F.audit(bt, S.user.uid, 'category-delete', 'settings/main', { name: c }, null);
      restock(c, 'Others', bt); S.settings.categories = next; draw();
    }));
    $('#sf2').onsubmit = (e) => {
      e.preventDefault(); const n = e.target.n.value.trim();
      if (!n || types.some((c) => c.toLowerCase() === n.toLowerCase())) return toast(t('Already there'), true);
      const next = [...types.filter((c) => c !== 'Others'), n, 'Others'];
      F.commit(saveSettings({ scrapTypes: next }), onWriteError); S.settings.scrapTypes = next; draw();
    };
    $$('[data-nmdel]').forEach((b) => (b.onclick = () => {
      if (!confirm(t('Forget this name?'))) return;
      const bt = F.writeBatch(F.db); bt.delete(F.doc(F.db, 'nameMap', b.dataset.nmdel)); F.commit(bt, onWriteError);
      delete S.nameMap[b.dataset.nmdel]; draw();
    }));
    $$('[data-sdel]').forEach((b) => (b.onclick = () => {
      if (!confirm(t('Delete this scrap type?'))) return;
      const next = types.filter((x) => x !== b.dataset.sdel);
      F.commit(saveSettings({ scrapTypes: next }), onWriteError); S.settings.scrapTypes = next; draw();
    }));
  };
  draw();
}

// ---------- shop link (public catalog) ----------
const shopUrl = (key) => new URL('shop.html?s=' + encodeURIComponent(key), location.href.split('#')[0]).href;

async function renderShopLink() {
  setTitle(t('Shop link'), '#/menu');
  const shown = Object.values(S.catalog).filter((c) => c.show).length;
  const intro = `<p class="muted small">${t('Customers open this link without logging in. They see the photo, description, price and whether the item is available — never the cost. "Ask on WhatsApp" goes to your number.')}</p>
    <p class="small">🛍️ ${shown} ${t('items are shown in the catalog.')} ${isAdmin() ? `<a href="#/stock">${t('Choose items in Stock')}</a>` : ''}</p>`;
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
const stockQtyByName = (name) => Object.values(S.stock).filter((x) => x.name.trim().toLowerCase() === String(name).trim().toLowerCase()).reduce((s2, x) => s2 + Math.max(0, x.qty), 0);
const orderLineHtml = (i = {}) => `<div class="orderline"><input name="on" list="snames" placeholder="${t('Item (from stock or type)')}" value="${esc(i.name || '')}">
  <input name="oq" type="number" min="1" inputmode="numeric" value="${i.qty || 1}"><button type="button" class="x" data-orm>×</button></div>`;

async function renderOrderForm(cid, oid) {
  if (needSeller()) return;
  const sid = S.sid;
  let o = null;
  if (oid) { const d = await F.getDoc(F.sellerDoc(sid, 'orders', oid)); if (!d.exists()) return go('#/orders'); o = { id: oid, ...d.data() }; cid = o.customerId; }
  const c = S.customers[cid];
  if (!c) return go('#/customers');
  setTitle(`${o ? t('Order') : t('New order')} · ${c.name}`, true);
  const def = o?.deliveryDate || L.nextRouteDate(daysOf(c), today());
  // Warn (never block) before taking an order from a risky or flagged customer.
  const oth = othersOf(c), warns = [];
  if (c.score?.band === 'risk') warns.push(`${t('Score')} ${c.score.score} — ${t('this customer is behind on payments')}`);
  if (c.ban) warns.push(`🚫 ${esc(c.ban.byName || '')}: ${esc(c.ban.reason)}`);
  oth.forEach((x) => { if (x.ban) warns.push(`🚫 ${esc(x.name)}: ${esc(x.ban)}`); else if (x.score != null && x.score < 60) warns.push(`${esc(x.name)} — ${t('Score')} ${x.score}`); });
  view.innerHTML = `${warns.length ? `<div class="banner warn"><b>⚠ ${t('Check before delivering')}</b>${warns.map((w) => `<div class="small">${w}</div>`).join('')}</div>` : ''}
    <div class="row" style="padding:4px 2px">${scoreBadges(c)}</div>
    <form id="of" class="card form">
    ${o && o.status !== 'pending' ? `<div class="banner warn">${o.status === 'delivered' ? '✓ ' + t('Delivered') + ' ' + fmtDate(o.deliveredOn) : t('Cancelled')}</div>` : ''}
    <label>${t('Items')}</label><div id="olines">${(o?.items || [{}]).map(orderLineHtml).join('')}</div>
    <datalist id="snames">${[...new Set(Object.values(S.stock).filter((x) => x.qty > 0).map((x) => x.name))].sort().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div id="ohint" class="small muted"></div>
    <button type="button" class="btn ghost small" id="addO">+ ${t('Another item')}</button>
    <label>${t('Deliver on')} <small class="muted">(${t('next route day')})</small><input name="dd" type="date" value="${def}" required></label>
    <label>${t('Note (optional)')}<input name="note" value="${esc(o?.note || '')}"></label>
    <p class="muted small">${t('No advance is taken on an order. When you deliver, the sale is entered as usual.')}</p>
    <button class="btn primary" type="submit">${t('Save order')}</button>
    ${o && o.status === 'pending' ? `<div class="contact"><a class="btn" href="#/deliver/${o.id}">✓ ${t('Delivered')}</a><button type="button" class="btn" id="nw">+7 ${t('Next week')}</button><button type="button" class="btn danger" id="ocx">${t('Cancel order')}</button></div>` : ''}</form>`;
  const f = $('#of');
  const hint = () => { $('#ohint').textContent = $$('.orderline', f).map((r) => $('[name=on]', r).value.trim()).filter(Boolean).map((n) => `${n}: ${t('in stock')} ${stockQtyByName(n)}`).join(' · '); };
  const bind = () => { $$('[data-orm]', f).forEach((b) => (b.onclick = () => { if ($$('.orderline', f).length > 1) b.parentElement.remove(); hint(); })); $$('[name=on]', f).forEach((i) => (i.onchange = hint)); hint(); };
  $('#addO').onclick = () => { $('#olines').insertAdjacentHTML('beforeend', orderLineHtml()); bind(); };
  bind();
  const save = (patch) => {
    const b = F.writeBatch(F.db), id = o?.id || F.newId(F.sellerCol(sid, 'orders'));
    const doc = { ...(o || { customerId: cid, customerName: c.name, status: 'pending', createdAt: Date.now(), by: S.user.uid }), ...patch };
    delete doc.id;
    b.set(F.sellerDoc(sid, 'orders', id), doc);
    if (doc.status === 'pending') b.set(F.doc(F.db, 'demand', id), { sellerKey: sid, items: doc.items.map((i) => ({ name: i.name, qty: i.qty })), deliveryDate: doc.deliveryDate, updatedAt: Date.now() });
    else b.delete(F.doc(F.db, 'demand', id));
    F.commit(b, onWriteError);
    return id;
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const items = $$('.orderline', f).map((r) => ({ name: $('[name=on]', r).value.trim(), qty: Math.max(1, Math.round(num($('[name=oq]', r).value))) })).filter((i) => i.name);
    if (!items.length) return toast(t('Add at least one item'), true);
    save({ items, deliveryDate: f.dd.value, note: f.note.value.trim(), customerName: c.name });
    toast(t('Order saved')); go(`#/customer/${cid}`);
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
  $('#naf').onsubmit = (e) => {
    e.preventDefault();
    const row = e.target, acol = F.sellerCol(sid, 'accounts'), aid = F.newId(acol), b = F.writeBatch(F.db);
    const doc = newAccountDoc(c.id, $('[name=an]', row).value.trim() || 'Account', $('[name=af]', row).value, num($('[name=ao]', row).value));
    b.set(F.doc(acol, aid), doc); F.commit(b, onWriteError);
    S.accounts[aid] = { id: aid, ...doc };
    go(`#/sale/${c.id}/${aid}`);
  };
}

async function renderOrders() {
  setTitle(t('Orders'));
  let tab = (() => { try { return sessionStorage.getItem('ordTab') || 'carry'; } catch { return 'carry'; } })();
  if (!S.sid) tab = 'buy';
  let day = today();
  const draw = async () => {
    try { sessionStorage.setItem('ordTab', tab); } catch {}
    const tabs = `${sellerBar()}<div class="tabs">${S.sid ? `<button data-ot="carry" class="${tab === 'carry' ? 'on' : ''}">${t('To carry')}</button>` : ''}
      <button data-ot="buy" class="${tab === 'buy' ? 'on' : ''}">${t('To buy')}</button>${S.sid ? `<button data-ot="all" class="${tab === 'all' ? 'on' : ''}">${t('All pending')}</button>` : ''}</div>`;
    view.innerHTML = tabs + '<div class="loading">…</div>';
    let body = '';
    if (tab === 'buy') {
      const demand = await F.fetchAll(F.collection(F.db, 'demand'));
      const rows = L.toBuy(demand, Object.values(S.stock)), need = rows.filter((r) => r.need > 0), ok = rows.filter((r) => !r.need);
      const tr = (r) => `<tr><td>${esc(r.name)}<small>${t('first needed')} ${fmtDate(r.first)}</small></td><td>${r.qty}</td><td>${r.inStock}</td><td><b>${r.need || '—'}</b></td></tr>`;
      const head = `<thead><tr><th>${t('Item')}</th><th>${t('Ordered')}</th><th>${t('In stock')}</th><th>${t('Buy')}</th></tr></thead>`;
      body = `<p class="muted small">${t('Pending orders of all sellers compared with stock. Customer names are not shown here.')}</p>
        <h3>🛒 ${t('Need to buy')}</h3>${need.length ? `<table class="rep">${head}<tbody>${need.map(tr).join('')}</tbody></table>` : `<div class="muted small">${t('Nothing to buy — stock covers all orders.')}</div>`}
        ${ok.length ? `<h3>✓ ${t('Enough in stock')}</h3><table class="rep">${head}<tbody>${ok.map(tr).join('')}</tbody></table>` : ''}`;
    } else {
      const all = (await F.fetchAll(F.query(F.sellerCol(S.sid, 'orders'), F.where('status', '==', 'pending')))).sort((a, b) => (a.deliveryDate < b.deliveryDate ? -1 : 1));
      if (tab === 'carry') {
        const wd = L.weekdayOf(day), list = all.filter((o) => o.deliveryDate <= day);
        const pos = new Map(L.routeSort(Object.values(S.customers), wd).map((c, i) => [c.id, i]));
        list.sort((a, b) => (pos.get(a.customerId) ?? 1e9) - (pos.get(b.customerId) ?? 1e9));
        const agg = {}; list.forEach((o) => o.items.forEach((i) => { const k = i.name.trim(); agg[k] = (agg[k] || 0) + Number(i.qty || 0); }));
        body = `<div class="toolbar"><input type="date" id="od" value="${day}"></div>
          <div class="card"><b>📦 ${t('Load these items')}</b>${Object.entries(agg).map(([n, q]) => `<div class="kv"><span>${esc(n)}</span><span><b>× ${q}</b> <small class="muted">${t('in stock')} ${stockQtyByName(n)}</small></span></div>`).join('') || `<div class="muted small">${t('No deliveries for this day')}</div>`}</div>
          <ul class="list">${list.map((o) => { const c = S.customers[o.customerId]; return `<li><a class="row" href="#/order-edit/${o.id}"><div>${placeBadge(c)}<b>${esc(o.customerName)}</b><small>${esc(orderText(o))}${o.note ? ' · ' + esc(o.note) : ''}</small></div>
            <span class="pill ${o.deliveryDate < day ? 'bad' : 'ok'}">${o.deliveryDate < day ? t('Late') + ' ' + shortDate(o.deliveryDate) : shortDate(o.deliveryDate)}</span></a></li>`; }).join('')}</ul>`;
      } else {
        body = `<ul class="list">${all.map((o) => `<li class="card"><div class="row" style="padding:0"><div><b>${esc(o.customerName)}</b><small>${esc(orderText(o))}${o.note ? ' · ' + esc(o.note) : ''}</small></div><span class="pill ${o.deliveryDate < today() ? 'bad' : ''}">${fmtDate(o.deliveryDate)}</span></div>
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
      if (patch.status === 'cancelled') b.delete(F.doc(F.db, 'demand', id)); else b.set(F.doc(F.db, 'demand', id), { sellerKey: S.sid, items: o.items, deliveryDate: patch.deliveryDate || o.deliveryDate, updatedAt: Date.now() });
      F.commit(b, onWriteError); setTimeout(draw, 250);
    };
    $$('[data-od]').forEach((i) => (i.onchange = () => i.value && upd(i.dataset.od, { deliveryDate: i.value })));
    $$('[data-nw]').forEach((b) => (b.onclick = () => { const o = S._orders.find((x) => x.id === b.dataset.nw); upd(o.id, { deliveryDate: L.addDays(o.deliveryDate, 7) }); }));
    $$('[data-ocx]').forEach((b) => (b.onclick = () => { if (confirm(t('Cancel this order?'))) upd(b.dataset.ocx, { status: 'cancelled', cancelledOn: today() }); }));
  };
  await draw();
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
    const routeList = plan.days.flatMap((pd) => L.routeSort(Object.values(S.customers).filter((c) => daysOf(c).includes(pd.day) && !seen.has(c.id) && seen.add(c.id)), pd.day));
    const paid = new Set(cols.filter((c) => c.kind !== 'discount').map((c) => c.customerId)), vis = new Map(visits.map((v) => [v.customerId, v]));
    const nopay = [...vis.values()].filter((v) => !paid.has(v.customerId));
    const notSeen = routeList.filter((c) => !paid.has(c.id) && !vis.has(c.id));
    const visited = routeList.filter((c) => paid.has(c.id) || vis.has(c.id)).length;
    const name = (id) => S.customers[id]?.name || '?';
    const closed = closedDoc.exists() ? closedDoc.data() : null;
    const text = [`*${APP_NAME} — ${t('Day closing')}*`, `${S.profile.role === 'admin' ? sellerName(sid) : S.profile.name} · ${fmtDate(day)}`, '',
      `${t('Collected')}: *${money(fig.collected)}* (${cols.filter((x) => x.kind !== 'discount').length})`, `  ${t('Cash')} ${money(fig.collectedCash)} · UPI ${money(fig.collectedUpi)}${fig.collectedScrap ? ` · ${t('Scrap')} ${money(fig.collectedScrap)}` : ''}`,
      `${t('Expenses')}: ${money(fig.expense)} (${t('Cash')} ${money(fig.expenseCash)} · UPI ${money(fig.expenseUpi)})`, `*${t('Cash in hand')}: ${money(fig.cashInHand)}*`, '',
      routeList.length ? `${t('Route')}: ${visited}/${routeList.length} ${t('visited')}` : '',
      nopay.length ? `${t('No payment')}: ${nopay.map((v) => `${name(v.customerId)} (${reasonLabel(v.reason)}${v.promiseDate ? ' → ' + fmtDate(v.promiseDate) : ''})`).join(', ')}` : '',
      notSeen.length ? `${t('Not visited')}: ${notSeen.map((c) => c.name).join(', ')}` : ''].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').trim();
    view.innerHTML = sellerBar() + `
      <div class="toolbar"><input type="date" id="cdd" value="${day}" max="${today()}"></div>
      ${closed ? `<div class="banner">✓ ${t('Closed at')} ${new Date(closed.closedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      <div class="card">
        <div class="kv"><span>${t('Collected')} (${cols.filter((x) => x.kind !== 'discount').length})</span><b>${money(fig.collected)}</b></div>
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

// ---------- shell ----------
function applyNav() {
  const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  $('#nav').innerHTML = [['#/home', 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z', 'Home'],
    ['#/customers', 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8', 'Customers'],
    ['#/stock', 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8', 'Stock'], ['#/report', 'M4 20V10M10 20V4M16 20v-7M22 20H2', 'Reports'],
    ['#/orders', 'M1 3h13v12H1zM14 8h4l3 3v4h-7M5.5 18.5a2 2 0 1 0 0-.01M17.5 18.5a2 2 0 1 0 0-.01', 'Orders'], ['#/menu', 'M4 6h16M4 12h16M4 18h16', 'Menu']]
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
