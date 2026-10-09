// Pure accounting logic — no Firebase, no DOM. Unit-tested in test/logic.test.mjs.

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Maximum selling price from purchase cost and markup %. */
export function maxPrice(unitCost, marginPct) {
  return Math.round((Number(unitCost) || 0) * (1 + (Number(marginPct) || 0) / 100));
}

/** Share of each rupee of sale value that is profit. */
export function profitRatio(saleValue, cost) {
  const v = Number(saleValue) || 0;
  if (v <= 0) return 0;
  return (v - (Number(cost) || 0)) / v;
}

/** Legacy balances: markup % converted to profit share of each collection. */
export function legacyRatio(legacyMarginPct) {
  const m = Number(legacyMarginPct) || 0;
  return m / (100 + m);
}

/**
 * Queue = list of receivable items on one account, oldest first.
 * item: { ref: 'opening' | saleId, date: 'YYYY-MM-DD', seq: number, remaining, ratio }
 */
export function sortQueue(queue) {
  return [...queue].sort((a, b) =>
    a.date === b.date ? (a.seq || 0) - (b.seq || 0) : a.date < b.date ? -1 : 1);
}

/**
 * Allocate a collection across open items, oldest first.
 * If `onlyRef` is given (advance on a new sale), it pays that item first.
 * Returns { queue, allocations: [{ref, amount, profit}], profit, excess }.
 */
export function allocate(queue, amount, onlyRef = null) {
  let left = round2(amount);
  const q = sortQueue(queue).map((i) => ({ ...i }));
  const order = onlyRef ? [...q.filter((i) => i.ref === onlyRef), ...q.filter((i) => i.ref !== onlyRef)] : q;
  const allocations = [];
  for (const item of order) {
    if (left <= 0) break;
    if (item.remaining <= 0) continue;
    const pay = round2(Math.min(left, item.remaining));
    item.remaining = round2(item.remaining - pay);
    left = round2(left - pay);
    allocations.push({ ref: item.ref, amount: pay, profit: round2(pay * item.ratio) });
  }
  if (left > 0) allocations.push({ ref: 'credit', amount: left, profit: 0 });
  const profit = round2(allocations.reduce((s, a) => s + a.profit, 0));
  return { queue: q, allocations, profit, excess: left };
}

/** Undo a collection's allocations (used when a collection is deleted). */
export function reverseAllocations(queue, allocations) {
  const q = queue.map((i) => ({ ...i }));
  for (const a of allocations || []) {
    if (a.ref === 'credit') continue;
    const item = q.find((i) => i.ref === a.ref);
    if (item) item.remaining = round2(item.remaining + a.amount);
  }
  return q;
}

/** Add a new sale to the queue. */
export function addSaleToQueue(queue, saleId, date, saleValue, cost) {
  const seq = queue.reduce((m, i) => Math.max(m, i.seq || 0), 0) + 1;
  return [...queue, { ref: saleId, date, seq, remaining: round2(saleValue), ratio: profitRatio(saleValue, cost) }];
}

/**
 * Credit a return against a sale: lowers what is still owed on that sale
 * and re-prices the remaining balance with the new value/cost.
 */
export function creditReturn(queue, saleId, creditAmount, newSaleValue, newCost) {
  return queue.map((i) => {
    if (i.ref !== saleId) return { ...i };
    return {
      ...i,
      remaining: round2(Math.max(0, i.remaining - creditAmount)),
      ratio: profitRatio(newSaleValue, newCost),
    };
  });
}

/** Sum line items of a sale. */
export function saleTotals(lines) {
  let value = 0, cost = 0;
  for (const l of lines) {
    value += (Number(l.price) || 0) * (Number(l.qty) || 0);
    cost += (Number(l.unitCost) || 0) * (Number(l.qty) || 0);
  }
  return { value: round2(value), cost: round2(cost) };
}

/**
 * Build a running ledger for one account.
 * entries: sales, collections (incl. advances) and credited returns.
 */
export function buildLedger(openingBalance, sales, collections, returns) {
  const rows = [];
  if (Number(openingBalance) > 0) rows.push({ date: '', type: 'opening', amount: Number(openingBalance), sign: 1 });
  for (const s of sales) rows.push({ date: s.date, at: s.createdAt || 0, type: 'sale', amount: s.saleValue, sign: 1, ref: s });
  for (const c of collections) rows.push({ date: c.date, at: (c.createdAt || 0) + (c.kind === 'advance' ? 1 : c.kind === 'discount' ? 2 : 0), type: c.kind === 'advance' ? 'advance' : c.kind === 'discount' ? 'discount' : 'collection', amount: c.amount, sign: -1, ref: c });
  for (const r of returns) if (r.credited) rows.push({ date: r.date, at: r.createdAt || 0, type: 'return', amount: r.amount, sign: -1, ref: r });
  rows.sort((a, b) => (a.date === b.date ? (a.at || 0) - (b.at || 0) : a.date < b.date ? -1 : 1));
  let bal = 0;
  for (const r of rows) { bal = round2(bal + r.sign * r.amount); r.balance = bal; }
  return rows;
}

/**
 * Report figures for one seller over a period.
 * Input arrays are already filtered to the date range.
 */
export const PAY_MODES = ['cash', 'upi', 'scrap'];
// Scrap = material (old aluminium, steel, copper…) taken instead of money. It lowers the balance but is not cash.
const modeOf = (x) => (x.kind === 'discount' ? 'discount' : x.mode === 'upi' || x.mode === 'scrap' ? x.mode : 'cash');
const sumBy = (arr, m) => round2(arr.filter((x) => modeOf(x) === m).reduce((s, x) => s + x.amount, 0));

/** Default payment mode for a customer: the one they used most (Cash on a tie or no history). */
export function preferredMode(counts) { // scrap is never the default
  return (Number(counts?.upi) || 0) > (Number(counts?.cash) || 0) ? 'upi' : 'cash';
}

/**
 * Report figures for one seller over a period.
 * Input arrays are already filtered to the date range.
 */
export function sellerReport({ sales = [], collections = [], returns = [], expenses = [] }) {
  const salesValue = round2(sales.reduce((s, x) => s + x.saleValue, 0));
  const salesCost = round2(sales.reduce((s, x) => s + x.cost, 0));
  const credited = returns.filter((r) => r.credited);
  const returnValue = round2(credited.reduce((s, r) => s + r.amount, 0));
  const returnCost = round2(credited.reduce((s, r) => s + r.cost, 0));
  // A discount lowers the balance like a payment but is not money: it is kept out of "collected"
  // and its (negative) profit lowers realised profit; booked profit drops by the full discount.
  const paid = collections.filter((c) => c.kind !== 'discount');
  const discount = round2(collections.filter((c) => c.kind === 'discount').reduce((s, c) => s + c.amount, 0));
  const collected = round2(paid.reduce((s, c) => s + c.amount, 0));
  const realised = round2(collections.reduce((s, c) => s + (c.profit || 0), 0));
  const expense = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const booked = round2(salesValue - salesCost - (returnValue - returnCost) - discount);
  const collectedCash = sumBy(collections, 'cash'), collectedUpi = sumBy(collections, 'upi'), collectedScrap = sumBy(collections, 'scrap');
  const expenseCash = sumBy(expenses, 'cash'), expenseUpi = sumBy(expenses, 'upi');
  return {
    salesValue, returnValue, collected, collectedCash, collectedUpi, collectedScrap, discount, booked, realised,
    expense, expenseCash, expenseUpi, cashInHand: round2(collectedCash - expenseCash),
    net: round2(realised - expense), salesCount: sales.length,
  };
}

/**
 * Company totals. scrapLosses = damaged returned items written off (cost);
 * scrapSales = bulk sales of scrap taken as payment: { received, credited } — the gain/loss is received − credited value.
 */
export function companyReport(sellerReports, companyExpenses = [], scrapLosses = [], scrapSales = []) {
  const sum = (k) => round2(sellerReports.reduce((s, r) => s + (r[k] || 0), 0));
  const companyExpense = round2(companyExpenses.reduce((s, e) => s + e.amount, 0));
  const companyExpenseCash = sumBy(companyExpenses, 'cash'), companyExpenseUpi = sumBy(companyExpenses, 'upi');
  const scrap = round2(scrapLosses.reduce((s, e) => s + e.amount, 0)); // damage loss
  const scrapSold = round2(scrapSales.reduce((s, e) => s + (Number(e.received) || 0), 0));
  const scrapSoldCredited = round2(scrapSales.reduce((s, e) => s + (Number(e.credited) || 0), 0));
  const scrapGain = round2(scrapSold - scrapSoldCredited);
  const scrapSoldCash = round2(scrapSales.filter((e) => e.mode !== 'upi').reduce((s, e) => s + (Number(e.received) || 0), 0));
  const realised = sum('realised');
  const personal = sum('expense');
  return {
    salesValue: sum('salesValue'), collected: sum('collected'), collectedCash: sum('collectedCash'), collectedUpi: sum('collectedUpi'), collectedScrap: sum('collectedScrap'), discount: sum('discount'),
    booked: sum('booked'), realised, personalExpense: personal, companyExpense, companyExpenseCash, companyExpenseUpi, scrap,
    scrapSold, scrapSoldCredited, scrapGain,
    cashInHand: round2(sum('cashInHand') - companyExpenseCash + scrapSoldCash),
    net: round2(realised - personal - companyExpense - scrap + scrapGain),
  };
}

/** Scrap on hand by type: everything taken as payment minus what was sold. */
export function scrapStock(scrapIn = [], scrapSales = []) {
  const by = {};
  for (const d of scrapIn) for (const i of d.items || []) by[i.type] = round2((by[i.type] || 0) + (Number(i.value) || 0));
  for (const d of scrapSales) for (const i of d.items || []) by[i.type] = round2((by[i.type] || 0) - (Number(i.value) || 0));
  return by;
}

/** Sales and booked profit per stock category. catOf(line) gives the category of a sale line. */
export function categoryReport(sales = [], returns = [], catOf = (l) => l.category || 'Others') {
  const out = {};
  const row = (c) => (out[c] ||= { qty: 0, value: 0, cost: 0, profit: 0 });
  for (const s of sales) for (const l of s.items || []) {
    const r = row(catOf(l)), q = Number(l.qty) || 0;
    r.qty += q; r.value = round2(r.value + q * (Number(l.price) || 0)); r.cost = round2(r.cost + q * (Number(l.unitCost) || 0));
  }
  for (const rt of returns) if (rt.credited) for (const l of rt.items || []) {
    const r = row(catOf(l)), q = Number(l.qty) || 0;
    r.qty -= q; r.value = round2(r.value - q * (Number(l.price) || 0)); r.cost = round2(r.cost - q * (Number(l.unitCost) || 0));
  }
  for (const r of Object.values(out)) r.profit = round2(r.value - r.cost);
  return out;
}

/**
 * Rebuild an account from its entries in the order they were made (used when a sale is voided).
 * opening: { amount, ratio }. Returns { queue, balance, collections: [{id, allocations, profit}] }.
 */
export function replayAccount({ opening = null, sales = [], collections = [], returns = [] }) {
  const ev = [
    ...sales.map((x) => ({ k: 0, at: x.createdAt || 0, x })),
    ...collections.map((x) => ({ k: x.kind === 'advance' ? 1 : 2, at: x.createdAt || 0, x })),
    ...returns.filter((r) => r.credited).map((x) => ({ k: 3, at: x.createdAt || 0, x })),
  ].sort((a, b) => a.at - b.at || a.k - b.k);
  let queue = opening && opening.amount > 0 ? [{ ref: 'opening', date: '0000-00-00', seq: 0, remaining: round2(opening.amount), ratio: opening.ratio }] : [];
  let balance = round2(opening?.amount || 0);
  const credited = {}, outCols = [];
  const saleOf = Object.fromEntries(sales.map((s) => [s.id, s]));
  for (const { k, x } of ev) {
    if (k === 0) { queue = addSaleToQueue(queue, x.id, x.date, x.saleValue, x.cost); balance = round2(balance + x.saleValue); }
    else if (k === 3) {
      const s = saleOf[x.saleId];
      const c = (credited[x.saleId] ||= { v: 0, c: 0 });
      c.v = round2(c.v + x.amount); c.c = round2(c.c + (x.cost || 0));
      if (s) queue = creditReturn(queue, s.id, x.amount, s.saleValue - c.v, s.cost - c.c);
      balance = round2(balance - x.amount);
    } else {
      const r = x.kind === 'discount' ? allocateDiscount(queue, x.amount) : allocate(queue, x.amount, k === 1 && x.saleId && queue.some((i) => i.ref === x.saleId) ? x.saleId : null);
      queue = r.queue; balance = round2(balance - x.amount);
      outCols.push({ id: x.id, allocations: r.allocations, profit: r.profit });
    }
  }
  return { queue, balance, collections: outCols };
}

/**
 * Void one sale with the least change: drop it from the queue and move only the money other collections
 * had paid toward it onto the remaining items (oldest first). Other collections and past profits are untouched.
 * collections: the account's collections except the sale's own advance, oldest first.
 * Returns { queue, collections: [{id, allocations, profit}] } (only the changed collections).
 */
export function voidFromQueue(queue, saleId, collections = []) {
  let q = queue.filter((i) => i.ref !== saleId).map((i) => ({ ...i }));
  const changed = [];
  for (const c of [...collections].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const onSale = (c.allocations || []).filter((a) => a.ref === saleId);
    if (!onSale.length) continue;
    const amt = round2(onSale.reduce((s, a) => s + a.amount, 0));
    const allocs = (c.allocations || []).filter((a) => a.ref !== saleId).map((a) => ({ ...a }));
    const r = c.kind === 'discount' ? allocateDiscount(q, amt) : allocate(q, amt);
    q = r.queue;
    // a discount's share is negative profit (margin given away): keep that when it moves to another item
    if (c.kind === 'discount') r.allocations.forEach((a) => { if (a.ref !== 'credit') a.profit = round2(a.profit - a.amount); });
    for (const a of r.allocations) {
      const ex = allocs.find((x) => x.ref === a.ref);
      if (ex) { ex.amount = round2(ex.amount + a.amount); ex.profit = round2(ex.profit + a.profit); } else allocs.push({ ...a });
    }
    const prof = round2(allocs.reduce((s, a) => s + a.profit, 0));
    changed.push({ id: c.id, allocations: allocs, profit: prof });
  }
  return { queue: q, collections: changed };
}

/** Open amount still due in a queue (used to spot a queue that no longer matches the balance). */
export const queueDue = (queue = []) => round2(queue.reduce((s, i) => s + Math.max(0, i.remaining || 0), 0));

/** Next date after `from` that falls on one of the route weekdays (or the next day if none set). */
export function nextRouteDate(days, from) {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(from, i);
    if (!days?.length || days.includes(new Date(d + 'T00:00:00Z').getUTCDay())) return d;
  }
  return addDays(from, 1);
}

export const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

/** Stable document id for an item name (catalog groups stock lots with the same name). */
export function nameKey(name) {
  const s = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  const slug = s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return (slug ? slug + '-' : 'n-') + h.toString(36);
}

/** Pending orders vs stock: what has to be bought. demand: [{items:[{name, qty}], deliveryDate}] */
export function toBuy(demand = [], stock = []) {
  const want = {};
  for (const d of demand) for (const i of d.items || []) {
    const k = String(i.name || '').trim().toLowerCase();
    if (!k) continue;
    const w = (want[k] ||= { name: String(i.name).trim(), qty: 0, first: d.deliveryDate || '' });
    w.qty += Number(i.qty) || 0;
    if (d.deliveryDate && (!w.first || d.deliveryDate < w.first)) w.first = d.deliveryDate;
  }
  const have = {};
  for (const s of stock) { const k = String(s.name || '').trim().toLowerCase(); have[k] = (have[k] || 0) + Math.max(0, Number(s.qty) || 0); }
  return Object.entries(want).map(([k, w]) => ({ ...w, inStock: have[k] || 0, need: Math.max(0, w.qty - (have[k] || 0)) }))
    .sort((a, b) => b.need - a.need || (a.first < b.first ? -1 : 1));
}

/** Shift a YYYY-MM-DD date by n days. */
export function addDays(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/**
 * Who held which customer book over a report range.
 * users: [{uid, name, role, sellerKey, heldFrom, heldTo, replaced}]
 * A handover ends the old holder's period the day before the new one starts.
 * A replaced login (forgot password) is the same person continuing, so it is skipped.
 */
export function holderPeriods(users, from, to) {
  return users
    .filter((u) => u.role === 'seller' && !u.replaced)
    .map((u) => ({ uid: u.uid, name: u.name, key: u.sellerKey || u.uid, active: u.active !== false, heldTo: u.heldTo || '',
      from: u.heldFrom && u.heldFrom > from ? u.heldFrom : from,
      to: u.heldTo && u.heldTo < to ? u.heldTo : to }))
    .filter((p) => p.from <= p.to)
    .sort((a, b) => (a.key === b.key ? (a.from < b.from ? -1 : 1) : a.name.localeCompare(b.name)));
}

/** India mobile number → wa.me format. */
export function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return d;
}

export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Route order for one weekday.
 * customers: [{id, lane, house, name, routeOrder: {<day>: n}}]
 * Customers with a saved position come first in that order; the rest follow by lane, then house number, then name.
 */
export function routeSort(customers, day) {
  const pos = (c) => Number(c.routeOrder?.[day]) || 0;
  const laneCmp = (a, b) => (a.lane || '￿').localeCompare(b.lane || '￿', 'en', { sensitivity: 'base' });
  const houseCmp = (a, b) => String(a.house || '').localeCompare(String(b.house || ''), 'en', { numeric: true, sensitivity: 'base' });
  return [...customers].sort((a, b) => {
    const pa = pos(a), pb = pos(b);
    if (pa && pb) return pa - pb;
    if (pa || pb) return pa ? -1 : 1;
    return laneCmp(a, b) || houseCmp(a, b) || String(a.name).localeCompare(String(b.name));
  });
}

/**
 * Suggested visiting order from past collection entry times on that weekday.
 * entries: [{customerId, date: 'YYYY-MM-DD', createdAt: ms}]; only entries made on their own date count
 * (back-dated entries say nothing about the time of the visit).
 * Returns customer ids: those with history by median minute of day, then the rest in their current order.
 */
export function orderFromTimes(entries, day, currentIds, tzOffsetMin = 330) {
  const mins = {};
  for (const e of entries) {
    if (!e.createdAt || !e.date) continue;
    const local = new Date(e.createdAt + tzOffsetMin * 60000);
    if (local.toISOString().slice(0, 10) !== e.date || local.getUTCDay() !== day) continue;
    (mins[e.customerId] ||= []).push(local.getUTCHours() * 60 + local.getUTCMinutes());
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const timed = currentIds.filter((id) => mins[id]).sort((a, b) => median(mins[a]) - median(mins[b]));
  const out = [...timed, ...currentIds.filter((id) => !mins[id])];
  out.timed = timed.length; // how many customers had usable times
  return out;
}

/**
 * Which route days to visit on a date, after holiday decisions.
 * routeChanges: { 'YYYY-MM-DD': { date, day, action: 'move' | 'cancel' | 'keep', toDate } } keyed by the event date.
 * Returns { days: [{ day, moved, from }], change } — change is set when that date's own route was moved or cancelled.
 */
export function dayPlan(date, routeChanges = {}, routeDays = [1, 2, 3, 6, 0]) {
  const wd = weekdayOf(date), out = { days: [], change: null };
  const rc = routeChanges[date];
  if (routeDays.includes(wd)) { if (rc && rc.action !== 'keep') out.change = rc; else out.days.push({ day: wd, moved: false }); }
  for (const r of Object.values(routeChanges)) {
    if (r.action === 'move' && r.toDate === date && !out.days.some((d) => d.day === r.day)) out.days.push({ day: r.day, moved: true, from: r.date });
  }
  return out;
}

/**
 * Holidays/events in the next `ahead` days that fall on a route day with customers and are not yet decided.
 * events: [{ date, name }]; busyDays: weekdays that have customers.
 */
export function routeAlerts(today, events, routeChanges = {}, busyDays = [], ahead = 2, routeDays = [1, 2, 3, 6, 0]) {
  const out = [];
  for (let i = 0; i <= ahead; i++) {
    const d = addDays(today, i), wd = weekdayOf(d);
    if (!routeDays.includes(wd) || !busyDays.includes(wd) || routeChanges[d]) continue;
    const names = events.filter((e) => e.date === d).map((e) => e.name);
    if (names.length) out.push({ date: d, day: wd, names });
  }
  return out;
}

/** Discount allocation: same oldest-first order as a payment; its profit is negative (the margin given away). */
export function allocateDiscount(queue, amount) {
  const r = allocate(queue, amount);
  const real = r.allocations.filter((a) => a.ref !== 'credit').reduce((s, a) => s + a.amount, 0);
  return { ...r, profit: round2(r.profit - real) };
}

/** First day of the business week (Saturday) for a date. */
export function weekStart(d, startDay = 6) {
  const wd = weekdayOf(d);
  return addDays(d, -((wd - startDay + 7) % 7));
}

/**
 * Customer score (0–100) from repayment against a one-year plan per sale.
 * Every sale (and the old-book opening balance) should be repaid within 365 days of its date, evenly after the advance.
 * accounts: [{id, frequency, openingBalance, date}], sales: [{id, accountId, date, saleValue, creditedValue, advance}],
 * collections: [{accountId, date, amount, kind, allocations:[{ref, amount}]}], promises: [{date, promiseDate}] (visits).
 * Parts: accuracy 30 (behind schedule on items still open; items already paid off are forgiven),
 * speed 25 (pace vs plan; on plan = half), current 20 (behind today; items older than a year still open),
 * promises 15 (kept promised dates), history 10 (items fully paid).
 */
export const SCORE_TOL = { daily: [3, 30], weekly: [7, 42], monthly: [30, 120] }; // [free days, zero-mark days]
export const SCORE_CAP = { daily: [7, 15], weekly: [14, 28], monthly: [60, 90] }; // days behind now -> cap at yellow / red
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };
export function customerScore({ accounts = [], sales = [], collections = [], promises = [], today }) {
  const dayN = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 864e5);
  const T = dayN(today);
  const paidBy = {}; // key `${accountId}|${ref}` -> [{t, amount}]
  for (const c of collections) for (const a of c.allocations || []) {
    if (a.ref === 'credit') continue;
    (paidBy[`${c.accountId}|${a.ref}`] ||= []).push({ t: dayN(c.date), amount: a.amount });
  }
  const items = [];
  for (const a of accounts) {
    const opened = a.date || (a.createdAt ? new Date(a.createdAt + 330 * 60000).toISOString().slice(0, 10) : today);
    if (Number(a.openingBalance) > 0) items.push({ key: `${a.id}|opening`, acc: a, start: dayN(opened), amount: Number(a.openingBalance), adv: 0 });
  }
  const accById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  for (const s of sales) {
    const acc = accById[s.accountId]; if (!acc) continue;
    const amount = round2((s.saleValue || 0) - (s.creditedValue || 0));
    if (amount > 0) items.push({ key: `${s.accountId}|${s.id}`, acc, start: dayN(s.date), amount, adv: Math.min(amount, Number(s.advance) || 0) });
  }
  if (!items.length) return { score: null, band: 'new', reason: 'no sales' };
  const paidAt = (it, t) => round2((paidBy[it.key] || []).filter((p) => p.t <= t).reduce((s, p) => s + p.amount, 0));
  const expectedAt = (it, t) => (t < it.start ? 0 : round2(it.adv + (it.amount - it.adv) * Math.min(1, (t - it.start) / 365)));
  for (const it of items) {
    it.paid = paidAt(it, T); it.open = it.paid < it.amount - 0.5;
    if (!it.open) { // day it was finished
      let acc = 0; for (const p of (paidBy[it.key] || []).sort((x, y) => x.t - y.t)) { acc += p.amount; if (acc >= it.amount - 0.5) { it.doneAt = p.t; break; } }
    }
  }
  // dominant frequency = account with the largest amount still open (else largest overall)
  const weightBy = {};
  for (const it of items) weightBy[it.acc.frequency || 'weekly'] = (weightBy[it.acc.frequency || 'weekly'] || 0) + (it.open ? it.amount - it.paid : 0) + 0.001;
  const freq = Object.entries(weightBy).sort((a, b) => b[1] - a[1])[0][0];
  const [free, zero] = SCORE_TOL[freq] || SCORE_TOL.weekly, per = PERIOD_DAYS[freq] || 7;
  const oldest = Math.min(...items.map((i) => i.start));
  if (T - oldest < 28) return { score: null, band: 'new', reason: 'less than 4 weeks', freq };
  const open = items.filter((i) => i.open && i.start <= T);
  const behindDays = (t) => {
    let behind = 0, rate = 0;
    for (const it of open) {
      if (t < it.start) continue;
      behind += Math.max(0, expectedAt(it, t) - paidAt(it, t));
      rate += (it.amount - it.adv) / 365;
    }
    return rate > 0 ? behind / rate : 0;
  };
  const markOf = (days) => Math.max(0, Math.min(1, 1 - (days - free) / (zero - free)));
  // accuracy: weekly samples over the last 182 days, only items still open
  let acc = 1;
  if (open.length) {
    const from = Math.max(T - 182, Math.min(...open.map((i) => i.start)));
    const pts = []; for (let t = T; t >= from; t -= 7) pts.push(behindDays(t));
    acc = pts.length ? markOf(pts.reduce((s, x) => s + x, 0) / pts.length) : 1;
  }
  const nowBehind = open.length ? behindDays(T) : 0;
  let cur = markOf(nowBehind);
  if (open.some((i) => T - i.start > 365)) cur *= 0.25;
  // speed: pace ratio vs plan; on plan = 0.5, twice the pace (or paid off within half a year) = 1
  let sw = 0, ss = 0;
  for (const it of items) {
    const age = (it.open ? T : it.doneAt) - it.start;
    if (it.open && age < 28) continue;
    const timeFrac = Math.max(1 / 365, Math.min(1, age / 365));
    const paidFrac = Math.min(1, (it.open ? it.paid : it.amount) / it.amount);
    const planFrac = Math.min(1, (it.adv + (it.amount - it.adv) * timeFrac) / it.amount);
    const ratio = it.open ? paidFrac / planFrac : 365 / Math.max(1, age);
    ss += Math.min(1, ratio / 2) * it.amount; sw += it.amount;
  }
  const speed = sw ? ss / sw : 0.5;
  // promises
  const due = promises.filter((p) => p.promiseDate && dayN(p.promiseDate) < T);
  const kept = due.filter((p) => collections.some((c) => c.kind !== 'discount' && c.kind !== 'advance' && c.date >= p.date && c.date <= p.promiseDate)).length;
  const prom = due.length ? kept / due.length : 1;
  const closed = items.filter((i) => !i.open).length;
  const hist = closed >= 2 ? 1 : closed === 1 ? 0.75 : 0.5;
  const parts = { accuracy: round2(30 * acc), speed: round2(25 * speed), current: round2(20 * cur), promises: round2(15 * prom), history: round2(10 * hist) };
  let score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
  // Being far behind right now overrides a good past: 2+ periods behind caps at yellow, 4+ at red (weekly: 14 / 28 days).
  const [capY, capR] = SCORE_CAP[freq] || SCORE_CAP.weekly;
  let capped = '';
  if (nowBehind >= capR && score > 59) { score = 59; capped = 'red'; } else if (nowBehind >= capY && score > 79) { score = 79; capped = 'yellow'; }
  // plan figures for the customer page
  const rateDay = open.reduce((s, it) => s + (it.amount - it.adv) / 365, 0);
  const expectedNow = round2(open.reduce((s, it) => s + expectedAt(it, T), 0));
  const paidNow = round2(open.reduce((s, it) => s + it.paid, 0));
  const last90 = collections.filter((c) => c.kind !== 'discount' && c.kind !== 'advance' && dayN(c.date) > T - 90).reduce((s, c) => s + c.amount, 0);
  const histDays = Math.min(90, T - oldest);
  return {
    score, band: score >= 80 ? 'good' : score >= 60 ? 'ok' : 'risk', parts, freq, capped,
    plan: {
      perPeriod: Math.round(rateDay * per), expected: expectedNow, paid: paidNow,
      behind: round2(Math.max(0, expectedNow - paidNow)), behindPeriods: Math.round((nowBehind / per) * 10) / 10,
      average: histDays > 0 ? round2((last90 / histDays) * per) : 0,
    },
    promises: { due: due.length, kept }, closedItems: closed,
  };
}

/** Food emoji for a dinner message (Malayalam or English words). */
export function foodEmoji(text) {
  const s = String(text || '').toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  if (has('വേണ്ട', 'venda', 'no need', 'nothing', 'none')) return '🙅';
  if (has('ബിരിയാണി', 'biriyani', 'biryani', 'ചോറ്', 'rice', 'meals', 'ഊണ്')) return '🍛';
  if (has('ചിക്കൻ', 'chicken', 'കോഴി', 'alfaham', 'അൽഫഹം', 'shawai', 'ഷവായ്')) return '🍗';
  if (has('ബീഫ്', 'beef', 'മട്ടൻ', 'mutton', 'ഇറച്ചി', 'പോത്ത്')) return '🥩';
  if (has('മീൻ', 'fish', 'ഫിഷ്', 'മത്തി', 'അയല')) return '🐟';
  if (has('മുട്ട', 'egg', 'omelette', 'ഓംലറ്റ്')) return '🥚';
  if (has('പൊറോട്ട', 'porotta', 'parotta', 'ചപ്പാത്തി', 'chapathi', 'chapati', 'ദോശ', 'dosa', 'അപ്പം', 'appam', 'പുട്ട്', 'puttu')) return '🫓';
  if (has('ജ്യൂസ്', 'juice', 'ചായ', 'tea', 'coffee', 'കാപ്പി', 'shake')) return '🥤';
  return '🍽️';
}
