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
  for (const c of collections) rows.push({ date: c.date, at: (c.createdAt || 0) + (c.kind === 'advance' ? 1 : 0), type: c.kind === 'advance' ? 'advance' : 'collection', amount: c.amount, sign: -1, ref: c });
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
export const PAY_MODES = ['cash', 'upi'];
const modeOf = (x) => (x.mode === 'upi' ? 'upi' : 'cash');
const sumBy = (arr, m) => round2(arr.filter((x) => modeOf(x) === m).reduce((s, x) => s + x.amount, 0));

/** Default payment mode for a customer: the one they used most (Cash on a tie or no history). */
export function preferredMode(counts) {
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
  const collected = round2(collections.reduce((s, c) => s + c.amount, 0));
  const realised = round2(collections.reduce((s, c) => s + (c.profit || 0), 0));
  const expense = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const booked = round2(salesValue - salesCost - (returnValue - returnCost));
  const collectedCash = sumBy(collections, 'cash'), collectedUpi = sumBy(collections, 'upi');
  const expenseCash = sumBy(expenses, 'cash'), expenseUpi = sumBy(expenses, 'upi');
  return {
    salesValue, returnValue, collected, collectedCash, collectedUpi, booked, realised,
    expense, expenseCash, expenseUpi, cashInHand: round2(collectedCash - expenseCash),
    net: round2(realised - expense), salesCount: sales.length,
  };
}

export function companyReport(sellerReports, companyExpenses = [], scrapLosses = []) {
  const sum = (k) => round2(sellerReports.reduce((s, r) => s + r[k], 0));
  const companyExpense = round2(companyExpenses.reduce((s, e) => s + e.amount, 0));
  const companyExpenseCash = sumBy(companyExpenses, 'cash'), companyExpenseUpi = sumBy(companyExpenses, 'upi');
  const scrap = round2(scrapLosses.reduce((s, e) => s + e.amount, 0));
  const realised = sum('realised');
  const personal = sum('expense');
  return {
    salesValue: sum('salesValue'), collected: sum('collected'), collectedCash: sum('collectedCash'), collectedUpi: sum('collectedUpi'),
    booked: sum('booked'), realised, personalExpense: personal, companyExpense, companyExpenseCash, companyExpenseUpi, scrap,
    cashInHand: round2(sum('cashInHand') - companyExpenseCash),
    net: round2(realised - personal - companyExpense - scrap),
  };
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
